import prisma from '../lib/prisma.js';
import { syncPaymentFromRazorpay } from '../services/payment.service.js';
import { getRazorpayClient } from '../config/razorpay.js';
import {
  sendAdvocateBookingConfirmationEmails,
  sendConsultancyConfirmationEmail,
  sendTestResponseSheetEmail,
  sendHelpRequestAcknowledgementEmail
} from '../services/email.service.js';
import { processTestCronJobs } from '../services/advocateTest.service.js';

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
    const expiredPayments = await prisma.payment.findMany({
      where: {
        status: 'CREATED',
        expiresAt: { lte: now },
        attempts: { none: {} }
      },
      select: { id: true, advocateBookingId: true }
    });

    let expiredCount = 0;
    if (expiredPayments.length > 0) {
      const expiredPaymentIds = expiredPayments.map(p => p.id);
      const advocateBookingIds = expiredPayments.map(p => p.advocateBookingId).filter(Boolean);

      const res = await prisma.payment.updateMany({
        where: { id: { in: expiredPaymentIds } },
        data: { status: 'EXPIRED' }
      });
      expiredCount = res.count;

      if (advocateBookingIds.length > 0) {
        await prisma.advocateBooking.updateMany({
          where: { id: { in: advocateBookingIds } },
          data: { status: 'EXPIRED' }
        });
      }
    }

    // Retry sending advocate booking confirmation emails for bookings in last 48 hours
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const pendingEmailBookings = await prisma.advocateBooking.findMany({
      where: {
        createdAt: { gte: fortyEightHoursAgo },
        status: { in: ['CONFIRMED', 'COMPLETED'] },
        OR: [
          { userConfirmationEmailSentAt: null },
          { advocateConfirmationEmailSentAt: null }
        ]
      },
      select: { id: true },
      take: 25,
      orderBy: { createdAt: 'asc' }
    });

    let emailsRetriedCount = 0;
    for (const b of pendingEmailBookings) {
      try {
        await sendAdvocateBookingConfirmationEmails(b.id);
        emailsRetriedCount++;
      } catch (emailErr) {
        errors.push({ bookingId: b.id, error: emailErr.message });
      }
    }

    // Retry unsent consultancy confirmation emails in the last 48h
    const pendingConsultancyEmails = await prisma.consultancyRequest.findMany({
      where: {
        createdAt: { gte: fortyEightHoursAgo },
        confirmationEmailSentAt: null,
        payment: {
          status: 'PAID'
        }
      },
      select: { id: true },
      take: 25,
      orderBy: { createdAt: 'asc' }
    });

    let consultancyEmailsRetriedCount = 0;
    for (const c of pendingConsultancyEmails) {
      try {
        await sendConsultancyConfirmationEmail(c.id);
        consultancyEmailsRetriedCount++;
      } catch (cErr) {
        errors.push({ consultancyRequestId: c.id, error: cErr.message });
      }
    }

    // Retry unsent test response sheet emails in the last 48h
    const pendingTestSheetAttempts = await prisma.advocateTestAttempt.findMany({
      where: {
        submittedAt: { gte: fortyEightHoursAgo },
        responseSheetEmailSentAt: null
      },
      select: { id: true },
      take: 25,
      orderBy: { submittedAt: 'asc' }
    });

    let testResponseSheetsRetriedCount = 0;
    for (const att of pendingTestSheetAttempts) {
      try {
        const res = await sendTestResponseSheetEmail(att.id);
        if (res && res.success) {
          testResponseSheetsRetriedCount++;
        }
      } catch (sheetErr) {
        errors.push({ attemptId: att.id, error: sheetErr.message });
      }
    }

    // Retry unsent help request acknowledgement emails in the last 48h
    let helpRequestEmailsRetriedCount = 0;
    try {
      const pendingHelpRequests = await prisma.helpRequest.findMany({
        where: {
          createdAt: { gte: fortyEightHoursAgo },
          acknowledgementEmailSentAt: null
        },
        select: { id: true },
        take: 25,
        orderBy: { createdAt: 'asc' }
      });

      for (const hr of pendingHelpRequests) {
        try {
          const res = await sendHelpRequestAcknowledgementEmail(hr.id);
          if (res && res.success) {
            helpRequestEmailsRetriedCount++;
          }
        } catch (hrErr) {
          errors.push({ helpRequestId: hr.id, error: hrErr.message });
        }
      }
    } catch (hrFindErr) {
      errors.push({ task: 'help_request_retry_cron', error: hrFindErr.message });
    }

    // Process Advocate Qualification Test background jobs (send due invites, expire links, auto-submit)
    let testCronResults = { invitesSent: 0, linksExpired: 0, attemptsAutoSubmitted: 0, errors: [] };
    try {
      testCronResults = await processTestCronJobs();
      if (testCronResults.errors && testCronResults.errors.length > 0) {
        errors.push(...testCronResults.errors);
      }
    } catch (testCronErr) {
      errors.push({ task: 'advocate_test_cron', error: testCronErr.message });
    }

    return res.status(200).json({
      success: true,
      reconciledCount,
      expiredCount,
      emailsRetriedCount,
      consultancyEmailsRetriedCount,
      testResponseSheetsRetried: testResponseSheetsRetriedCount,
      helpRequestEmailsRetried: helpRequestEmailsRetriedCount,
      testInvitesSent: testCronResults.invitesSent,
      testLinksExpired: testCronResults.linksExpired,
      testAttemptsAutoSubmitted: testCronResults.attemptsAutoSubmitted,
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
