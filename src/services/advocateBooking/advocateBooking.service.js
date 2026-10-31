import prisma from '../../lib/prisma.js';
import { getRazorpayClient, getRazorpayKeyId, isPaymentsEnabled } from '../../config/razorpay.js';
import {
  isAdvocateBookable,
  assertAdvocateBookable,
  getBookableModes,
  quote,
  formatPricingSummary
} from './pricing.js';
import {
  validateStart,
  isSlotFree,
  checkUserSlotConflict,
  getAdvocateBusySlots,
  DEFAULT_BOOKING_TIMEZONE
} from './slotValidation.js';
import { syncPaymentFromRazorpay, formatPayment } from '../payment.service.js';

/**
 * Returns options and bookable modes for an advocate public profile / Consult Now modal.
 */
export const getAdvocateBookingOptions = async (advocateId) => {
  const advocate = await prisma.advocate.findUnique({
    where: { id: advocateId },
    select: {
      id: true,
      fullName: true,
      profilePhotoUrl: true,
      bestPracticeArea: true,
      practiceAreas: true,
      isActive: true,
      status: true,
      approvalStatus: true,
      deletionStatus: true,
      voiceCallPricePer15Min: true,
      videoCallPricePer15Min: true,
      offlineVisitingFee: true,
      officeVisitDurationMinutes: true
    }
  });

  if (!advocate) {
    const error = new Error('Advocate not found.');
    error.statusCode = 404;
    throw error;
  }

  const bookable = isAdvocateBookable(advocate);
  const modes = bookable ? getBookableModes(advocate) : [];

  const slotMinutes = parseInt(process.env.ADVOCATE_BOOKING_SLOT_MINUTES || '15', 10);
  const inPersonMinutes = advocate.officeVisitDurationMinutes
    ? parseInt(advocate.officeVisitDurationMinutes, 10)
    : parseInt(process.env.ADVOCATE_IN_PERSON_MINUTES || '60', 10);
  const minLeadMinutes = parseInt(process.env.ADVOCATE_BOOKING_MIN_LEAD_MINUTES || '30', 10);
  const maxDaysAhead = parseInt(process.env.ADVOCATE_BOOKING_MAX_DAYS_AHEAD || '30', 10);
  const timezone = process.env.BOOKING_TIMEZONE || DEFAULT_BOOKING_TIMEZONE;

  return {
    success: true,
    advocate: {
      id: advocate.id,
      fullName: advocate.fullName,
      profilePhotoUrl: advocate.profilePhotoUrl,
      bestPracticeArea: advocate.bestPracticeArea || advocate.practiceAreas?.[0] || null
    },
    bookable,
    modes,
    pricing: formatPricingSummary(advocate),
    voiceCallPricePer15Min: advocate.voiceCallPricePer15Min !== null ? Number(advocate.voiceCallPricePer15Min) : null,
    videoCallPricePer15Min: advocate.videoCallPricePer15Min !== null ? Number(advocate.videoCallPricePer15Min) : null,
    offlineVisitingFee: advocate.offlineVisitingFee !== null ? Number(advocate.offlineVisitingFee) : null,
    officeVisitDurationMinutes: advocate.officeVisitDurationMinutes ?? inPersonMinutes,
    slotMinutes,
    inPersonMinutes,
    minLeadMinutes,
    maxDaysAhead,
    timezone
  };
};

/**
 * Quotes an appointment slot and checks real-time availability.
 */
export const quoteBookingSlot = async (advocateId, { mode, startAt }, userId = null) => {
  const advocate = await prisma.advocate.findUnique({
    where: { id: advocateId }
  });

  if (!advocate) {
    const error = new Error('Advocate not found.');
    error.statusCode = 404;
    throw error;
  }

  assertAdvocateBookable(advocate);
  const breakdown = quote(advocate, mode);

  const { startAt: slotStart, endAt: slotEnd, durationMinutes } = validateStart(mode, startAt, breakdown.durationMinutes);

  const free = await isSlotFree(advocateId, slotStart, slotEnd);
  if (!free) {
    const error = new Error('The selected time slot is no longer available. Please select another time.');
    error.statusCode = 409;
    error.code = 'SLOT_TAKEN';
    throw error;
  }

  if (userId) {
    await checkUserSlotConflict(userId, slotStart, slotEnd);
  }

  return {
    success: true,
    available: true,
    startAt: slotStart.toISOString(),
    endAt: slotEnd.toISOString(),
    durationMinutes,
    mode,
    breakdown
  };
};

/**
 * Creates or reuses a checkout order for an advocate appointment.
 */
export const createAdvocateBookingCheckout = async ({ userId, advocateId, mode, startAt }) => {
  if (!isPaymentsEnabled()) {
    const err = new Error('Payments are currently disabled on this platform.');
    err.statusCode = 400;
    err.code = 'PAYMENTS_DISABLED';
    throw err;
  }

  const rzpClient = getRazorpayClient();
  if (!rzpClient) {
    const err = new Error('Payments are not configured.');
    err.statusCode = 503;
    throw err;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, fullName: true, email: true, phone: true }
  });

  if (!user) {
    const err = new Error('User not found.');
    err.statusCode = 404;
    throw err;
  }

  const advocate = await prisma.advocate.findUnique({
    where: { id: advocateId }
  });

  if (!advocate) {
    const err = new Error('Advocate not found.');
    err.statusCode = 404;
    throw err;
  }

  assertAdvocateBookable(advocate);
  const pricing = quote(advocate, mode);
  const { startAt: slotStart, endAt: slotEnd, durationMinutes } = validateStart(mode, startAt, pricing.durationMinutes);

  const now = new Date();

  // 1. Reuse Rule: Check if this user already has an active HOLD for the exact same advocate+mode+startAt
  const existingPayment = await prisma.payment.findFirst({
    where: {
      userId,
      purpose: 'ADVOCATE_BOOKING',
      advocateBooking: {
        advocateId,
        mode,
        startAt: slotStart,
        status: 'HOLD'
      },
      expiresAt: { gt: now }
    },
    include: { advocateBooking: true },
    orderBy: { createdAt: 'desc' }
  });

  if (existingPayment) {
    const synced = await syncPaymentFromRazorpay({ paymentId: existingPayment.id });

    if (synced.status === 'PAID') {
      return {
        alreadyPaid: true,
        statusCode: 200,
        response: {
          success: true,
          code: 'ALREADY_PAID',
          message: 'Payment for this appointment was already completed.',
          booking: synced.advocateBooking,
          payment: formatPayment(synced)
        }
      };
    }

    if (synced.status === 'PROCESSING') {
      const err = new Error('Your previous payment is still being processed by the bank. Please wait — do not pay again.');
      err.statusCode = 409;
      err.code = 'PAYMENT_PROCESSING';
      err.checkoutId = synced.id;
      throw err;
    }

    if (synced.status === 'CREATED' || synced.status === 'FAILED') {
      // Reuse the existing Razorpay order
      const updatedBooking = await prisma.advocateBooking.update({
        where: { id: synced.advocateBookingId },
        data: {
          userName: user.fullName || '',
          userPhone: user.phone,
          userEmail: user.email
        }
      });

      return {
        statusCode: 200,
        response: {
          success: true,
          checkout: {
            checkoutId: synced.id,
            razorpayOrderId: synced.razorpayOrderId,
            amount: synced.amount,
            currency: synced.currency,
            keyId: getRazorpayKeyId(),
            status: synced.status,
            expiresAt: synced.expiresAt,
            booking: {
              id: updatedBooking.id,
              mode: updatedBooking.mode,
              startAt: updatedBooking.startAt,
              endAt: updatedBooking.endAt,
              durationMinutes: updatedBooking.durationMinutes,
              subject: updatedBooking.subject,
              breakdown: pricing
            },
            prefill: {
              name: user.fullName || '',
              email: user.email,
              contact: user.phone
            }
          }
        }
      };
    }
  }

  // 2. New Booking Checkout
  const holdMinutes = parseInt(process.env.ADVOCATE_BOOKING_HOLD_MINUTES || '10', 10);
  const holdExpiresAt = new Date(Date.now() + holdMinutes * 60 * 1000);

  // Execute in transaction with row lock on Advocate to serialize concurrent checkouts
  let newBooking;
  let newPayment;

  // First create Razorpay order
  let rzpOrder;
  try {
    rzpOrder = await rzpClient.orders.create({
      amount: pricing.totalPaise,
      currency: 'INR',
      receipt: `adv_${Date.now()}`.slice(0, 40),
      notes: {
        purpose: 'ADVOCATE_BOOKING',
        userId,
        advocateId,
        mode
      }
    });
  } catch (rzpErr) {
    console.error('[Razorpay Order Creation Error]:', rzpErr);
    const err = new Error('Failed to create payment gateway order.');
    err.statusCode = 502;
    throw err;
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        // Lock advocate row to serialize checkouts
        await tx.$queryRaw`
          SELECT id FROM "Advocate"
          WHERE id = ${advocateId}
          FOR UPDATE
        `;

        // Check user conflict across all advocates
        await checkUserSlotConflict(userId, slotStart, slotEnd, tx);

        // Check advocate slot availability
        const slotFree = await isSlotFree(advocateId, slotStart, slotEnd, tx);
        if (!slotFree) {
          const err = new Error('The selected time slot is no longer available. Please select another time.');
          err.statusCode = 409;
          err.code = 'SLOT_TAKEN';
          throw err;
        }

        // Create AdvocateBooking in HOLD
        newBooking = await tx.advocateBooking.create({
          data: {
            userId,
            advocateId,
            mode,
            startAt: slotStart,
            endAt: slotEnd,
            durationMinutes,
            subject: null,
            ratePerMinutePaise: pricing.ratePerMinutePaise,
            feePaise: pricing.feePaise,
            gstPercent: pricing.gstPercent,
            gstPaise: pricing.gstPaise,
            platformFeePaise: pricing.platformFeePaise,
            totalPaise: pricing.totalPaise,
            currency: 'INR',
            userName: user.fullName || '',
            userPhone: user.phone,
            userEmail: user.email,
            advocateName: advocate.fullName,
            status: 'HOLD',
            holdExpiresAt
          }
        });

        // Create Payment record
        newPayment = await tx.payment.create({
          data: {
            purpose: 'ADVOCATE_BOOKING',
            userId,
            advocateBookingId: newBooking.id,
            phoneNumber: user.phone,
            email: user.email,
            amount: pricing.totalPaise,
            currency: 'INR',
            status: 'CREATED',
            razorpayOrderId: rzpOrder.id,
            expiresAt: holdExpiresAt
          }
        });
      },
      { timeout: 15000 }
    );
  } catch (txError) {
    // Clean up if transaction failed
    throw txError;
  }

  return {
    statusCode: 201,
    response: {
      success: true,
      checkout: {
        checkoutId: newPayment.id,
        razorpayOrderId: newPayment.razorpayOrderId,
        amount: newPayment.amount,
        currency: newPayment.currency,
        keyId: getRazorpayKeyId(),
        status: newPayment.status,
        expiresAt: newPayment.expiresAt,
        booking: {
          id: newBooking.id,
          mode: newBooking.mode,
          startAt: newBooking.startAt,
          endAt: newBooking.endAt,
          durationMinutes: newBooking.durationMinutes,
          subject: newBooking.subject,
          breakdown: pricing
        },
        prefill: {
          name: user.fullName || '',
          email: user.email,
          contact: user.phone
        }
      }
    }
  };
};

export { getAdvocateBusySlots };
