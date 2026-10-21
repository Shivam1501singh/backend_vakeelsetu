import assert from 'assert';
import crypto from 'crypto';
import { verifyCheckoutSignature, verifyWebhookSignature } from '../src/services/payment.service.js';

console.log('--- Testing Signature Verification Helpers ---');

const TEST_SECRET = 'rzp_test_secret_key_12345';
const TEST_WEBHOOK_SECRET = 'rzp_test_webhook_secret_67890';

process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

// 1. Checkout Signature Verification
{
  const orderId = 'order_test_12345';
  const paymentId = 'pay_test_67890';
  const validSignature = crypto
    .createHmac('sha256', TEST_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  // Case 1a: Valid checkout signature
  const resValid = verifyCheckoutSignature({
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: validSignature
  });
  assert.strictEqual(resValid, true, 'Valid checkout signature should return true');
  console.log('  [PASS] Valid checkout signature verified');

  // Case 1b: Tampered signature
  const resTampered = verifyCheckoutSignature({
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: 'invalid_tampered_signature_hex'
  });
  assert.strictEqual(resTampered, false, 'Tampered checkout signature should return false');
  console.log('  [PASS] Tampered checkout signature rejected');

  // Case 1c: Missing arguments
  const resMissing = verifyCheckoutSignature({
    razorpay_order_id: orderId,
    razorpay_payment_id: '',
    razorpay_signature: validSignature
  });
  assert.strictEqual(resMissing, false, 'Missing payment_id should return false');
  console.log('  [PASS] Missing parameters rejected');
}

// 2. Webhook Signature Verification
{
  const payloadObject = {
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_123' } } }
  };
  const rawBody = Buffer.from(JSON.stringify(payloadObject), 'utf8');

  const validWebhookSig = crypto
    .createHmac('sha256', TEST_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  // Case 2a: Valid webhook signature
  const resWebValid = verifyWebhookSignature({
    rawBody,
    signature: validWebhookSig
  });
  assert.strictEqual(resWebValid, true, 'Valid webhook signature should return true');
  console.log('  [PASS] Valid webhook signature verified');

  // Case 2b: Tampered body
  const tamperedRawBody = Buffer.from(JSON.stringify({ ...payloadObject, tampered: true }), 'utf8');
  const resWebTampered = verifyWebhookSignature({
    rawBody: tamperedRawBody,
    signature: validWebhookSig
  });
  assert.strictEqual(resWebTampered, false, 'Tampered webhook body should return false');
  console.log('  [PASS] Tampered webhook body rejected');

  // Case 2c: Invalid signature string
  const resWebBadSig = verifyWebhookSignature({
    rawBody,
    signature: 'bad_signature_hex'
  });
  assert.strictEqual(resWebBadSig, false, 'Bad signature should return false');
  console.log('  [PASS] Bad signature string rejected');
}

console.log('All signature tests passed successfully!');
