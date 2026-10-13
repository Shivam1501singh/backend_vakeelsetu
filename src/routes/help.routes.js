import express from 'express';
import * as helpController from '../controllers/help.controller.js';
import { helpLimiter, generalLimiter } from '../middleware/rate-limit.middleware.js';
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js';

export const helpRouter = express.Router();
export const adminHelpRouter = express.Router();

// Publicly accessible endpoints (No Auth required)
helpRouter.post('/', helpLimiter, helpController.createRequest);
helpRouter.post('/lookup', helpLimiter, helpController.lookupRequest);

// Protected Admin / Support endpoints (Protected by RBAC permissions; Admin has full access)
adminHelpRouter.get('/', requireAuth, requirePermission('help:view'), generalLimiter, helpController.adminListRequests);
adminHelpRouter.get('/:id', requireAuth, requirePermission('help:view'), generalLimiter, helpController.adminGetDetails);
adminHelpRouter.patch('/:id', requireAuth, requirePermission('help:respond'), generalLimiter, helpController.submitAdminResponse);
