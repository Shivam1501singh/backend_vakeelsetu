import express from 'express';
import * as paymentController from '../controllers/payment.controller.js';
import * as paymentCronController from '../controllers/paymentCron.controller.js';
import * as paymentWebhookController from '../controllers/paymentWebhook.controller.js';
import { requireAuth, requireRole, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

export const userCheckoutRouter = express.Router();
export const userPaymentsRouter = express.Router();
export const adminPaymentRouter = express.Router();
export const cronPaymentRouter = express.Router();
export const webhookRouter = express.Router();

// User Checkout Routes (USER role required)
userCheckoutRouter.post(
  '/',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  paymentController.createCheckout
);

userCheckoutRouter.post(
  '/verify',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  paymentController.verifyCheckout
);

userCheckoutRouter.get(
  '/:checkoutId/status',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  paymentController.getCheckoutStatus
);

// User Payments History
userPaymentsRouter.get(
  '/',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  paymentController.getUserPayments
);

// Admin Payments Management (Protected by RBAC)
adminPaymentRouter.get(
  '/',
  requireAuth,
  requirePermission('payments:view'),
  generalLimiter,
  paymentController.adminListPayments
);

adminPaymentRouter.get(
  '/:id',
  requireAuth,
  requirePermission('payments:view'),
  generalLimiter,
  paymentController.adminGetPaymentById
);

adminPaymentRouter.post(
  '/:id/refund',
  requireAuth,
  requirePermission('payments:refund'),
  generalLimiter,
  paymentController.adminRefundPayment
);

// Internal Cron Endpoints (Vercel Cron Bearer Auth)
cronPaymentRouter.get(
  '/payments-reconcile',
  paymentCronController.reconcilePaymentsCron
);

cronPaymentRouter.get(
  '/refund-eligibility',
  paymentCronController.refundEligibilityCron
);

// Public Razorpay Webhook (Raw body parser must be mounted before express.json())
webhookRouter.post(
  '/',
  paymentWebhookController.handleRazorpayWebhook
);
