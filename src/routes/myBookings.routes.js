import express from 'express';
import * as myBookingsController from '../controllers/myBookings.controller.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

const router = express.Router();

// User Consultancy Bookings Endpoints (USER role only)
router.get(
  '/',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  myBookingsController.listUserBookings
);

router.get(
  '/:id',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  myBookingsController.getUserBooking
);

export default router;
