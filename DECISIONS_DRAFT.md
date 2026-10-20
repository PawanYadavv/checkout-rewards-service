# DECISIONS (draft)

Working notes; becomes DECISIONS.md in Step 10.

## System invariants

- **I1** Inventory never goes negative; initial stock = sold + remaining.
- **I2** A cart is checked out at most once (`open → checked_out`, never back); a checked-out cart cannot be edited.
- **I3** A retried checkout never creates a second order or charges inventory twice.
- **I4** Checkout is all-or-nothing: inventory, order, order items, coupon redemption and cart status commit together or not at all.
- **I5** An order is a self-contained snapshot (product name, unit price, quantity, line total, subtotal, discount, coupon, total).
- **I6** Money is integer paise; `0 ≤ discount ≤ subtotal`; `total = subtotal − discount ≥ 0`.
- **I7** A coupon is redeemed at most once, even under concurrent checkouts.
- **I8** A coupon is consumed only by a checkout that commits.
- **I9** At most one coupon per milestone, and only for milestones actually reached.
- **I10** Invalid products or quantities never enter a cart.
- **I11** The report is read-only and reconciles with orders and coupons (net = gross − discounts = Σ order totals; generated = available + redeemed).

---

## Decision: PostgreSQL (relational) instead of MongoDB or in-memory

**Context:** The hardest requirements are consistency under concurrent and retried requests: no oversell, one order per cart, one redemption per coupon.

**Options considered:** (a) PostgreSQL with plain SQL; (b) MongoDB; (c) in-memory store with locks.

**Choice:** (a) PostgreSQL 16, `pg` library, hand-written SQL.

**Why:** Multi-row ACID transactions are the default model; CHECK / UNIQUE / foreign-key constraints enforce invariants even if app code has a bug; the data is relational (carts → products, orders → coupons); conditional `UPDATE … WHERE inventory >= q` is atomic under row locks. MongoDB supports multi-document transactions but has weaker schema constraints. In-memory would not survive restarts or multiple app instances.

**Consequences:** Needs Docker for setup. Concurrency logic is visible in SQL and easy to explain.

## Decision: Price changes before checkout

**Context:** A product's price may change after it is added to a cart.

**Options considered:** (a) live price, snapshot at checkout; (b) lock price at add time; (c) live price + client-sent expected total, reject on mismatch.

**Choice:** (a) Cart stores only product + quantity. Cart view shows current prices. Checkout charges the current price and snapshots it into the order.

**Why:** Simplest model with no stale data; the order snapshot satisfies "explain what was purchased".

**Consequences:** Customer may pay a different price than first seen. (c) is a natural future addition.

## Decision: Availability changes before checkout

**Context:** Stock may drop after an item is added.

**Options considered:** (a) soft check on add, hard check at checkout, no reservation; (b) check only at checkout; (c) reserve stock in carts.

**Choice:** (a) Adding more than current stock is rejected. Checkout is the real gate: if any line cannot be fulfilled, the whole checkout fails with `409 INSUFFICIENT_STOCK` listing the products. No partial fulfilment.

**Why:** Early feedback for clients without reservation complexity (expiry jobs, locked stock in abandoned carts).

**Consequences:** A cart can become unfulfillable; the client must adjust it.

## Decision: Coupon ownership and milestones

**Context:** The brief has no customer identity.

**Options considered:** (a) store-wide milestones, bearer coupon codes; (b) coupon belongs to whoever placed the nth order.

**Choice:** (a) Every nth successfully placed order store-wide is a milestone. Coupons are codes usable once by anyone. All successful orders count, including those that used a coupon.

**Why:** Matches the brief without inventing a user model.

**Consequences:** Codes are shareable. Per-customer coupons would need auth/identity.

## Decision: Coupon generation with several pending milestones

**Context:** E.g. n = 5, 12 orders, no coupons: milestones 5 and 10 are unrewarded.

**Options considered:** (a) one coupon per admin request, oldest milestone first; (b) generate all pending in one call; (c) auto-generate during checkout.

**Choice:** (a) Each call rewards the oldest unrewarded milestone; when none is eligible, `409 NO_ELIGIBLE_MILESTONE`.

**Why:** One clear outcome per call; keeps checkout path free of extra work. Brief says the admin *requests* generation.

**Consequences:** Admin may need repeated calls to catch up.

## Decision: Coupon value, expiry and rules

**Context:** x may change; brief does not specify expiry or stacking.

**Options considered:** (a) coupon stores its own `percent_off` copied from x at generation; (b) read x at redemption time.

**Choice:** (a) No expiry, no minimum order, at most one coupon per checkout. n and x come from env config.

**Why:** Issued coupons stay deterministic when config changes.

**Consequences:** Changing x affects only future coupons.

## Decision: Discount rounding

**Context:** x% of a paise amount is often fractional.

**Options considered:** (a) floor; (b) round half up; (c) banker's rounding.

**Choice:** (a) `discount = min(subtotal, floor(subtotal × x / 100))` using integer math only.

**Why:** Deterministic, simple, never over-discounts, never negative total.

**Consequences:** Customer may get up to 1 paisa less than the exact percentage.

## Decision: Invalid or used coupon at checkout

**Context:** Client supplies a coupon that does not exist or is already redeemed.

**Options considered:** (a) reject the whole checkout; (b) ignore coupon, charge full price.

**Choice:** (a) `404 COUPON_NOT_FOUND` or `409 COUPON_ALREADY_REDEEMED`; nothing changes.

**Why:** Never charge an amount the customer did not expect; errors stay visible.

**Consequences:** Client must retry without the coupon.

## Decision: Checkout idempotency

**Context:** Clients retry checkout after timeouts; a retry must not create a second order or charge inventory twice.

**Options considered:** (a) required `Idempotency-Key` header stored with a UNIQUE constraint, bound to the cart; (b) optional header, cart as natural key; (c) optional header + cart backstop.

**Choice:** (a)
- Same key + same cart → original order, no new side effects; response is the same 201 body plus `Idempotent-Replayed: true`.
- Same key + different cart → `422 IDEMPOTENCY_KEY_REUSED`.
- New key on checked-out cart → `409 CART_NOT_OPEN` (same code as editing a checked-out cart).
- The key is inserted inside the checkout transaction, so failed checkouts are not remembered and can be retried with the same key.

**Why:** Distinguishes a genuine retry from a conflicting request; the DB unique constraint handles concurrent duplicates.

**Consequences:** Clients must send a key. `UNIQUE(cart_id)` on orders remains a backstop.

## Decision: Where the idempotency key is stored

**Context:** Decision above needs the key stored with a UNIQUE constraint.

**Options considered:** (a) separate `idempotency_keys` table storing the response body; (b) `orders.idempotency_key NOT NULL UNIQUE`, response rebuilt from the order.

**Choice:** (b)

**Why:** Only successful checkouts are remembered, and each one is exactly one order, so a separate table adds nothing. Rebuilding the response from the stored order is deterministic.

**Consequences:** Fewer tables. If we later wanted to replay failures too, we would need (a).

## Decision: Inventory concurrency technique

**Context:** Concurrent checkouts must not oversell.

**Options considered:** (a) conditional atomic `UPDATE … WHERE inventory >= q`; (b) `SELECT … FOR UPDATE` + check in app code; (c) SERIALIZABLE with retries.

**Choice:** (a) Under READ COMMITTED; products updated in ID order to avoid deadlocks; cart row locked with `SELECT … FOR UPDATE` to serialize checkouts of the same cart. 0 rows updated → rollback, `409 INSUFFICIENT_STOCK`.

**Why:** Short, visible, correct, and easy to explain/debug.

**Consequences:** Relies on row locks in one Postgres instance, which still works with many app instances.

## Decision: Payment

**Context:** No real payment integration required.

**Options considered:** (a) committed checkout = payment success; (b) fake `PaymentGateway`.

**Choice:** (a) Document how a real gateway would change the flow (pending order → charge outside the transaction → confirm or release).

**Why:** Keeps focus on invariants; a fake gateway inside the transaction would model a bad pattern.

**Consequences:** No payment-failure path to test; documented as deferred.

## Decision: Cart item editing rules

**Context:** Semantics for duplicate adds, quantity 0 and edits after checkout.

**Options considered:** (a) add merges, PATCH sets, 0 rejected; (b) duplicate add → 409; (c) PATCH 0 removes.

**Choice:** (a) `POST` with an existing product adds to quantity; `PATCH` sets absolute quantity; quantity is an integer 1–100; remove via `DELETE`; edits on a checked-out cart → `409 CART_NOT_OPEN`.

**Why:** One way to do each thing.

**Consequences:** Clients need DELETE to remove items.

## Decision: Error model

**Context:** Clients must be able to tell errors apart and react correctly (fix input, retry, give up).

**Options considered:** (a) HTTP status only; (b) status + free-text message; (c) status + stable machine-readable `code` + message + optional `details`.

**Choice:** (c) `{ "error": { "code", "message", "details?" } }` from one central error handler. Status rules: 400 bad input, 404 missing resource, 409 conflicts with current state (stock, cart already checked out, coupon used), 422 idempotency key reused with a different cart, 500 unexpected (logged, no internals leaked).

**Why:** Several different failures share a status (e.g. many 409s); the `code` tells them apart. One handler keeps the format identical everywhere.

**Consequences:** Error codes are part of the API contract and must be documented in the README.

## Decision: IDs and admin endpoints

**Context:** No authentication.

**Options considered:** (a) UUIDs for carts/orders, readable product IDs, random coupon codes, `/admin/*` routes; (b) serial integers everywhere.

**Choice:** (a) e.g. `p_keyboard`, `SAVE-7KQ2M9`. Admin routes are unauthenticated but clearly marked as administrative.

**Why:** Unguessable cart/order IDs without auth; readable seeds and curl examples.

**Consequences:** Real deployment needs auth on `/admin/*`.

## Decision: Idempotency lookup happens after the cart lock

**Context:** Two retries with the same key can arrive at the same moment.

**Options considered:** (a) look up the key before locking; (b) lock the cart first, then look up the key.

**Choice:** (b) `lockCart` → look up order by key → only then check the cart is open.

**Why:** With (a), both retries see "no order yet"; the second then waits on the lock and gets `409 CART_NOT_OPEN` instead of its order. With (b), the second waits, then finds the order the first one committed and replays it. Same key on two *different* carts at the same moment is caught by `UNIQUE(idempotency_key)` and mapped to 422.

**Consequences:** The request body is not fingerprinted: a retry with the same key but a different coupon gets the original order back. Acceptable because the key means "same attempt"; documented.

## Decision: Milestone counting and concurrent coupon generation

**Context:** Two admins may request generation at the same moment; n may be changed by config.

**Options considered:** (a) next milestone = smallest unrewarded multiple of n; (b) next milestone = last rewarded milestone + n. For concurrency: (i) rely on `UNIQUE(milestone)` and map the error; (ii) serialize generation with `pg_advisory_xact_lock`.

**Choice:** (b) + (ii), with `UNIQUE(milestone)` as backup.

**Why:** (b) stays sensible when n changes live ("n more orders since the last reward"). The advisory lock makes the second admin wait and then see the first coupon, giving a clean 409 instead of a constraint error.

**Consequences:** Generation is serialized (fine: rare admin action). Changing n affects only future milestones.

## Decision: Coupon redeemed early in the checkout transaction

**Context:** A coupon must not be lost by a checkout that fails, and must not be used twice concurrently.

**Options considered:** (a) check the coupon, redeem after the order is saved; (b) redeem with a conditional `UPDATE … WHERE redeemed_at IS NULL` inside the checkout transaction.

**Choice:** (b), done right after locking the cart, before taking stock.

**Why:** The conditional UPDATE is atomic: a second checkout waits on the row lock and then sees it redeemed (409). Any later failure (e.g. out of stock) rolls back the redemption. Lock order is always cart → coupon → products, so no deadlocks.

**Consequences:** Tests prove both concurrent-use and failed-checkout cases.
