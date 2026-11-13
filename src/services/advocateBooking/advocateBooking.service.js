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
 * Validates requested duration and ensures booking ends on the same IST day.
 */
export const validateDurationAndDay = (mode, advocate, startAtDate, rawDurationMinutes) => {
  const slotMinutes = parseInt(process.env.ADVOCATE_BOOKING_SLOT_MINUTES || '15', 10);

  let durationMinutes;
  if (mode === 'IN_PERSON') {
    const fixedDuration = advocate.officeVisitDurationMinutes
      ? parseInt(advocate.officeVisitDurationMinutes, 10)
      : parseInt(process.env.ADVOCATE_IN_PERSON_MINUTES || '60', 10);

    if (rawDurationMinutes !== undefined && rawDurationMinutes !== null && parseInt(rawDurationMinutes, 10) !== fixedDuration) {
      const err = new Error('Office visit duration is fixed by the advocate.');
      err.statusCode = 400;
      err.code = 'INVALID_DURATION';
      throw err;
    }
    durationMinutes = fixedDuration;
  } else {
    // VOICE_CALL or VIDEO_CALL
    if (rawDurationMinutes === undefined || rawDurationMinutes === null) {
      durationMinutes = slotMinutes;
    } else {
      const parsed = parseInt(rawDurationMinutes, 10);
      if (isNaN(parsed) || parsed < slotMinutes || parsed % slotMinutes !== 0) {
        const err = new Error('Duration must be in steps of 15 minutes.');
        err.statusCode = 400;
        err.code = 'INVALID_DURATION';
        throw err;
      }
      durationMinutes = parsed;
    }
  }

  // Same day check in IST: end <= 24:00 IST that day
  const endAtDate = new Date(startAtDate.getTime() + durationMinutes * 60 * 1000);
  const tz = process.env.BOOKING_TIMEZONE || DEFAULT_BOOKING_TIMEZONE;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const istDateStr = formatter.format(startAtDate); // YYYY-MM-DD
  const nextDayStartUtc = new Date(new Date(`${istDateStr}T23:59:59.999+05:30`).getTime() + 1);

  if (endAtDate.getTime() > nextDayStartUtc.getTime()) {
    const err = new Error('The booking must end on the same day.');
    err.statusCode = 400;
    err.code = 'INVALID_DURATION';
    throw err;
  }

  return durationMinutes;
};

/**
 * Quotes an appointment slot and checks real-time availability.
 */
export const quoteBookingSlot = async (advocateId, { mode, startAt, durationMinutes: rawDurationMinutes }, userId = null) => {
  const advocate = await prisma.advocate.findUnique({
    where: { id: advocateId }
  });

  if (!advocate) {
    const error = new Error('Advocate not found.');
    error.statusCode = 404;
    throw error;
  }

  assertAdvocateBookable(advocate);

  const startDate = new Date(startAt);
  if (isNaN(startDate.getTime())) {
    const error = new Error('Invalid ISO date format for startAt.');
    error.statusCode = 400;
    error.code = 'INVALID_SLOT';
    throw error;
  }

  const durationMinutes = validateDurationAndDay(mode, advocate, startDate, rawDurationMinutes);
  const breakdown = quote(advocate, mode, durationMinutes, startAt);
  const { startAt: slotStart, endAt: slotEnd } = validateStart(mode, startAt, durationMinutes);

  const free = await isSlotFree(advocateId, slotStart, slotEnd, prisma, null, userId);
  if (!free) {
    const error = new Error(`The advocate is not available for the full ${durationMinutes} minutes. Please choose a shorter duration or another time.`);
    error.statusCode = 409;
    error.code = 'SLOT_TAKEN';
    throw error;
  }

  if (userId) {
    await checkUserSlotConflict(userId, slotStart, slotEnd, prisma, null, true);
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

let holdMinutesWarned = false;
export const getAdvocateBookingHoldMinutes = () => {
  const raw = process.env.ADVOCATE_BOOKING_HOLD_MINUTES;
  if (!raw || String(raw).trim() === '') {
    return 10;
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 3 || parsed > 30) {
    if (!holdMinutesWarned) {
      console.warn(`[Config Warning] Invalid ADVOCATE_BOOKING_HOLD_MINUTES "${raw}". Must be an integer between 3 and 30. Defaulting to 10.`);
      holdMinutesWarned = true;
    }
    return 10;
  }
  return parsed;
};

export const resetHoldMinutesWarned = () => {
  holdMinutesWarned = false;
};

let testRzpClient = null;
export const setAdvocateBookingRzpClient = (client) => {
  testRzpClient = client;
};
const getEffectiveRzpClient = () => testRzpClient || getRazorpayClient();

/**
 * Checks payments of a Razorpay order with a 5000ms timeout.
 */
export const checkRazorpayOrderPayments = async (orderId, rzpClient) => {
  const client = rzpClient || getEffectiveRzpClient();
  if (!client) {
    return { status: 'TIMEOUT_OR_ERROR', payments: [] };
  }
  let timer;
  try {
    const fetchPromise = client.orders.fetchPayments(orderId);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Razorpay request timeout')), 5000);
    });
    const rzpResponse = await Promise.race([fetchPromise, timeoutPromise]);
    clearTimeout(timer);
    const items = (rzpResponse && rzpResponse.items) || [];
    const hasCapturedOrAuthorized = items.some((p) => p.status === 'captured' || p.status === 'authorized');
    if (hasCapturedOrAuthorized) {
      return { status: 'PAID', payments: items };
    }
    const hasPending = items.some((p) => p.status === 'created');
    if (hasPending) {
      return { status: 'PENDING', payments: items };
    }
    return { status: 'RELEASE', payments: items };
  } catch (err) {
    if (timer) clearTimeout(timer);
    console.error(`[Razorpay Check] Error for order ${orderId}:`, err.message);
    return { status: 'TIMEOUT_OR_ERROR', payments: [] };
  }
};

/**
 * Cancels an advocate booking checkout safely.
 */
export const cancelAdvocateBookingCheckout = async ({ checkoutId, userId }) => {
  const payment = await prisma.payment.findUnique({
    where: { id: checkoutId },
    include: { advocateBooking: true }
  });

  if (!payment || payment.userId !== userId || payment.purpose !== 'ADVOCATE_BOOKING') {
    const error = new Error('Checkout not found.');
    error.statusCode = 404;
    throw error;
  }

  // 1. If already confirmed
  if (payment.advocateBooking?.status === 'CONFIRMED' || payment.status === 'PAID') {
    return {
      success: true,
      result: 'PAID',
      message: 'Payment received. Your booking is confirmed.',
      bookingId: payment.advocateBooking?.bookingId || undefined
    };
  }

  // 2. If already closed/expired
  if (
    payment.advocateBooking?.status === 'EXPIRED' ||
    payment.status === 'EXPIRED' ||
    payment.status === 'FAILED'
  ) {
    return {
      success: true,
      result: 'ALREADY_CLOSED',
      status: 'EXPIRED'
    };
  }

  if (payment.advocateBooking?.status !== 'HOLD') {
    return {
      success: true,
      result: 'ALREADY_CLOSED',
      status: payment.advocateBooking?.status || 'EXPIRED'
    };
  }

  // 3. Status is HOLD -> ask Razorpay
  const rzpClient = getEffectiveRzpClient();
  const rzpCheck = await checkRazorpayOrderPayments(payment.razorpayOrderId, rzpClient);

  if (rzpCheck.status === 'PAID') {
    const synced = await syncPaymentFromRazorpay({ paymentId: payment.id });
    return {
      success: true,
      result: 'PAID',
      message: 'Payment received. Your booking is confirmed.',
      bookingId: synced.advocateBooking?.bookingId || payment.advocateBooking?.bookingId
    };
  }

  if (rzpCheck.status === 'PENDING') {
    return {
      success: true,
      result: 'PAYMENT_PROCESSING',
      message: "Your payment is being confirmed. Please don't pay again."
    };
  }

  if (rzpCheck.status === 'TIMEOUT_OR_ERROR') {
    return {
      success: true,
      result: 'HOLD_KEPT',
      message: "We couldn't confirm the payment status right now. The slot will be released automatically in a few minutes."
    };
  }

  // rzpCheck.status === 'RELEASE': no payments, or only failed
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.advocateBooking.findUnique({
      where: { id: payment.advocateBookingId },
      select: { id: true, status: true }
    });
    if (fresh && fresh.status === 'HOLD') {
      await tx.advocateBooking.update({
        where: { id: payment.advocateBookingId },
        data: { status: 'EXPIRED' }
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'EXPIRED',
          failureReason: 'USER_CANCELLED'
        }
      });
    }
  });

  return {
    success: true,
    result: 'RELEASED',
    message: 'Slot released.'
  };
};

/**
 * Creates or reuses a checkout order for an advocate appointment.
 */
export const createAdvocateBookingCheckout = async ({ userId, advocateId, mode, startAt, durationMinutes: rawDurationMinutes }) => {
  if (!isPaymentsEnabled()) {
    const err = new Error('Payments are currently disabled on this platform.');
    err.statusCode = 400;
    err.code = 'PAYMENTS_DISABLED';
    throw err;
  }

  const rzpClient = getEffectiveRzpClient();
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

  const startDate = new Date(startAt);
  if (isNaN(startDate.getTime())) {
    const error = new Error('Invalid ISO date format for startAt.');
    error.statusCode = 400;
    error.code = 'INVALID_SLOT';
    throw error;
  }

  const durationMinutes = validateDurationAndDay(mode, advocate, startDate, rawDurationMinutes);
  const pricing = quote(advocate, mode, durationMinutes, startAt);
  const { startAt: slotStart, endAt: slotEnd } = validateStart(mode, startAt, durationMinutes);

  const now = new Date();
  let oldHoldToRelease = null;

  // 1. Reuse Rule: Check if this user already has an active HOLD for the same advocate and startAt
  const existingPayment = await prisma.payment.findFirst({
    where: {
      userId,
      purpose: 'ADVOCATE_BOOKING',
      advocateBooking: {
        advocateId,
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
      const isSameMode = synced.advocateBooking?.mode === mode;
      const isSameDuration = synced.advocateBooking?.durationMinutes === durationMinutes;

      if (isSameMode && isSameDuration) {
        // Reuse the existing Razorpay order and HOLD
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
      } else {
        // Different duration or mode: mark old hold to be released in the transaction
        oldHoldToRelease = {
          paymentId: synced.id,
          bookingId: synced.advocateBookingId
        };
      }
    }
  }

  // 1.5 Safety check: Check for OTHER active HOLDs of this user (any advocate/time)
  const otherActivePayments = await prisma.payment.findMany({
    where: {
      userId,
      purpose: 'ADVOCATE_BOOKING',
      status: 'CREATED',
      expiresAt: { gt: now },
      ...(existingPayment ? { id: { not: existingPayment.id } } : {}),
      advocateBooking: {
        status: 'HOLD'
      }
    },
    include: { advocateBooking: true }
  });

  for (const otherPay of otherActivePayments) {
    const check = await checkRazorpayOrderPayments(otherPay.razorpayOrderId, rzpClient);
    if (check.status === 'PAID') {
      await syncPaymentFromRazorpay({ paymentId: otherPay.id });
      const err = new Error('Your previous payment is still being processed by the bank. Please wait — do not pay again.');
      err.statusCode = 409;
      err.code = 'PAYMENT_PROCESSING';
      err.checkoutId = otherPay.id;
      throw err;
    }
    if (check.status === 'PENDING') {
      const err = new Error('Your previous payment is still being processed by the bank. Please wait — do not pay again.');
      err.statusCode = 409;
      err.code = 'PAYMENT_PROCESSING';
      err.checkoutId = otherPay.id;
      throw err;
    }
    if (check.status === 'RELEASE') {
      await prisma.$transaction(async (tx) => {
        await tx.advocateBooking.update({
          where: { id: otherPay.advocateBookingId },
          data: { status: 'EXPIRED' }
        });
        await tx.payment.update({
          where: { id: otherPay.id },
          data: { status: 'EXPIRED', failureReason: 'USER_CANCELLED' }
        });
      });
    }
  }

  // 2. New Booking Checkout
  const holdMinutes = getAdvocateBookingHoldMinutes();
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
        mode,
        durationMinutes: String(durationMinutes)
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

        // If replacing an old HOLD with different duration or mode, cancel/release it first
        if (oldHoldToRelease) {
          await tx.advocateBooking.update({
            where: { id: oldHoldToRelease.bookingId },
            data: { status: 'EXPIRED' }
          });
          await tx.payment.update({
            where: { id: oldHoldToRelease.paymentId },
            data: { status: 'FAILED' }
          });
        }

        // Check user conflict across all advocates (ignoring user's own holds since they are being replaced/released)
        await checkUserSlotConflict(userId, slotStart, slotEnd, tx, null, true);

        // Check advocate slot availability (excluding this user's own hold for this advocate if any)
        const slotFree = await isSlotFree(advocateId, slotStart, slotEnd, tx, null, userId);
        if (!slotFree) {
          const err = new Error(`The advocate is not available for the full ${durationMinutes} minutes. Please choose a shorter duration or another time.`);
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
