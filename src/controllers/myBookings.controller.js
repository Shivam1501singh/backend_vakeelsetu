import * as myBookingsService from '../services/myBookings.service.js';
import { userBookingsQuerySchema } from '../validators/myBookings.validator.js';

/**
 * User: List own consultancy bookings with status filtering and counts
 * GET /api/user/bookings
 */
export const listUserBookings = async (req, res, next) => {
  try {
    const validated = userBookingsQuerySchema.parse(req.query);

    const result = await myBookingsService.listUserBookings(req.user.id, {
      status: validated.status,
      from: validated.from,
      to: validated.to,
      page: validated.page,
      limit: validated.limit
    });

    return res.status(200).json({
      success: true,
      bookings: result.bookings,
      pagination: result.pagination,
      counts: result.counts
    });
  } catch (error) {
    next(error);
  }
};

/**
 * User: Get single booking detail by ID with timeline
 * GET /api/user/bookings/:id
 */
export const getUserBooking = async (req, res, next) => {
  try {
    const { id } = req.params;

    const booking = await myBookingsService.getUserBooking(req.user.id, id);

    return res.status(200).json({
      success: true,
      booking
    });
  } catch (error) {
    next(error);
  }
};
