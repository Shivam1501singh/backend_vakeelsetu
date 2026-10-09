import express from 'express';
import multer from 'multer';
import * as userRightController from '../controllers/userRight.controller.js';
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Admin User Rights Routes (Authenticated, user_rights permissions required)
router.post(
  '/api/admin/user-rights',
  requireAuth,
  requirePermission('user_rights:create'),
  generalLimiter,
  upload.single('photo'),
  userRightController.createUserRight
);

router.patch(
  '/api/admin/user-rights/:id',
  requireAuth,
  requirePermission('user_rights:update'),
  generalLimiter,
  upload.single('photo'),
  userRightController.updateUserRight
);

router.delete(
  '/api/admin/user-rights/:id',
  requireAuth,
  requirePermission('user_rights:delete'),
  generalLimiter,
  userRightController.deleteUserRight
);

// Public User Rights Routes (No Authentication Required)
router.get('/api/user-rights', generalLimiter, userRightController.getUserRights);
router.get('/api/user-rights/:id', generalLimiter, userRightController.getSingleUserRight);

export default router;
