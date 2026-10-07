import express from 'express';
import * as consultancyController from '../controllers/consultancy.controller.js';
import { requireAuth, requireRole, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

export const userConsultancyRouter = express.Router();
export const adminConsultancyRouter = express.Router();

// User Consultancy Routes (USER only)
userConsultancyRouter.post(
  '/',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  consultancyController.createUserRequest
);

userConsultancyRouter.get(
  '/',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  consultancyController.getUserRequests
);

userConsultancyRouter.get(
  '/:id',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  consultancyController.getUserRequestById
);

// Admin Consultancy Routes (Protected by RBAC; Admin has full access)
adminConsultancyRouter.get(
  '/',
  requireAuth,
  requirePermission('consultancy:view'),
  generalLimiter,
  consultancyController.adminListRequests
);

adminConsultancyRouter.patch(
  '/:id/status',
  requireAuth,
  requirePermission('consultancy:update'),
  generalLimiter,
  consultancyController.adminMarkCompleted
);
