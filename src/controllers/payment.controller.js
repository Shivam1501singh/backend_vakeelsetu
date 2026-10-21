import prisma from '../lib/prisma.js';
import { getRazorpayClient, getRazorpayKeyId, isRazorpayConfigured, isPaymentsEnabled } from '../config/razorpay.js';
import { getConsultancyPrice } from '../config/consultancyPricing.js';
import { createConsultancyRequestSchema } from '../validators/consultancy.validator.js';
import {
  checkoutVerifySchema,
  adminPaymentQuerySchema,
  adminRefundSchema,
  userPaymentQuerySchema
} from '../validators/payment.validator.js';
import {
  syncPaymentFromRazorpay,
  verifyCheckoutSignature,
  formatPayment
} from '../services/payment.service.js';

// Cache for throttling status syncs (paymentId -> lastSyncTimestamp)
const syncThrottleMap = new Map();

/**
 * User: Create or reuse a checkout for consultancy booking
 * POST /api/user/consultancy/checkout
 */
export const createCheckout = async (req, res, next) => {
  try {
    if (!isPaymentsEnabled()) {
      return res.status(400).json({
        success: false,
        code: 'PAYMENTS_DISABLED',
        message: 'Payments are currently disabled on this platform.'
      });
    }

    const rzpClient = getRazorpayClient();
    if (!rzpClient) {
      return res.status(503).json({
        success: false,
        message: 'Payments are not configured.'
      });
    }

    const validated = createConsultancyRequestSchema.parse(req.body);
    const amountInPaise = getConsultancyPrice(validated.callType, validated.duration) * 100;
    const now = new Date();

    // Reuse rule: Find existing active order for this user & package
    const existingActivePayment = await prisma.payment.findFirst({
      where: {
        userId: req.user.id,
        callType: validated.callType,
        duration: validated.duration,
        status: { in: ['CREATED', 'PROCESSING', 'FAILED'] },
        expiresAt: { gt: now }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (existingActivePayment) {
      // Sync latest status with Razorpay
      const synced = await syncPaymentFromRazorpay({ paymentId: existingActivePayment.id });

      if (synced.status === 'PAID') {
        return res.status(200).json({
          success: true,
          code: 'ALREADY_PAID',
          message: 'Payment for this package was already completed.',
          payment: formatPayment(synced),
          consultancyRequest: synced.consultancyRequest
        });
      }

      if (synced.status === 'PROCESSING') {
        return res.status(409).json({
          success: false,
          code: 'PAYMENT_PROCESSING',
          message: 'Your previous payment is still being processed by the bank. Please wait — do not pay again.',
          checkoutId: synced.id
        });
      }

      if (synced.status === 'CREATED' || synced.status === 'FAILED') {
        // Reuse same order; update snapshot if contact changed
        const updated = await prisma.payment.update({
          where: { id: synced.id },
          data: {
            phoneNumber: validated.phoneNumber.trim(),
            email: validated.email.trim().toLowerCase()
          }
        });

        return res.status(200).json({
          success: true,
          checkout: {
            checkoutId: updated.id,
            razorpayOrderId: updated.razorpayOrderId,
            amount: updated.amount,
            currency: updated.currency,
            keyId: getRazorpayKeyId(),
            status: updated.status,
            expiresAt: updated.expiresAt,
            package: {
              callType: updated.callType,
              duration: updated.duration,
              price: updated.amount / 100
            },
            prefill: {
              name: req.user.fullName || '',
              email: updated.email,
              contact: updated.phoneNumber
            }
          }
        });
      }
    }

    // No reusable checkout found; create new Razorpay order
    const ttlMinutes = parseInt(process.env.PAYMENT_CHECKOUT_TTL_MINUTES || '30', 10);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    const rzpOrder = await rzpClient.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `cns_${Date.now()}`.slice(0, 40),
      notes: {
        userId: req.user.id,
        callType: validated.callType,
        duration: String(validated.duration)
      }
    });

    const newPayment = await prisma.payment.create({
      data: {
        userId: req.user.id,
        callType: validated.callType,
        duration: validated.duration,
        phoneNumber: validated.phoneNumber.trim(),
        email: validated.email.trim().toLowerCase(),
        amount: amountInPaise,
        currency: 'INR',
        status: 'CREATED',
        razorpayOrderId: rzpOrder.id,
        expiresAt
      }
    });

    return res.status(201).json({
      success: true,
      checkout: {
        checkoutId: newPayment.id,
        razorpayOrderId: newPayment.razorpayOrderId,
        amount: newPayment.amount,
        currency: newPayment.currency,
        keyId: getRazorpayKeyId(),
        status: newPayment.status,
        expiresAt: newPayment.expiresAt,
        package: {
          callType: newPayment.callType,
          duration: newPayment.duration,
          price: newPayment.amount / 100
        },
        prefill: {
          name: req.user.fullName || '',
          email: newPayment.email,
          contact: newPayment.phoneNumber
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * User: Verify Razorpay checkout signature & sync payment
 * POST /api/user/consultancy/checkout/verify
 */
export const verifyCheckout = async (req, res, next) => {
  try {
    const validated = checkoutVerifySchema.parse(req.body);

    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId: validated.razorpay_order_id }
    });

    if (!payment || payment.userId !== req.user.id) {
      return res.status(404).json({
        success: false,
        message: 'Payment order not found.'
      });
    }

    const isValidSignature = verifyCheckoutSignature({
      razorpay_order_id: validated.razorpay_order_id,
      razorpay_payment_id: validated.razorpay_payment_id,
      razorpay_signature: validated.razorpay_signature
    });

    if (!isValidSignature) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_SIGNATURE',
        message: 'Payment signature verification failed.'
      });
    }

    // Signature valid -> Synchronize state with Razorpay
    const synced = await syncPaymentFromRazorpay({ paymentId: payment.id });

    if (synced.status === 'PAID') {
      return res.status(200).json({
        success: true,
        status: 'PAID',
        payment: formatPayment(synced),
        consultancyRequest: synced.consultancyRequest
      });
    }

    if (synced.status === 'PROCESSING') {
      return res.status(202).json({
        success: true,
        status: 'PROCESSING',
        message: 'Payment is currently being processed by the bank.'
      });
    }

    if (synced.status === 'FAILED') {
      return res.status(200).json({
        success: true,
        status: 'FAILED',
        message: synced.failureReason || 'Payment failed.'
      });
    }

    return res.status(200).json({
      success: true,
      status: synced.status,
      payment: formatPayment(synced)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * User: Poll checkout status (throttled)
 * GET /api/user/consultancy/checkout/:checkoutId/status
 */
export const getCheckoutStatus = async (req, res, next) => {
  try {
    const { checkoutId } = req.params;

    const payment = await prisma.payment.findUnique({
      where: { id: checkoutId },
      include: {
        consultancyRequest: true,
        attempts: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!payment || payment.userId !== req.user.id) {
      return res.status(404).json({
        success: false,
        message: 'Payment order not found.'
      });
    }

    // Throttle sync to once per 10s per payment
    const lastSync = syncThrottleMap.get(payment.id) || 0;
    const now = Date.now();
    let currentPayment = payment;

    if (now - lastSync > 10000 && payment.status !== 'PAID' && payment.status !== 'REFUNDED') {
      syncThrottleMap.set(payment.id, now);
      currentPayment = await syncPaymentFromRazorpay({ paymentId: payment.id });
    }

    return res.status(200).json({
      success: true,
      status: currentPayment.status,
      payment: formatPayment(currentPayment),
      consultancyRequest: currentPayment.consultancyRequest || null
    });
  } catch (error) {
    next(error);
  }
};

/**
 * User: List own payments history
 * GET /api/user/payments
 */
export const getUserPayments = async (req, res, next) => {
  try {
    const query = userPaymentQuerySchema.parse(req.query);
    const page = Math.max(1, query.page || 1);
    const limit = Math.max(1, Math.min(100, query.limit || 10));
    const skip = (page - 1) * limit;

    const where = { userId: req.user.id };

    const [total, items] = await prisma.$transaction([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          consultancyRequest: {
            select: {
              id: true,
              status: true,
              completedAt: true
            }
          },
          attempts: {
            orderBy: { createdAt: 'desc' }
          }
        }
      })
    ]);

    const formatted = items.map(formatPayment);

    return res.status(200).json({
      success: true,
      data: formatted,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: List all payments with filtering, search, and status counts
 * GET /api/admin/payments
 */
export const adminListPayments = async (req, res, next) => {
  try {
    const query = adminPaymentQuerySchema.parse(req.query);
    const page = Math.max(1, query.page || 1);
    const limit = Math.max(1, Math.min(100, query.limit || 10));
    const skip = (page - 1) * limit;

    const where = {};

    if (query.status) {
      where.status = query.status;
    }

    const now = new Date();
    if (query.refundEligible === true) {
      where.status = 'PAID';
      where.refundEligibleAt = { lte: now };
      where.consultancyRequest = {
        status: { not: 'COMPLETED' }
      };
    }

    if (query.search) {
      const search = query.search.trim();
      where.OR = [
        { razorpayOrderId: { contains: search, mode: 'insensitive' } },
        { phoneNumber: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
        { user: { fullName: { contains: search, mode: 'insensitive' } } },
        { attempts: { some: { razorpayPaymentId: { contains: search } } } }
      ];
    }

    if (query.from || query.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(query.from);
      if (query.to) where.createdAt.lte = new Date(query.to);
    }

    const [total, items, statusGroupCounts] = await prisma.$transaction([
      prisma.payment.count({ where }),
      prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true
            }
          },
          consultancyRequest: {
            select: {
              id: true,
              status: true,
              completedAt: true
            }
          },
          attempts: {
            select: {
              id: true,
              razorpayPaymentId: true,
              status: true,
              amount: true,
              method: true,
              createdAt: true
            }
          }
        }
      }),
      prisma.payment.groupBy({
        by: ['status'],
        _count: { status: true }
      })
    ]);

    // Build counts dictionary
    const counts = {
      ALL: 0,
      CREATED: 0,
      PROCESSING: 0,
      PAID: 0,
      FAILED: 0,
      EXPIRED: 0,
      REFUND_PENDING: 0,
      REFUNDED: 0
    };

    let allCount = 0;
    for (const group of statusGroupCounts) {
      counts[group.status] = group._count.status;
      allCount += group._count.status;
    }
    counts.ALL = allCount;

    const data = items.map(item => {
      const isRefundEligible =
        item.status === 'PAID' &&
        item.consultancyRequest?.status !== 'COMPLETED' &&
        item.refundEligibleAt &&
        item.refundEligibleAt <= now;

      const capturedCount = item.attempts.filter(a => a.status === 'CAPTURED' || a.status === 'DUPLICATE_REFUNDED').length;
      const failedCount = item.attempts.filter(a => a.status === 'FAILED').length;

      return {
        ...formatPayment(item),
        isRefundEligible,
        attemptsSummary: {
          total: item.attempts.length,
          captured: capturedCount,
          failed: failedCount
        }
      };
    });

    return res.status(200).json({
      success: true,
      data,
      counts,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Get single payment by ID with full details, attempts, and audit events
 * GET /api/admin/payments/:id
 */
export const adminGetPaymentById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const payment = await prisma.payment.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true
          }
        },
        consultancyRequest: true,
        attempts: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found.'
      });
    }

    // Fetch related webhook audit events
    const webhookEvents = await prisma.paymentWebhookEvent.findMany({
      where: {
        payload: {
          path: ['payload', 'payment', 'entity', 'order_id'],
          equals: payment.razorpayOrderId
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const now = new Date();
    const isRefundEligible =
      payment.status === 'PAID' &&
      payment.consultancyRequest?.status !== 'COMPLETED' &&
      payment.refundEligibleAt &&
      payment.refundEligibleAt <= now;

    return res.status(200).json({
      success: true,
      data: {
        ...formatPayment(payment),
        isRefundEligible,
        webhookEvents
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Refund payment
 * POST /api/admin/payments/:id/refund
 */
export const adminRefundPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const validated = adminRefundSchema.parse(req.body);

    const payment = await prisma.payment.findUnique({
      where: { id },
      include: {
        consultancyRequest: true,
        attempts: {
          where: { status: 'CAPTURED' },
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found.'
      });
    }

    if (payment.status === 'REFUNDED' || payment.status === 'REFUND_PENDING') {
      return res.status(409).json({
        success: false,
        message: 'Payment has already been refunded or has a refund pending.'
      });
    }

    if (payment.status !== 'PAID') {
      return res.status(400).json({
        success: false,
        message: `Only PAID payments can be refunded. Current status is ${payment.status}.`
      });
    }

    if (payment.consultancyRequest?.status === 'COMPLETED') {
      return res.status(400).json({
        success: false,
        message: 'Cannot refund a payment for a COMPLETED consultancy request.'
      });
    }

    const now = new Date();
    const isEligible = payment.refundEligibleAt && now >= payment.refundEligibleAt;

    const isAdmin =
      (req.user.type && req.user.type.toLowerCase() === 'admin') ||
      (req.user.role && req.user.role.toUpperCase() === 'ADMIN');

    if (!isEligible) {
      // If not eligible yet, only Main Admin with "force: true" can execute
      if (!isAdmin || !validated.force) {
        return res.status(400).json({
          success: false,
          message: 'Payment is not yet eligible for refund (7 working days SLA has not passed). Only the Main Admin can force refund.'
        });
      }
    }

    const rzpClient = getRazorpayClient();
    if (!rzpClient) {
      return res.status(503).json({
        success: false,
        message: 'Payments are not configured.'
      });
    }

    // Find the captured attempt to refund
    const capturedAttempt = payment.attempts[0];
    if (!capturedAttempt) {
      return res.status(400).json({
        success: false,
        message: 'No captured attempt found on this payment to refund.'
      });
    }

    // Execute refund via Razorpay
    const rzpRefund = await rzpClient.payments.refund(capturedAttempt.razorpayPaymentId, {
      amount: payment.amount,
      notes: {
        reason: validated.reason,
        refundedById: req.user.id
      }
    });

    const isProcessedImmediately = rzpRefund.status === 'processed';

    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: isProcessedImmediately ? 'REFUNDED' : 'REFUND_PENDING',
        refundId: rzpRefund.id,
        refundReason: validated.reason,
        refundedById: req.user.id,
        refundedByType: req.user.type || req.user.role || 'ADMIN',
        refundedAt: isProcessedImmediately ? new Date() : null
      }
    });

    if (isProcessedImmediately && payment.consultancyRequestId) {
      await prisma.consultancyRequest.update({
        where: { id: payment.consultancyRequestId },
        data: { status: 'REFUNDED' }
      });
    }

    return res.status(200).json({
      success: true,
      message: isProcessedImmediately ? 'Payment refunded successfully.' : 'Payment refund initiated.',
      payment: formatPayment(updatedPayment)
    });
  } catch (error) {
    next(error);
  }
};
