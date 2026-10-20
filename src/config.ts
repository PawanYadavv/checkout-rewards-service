// Business rule: every N successfully placed orders, the admin may generate one coupon for X% off.
// Change these with env vars, e.g. COUPON_EVERY_N_ORDERS=3 COUPON_PERCENT_OFF=20 npm run dev
export const config = {
  couponEveryNOrders: Number(process.env.COUPON_EVERY_N_ORDERS ?? 5),
  couponPercentOff: Number(process.env.COUPON_PERCENT_OFF ?? 10),
};

if (!Number.isInteger(config.couponEveryNOrders) || config.couponEveryNOrders < 1) {
  throw new Error("COUPON_EVERY_N_ORDERS must be a positive integer");
}
if (!Number.isInteger(config.couponPercentOff) || config.couponPercentOff < 1 || config.couponPercentOff > 100) {
  throw new Error("COUPON_PERCENT_OFF must be an integer from 1 to 100");
}
