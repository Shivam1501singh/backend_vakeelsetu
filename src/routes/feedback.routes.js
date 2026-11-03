import express from 'express';
import * as feedbackController from '../controllers/feedback.controller.js';
import { requireAuth, requireRole, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

export const userFeedbackRouter = express.Router();
export const advocateFeedbackRouter = express.Router();
export const commonFeedbackRouter = express.Router();
export const adminFeedbackRouter = express.Router();

// User Feedback Route (USER only)
userFeedbackRouter.post(
  '/',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  feedbackController.submitFeedback
);

// Advocate Feedback Route (ADVOCATE only)
advocateFeedbackRouter.post(
  '/',
  requireAuth,
  requireRole('ADVOCATE'),
  generalLimiter,
  feedbackController.submitFeedback
);

// Common Feedback Route (USER and ADVOCATE both allowed)
commonFeedbackRouter.post(
  '/',
  requireAuth,
  requireRole('USER', 'ADVOCATE'),
  generalLimiter,
  feedbackController.submitFeedback
);

// Admin Feedback Routes (Protected by RBAC; Admin has full access)
adminFeedbackRouter.get(
  '/',
  requireAuth,
  requirePermission('feedback:view'),
  generalLimiter,
  feedbackController.adminListFeedbacks
);

adminFeedbackRouter.delete(
  '/:id',
  requireAuth,
  requirePermission('feedback:delete'),
  generalLimiter,
  feedbackController.adminDeleteFeedback
);
