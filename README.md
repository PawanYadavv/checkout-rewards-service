# Checkout and Rewards Service

Backend for an ecommerce store: carts, checkout, orders, milestone discount coupons and an admin report.
Focus: correct behaviour under **concurrent and retried requests** (no oversell, no double orders, no double coupon use).

- Stack: Node.js 20, TypeScript, Express 5, PostgreSQL 16 (plain `pg`, hand-written SQL), Vitest + Supertest
- Design reasoning: see [DECISIONS.md](DECISIONS.md)
- Clickable API examples: [requests.http](requests.http) (VS Code "REST Client" extension)

## Setup and run

Requirements: Node.js 20+, Docker.

```bash
npm install
docker compose up -d        # Postgres 16 on localhost:5433
npm run db:reset            # create tables + seed 6 products (drops existing data)
npm run dev                 # API on http://localhost:3000
```

Run the tests (Postgres must be running; tests reset the database):

```bash
npm test
```

Configuration (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `COUPON_EVERY_N_ORDERS` | `5` | n: every n successfully placed orders, one coupon may be generated |
| `COUPON_PERCENT_OFF` | `10` | x: percent off for newly generated coupons |
| `DATABASE_URL` | `postgres://app:app@localhost:5433/checkout` | Postgres connection |
| `PORT` | `3000` | HTTP port |

## Conventions

- **Money** is always an integer in **paise** (`249900` = ₹2,499.00). No floats.
- **IDs**: carts and orders are UUIDs; products are readable strings (`p_mouse`).
- **Errors** always have this shape, and clients should branch on `code`:
  ```json
  { "error": { "code": "INSUFFICIENT_STOCK", "message": "Not enough stock for some items", "details": [ ... ] } }
  ```
- **Admin** endpoints are under `/admin/*`. They have no authentication (allowed by the brief) and are clearly administrative.

## API

### Products
| Method | Path | Success | Notes |
|---|---|---|---|
| GET | `/products` | 200 | List of `{ id, name, pricePaise, inventory }` |

### Carts
| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/carts` | — | 201 cart | — |
| GET | `/carts/:cartId` | — | 200 cart | 404 `CART_NOT_FOUND` |
| POST | `/carts/:cartId/items` | `{ "productId": "p_mouse", "quantity": 2 }` | 200 cart | 400 `VALIDATION_ERROR`, 404 `CART_NOT_FOUND` / `PRODUCT_NOT_FOUND`, 409 `INSUFFICIENT_STOCK` / `CART_NOT_OPEN` |
| PATCH | `/carts/:cartId/items/:productId` | `{ "quantity": 5 }` | 200 cart | 400 `VALIDATION_ERROR`, 404 `ITEM_NOT_IN_CART`, 409 `INSUFFICIENT_STOCK` / `CART_NOT_OPEN` |
| DELETE | `/carts/:cartId/items/:productId` | — | 200 cart | 404 `ITEM_NOT_IN_CART`, 409 `CART_NOT_OPEN` |

Rules: `quantity` is an integer 1–100. Adding a product already in the cart **adds** to its quantity; PATCH **sets** it.
The cart shows **current** prices; the price is fixed into the order at checkout.

Cart response:
```json
{
  "id": "3f2a…", "status": "open",
  "items": [ { "productId": "p_mouse", "name": "Wireless Mouse", "unitPricePaise": 99900,
               "quantity": 2, "lineTotalPaise": 199800, "availableInventory": 100 } ],
  "subtotalPaise": 199800
}
```

### Checkout and orders
| Method | Path | Headers / body | Success | Errors |
|---|---|---|---|---|
| POST | `/carts/:cartId/checkout` | header `Idempotency-Key` (required); body `{ "couponCode": "SAVE-7KQ2M9" }` (optional) | 201 order | see below |
| GET | `/orders/:orderId` | — | 200 order | 404 `ORDER_NOT_FOUND` |

Checkout errors:

| Status | Code | When |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | header missing or longer than 255 chars |
| 400 | `VALIDATION_ERROR` | `couponCode` is not a non-empty string |
| 404 | `CART_NOT_FOUND` / `COUPON_NOT_FOUND` | unknown cart / coupon |
| 409 | `CART_EMPTY` | nothing to buy |
| 409 | `CART_NOT_OPEN` | cart already checked out (with a different key) |
| 409 | `INSUFFICIENT_STOCK` | any line cannot be fulfilled; `details` lists `{ productId, requested, available }`. Nothing is changed. |
| 409 | `COUPON_ALREADY_REDEEMED` | coupon used by another order |
| 422 | `IDEMPOTENCY_KEY_REUSED` | this key already placed an order for a **different** cart |

**Retries:** sending the same `Idempotency-Key` for the same cart again returns the **same order** (201, same body) with header
`Idempotent-Replayed: true`. No second order, no extra stock taken. A failed checkout is not remembered, so the client
can fix the cart and retry with the same key.

Order response:
```json
{
  "id": "9b1c…", "cartId": "3f2a…",
  "items": [ { "productId": "p_cable", "name": "USB-C Cable", "unitPricePaise": 29999, "quantity": 1, "lineTotalPaise": 29999 } ],
  "subtotalPaise": 29999, "couponCode": "SAVE-7KQ2M9", "discountPaise": 2999, "totalPaise": 27000,
  "createdAt": "2026-10-20T09:00:00.000Z"
}
```

### Admin
| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/admin/coupons` | 201 `{ code, milestone, percentOff, createdAt }` | 409 `NO_ELIGIBLE_MILESTONE` (`details: { orderCount, nextMilestone }`) |
| GET | `/admin/coupons` | 200 list with `status: available \| redeemed` | — |
| GET | `/admin/report` | 200 report | — |

Report response:
```json
{
  "totalOrders": 6,
  "grossRevenuePaise": 849295,
  "totalDiscountPaise": 19980,
  "netRevenuePaise": 829315,
  "coupons": { "generated": 1, "available": 0, "redeemed": 1 },
  "quantitySoldByProduct": [ { "productId": "p_cable", "name": "USB-C Cable", "quantity": 5 } ]
}
```

### Other errors
| Status | Code | When |
|---|---|---|
| 400 | `INVALID_JSON` | request body is not valid JSON |
| 404 | `NOT_FOUND` | unknown route |
| 500 | `INTERNAL_ERROR` | unexpected failure (logged server-side; no internals returned) |

## curl walkthrough

```bash
B=http://localhost:3000
curl -s $B/products

CART=$(curl -s -X POST $B/carts | sed 's/.*"id":"\([^"]*\)".*/\1/')
curl -s -X POST $B/carts/$CART/items -H 'Content-Type: application/json' -d '{"productId":"p_mouse","quantity":2}'
curl -s -X PATCH $B/carts/$CART/items/p_mouse -H 'Content-Type: application/json' -d '{"quantity":3}'
curl -s $B/carts/$CART

# Checkout, then retry with the same key: same order, header Idempotent-Replayed: true
curl -s -i -X POST $B/carts/$CART/checkout -H 'Idempotency-Key: demo-1'
curl -s -i -X POST $B/carts/$CART/checkout -H 'Idempotency-Key: demo-1'

# Admin
curl -s -X POST $B/admin/coupons          # 409 until 5 orders exist
curl -s $B/admin/coupons
curl -s $B/admin/report

# Checkout with a coupon (new cart)
curl -s -X POST $B/carts/$CART2/checkout -H 'Idempotency-Key: demo-2' \
  -H 'Content-Type: application/json' -d '{"couponCode":"SAVE-XXXXXX"}'
```

## Project layout

```
sql/schema.sql        tables + constraints (the database enforces the invariants too)
sql/seed.sql          6 products; p_lamp has only 2 in stock
src/app.ts            routes wiring, /health, /products
src/db.ts             pool + withTransaction (BEGIN / COMMIT / ROLLBACK)
src/cart.ts           cart lock, stock pre-check, cart view
src/checkout.ts       the checkout transaction
src/coupons.ts        coupon generation, redemption, discount math
src/report.ts         admin report (read-only snapshot)
src/order.ts          order view (from the stored snapshot)
src/errors.ts         AppError + central JSON error handler
src/routes/*.ts       HTTP endpoints
test/*.test.ts        business-rule and concurrency tests
```

## Status

All features in the brief are implemented. What was intentionally deferred is listed in [DECISIONS.md](DECISIONS.md).

Approximate time spent: 7.5 hours over 2 days
