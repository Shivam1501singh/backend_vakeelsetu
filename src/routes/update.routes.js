import express from 'express';
import * as updateController from '../controllers/update.controller.js';
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

const router = express.Router();

// Admin Updates Routes (Authenticated, updates permissions required)
router.post(
  '/api/admin/updates',
  requireAuth,
  requirePermission('updates:create'),
  generalLimiter,
  updateController.createUpdate
);

router.patch(
  '/api/admin/updates/:id',
  requireAuth,
  requirePermission('updates:update'),
  generalLimiter,
  updateController.updateUpdate
);

router.delete(
  '/api/admin/updates/:id',
  requireAuth,
  requirePermission('updates:delete'),
  generalLimiter,
  updateController.deleteUpdate
);

// Public Updates Routes (No Authentication Required)
router.get('/api/updates', generalLimiter, updateController.getUpdates);
router.get('/api/updates/:id', generalLimiter, updateController.getSingleUpdate);

export default router;
