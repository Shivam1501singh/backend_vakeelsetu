import prisma from '../lib/prisma.js';
import { syncPaymentFromRazorpay } from '../services/payment.service.js';
import { getRazorpayClient } from '../config/razorpay.js';

/**
 * Validates the Vercel Cron Bearer secret
 */
const validateCronSecret = (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.warn('[Cron Auth Warning] CRON_SECRET is not set in environment.');
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ success: false, message: 'Unauthorized: Invalid cron secret' });
    return false;
  }
  return true;
};

/**
 * Cron: Reconcile stalled or pending payments
 * GET /api/internal/cron/payments-reconcile
 */
export const reconcilePaymentsCron = async (req, res) => {
  if (!validateCronSecret(req, res)) return;

  try {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const now = new Date();

    // Find pending/stalled payments older than 2 minutes (batch of 50)
    const pendingPayments = await prisma.payment.findMany({
      where: {
        status: { in: ['CREATED', 'PROCESSING', 'REFUND_PENDING'] },
        updatedAt: { lte: twoMinutesAgo }
      },
      take: 50,
      orderBy: { updatedAt: 'asc' }
    });

    let reconciledCount = 0;
    const errors = [];

    for (const payment of pendingPayments) {
      try {
        await syncPaymentFromRazorpay({ paymentId: payment.id });
        reconciledCount++;
      } catch (err) {
        errors.push({ paymentId: payment.id, error: err.message });
      }
    }

    // Expire orders with no attempts past expiresAt
    const expiredResult = await prisma.payment.updateMany({
      where: {
        status: 'CREATED',
        expiresAt: { lte: now },
        attempts: { none: {} }
      },
      data: { status: 'EXPIRED' }
    });

    return res.status(200).json({
      success: true,
      reconciledCount,
      expiredCount: expiredResult.count,
      errors
    });
  } catch (error) {
    console.error('[Reconcile Cron Error]:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reconcile payments',
      error: error.message
    });
  }
};

/**
 * Cron: Identify and optionally auto-refund SLA breached consultancies
 * GET /api/internal/cron/refund-eligibility
 */
export const refundEligibilityCron = async (req, res) => {
  if (!validateCronSecret(req, res)) return;

  try {
    const now = new Date();
    const autoRefundEnabled = process.env.AUTO_REFUND_ENABLED === 'true';

    // Find PAID payments that breached SLA and have not been completed
    const eligiblePayments = await prisma.payment.findMany({
      where: {
        status: 'PAID',
        refundEligibleAt: { lte: now },
        consultancyRequest: {
          status: { not: 'COMPLETED' }
        }
      },
      include: {
        attempts: {
          where: { status: 'CAPTURED' },
          take: 1
        }
      }
    });

    let autoRefundsExecuted = 0;
    const errors = [];

    if (autoRefundEnabled && eligiblePayments.length > 0) {
      const rzpClient = getRazorpayClient();

      for (const payment of eligiblePayments) {
        const attempt = payment.attempts[0];
        if (!attempt) continue;

        try {
          const rzpRefund = await rzpClient.payments.refund(attempt.razorpayPaymentId, {
            amount: payment.amount,
            notes: { reason: 'SLA_BREACH_AUTO_REFUND' }
          });

          const isProcessed = rzpRefund.status === 'processed';

          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              status: isProcessed ? 'REFUNDED' : 'REFUND_PENDING',
              refundId: rzpRefund.id,
              refundReason: 'SLA_BREACH_AUTO_REFUND',
              refundedById: 'SYSTEM_CRON',
              refundedByType: 'CRON',
              refundedAt: isProcessed ? new Date() : null
            }
          });

          if (isProcessed && payment.consultancyRequestId) {
            await prisma.consultancyRequest.update({
              where: { id: payment.consultancyRequestId },
              data: { status: 'REFUNDED' }
            });
          }

          autoRefundsExecuted++;
        } catch (refErr) {
          errors.push({ paymentId: payment.id, error: refErr.message });
        }
      }
    }

    return res.status(200).json({
      success: true,
      eligiblePaymentsFound: eligiblePayments.length,
      autoRefundsExecuted,
      autoRefundEnabled,
      errors
    });
  } catch (error) {
    console.error('[Refund Eligibility Cron Error]:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process refund eligibility',
      error: error.message
    });
  }
};
