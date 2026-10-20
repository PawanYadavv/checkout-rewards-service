-- All money is integer paise. CHECK constraints are the last line of defence:
-- even buggy app code cannot store a negative stock or a wrong total.

CREATE TABLE products (
  id          text    PRIMARY KEY,
  name        text    NOT NULL,
  price_paise integer NOT NULL CHECK (price_paise > 0),
  inventory   integer NOT NULL CHECK (inventory >= 0)
);

CREATE TABLE carts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  status     text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  cart_id    uuid    NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id text    NOT NULL REFERENCES products(id),
  quantity   integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  PRIMARY KEY (cart_id, product_id) -- one row per product per cart
);

CREATE TABLE coupons (
  code        text        PRIMARY KEY,
  milestone   integer     NOT NULL UNIQUE CHECK (milestone > 0), -- e.g. 5, 10, 15: one coupon per milestone
  percent_off integer     NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
  redeemed_at timestamptz,                                       -- NULL = still available
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id         uuid        NOT NULL UNIQUE REFERENCES carts(id),    -- one order per cart
  idempotency_key text        NOT NULL UNIQUE,                         -- one order per key
  coupon_code     text        UNIQUE REFERENCES coupons(code),         -- a coupon used by at most one order
  subtotal_paise  integer     NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise  integer     NOT NULL CHECK (discount_paise >= 0),
  total_paise     integer     NOT NULL CHECK (total_paise >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_paise <= subtotal_paise),
  CHECK (total_paise = subtotal_paise - discount_paise)
);



-- Snapshot of what was bought: name and price copied at checkout time.
CREATE TABLE order_items (
  order_id         uuid    NOT NULL REFERENCES orders(id),
  product_id       text    NOT NULL REFERENCES products(id),
  product_name     text    NOT NULL,
  unit_price_paise integer NOT NULL CHECK (unit_price_paise > 0),
  quantity         integer NOT NULL CHECK (quantity > 0),
  line_total_paise integer NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CHECK (line_total_paise = unit_price_paise * quantity)
);
