import express from 'express';
import * as ipcController from '../controllers/ipc.controller.js';
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

const router = express.Router();

// Content Creator IPC Routes (Authenticated, ipc permissions required)
router.post(
  '/api/content-creator/ipc',
  requireAuth,
  requirePermission('ipc:create'),
  generalLimiter,
  ipcController.createIPCSection
);

router.patch(
  '/api/content-creator/ipc/:ipcId',
  requireAuth,
  requirePermission('ipc:update'),
  generalLimiter,
  ipcController.editIPCSection
);

// Public IPC Routes (No Authentication Required)
router.get('/api/ipc', generalLimiter, ipcController.getIPCSections);
router.get('/api/ipc/search', generalLimiter, ipcController.searchIPCSections);
router.get('/api/ipc/:ipcId', generalLimiter, ipcController.getSingleIPCSection);

export default router;
