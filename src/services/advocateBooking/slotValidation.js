import prisma from '../../lib/prisma.js';
import { getModeDurationMinutes } from './pricing.js';

export const DEFAULT_BOOKING_TIMEZONE = 'Asia/Kolkata';

/**
 * Validates a requested slot start time.
 * Enforces:
 * - Valid ISO timestamp
 * - Aligned to ADVOCATE_BOOKING_SLOT_MINUTES grid (e.g. 0, 15, 30, 45)
 * - Seconds and milliseconds are 0
 * - In the future by at least ADVOCATE_BOOKING_MIN_LEAD_MINUTES
 * - Within ADVOCATE_BOOKING_MAX_DAYS_AHEAD
 *
 * @param {string} mode - VOICE_CALL | VIDEO_CALL | IN_PERSON
 * @param {string|Date} startAtInput - ISO 8601 date string or Date
 * @returns {{ startAt: Date, endAt: Date, durationMinutes: number }}
 */
export const validateStart = (mode, startAtInput) => {
  if (!startAtInput) {
    const error = new Error('Slot start time (startAt) is required.');
    error.statusCode = 400;
    error.code = 'INVALID_SLOT';
    throw error;
  }

  const startAt = new Date(startAtInput);
  if (isNaN(startAt.getTime())) {
    const error = new Error('Invalid ISO date format for startAt.');
    error.statusCode = 400;
    error.code = 'INVALID_SLOT';
    throw error;
  }

  const slotMinutes = parseInt(process.env.ADVOCATE_BOOKING_SLOT_MINUTES || '15', 10);
  const minLeadMinutes = parseInt(process.env.ADVOCATE_BOOKING_MIN_LEAD_MINUTES || '30', 10);
  const maxDaysAhead = parseInt(process.env.ADVOCATE_BOOKING_MAX_DAYS_AHEAD || '30', 10);
  const durationMinutes = getModeDurationMinutes(mode);

  // Check seconds and milliseconds are 0
  if (startAt.getUTCSeconds() !== 0 || startAt.getUTCMilliseconds() !== 0) {
    const error = new Error('Slot start time must have 0 seconds and milliseconds.');
    error.statusCode = 400;
    error.code = 'INVALID_SLOT';
    throw error;
  }

  // Check minute alignment (must be multiple of slotMinutes)
  const tz = process.env.BOOKING_TIMEZONE || DEFAULT_BOOKING_TIMEZONE;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    minute: 'numeric'
  });
  const minuteInTz = parseInt(formatter.format(startAt), 10);

  if (minuteInTz % slotMinutes !== 0) {
    const error = new Error(
      `Slot start time minute (${minuteInTz}) must be a multiple of ${slotMinutes} minutes.`
    );
    error.statusCode = 400;
    error.code = 'INVALID_SLOT';
    throw error;
  }

  const now = new Date();
  const minStartTime = new Date(now.getTime() + minLeadMinutes * 60 * 1000);
  const maxStartTime = new Date(now.getTime() + maxDaysAhead * 24 * 60 * 60 * 1000);

  if (startAt < minStartTime) {
    const error = new Error(
      `Slot start time must be at least ${minLeadMinutes} minutes in the future.`
    );
    error.statusCode = 400;
    error.code = 'INVALID_SLOT';
    throw error;
  }

  if (startAt > maxStartTime) {
    const error = new Error(
      `Slot start time cannot be more than ${maxDaysAhead} days in advance.`
    );
    error.statusCode = 400;
    error.code = 'INVALID_SLOT';
    throw error;
  }

  const endAt = new Date(startAt.getTime() + durationMinutes * 60 * 1000);

  return {
    startAt,
    endAt,
    durationMinutes
  };
};

/**
 * Checks if a time interval [startAt, endAt) is free for an advocate.
 * Expired HOLD records are lazily treated as free.
 */
export const isSlotFree = async (advocateId, startAt, endAt, tx = prisma, excludeBookingId = null) => {
  const now = new Date();

  const conflictingBooking = await tx.advocateBooking.findFirst({
    where: {
      advocateId,
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      OR: [
        { status: { in: ['CONFIRMED', 'COMPLETED', 'REFUND_PENDING'] } },
        {
          status: 'HOLD',
          holdExpiresAt: { gt: now }
        }
      ]
    },
    select: { id: true }
  });

  return !conflictingBooking;
};

/**
 * Ensures that the user does not have any overlapping bookings (across ANY advocate).
 */
export const checkUserSlotConflict = async (userId, startAt, endAt, tx = prisma, excludeBookingId = null) => {
  const now = new Date();

  const conflictingBooking = await tx.advocateBooking.findFirst({
    where: {
      userId,
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      OR: [
        { status: { in: ['CONFIRMED', 'COMPLETED', 'REFUND_PENDING'] } },
        {
          status: 'HOLD',
          holdExpiresAt: { gt: now }
        }
      ]
    },
    select: { id: true, startAt: true, endAt: true }
  });

  if (conflictingBooking) {
    const error = new Error('You already have another consultation scheduled during this time slot.');
    error.statusCode = 400;
    error.code = 'USER_SLOT_CONFLICT';
    throw error;
  }
};

/**
 * Converts a date string YYYY-MM-DD and time HH:mm:ss.SSS in a specified time zone to a UTC Date.
 */
const getUtcDateFromTz = (dateStr, timeStr, timeZone) => {
  // Approximate with standard ISO string and adjust
  const isoStr = `${dateStr}T${timeStr}Z`;
  const tentativeDate = new Date(isoStr);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  // Calculate timezone offset by formatting tentativeDate
  const parts = formatter.formatToParts(tentativeDate);
  const partMap = {};
  for (const p of parts) partMap[p.type] = p.value;

  const tzDate = new Date(
    `${partMap.year}-${partMap.month}-${partMap.day}T${partMap.hour === '24' ? '00' : partMap.hour}:${partMap.minute}:${partMap.second}Z`
  );
  const offsetMs = tzDate.getTime() - tentativeDate.getTime();

  return new Date(tentativeDate.getTime() - offsetMs);
};

/**
 * Retrieves the busy intervals for an advocate for a given date (YYYY-MM-DD) in BOOKING_TIMEZONE.
 * Returns strictly no user data.
 */
export const getAdvocateBusySlots = async (advocateId, dateString, tx = prisma) => {
  const tz = process.env.BOOKING_TIMEZONE || DEFAULT_BOOKING_TIMEZONE;

  // Validate YYYY-MM-DD
  if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const error = new Error('Invalid date format. Expected YYYY-MM-DD.');
    error.statusCode = 400;
    error.code = 'INVALID_DATE';
    throw error;
  }

  const startOfDayUtc = getUtcDateFromTz(dateString, '00:00:00.000', tz);
  const endOfDayUtc = getUtcDateFromTz(dateString, '23:59:59.999', tz);

  const now = new Date();

  const busyBookings = await tx.advocateBooking.findMany({
    where: {
      advocateId,
      startAt: { lt: endOfDayUtc },
      endAt: { gt: startOfDayUtc },
      OR: [
        { status: { in: ['CONFIRMED', 'COMPLETED', 'REFUND_PENDING'] } },
        {
          status: 'HOLD',
          holdExpiresAt: { gt: now }
        }
      ]
    },
    select: {
      startAt: true,
      endAt: true
    },
    orderBy: {
      startAt: 'asc'
    }
  });

  return {
    date: dateString,
    timezone: tz,
    busy: busyBookings.map((b) => ({
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString()
    }))
  };
};
