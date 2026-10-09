import express from 'express';
import * as bnsController from '../controllers/bns.controller.js';
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

const router = express.Router();

// Admin BNS Routes (Authenticated, bns permissions required)
router.post(
  '/api/admin/bns',
  requireAuth,
  requirePermission('bns:create'),
  generalLimiter,
  bnsController.createBNSSection
);

router.patch(
  '/api/admin/bns/:bnsId',
  requireAuth,
  requirePermission('bns:update'),
  generalLimiter,
  bnsController.editBNSSection
);

// Public BNS Routes (No Authentication Required)
router.get('/api/bns', generalLimiter, bnsController.getBNSSections);
router.get('/api/bns/search', generalLimiter, bnsController.searchBNSSections);
router.get('/api/bns/:bnsId', generalLimiter, bnsController.getSingleBNSSection);

export default router;
