import * as adminAdvocateBookingService from '../services/advocateBooking/adminAdvocateBooking.service.js';
import { adminAdvocateBookingQuerySchema } from '../validators/advocateBooking.validator.js';

/**
 * Admin: List all advocate bookings with filtering, search, and status group counts
 * GET /api/admin/advocate-bookings
 */
export const listAdvocateBookings = async (req, res, next) => {
  try {
    const validated = adminAdvocateBookingQuerySchema.parse(req.query);
    const result = await adminAdvocateBookingService.adminListAdvocateBookings(validated);
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Get single advocate booking details by ID with attempts and timeline
 * GET /api/admin/advocate-bookings/:id
 */
export const getAdvocateBookingById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await adminAdvocateBookingService.adminGetAdvocateBookingById(id);
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};
