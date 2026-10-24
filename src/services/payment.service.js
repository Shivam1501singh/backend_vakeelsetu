import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { getRazorpayClient, isRazorpayConfigured } from '../config/razorpay.js';
import { getConsultancyPrice } from '../config/consultancyPricing.js';
import { addWorkingDays } from '../utils/workingDays.js';
import { createConsultancyWithUniqueBookingId, generateUniqueAdvocateBookingId } from '../utils/bookingId.util.js';
import { isSlotFree } from './advocateBooking/slotValidation.js';
import { logApiError } from './errorLogger.service.js';

/**
 * Verifies Razorpay Checkout signature using constant-time comparison.
 * Formula: HMAC_SHA256(order_id + "|" + payment_id, secret) === signature
 */
export const verifyCheckoutSignature = ({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) => {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return false;
  }
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;

  const generatedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  const generatedBuf = Buffer.from(generatedSignature, 'utf8');
  const signatureBuf = Buffer.from(razorpay_signature, 'utf8');

  if (generatedBuf.length !== signatureBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(generatedBuf, signatureBuf);
};

/**
 * Verifies Razorpay Webhook signature using constant-time comparison.
 * Formula: HMAC_SHA256(rawBody, webhookSecret) === x-razorpay-signature
 */
export const verifyWebhookSignature = ({ rawBody, signature }) => {
  if (!rawBody || !signature) {
    return false;
  }
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;

  const generatedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const generatedBuf = Buffer.from(generatedSignature, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');

  if (generatedBuf.length !== signatureBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(generatedBuf, signatureBuf);
};

/**
 * Maps Razorpay payment status string to PaymentAttemptStatus enum.
 */
const mapRazorpayAttemptStatus = (rzpStatus) => {
  switch (rzpStatus) {
    case 'captured':
      return 'CAPTURED';
    case 'authorized':
      return 'AUTHORIZED';
    case 'failed':
      return 'FAILED';
    case 'refunded':
      return 'REFUNDED';
    case 'created':
    default:
      return 'CREATED';
  }
};

/**
 * Formats a Payment record for client responses (adding rupee conversion and safe fields)
 */
export const formatPayment = (payment) => {
  if (!payment) return null;
  const capturedAttempt = Array.isArray(payment.attempts)
    ? payment.attempts.find(a => a.status === 'CAPTURED' || a.status === 'DUPLICATE_REFUNDED')
    : null;

  return {
    ...payment,
    amountRupees: payment.amount ? payment.amount / 100 : 0,
    razorpayPaymentId: capturedAttempt?.razorpayPaymentId || payment.attempts?.[0]?.razorpayPaymentId || null
  };
};

/**
 * Single source of truth for synchronizing payment state from Razorpay.
 * Idempotent, safe to call from verify API, webhook, or cron reconciler.
 * Uses DB row-level locking (SELECT ... FOR UPDATE) to serialize concurrent updates.
 *
 * @param {object} params
 * @param {string} [params.paymentId] - Internal Payment UUID
 * @param {string} [params.razorpayOrderId] - Razorpay Order ID (e.g. order_XXXX)
 * @returns {Promise<object>} The updated Payment record
 */
export const syncPaymentFromRazorpay = async ({ paymentId, razorpayOrderId }) => {
  const rzpClient = getRazorpayClient();
  if (!rzpClient) {
    const err = new Error('Payments are not configured.');
    err.statusCode = 503;
    throw err;
  }

  // 1. Locate the Payment row to identify orderId & paymentId
  const initialPayment = await prisma.payment.findFirst({
    where: {
      OR: [
        paymentId ? { id: paymentId } : undefined,
        razorpayOrderId ? { razorpayOrderId } : undefined
      ].filter(Boolean)
    }
  });

  if (!initialPayment) {
    const err = new Error('Payment not found.');
    err.statusCode = 404;
    throw err;
  }

  const orderId = initialPayment.razorpayOrderId;
  const pId = initialPayment.id;

  // 2. Fetch payments for this order from Razorpay
  let rzpPayments = [];
  try {
    const rzpPaymentsResponse = await rzpClient.orders.fetchPayments(orderId);
    rzpPayments = (rzpPaymentsResponse && rzpPaymentsResponse.items) || [];
  } catch (err) {
    console.error(`[Razorpay Sync] Failed to fetch payments for order ${orderId}:`, err.message);
  }

  // 3. Upsert all fetched Razorpay payment attempts in the database
  for (const p of rzpPayments) {
    const mappedStatus = mapRazorpayAttemptStatus(p.status);
    const capturedAt = p.captured && p.created_at ? new Date(p.created_at * 1000) : null;

    // Filter sensitive fields from raw entity if any
    const rawData = {
      id: p.id,
      entity: p.entity,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      method: p.method,
      order_id: p.order_id,
      description: p.description,
      error_code: p.error_code,
      error_description: p.error_description,
      created_at: p.created_at
    };

    await prisma.paymentAttempt.upsert({
      where: { razorpayPaymentId: p.id },
      update: {
        status: mappedStatus,
        amount: p.amount,
        method: p.method || null,
        errorCode: p.error_code || null,
        errorDescription: p.error_description || null,
        capturedAt: capturedAt || undefined,
        raw: rawData
      },
      create: {
        paymentId: pId,
        razorpayPaymentId: p.id,
        status: mappedStatus,
        amount: p.amount,
        method: p.method || null,
        errorCode: p.error_code || null,
        errorDescription: p.error_description || null,
        capturedAt,
        raw: rawData
      }
    });
  }

  // 4. Decide state inside a transactional row lock
  let txAttempts = 0;
  const maxTxRetries = 3;

  while (txAttempts < maxTxRetries) {
    try {
      await prisma.$transaction(
        async (tx) => {
      // Row lock on Payment
      const lockedRows = await tx.$queryRaw`
        SELECT * FROM "Payment"
        WHERE "id" = ${pId}
        FOR UPDATE
      `;
      const currentPayment = lockedRows[0];
      if (!currentPayment) return;

      // Fetch all attempts for this payment within transaction
      const attempts = await tx.paymentAttempt.findMany({
        where: { paymentId: pId },
        orderBy: { createdAt: 'asc' }
      });

      const capturedAttempts = attempts.filter(a => a.status === 'CAPTURED' || a.status === 'DUPLICATE_REFUNDED');
      const authorizedAttempts = attempts.filter(a => a.status === 'AUTHORIZED');
      const failedAttempts = attempts.filter(a => a.status === 'FAILED');

      const now = new Date();

      // Case A: At least one captured attempt exists
      if (capturedAttempts.length > 0) {
        // If Payment is not already PAID
        if (currentPayment.status !== 'PAID') {
          const firstCaptured = capturedAttempts[0];

          // Amount & currency verification
          if (firstCaptured.amount !== currentPayment.amount || currentPayment.currency !== 'INR') {
            // Amount mismatch -> FAILED, refund the attempt
            await tx.payment.update({
              where: { id: pId },
              data: {
                status: 'FAILED',
                failureReason: 'AMOUNT_MISMATCH'
              }
            });

            try {
              await rzpClient.payments.refund(firstCaptured.razorpayPaymentId, {
                amount: firstCaptured.amount,
                notes: { reason: 'AMOUNT_MISMATCH_REFUND' }
              });
            } catch (refundErr) {
              console.error('[Refund Error] Failed to refund mismatched payment:', refundErr.message);
            }

            logApiError(new Error(`Payment amount mismatch for payment ${pId}: expected ${currentPayment.amount}, got ${firstCaptured.amount}`));
            return;
          }

          // Valid captured payment: Branch on purpose
          const paidAtDate = firstCaptured.capturedAt || now;

          if (currentPayment.purpose === 'ADVOCATE_BOOKING') {
            const booking = await tx.advocateBooking.findUnique({
              where: { id: currentPayment.advocateBookingId }
            });

            if (!booking) {
              throw new Error(`AdvocateBooking ${currentPayment.advocateBookingId} not found for payment ${pId}`);
            }

            // Row lock on Advocate to serialize concurrent confirmations
            await tx.$queryRaw`
              SELECT id FROM "Advocate"
              WHERE id = ${booking.advocateId}
              FOR UPDATE
            `;

            // Re-check overlap for this booking, excluding itself
            const slotFree = await isSlotFree(booking.advocateId, booking.startAt, booking.endAt, tx, booking.id);

            if (slotFree) {
              const assignedBookingId = booking.bookingId || await generateUniqueAdvocateBookingId(tx, paidAtDate);

              await tx.advocateBooking.update({
                where: { id: booking.id },
                data: {
                  bookingId: assignedBookingId,
                  status: 'CONFIRMED',
                  confirmedAt: paidAtDate
                }
              });

              await tx.payment.update({
                where: { id: pId },
                data: {
                  status: 'PAID',
                  paidAt: paidAtDate,
                  refundEligibleAt: null,
                  failureReason: null
                }
              });
            } else {
              // Slot taken (e.g. hold expired and someone else booked before late payment cleared)
              console.warn(`[Late Payment Conflict] Slot was taken for booking ${booking.id}. Initiating auto-refund.`);
              await tx.advocateBooking.update({
                where: { id: booking.id },
                data: {
                  status: 'REFUND_PENDING',
                  refundReason: 'SLOT_CONFLICT_AFTER_EXPIRY'
                }
              });

              await tx.payment.update({
                where: { id: pId },
                data: {
                  status: 'FAILED',
                  failureReason: 'SLOT_CONFLICT_AFTER_EXPIRY'
                }
              });

              try {
                await rzpClient.payments.refund(firstCaptured.razorpayPaymentId, {
                  amount: firstCaptured.amount,
                  notes: { reason: 'SLOT_CONFLICT_AFTER_EXPIRY', advocateBookingId: booking.id }
                });
              } catch (refErr) {
                console.error('[Refund Error] Failed to auto-refund conflicted slot payment:', refErr.message);
              }
            }
          } else {
            // Existing CONSULTANCY branch (completely unchanged)
            const priceDecimal = Number(currentPayment.amount) / 100;
            const consultancy = await createConsultancyWithUniqueBookingId(
              tx,
              {
                userId: currentPayment.userId,
                callType: currentPayment.callType,
                duration: currentPayment.duration,
                price: priceDecimal,
                phoneNumber: currentPayment.phoneNumber,
                email: currentPayment.email,
                status: 'PENDING',
                completedAt: null
              },
              paidAtDate
            );
            const refundWorkingDays = parseInt(process.env.REFUND_WORKING_DAYS || '7', 10);
            const refundEligibleAt = addWorkingDays(paidAtDate, refundWorkingDays);

            await tx.payment.update({
              where: { id: pId },
              data: {
                status: 'PAID',
                consultancyRequestId: consultancy.id,
                paidAt: paidAtDate,
                refundEligibleAt,
                failureReason: null
              }
            });
          }
        }

        // Check for duplicate captured attempts
        // If there are multiple captured attempts, keep the first one and auto-refund the rest!
        if (capturedAttempts.length > 1) {
          const duplicateAttempts = capturedAttempts.slice(1);
          for (const dup of duplicateAttempts) {
            if (dup.status !== 'DUPLICATE_REFUNDED') {
              try {
                const refundRes = await rzpClient.payments.refund(dup.razorpayPaymentId, {
                  amount: dup.amount,
                  notes: { reason: 'DUPLICATE_PAYMENT_REFUND', paymentId: pId }
                });

                await tx.paymentAttempt.update({
                  where: { id: dup.id },
                  data: {
                    status: 'DUPLICATE_REFUNDED',
                    refundId: refundRes.id
                  }
                });
                console.log(`[Duplicate Refund] Refunded extra attempt ${dup.razorpayPaymentId}`);
              } catch (dupRefundErr) {
                console.error(`[Duplicate Refund Error] Could not auto-refund ${dup.razorpayPaymentId}:`, dupRefundErr.message);
              }
            }
          }
        }
        return;
      }

      // Case B: Authorized attempt exists (not captured)
      if (authorizedAttempts.length > 0 && currentPayment.status !== 'PAID') {
        const authAttempt = authorizedAttempts[0];
        try {
          const captureRes = await rzpClient.payments.capture(
            authAttempt.razorpayPaymentId,
            currentPayment.amount,
            'INR'
          );
          if (captureRes.status === 'captured') {
            await tx.paymentAttempt.update({
              where: { id: authAttempt.id },
              data: {
                status: 'CAPTURED',
                capturedAt: new Date()
              }
            });
            // Recursively re-run inside sync to complete the PAID transition
            return;
          }
        } catch (capErr) {
          console.error('[Capture attempt failed]:', capErr.message);
        }

        if (currentPayment.status === 'CREATED') {
          await tx.payment.update({
            where: { id: pId },
            data: { status: 'PROCESSING' }
          });
        }
        return;
      }

      // Case C: Only failed attempts
      if (
        failedAttempts.length > 0 &&
        capturedAttempts.length === 0 &&
        authorizedAttempts.length === 0 &&
        currentPayment.status !== 'PAID'
      ) {
        if (currentPayment.status !== 'FAILED') {
          const lastError = failedAttempts[failedAttempts.length - 1];
          await tx.payment.update({
            where: { id: pId },
            data: {
              status: 'FAILED',
              failureReason: lastError.errorDescription || 'Payment attempt failed'
            }
          });

          if (currentPayment.purpose === 'ADVOCATE_BOOKING' && currentPayment.advocateBookingId && now > currentPayment.expiresAt) {
            await tx.advocateBooking.update({
              where: { id: currentPayment.advocateBookingId },
              data: { status: 'EXPIRED' }
            });
          }
        }
        return;
      }

      // Case D: No attempts and checkout TTL expired
      if (attempts.length === 0 && currentPayment.status === 'CREATED' && now > currentPayment.expiresAt) {
        await tx.payment.update({
          where: { id: pId },
          data: { status: 'EXPIRED' }
        });

        if (currentPayment.purpose === 'ADVOCATE_BOOKING' && currentPayment.advocateBookingId) {
          await tx.advocateBooking.update({
            where: { id: currentPayment.advocateBookingId },
            data: { status: 'EXPIRED' }
          });
        }
      }
    },
    { timeout: 15000 }
  );
      break;
    } catch (txErr) {
      txAttempts++;
      const isBookingCollision =
        txErr?.code === 'P2002' &&
        (Array.isArray(txErr?.meta?.target)
          ? txErr.meta.target.includes('bookingId')
          : String(txErr?.meta?.target || '').includes('bookingId'));

      if (isBookingCollision && txAttempts < maxTxRetries) {
        console.warn(`[Razorpay Sync] bookingId collision on attempt ${txAttempts}, retrying transaction...`);
        continue;
      }
      throw txErr;
    }
  }

  // 5. Return fresh Payment with relations
  return await prisma.payment.findUnique({
    where: { id: pId },
    include: {
      attempts: { orderBy: { createdAt: 'desc' } },
      consultancyRequest: true,
      advocateBooking: true,
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true
        }
      }
    }
  });
};
