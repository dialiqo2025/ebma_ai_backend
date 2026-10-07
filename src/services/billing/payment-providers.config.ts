export type PaymentGateway = "razorpay" | "stripe";

const RAZORPAY_ALLOWED = new Set([
  "upi",
  "card",
  "netbanking",
  "wallet",
  "emi",
  "paylater",
]);

const STRIPE_ALLOWED = new Set([
  "card",
  "upi",
  "netbanking",
  "customer_balance",
  "link",
]);

const parseList = (raw: string | undefined, fallback: string[]) => {
  const parts = String(raw || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? parts : fallback;
};

/** Instruments enabled on Razorpay hosted checkout (Payment Link). */
export const razorpayPaymentMethods = () => {
  const methods = parseList(process.env.RAZORPAY_PAYMENT_METHODS, [
    "upi",
    "card",
    "netbanking",
  ]).filter((m) => RAZORPAY_ALLOWED.has(m));
  return methods.length ? methods : ["upi", "card", "netbanking"];
};

/** Stripe Checkout `payment_method_types`. */
export const stripePaymentMethodTypes = () => {
  const methods = parseList(process.env.STRIPE_PAYMENT_METHOD_TYPES, ["card"]).filter(
    (m) => STRIPE_ALLOWED.has(m),
  );
  return methods.length ? methods : ["card"];
};

/** Razorpay Payment Link `options.checkout.method` flags. */
export const razorpayCheckoutMethodFlags = () => {
  const enabled = new Set(razorpayPaymentMethods());
  return {
    upi: enabled.has("upi"),
    card: enabled.has("card"),
    netbanking: enabled.has("netbanking"),
    wallet: enabled.has("wallet"),
    emi: enabled.has("emi"),
    paylater: enabled.has("paylater"),
  };
};

export const paymentProviderCapabilities = () => ({
  stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY?.trim()),
  razorpayConfigured: Boolean(
    process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim(),
  ),
  razorpay: {
    methods: razorpayPaymentMethods(),
  },
  stripe: {
    methods: stripePaymentMethodTypes(),
  },
});
