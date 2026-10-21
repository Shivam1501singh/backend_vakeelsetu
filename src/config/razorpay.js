import Razorpay from 'razorpay';

let razorpayInstance = null;

/**
 * Returns true if Razorpay credentials and configuration are present.
 */
export const isRazorpayConfigured = () => {
  return Boolean(
    process.env.RAZORPAY_KEY_ID &&
    process.env.RAZORPAY_KEY_SECRET
  );
};

/**
 * Returns true if payment feature is turned on in environment.
 */
export const isPaymentsEnabled = () => {
  return process.env.PAYMENTS_ENABLED === 'true';
};

/**
 * Lazily creates and returns the singleton Razorpay instance.
 * Returns null if credentials are not configured.
 */
export const getRazorpayClient = () => {
  if (!isRazorpayConfigured()) {
    return null;
  }

  if (!razorpayInstance) {
    razorpayInstance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
  }

  return razorpayInstance;
};

/**
 * Convenience helper to get the public Razorpay Key ID
 */
export const getRazorpayKeyId = () => {
  return process.env.RAZORPAY_KEY_ID || null;
};
