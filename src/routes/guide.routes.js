import express from 'express';
import * as guideController from '../controllers/guide.controller.js';
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

const router = express.Router();

// Admin Guides Routes (Authenticated, guides permissions required)
router.post(
  '/api/admin/guides',
  requireAuth,
  requirePermission('guides:create'),
  generalLimiter,
  guideController.createGuide
);

router.patch(
  '/api/admin/guides/:id',
  requireAuth,
  requirePermission('guides:update'),
  generalLimiter,
  guideController.updateUserGuide
);

router.delete(
  '/api/admin/guides/:id',
  requireAuth,
  requirePermission('guides:delete'),
  generalLimiter,
  guideController.deleteGuide
);

// Public Guides Routes (No Authentication Required)
router.get('/api/guides', generalLimiter, guideController.getGuides);
router.get('/api/guides/:id', generalLimiter, guideController.getSingleGuide);

export default router;
