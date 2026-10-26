import * as advocateBookingService from '../services/advocateBooking/advocateBooking.service.js';
import * as advocateAppointmentService from '../services/advocateBooking/advocateAppointment.service.js';
import {
  bookingQuoteSchema,
  advocateCheckoutSchema,
  advocateAppointmentQuerySchema
} from '../validators/advocateBooking.validator.js';
import { checkoutVerifySchema } from '../validators/payment.validator.js';
import { verifyCheckoutSignature, syncPaymentFromRazorpay, formatPayment } from '../services/payment.service.js';
import prisma from '../lib/prisma.js';

/**
 * Public: Get booking options & pricing for an advocate
 * GET /api/advocates/:advocateId/booking-options
 */
export const getBookingOptions = async (req, res, next) => {
  try {
    const { advocateId } = req.params;
    const result = await advocateBookingService.getAdvocateBookingOptions(advocateId);
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * Public: Get busy slots for an advocate on a given date (YYYY-MM-DD)
 * GET /api/advocates/:advocateId/busy-slots?date=YYYY-MM-DD
 */
export const getBusySlots = async (req, res, next) => {
  try {
    const { advocateId } = req.params;
    const { date } = req.query;

    const result = await advocateBookingService.getAdvocateBusySlots(advocateId, date);
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * User: Get real-time quote and slot availability check
 * POST /api/advocates/:advocateId/booking-quote
 */
export const getBookingQuote = async (req, res, next) => {
  try {
    const { advocateId } = req.params;
    const validated = bookingQuoteSchema.parse(req.body);
    const userId = req.user?.id || null;

    const result = await advocateBookingService.quoteBookingSlot(advocateId, validated, userId);
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * User: Create or reuse checkout for advocate appointment
 * POST /api/user/advocate-bookings/checkout
 */
export const createCheckout = async (req, res, next) => {
  try {
    const validated = advocateCheckoutSchema.parse(req.body);
    const userId = req.user.id;

    const result = await advocateBookingService.createAdvocateBookingCheckout({
      userId,
      advocateId: validated.advocateId,
      mode: validated.mode,
      startAt: validated.startAt
    });

    return res.status(result.statusCode).json(result.response);
  } catch (error) {
    next(error);
  }
};

/**
 * User: Verify Razorpay checkout signature for advocate booking
 * POST /api/user/advocate-bookings/checkout/verify
 */
export const verifyCheckout = async (req, res, next) => {
  try {
    const validated = checkoutVerifySchema.parse(req.body);

    const payment = await prisma.payment.findUnique({
      where: { razorpayOrderId: validated.razorpay_order_id },
      include: { advocateBooking: true }
    });

    if (!payment || payment.userId !== req.user.id) {
      return res.status(404).json({
        success: false,
        message: 'Payment order not found.'
      });
    }

    const isValidSignature = verifyCheckoutSignature({
      razorpay_order_id: validated.razorpay_order_id,
      razorpay_payment_id: validated.razorpay_payment_id,
      razorpay_signature: validated.razorpay_signature
    });

    if (!isValidSignature) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_SIGNATURE',
        message: 'Payment signature verification failed.'
      });
    }

    // Synchronize payment with Razorpay
    const synced = await syncPaymentFromRazorpay({ paymentId: payment.id });

    if (synced.status === 'PAID') {
      return res.status(200).json({
        success: true,
        status: 'PAID',
        payment: formatPayment(synced),
        booking: synced.advocateBooking
      });
    }

    if (synced.status === 'PROCESSING') {
      return res.status(202).json({
        success: true,
        status: 'PROCESSING',
        message: 'Payment is currently being processed by the bank.'
      });
    }

    if (synced.status === 'FAILED') {
      return res.status(200).json({
        success: true,
        status: 'FAILED',
        message: synced.failureReason || 'Payment failed.'
      });
    }

    return res.status(200).json({
      success: true,
      status: synced.status,
      payment: formatPayment(synced)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * User: Poll checkout status for advocate booking
 * GET /api/user/advocate-bookings/checkout/:checkoutId/status
 */
export const getCheckoutStatus = async (req, res, next) => {
  try {
    const { checkoutId } = req.params;

    const payment = await prisma.payment.findUnique({
      where: { id: checkoutId },
      include: {
        advocateBooking: true,
        attempts: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!payment || payment.userId !== req.user.id) {
      return res.status(404).json({
        success: false,
        message: 'Payment order not found.'
      });
    }

    let currentPayment = payment;
    if (payment.status !== 'PAID' && payment.status !== 'REFUNDED') {
      currentPayment = await syncPaymentFromRazorpay({ paymentId: payment.id });
    }

    return res.status(200).json({
      success: true,
      status: currentPayment.status,
      payment: formatPayment(currentPayment),
      booking: currentPayment.advocateBooking || null
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Advocate: List own appointments ("My Appointments")
 * GET /api/advocate/appointments
 */
export const getAdvocateAppointments = async (req, res, next) => {
  try {
    const query = advocateAppointmentQuerySchema.parse(req.query);
    const advocateId = req.user.id;

    const result = await advocateAppointmentService.getAdvocateAppointments(advocateId, query);
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Advocate: Get single appointment detail
 * GET /api/advocate/appointments/:id
 */
export const getAdvocateAppointmentById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const advocateId = req.user.id;

    const result = await advocateAppointmentService.getAdvocateAppointmentById(advocateId, id);
    return res.status(200).json({
      success: true,
      appointment: result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Advocate: Mark appointment completed
 * PATCH /api/advocate/appointments/:id/complete
 */
export const completeAdvocateAppointment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const advocateId = req.user.id;

    const result = await advocateAppointmentService.completeAdvocateAppointment(advocateId, id);
    return res.status(200).json({
      success: true,
      message: 'Appointment marked as completed.',
      appointment: result
    });
  } catch (error) {
    next(error);
  }
};
