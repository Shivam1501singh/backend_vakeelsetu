import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { verifyWebhookSignature, syncPaymentFromRazorpay } from '../services/payment.service.js';

/**
 * Public Webhook endpoint for Razorpay events
 * POST /api/payments/razorpay/webhook
 *
 * NOTE: Must receive raw binary buffer (express.raw({ type: 'application/json' }))
 */
export const handleRazorpayWebhook = async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body; // Buffer from express.raw()

  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    console.error('[Razorpay Webhook] Received non-buffer or empty body');
    return res.status(400).json({ success: false, message: 'Invalid request body' });
  }

  const isValid = verifyWebhookSignature({ rawBody, signature });
  if (!isValid) {
    console.warn('[Razorpay Webhook] Invalid webhook signature detected');
    return res.status(400).json({ success: false, message: 'Invalid webhook signature.' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('[Razorpay Webhook] Failed to parse JSON payload:', err.message);
    return res.status(400).json({ success: false, message: 'Invalid JSON payload' });
  }

  const headerEventId = req.headers['x-razorpay-event-id'];
  const eventId = headerEventId || crypto.createHash('sha256').update(rawBody).digest('hex');
  const eventName = payload.event || 'unknown';

  // Idempotency: Check if this webhook event was already recorded
  const existingEvent = await prisma.paymentWebhookEvent.findUnique({
    where: { eventId }
  });

  if (existingEvent) {
    // Already received; return 200 immediately to prevent Razorpay retries
    return res.status(200).json({ received: true, duplicate: true });
  }

  // Record the incoming event in DB
  const webhookRecord = await prisma.paymentWebhookEvent.create({
    data: {
      eventId,
      event: eventName,
      payload
    }
  });

  // Respond 200 to Razorpay immediately, process asynchronously
  res.status(200).json({ received: true });

  try {
    switch (eventName) {
      case 'payment.authorized':
      case 'payment.captured':
      case 'payment.failed':
      case 'order.paid': {
        const orderId =
          payload.payload?.payment?.entity?.order_id ||
          payload.payload?.order?.entity?.id;

        if (orderId) {
          await syncPaymentFromRazorpay({ razorpayOrderId: orderId });
        }
        break;
      }

      case 'refund.processed': {
        const refundEntity = payload.payload?.refund?.entity;
        const paymentEntity = payload.payload?.payment?.entity;
        const orderId = paymentEntity?.order_id;
        const paymentId = paymentEntity?.id;

        if (orderId) {
          const payment = await prisma.payment.findUnique({
            where: { razorpayOrderId: orderId }
          });

          if (payment) {
            await prisma.payment.update({
              where: { id: payment.id },
              data: {
                status: 'REFUNDED',
                refundId: refundEntity?.id || payment.refundId,
                refundedAt: new Date()
              }
            });

            if (payment.consultancyRequestId) {
              await prisma.consultancyRequest.update({
                where: { id: payment.consultancyRequestId },
                data: { status: 'REFUNDED' }
              });
            }

            if (payment.advocateBookingId) {
              await prisma.advocateBooking.update({
                where: { id: payment.advocateBookingId },
                data: {
                  status: 'REFUNDED',
                  refundedAt: new Date()
                }
              });
            }
          }
        }

        if (paymentId) {
          await prisma.paymentAttempt.updateMany({
            where: { razorpayPaymentId: paymentId },
            data: {
              status: 'REFUNDED',
              refundId: refundEntity?.id
            }
          });
        }
        break;
      }

      case 'refund.failed': {
        console.warn(`[Razorpay Webhook] Refund failed: ${payload.payload?.refund?.entity?.id}`);
        break;
      }

      default:
        // Other events logged and ignored
        break;
    }

    await prisma.paymentWebhookEvent.update({
      where: { id: webhookRecord.id },
      data: { processedAt: new Date() }
    });
  } catch (procErr) {
    console.error(`[Razorpay Webhook Processing Error] Event ${eventId}:`, procErr);
    await prisma.paymentWebhookEvent.update({
      where: { id: webhookRecord.id },
      data: { error: procErr.message || String(procErr) }
    });
  }
};
