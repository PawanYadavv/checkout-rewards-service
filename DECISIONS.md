# DECISIONS

## 1. System invariants and where they are enforced

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Inventory never goes negative; nothing is oversold | `UPDATE products … WHERE inventory >= $q` in `checkout.ts`; `CHECK (inventory >= 0)` as backup |
| I2 | A cart is checked out at most once; a checked-out cart cannot be edited | cart row lock (`SELECT … FOR UPDATE` in `cart.ts`) + status check; `UNIQUE(orders.cart_id)` |
| I3 | A retried checkout never creates a second order or takes stock twice | `orders.idempotency_key UNIQUE` + lookup after the cart lock |
| I4 | Checkout is all-or-nothing (stock, order, items, coupon, cart status) | one transaction (`withTransaction` in `db.ts`) |
| I5 | An order explains itself forever | `order_items` copies name, unit price, quantity, line total; order stores subtotal, discount, coupon, total |
| I6 | Money is exact; `0 ≤ discount ≤ subtotal`; `total = subtotal − discount ≥ 0` | integer paise everywhere; `calculateDiscount`; `CHECK` constraints on `orders` and `order_items` |
| I7 | A coupon is redeemed at most once, even concurrently | `UPDATE coupons … WHERE redeemed_at IS NULL`; `UNIQUE(orders.coupon_code)` |
| I8 | A coupon is consumed only by a checkout that commits | redemption happens inside the checkout transaction |
| I9 | At most one coupon per milestone, only for reached milestones | eligibility check under `pg_advisory_xact_lock`; `UNIQUE(coupons.milestone)` |
| I10 | Invalid products or quantities never enter a cart | `requireQuantity` / `ensureStock`; FK + `CHECK (quantity BETWEEN 1 AND 100)` |
| I11 | The report is read-only and reconciles with orders and coupons | computed from the same tables in one `REPEATABLE READ READ ONLY` transaction |

## 2. Ambiguities and the semantics chosen

| Ambiguity | Chosen semantics |
|---|---|
| Price changes after add, before checkout | Cart shows the current price; checkout charges the current price and snapshots it |
| Stock drops after add, before checkout | No reservation. Soft check on add; checkout fails as a whole with `409 INSUFFICIENT_STOCK` (no partial fulfilment) |
| Who owns a coupon? (no customers in the brief) | Store-wide milestones; a coupon is a bearer code usable once by anyone |
| What counts as an order for milestones? | Every successfully placed order, including ones that used a coupon |
| Several unrewarded milestones | One coupon per admin request, oldest milestone first |
| How is the next milestone defined if n changes? | Last rewarded milestone + n (first is n) |
| Coupon percent if x changes later | Copied into the coupon at generation; issued coupons never change |
| Expiry, minimum order, stacking | None, none, one coupon per checkout |
| Rounding | Round the discount down to whole paise |
| Invalid or used coupon at checkout | Reject the checkout (404 / 409); never silently charge full price |
| Retry semantics | Same key + same cart → same order (201, `Idempotent-Replayed: true`); same key + other cart → 422; failures are not remembered |
| Duplicate add / quantity 0 | Add merges quantities; PATCH sets; quantity 1–100; remove with DELETE |
| Payment | A committed checkout counts as payment success (no gateway) |

## 3. Material design decisions

## Decision: PostgreSQL with hand-written SQL

**Context:** The hardest requirements are consistency under concurrent and retried requests.

**Options considered:** PostgreSQL + `pg`; MongoDB; in-memory store with application locks; an ORM.

**Choice:** PostgreSQL 16 via docker-compose, plain `pg`, hand-written SQL.

**Why:** Multi-row ACID transactions are the default; CHECK / UNIQUE / FK constraints enforce invariants even if app code has a bug; row locks make conditional updates atomic. MongoDB has multi-document transactions but weaker constraints. In-memory would not survive restarts or work across instances. No ORM, so the locking and SQL are visible.

**Consequences:** Docker is needed to run. Concurrency logic is explicit and easy to point at.

## Decision: Inventory protected by a conditional atomic UPDATE

**Context:** Concurrent checkouts must not oversell.

**Options considered:** conditional `UPDATE … WHERE inventory >= q`; `SELECT … FOR UPDATE` then check in code; SERIALIZABLE with retries.

**Choice:** Conditional UPDATE under READ COMMITTED, one product at a time in product-id order. 0 rows updated → shortage → whole transaction rolls back.

**Why:** Check and decrement are one statement. Concurrent updates to the same row queue on its row lock, and the waiting one re-checks the condition against the committed value. Fixed lock order prevents deadlocks. SERIALIZABLE would need a retry loop and is harder to debug.

**Consequences:** `RETURNING name, price_paise` gives the snapshot values from the same locked row.

## Decision: Cart row lock serializes all cart writes and checkout

**Context:** Lost updates on concurrent adds; an item added while checkout runs could end up in the cart but not in the order.

**Options considered:** no lock (upserts only); optimistic version column; `SELECT … FOR UPDATE` on the cart row.

**Choice:** Every cart mutation and checkout starts with `SELECT status FROM carts WHERE id = $1 FOR UPDATE`.

**Why:** One simple rule fixes both races. Tests show 10 concurrent adds give quantity 10 (2 without the lock), and an add racing a checkout is either in the order or gets `409 CART_NOT_OPEN`.

**Consequences:** Writes to the same cart are serialized (fine: one cart = one customer).

## Decision: Idempotency key stored on the order, checked after the cart lock

**Context:** Retries after timeouts must return the original result, including retries that arrive while the first attempt is still running.

**Options considered:** optional key with the cart as natural key; separate `idempotency_keys` table storing response bodies; required key stored as `orders.idempotency_key UNIQUE`. Lookup before vs after the cart lock.

**Choice:** Required `Idempotency-Key` stored on the order. Order of steps: lock cart → look up order by key → check cart is open.

**Why:** Only successes are remembered and each success is exactly one order, so no extra table is needed; the response is rebuilt from the order. Looking up after the lock means a concurrent retry waits, then finds the committed order. The key is written in the checkout transaction, so a failed checkout leaves no key behind. Same key on two different carts at the same instant is stopped by the UNIQUE constraint and mapped to 422.

**Consequences:** The body is not fingerprinted: a retry with the same key but a different coupon gets the original order. Keys are kept forever (no TTL).

## Decision: Coupon redeemed atomically inside the checkout transaction

**Context:** A coupon must not be redeemed twice concurrently, and must not be lost if checkout fails.

**Options considered:** validate first and mark used after the order is saved; conditional `UPDATE … WHERE redeemed_at IS NULL` inside the transaction.

**Choice:** Conditional UPDATE, right after the cart lock and before taking stock.

**Why:** The second concurrent checkout waits for the row lock, then sees `redeemed_at` set → 409. Any later failure (e.g. out of stock) rolls the redemption back. Redeeming *before* the stock step means the "failed checkout keeps the coupon" test truly exercises the rollback. Lock order is always cart → coupon → products.

**Consequences:** `UNIQUE(orders.coupon_code)` is a second line of defence.

## Decision: Milestones and concurrent coupon generation

**Context:** Two admins may generate at once; n may be changed by config.

**Options considered:** next milestone = smallest unrewarded multiple of n vs last rewarded milestone + n; rely on `UNIQUE(milestone)` errors vs serialize with an advisory lock.

**Choice:** Last milestone + n, generated under `pg_advisory_xact_lock(1)`, with `UNIQUE(milestone)` as backup.

**Why:** Stays sensible when n changes ("n more orders since the last reward"). The lock makes the second admin wait and then get a clean `409 NO_ELIGIBLE_MILESTONE`. Test: 5 concurrent requests → exactly 1 coupon.

**Consequences:** Generation is serialized (rare admin action, acceptable).

## Decision: Report computed live in one read-only snapshot

**Context:** The report must reconcile and must not mutate state.

**Options considered:** running counters updated during checkout; SELECT aggregates per request.

**Choice:** Aggregates in a `REPEATABLE READ READ ONLY` transaction.

**Why:** Reconciles by construction (same rows the order API returns); no extra writes on the hot checkout path; one snapshot keeps all numbers consistent with each other during concurrent checkouts; READ ONLY makes mutation impossible.

**Consequences:** Cost grows with the number of orders (see scaling section).

## Decision: Live prices in the cart, snapshot in the order

**Context:** Prices may change between add and checkout; orders must stay explainable.

**Options considered:** live price; lock price at add time; live price plus a client-sent expected total.

**Choice:** Live price until checkout; order and order items store copies.

**Why:** Simplest model with no stale prices; the snapshot satisfies "explain what was purchased even if product data later changes".

**Consequences:** A customer may pay a different price than first seen. An expected-total guard is a natural addition.

## Decision: No payment abstraction

**Context:** Payment integration is not required.

**Options considered:** committed checkout = paid; a fake gateway that can fail.

**Choice:** Committed checkout = payment success.

**Why:** Calling a gateway inside the DB transaction would hold locks during a network call, which is the wrong pattern; doing it properly needs a pending-order state, which is beyond the timebox.

**Consequences:** With real payments: create order as `pending` and reserve stock/coupon in one transaction → charge outside the transaction (idempotent on the order id) → mark `paid`, or release stock and coupon on failure/timeout.

## 4. Transaction, concurrency and idempotency strategy

Checkout runs in one READ COMMITTED transaction:

1. `SELECT … FROM carts WHERE id = $1 FOR UPDATE` lock the cart (404 if missing)
2. look up an order with this `Idempotency-Key` → replay it (or 422 if it belongs to another cart)
3. cart must be `open` (409 `CART_NOT_OPEN`), and non-empty (409 `CART_EMPTY`)
4. `UPDATE coupons … WHERE code = $1 AND redeemed_at IS NULL` if a coupon is given (404 / 409)
5. for each item in product-id order: `UPDATE products SET inventory = inventory - q WHERE id = $1 AND inventory >= q RETURNING name, price` (collect shortages → 409 with details)
6. compute subtotal, discount, total in integer paise
7. insert order (with key and coupon) and order items
8. set cart to `checked_out`, COMMIT

Any error → ROLLBACK: stock, coupon, key and cart status all return to their previous state.
Lock order is always cart → coupon → products (sorted), so two checkouts cannot deadlock.
Database constraints (CHECK, UNIQUE, FK) back up every application check.

Tests that exercise competing or repeated operations: concurrent checkouts on the last 2 units; 5 simultaneous retries with one key; add racing checkout; two checkouts with one coupon; 5 simultaneous coupon generations; 10 concurrent adds to one cart; failed checkout keeps the coupon and the key. Each race test was verified by temporarily removing its protection and seeing the test fail.

## 5. Money and rounding

- All amounts are integers in paise (`integer` columns; JS numbers stay far below 2^53).
- `lineTotal = unitPrice × quantity`; `subtotal = Σ lineTotal`.
- `discount = min(subtotal, floor(subtotal × percentOff / 100))`. Example: 10% of 29999 = 2999.9 → 2999.
- `total = subtotal − discount`, so it is never negative. The database checks this equation too.
- Report sums are `bigint` in SQL and converted to numbers.

## 6. Error model

- One shape everywhere: `{ "error": { "code", "message", "details?" } }`, produced by one central handler.
- 400 invalid input, 404 missing resource, 409 conflicts with current state, 422 idempotency key reused for another cart, 500 unexpected.
- The `code` distinguishes failures that share a status (e.g. `INSUFFICIENT_STOCK` vs `COUPON_ALREADY_REDEEMED` vs `CART_NOT_OPEN`).
- `details` carries actionable data (requested vs available stock; order count vs next milestone).
- Malformed UUIDs return 404 instead of leaking a database error. 500s are logged and return no internals.

## 7. Implemented vs intentionally deferred

Implemented: everything in the brief (cart CRUD with validation, checkout, idempotent retries, order retrieval, milestone coupons, admin generation and report), plus `GET /products` and `GET /admin/coupons`, docs and executable examples.

Deferred:
- Authentication / authorization (admin routes are open, as allowed).
- Real payment flow (design described above).
- Stock reservation and cart expiry.
- Request fingerprinting for idempotency keys, and key expiry.
- Rate limiting, pagination, structured logging/metrics, migrations tool (single schema file + reset script).

## 8. Multiple instances and production scale

- The API is stateless; all coordination happens in Postgres (row locks, advisory lock, unique constraints). Running N app instances behind a load balancer works unchanged.
- Use a connection pooler (PgBouncer, transaction mode) and size pools per instance. Transactions are short and contain no network calls.
- Hot products: all checkouts for one product queue on one row. Options at higher scale: split stock into buckets, or reserve via a queue.
- Report: move to precomputed aggregates or a read replica as orders grow.
- Idempotency keys: add a TTL / cleanup job; scope keys per client once auth exists.
- Payments: pending-order + outbox pattern so external calls happen outside transactions and are retried safely.
- Replace `db:reset` with a migration tool.

## 9. How AI tools were used

I built this step by step with an AI assistant (Claude), one small step at a time, asking it to explain each file before moving on. I ran every step locally and committed in increments.

- **Resolving ambiguities:** the AI listed the ambiguities with options; I chose each one (all 12 listed in section 2) before any code was written.
- **Questioned the stack:** I asked why PostgreSQL rather than MongoDB. Instead of just accepting the default, this became an explicit decision with alternatives (section 3).
- **Redirected the approach:** early explanations were long and theoretical. I stopped and redirected to a practical method: the few lines that enforce each rule, plus something to run and see. This produced `requests.http` and the habit of testing every rule by hand.
- **Validated generated code instead of trusting it:** for each concurrency test, the protection was temporarily removed to confirm the test fails without it. This exposed a generated test that passed for the wrong reason: "failed checkout keeps the coupon" failed on stock *before* the coupon was ever touched, so it did not prove the rollback. The checkout order was changed to redeem the coupon first, and the test now fails if rollback is broken.

## 10. What I would examine first with two more hours

1. A pending-order payment flow with a fake gateway, to test "payment fails → stock and coupon released".
2. Fingerprinting the checkout request so a reused key with a different body returns 422.
3. A load test (k6) of many concurrent checkouts on one product, to measure lock contention and confirm no deadlocks.
4. Authentication for `/admin/*`.
