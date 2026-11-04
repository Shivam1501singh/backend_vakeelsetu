import express from 'express';
import { optionalAuth, requireAuth, requireRole } from '../middleware/auth.middleware.js';
import {
  registerToken,
  unregisterToken,
  testPushNotification,
  getNotificationLogs
} from '../controllers/notification.controller.js';

const router = express.Router();

// Register device FCM token (for Mobile & Web clients, can be authenticated or unauthenticated)
router.post('/register-token', optionalAuth, registerToken);

// Unregister device FCM token (e.g. on logout)
router.post('/unregister-token', unregisterToken);

// Test push notification endpoint
router.post('/test', testPushNotification);

// View notification audit logs (admin protected)
router.get('/logs', requireAuth, requireRole('ADMIN'), getNotificationLogs);

export default router;

