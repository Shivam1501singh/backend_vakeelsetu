import express from 'express';
import * as advocateBookingController from '../controllers/advocateBooking.controller.js';
import * as adminAdvocateBookingController from '../controllers/adminAdvocateBooking.controller.js';
import { requireAuth, requireRole, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

export const userAdvocateBookingRouter = express.Router();
export const advocateAppointmentRouter = express.Router();
export const adminAdvocateBookingRouter = express.Router();

// -------------------------------------------------------------
// User Advocate Booking Checkout Routes (Requires USER role)
// -------------------------------------------------------------
userAdvocateBookingRouter.post(
  '/checkout',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  advocateBookingController.createCheckout
);

userAdvocateBookingRouter.post(
  '/checkout/verify',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  advocateBookingController.verifyCheckout
);

userAdvocateBookingRouter.get(
  '/checkout/:checkoutId/status',
  requireAuth,
  requireRole('USER'),
  generalLimiter,
  advocateBookingController.getCheckoutStatus
);

// -------------------------------------------------------------
// Advocate "My Appointments" Routes (Requires ADVOCATE role)
// -------------------------------------------------------------
advocateAppointmentRouter.get(
  '/',
  requireAuth,
  requireRole('ADVOCATE'),
  generalLimiter,
  advocateBookingController.getAdvocateAppointments
);

advocateAppointmentRouter.get(
  '/:id',
  requireAuth,
  requireRole('ADVOCATE'),
  generalLimiter,
  advocateBookingController.getAdvocateAppointmentById
);

advocateAppointmentRouter.patch(
  '/:id/complete',
  requireAuth,
  requireRole('ADVOCATE'),
  generalLimiter,
  advocateBookingController.completeAdvocateAppointment
);

// -------------------------------------------------------------
// Admin Advocate Booking Routes (Requires advocate_bookings:view)
// -------------------------------------------------------------
adminAdvocateBookingRouter.get(
  '/',
  requireAuth,
  requirePermission('advocate_bookings:view'),
  generalLimiter,
  adminAdvocateBookingController.listAdvocateBookings
);

adminAdvocateBookingRouter.get(
  '/:id',
  requireAuth,
  requirePermission('advocate_bookings:view'),
  generalLimiter,
  adminAdvocateBookingController.getAdvocateBookingById
);
