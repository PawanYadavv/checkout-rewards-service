-- Prices in paise: 249900 = ₹2,499.00
INSERT INTO products (id, name, price_paise, inventory) VALUES
  ('p_keyboard', 'Mechanical Keyboard', 249900, 50),
  ('p_mouse',    'Wireless Mouse',       99900, 100),
  ('p_monitor',  '27" Monitor',        1899900, 20),
  ('p_cable',    'USB-C Cable',          29999, 200),
  ('p_headset',  'Gaming Headset',      449900, 30),
  ('p_lamp',     'Limited Edition Desk Lamp', 199900, 2); -- low stock, for oversell tests
