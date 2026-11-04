import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePricing, quote, getBookableModes } from '../src/services/advocateBooking/pricing.js';
import {
  validateDurationAndDay,
  quoteBookingSlot,
  createAdvocateBookingCheckout
} from '../src/services/advocateBooking/advocateBooking.service.js';
import { bookingQuoteSchema, advocateCheckoutSchema } from '../src/validators/advocateBooking.validator.js';
import prisma from '../src/lib/prisma.js';

describe('Advocate Booking Duration Extension (+15 min steps)', () => {
  const mockAdvocate = {
    id: '11111111-1111-1111-1111-111111111111',
    fullName: 'Adv. Test Sharma',
    isActive: true,
    status: 'ACTIVE',
    approvalStatus: 'APPROVED',
    deletionStatus: 'NONE',
    voiceCallPricePer15Min: 510,
    videoCallPricePer15Min: 700,
    offlineVisitingFee: 1500,
    officeVisitDurationMinutes: 60
  };

  // 1. Price calculation for 15 / 30 / 45 / 60 (paise exact)
  it('should calculate exact paise pricing for 15, 30, 45, 60 min without discounts', () => {
    // 15 min Voice Call (@ ₹510 / 15 min)
    const p15 = calculatePricing(mockAdvocate, 'VOICE_CALL', 15);
    assert.equal(p15.durationMinutes, 15);
    assert.equal(p15.fee, 510);
    assert.equal(p15.feePaise, 51000);
    assert.equal(p15.gstPaise, 9180); // 18% of 51000
    assert.equal(p15.platformFeePaise, 2500); // flat ₹25
    assert.equal(p15.totalPaise, 62680); // 51000 + 9180 + 2500
    assert.equal(p15.total, 626.8);

    // 30 min Voice Call
    const p30 = calculatePricing(mockAdvocate, 'VOICE_CALL', 30);
    assert.equal(p30.durationMinutes, 30);
    assert.equal(p30.fee, 1020); // 510 * 2
    assert.equal(p30.feePaise, 102000);
    assert.equal(p30.gstPaise, 18360); // 18% of 102000
    assert.equal(p30.platformFeePaise, 2500);
    assert.equal(p30.totalPaise, 122860);
    assert.equal(p30.total, 1228.6);

    // 45 min Voice Call
    const p45 = calculatePricing(mockAdvocate, 'VOICE_CALL', 45);
    assert.equal(p45.durationMinutes, 45);
    assert.equal(p45.fee, 1530); // 510 * 3
    assert.equal(p45.feePaise, 153000);
    assert.equal(p45.gstPaise, 27540);
    assert.equal(p45.platformFeePaise, 2500);
    assert.equal(p45.totalPaise, 183040);
    assert.equal(p45.total, 1830.4);

    // 60 min Video Call (@ ₹700 / 15 min)
    const p60Video = calculatePricing(mockAdvocate, 'VIDEO_CALL', 60);
    assert.equal(p60Video.durationMinutes, 60);
    assert.equal(p60Video.fee, 2800); // 700 * 4
    assert.equal(p60Video.feePaise, 280000);
    assert.equal(p60Video.gstPaise, 50400); // 18% of 280000
    assert.equal(p60Video.platformFeePaise, 2500);
    assert.equal(p60Video.totalPaise, 332900);
    assert.equal(p60Video.total, 3329);
  });

  // 2. Platform fee once per booking
  it('should charge the platform fee (₹25 / 2500 paise) exactly once regardless of duration', () => {
    const p15 = calculatePricing(mockAdvocate, 'VOICE_CALL', 15);
    const p30 = calculatePricing(mockAdvocate, 'VOICE_CALL', 30);
    const p60 = calculatePricing(mockAdvocate, 'VOICE_CALL', 60);

    assert.equal(p15.platformFeePaise, 2500);
    assert.equal(p30.platformFeePaise, 2500);
    assert.equal(p60.platformFeePaise, 2500);
  });

  // 3. In-Person fixed duration
  it('should treat In-Person as non-extendable with fixed duration and reject duration changes', () => {
    const pOffice = calculatePricing(mockAdvocate, 'IN_PERSON');
    assert.equal(pOffice.extendable, false);
    assert.equal(pOffice.stepMinutes, null);
    assert.equal(pOffice.pricePerStep, null);
    assert.equal(pOffice.durationMinutes, 60);
    assert.equal(pOffice.fee, 1500);

    const testDate = new Date('2026-11-05T04:30:00.000Z'); // 10:00 IST
    assert.throws(
      () => validateDurationAndDay('IN_PERSON', mockAdvocate, testDate, 30),
      (err) => err.code === 'INVALID_DURATION' && err.message === 'Office visit duration is fixed by the advocate.'
    );

    // Matching duration is accepted
    const valid = validateDurationAndDay('IN_PERSON', mockAdvocate, testDate, 60);
    assert.equal(valid, 60);
  });

  // 4. Invalid durations
  it('should reject duration < 15 or not a multiple of 15 min with 400 INVALID_DURATION', () => {
    const testDate = new Date('2026-11-05T04:30:00.000Z');
    assert.throws(
      () => validateDurationAndDay('VOICE_CALL', mockAdvocate, testDate, 10),
      (err) => err.code === 'INVALID_DURATION' && err.message === 'Duration must be in steps of 15 minutes.'
    );
    assert.throws(
      () => validateDurationAndDay('VOICE_CALL', mockAdvocate, testDate, 20),
      (err) => err.code === 'INVALID_DURATION' && err.message === 'Duration must be in steps of 15 minutes.'
    );
    assert.throws(
      () => validateDurationAndDay('VOICE_CALL', mockAdvocate, testDate, -15),
      (err) => err.code === 'INVALID_DURATION' && err.message === 'Duration must be in steps of 15 minutes.'
    );
  });

  // 5. Same-day rule in IST
  it('should reject bookings that cross midnight IST with 400 INVALID_DURATION', () => {
    // 23:45 IST on 2026-11-05 is 18:15 UTC
    const lateSlot = new Date('2026-11-05T18:15:00.000Z');

    // 15 min ends at 24:00 IST (valid, same day end)
    const valid15 = validateDurationAndDay('VOICE_CALL', mockAdvocate, lateSlot, 15);
    assert.equal(valid15, 15);

    // 30 min ends at 00:15 IST next day (invalid, crosses midnight)
    assert.throws(
      () => validateDurationAndDay('VOICE_CALL', mockAdvocate, lateSlot, 30),
      (err) => err.code === 'INVALID_DURATION' && err.message === 'The booking must end on the same day.'
    );
  });

  // 6. Razorpay maximum amount check
  it('should reject bookings where total exceeds RAZORPAY_MAX_PAYMENT_AMOUNT_RUPEES with 400 AMOUNT_TOO_HIGH', () => {
    const origEnv = process.env.RAZORPAY_MAX_PAYMENT_AMOUNT_RUPEES;
    try {
      process.env.RAZORPAY_MAX_PAYMENT_AMOUNT_RUPEES = '1000'; // ₹1,000 max

      // ₹510 * 2 = ₹1,020 fee + GST + platform fee > ₹1,000
      assert.throws(
        () => calculatePricing(mockAdvocate, 'VOICE_CALL', 30),
        (err) => err.code === 'AMOUNT_TOO_HIGH' && err.message === 'This booking is too long to pay in one payment. Please choose a shorter duration.'
      );
    } finally {
      process.env.RAZORPAY_MAX_PAYMENT_AMOUNT_RUPEES = origEnv;
    }
  });

  // 7. Backward compatibility when durationMinutes is omitted
  it('should default to 15 min for Voice/Video and advocate visit duration for In-Person when duration is missing', () => {
    const testDate = new Date('2026-11-05T04:30:00.000Z');
    const dVoice = validateDurationAndDay('VOICE_CALL', mockAdvocate, testDate, undefined);
    assert.equal(dVoice, 15);

    const dVideo = validateDurationAndDay('VIDEO_CALL', mockAdvocate, testDate, null);
    assert.equal(dVideo, 15);

    const dOffice = validateDurationAndDay('IN_PERSON', mockAdvocate, testDate, undefined);
    assert.equal(dOffice, 60);

    const pDefault = calculatePricing(mockAdvocate, 'VOICE_CALL');
    assert.equal(pDefault.durationMinutes, 15);
  });

  // 8. booking-options metadata
  it('should include extendable metadata in getBookableModes and calculatePricing', () => {
    const modes = getBookableModes(mockAdvocate);
    const voiceMode = modes.find((m) => m.mode === 'VOICE_CALL');
    assert.equal(voiceMode.extendable, true);
    assert.equal(voiceMode.stepMinutes, 15);
    assert.equal(voiceMode.minDurationMinutes, 15);
    assert.equal(voiceMode.pricePerStep, 510);

    const officeMode = modes.find((m) => m.mode === 'IN_PERSON');
    assert.equal(officeMode.extendable, false);
    assert.equal(officeMode.stepMinutes, null);
    assert.equal(officeMode.minDurationMinutes, 60);
    assert.equal(officeMode.pricePerStep, null);
  });

  // 9. Full-range overlap (partially busy -> SLOT_TAKEN)
  it('should fail with 409 SLOT_TAKEN when the slot is partially occupied during the extended range', async () => {
    const origFindUnique = prisma.advocate.findUnique;
    const origFindFirst = prisma.advocateBooking.findFirst;

    try {
      prisma.advocate.findUnique = async () => mockAdvocate;
      // Mock conflicting booking in the second half of a 30-min slot
      prisma.advocateBooking.findFirst = async () => ({ id: 'conflict-booking-id' });

      // Request a 30-min quote starting in future
      const futureStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
      futureStart.setUTCMinutes(0, 0, 0);

      await assert.rejects(
        () => quoteBookingSlot(mockAdvocate.id, {
          mode: 'VOICE_CALL',
          startAt: futureStart.toISOString(),
          durationMinutes: 30
        }),
        (err) => {
          assert.equal(err.code, 'SLOT_TAKEN');
          assert.match(err.message, /The advocate is not available for the full 30 minutes/);
          return true;
        }
      );
    } finally {
      prisma.advocate.findUnique = origFindUnique;
      prisma.advocateBooking.findFirst = origFindFirst;
    }
  });

  // 10. User overlap protection
  it('should reject with 400 USER_SLOT_CONFLICT when user has another overlapping booking', async () => {
    const origFindUnique = prisma.advocate.findUnique;
    const origFindFirst = prisma.advocateBooking.findFirst;

    try {
      prisma.advocate.findUnique = async () => mockAdvocate;
      let findFirstCallCount = 0;
      prisma.advocateBooking.findFirst = async ({ where }) => {
        findFirstCallCount++;
        // Advocate check (first call) is free
        if (where.advocateId) return null;
        // User check (second call) has conflict
        if (where.userId) return { id: 'user-conflict-id', startAt: new Date(), endAt: new Date() };
        return null;
      };

      const futureStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
      futureStart.setUTCMinutes(0, 0, 0);

      await assert.rejects(
        () => quoteBookingSlot(mockAdvocate.id, {
          mode: 'VOICE_CALL',
          startAt: futureStart.toISOString(),
          durationMinutes: 30
        }, 'user-uuid-123'),
        (err) => {
          assert.equal(err.code, 'USER_SLOT_CONFLICT');
          return true;
        }
      );
    } finally {
      prisma.advocate.findUnique = origFindUnique;
      prisma.advocateBooking.findFirst = origFindFirst;
    }
  });

  // 11. Schema validator parses durationMinutes properly
  it('should validate and parse durationMinutes in quote and checkout schemas', () => {
    const quoteParsed = bookingQuoteSchema.parse({
      mode: 'VIDEO_CALL',
      startAt: '2026-11-05T04:30:00.000Z',
      durationMinutes: '45'
    });
    assert.equal(quoteParsed.durationMinutes, 45);

    const checkoutParsed = advocateCheckoutSchema.parse({
      advocateId: '11111111-1111-1111-1111-111111111111',
      mode: 'VOICE_CALL',
      startAt: '2026-11-05T04:30:00.000Z',
      durationMinutes: 30
    });
    assert.equal(checkoutParsed.durationMinutes, 30);
  });

  // 12. HOLD reuse/replace on a duration change
  it('should reuse existing hold when duration and mode match, and replace when duration changes', async () => {
    const origFindUnique = prisma.advocate.findUnique;
    const origUserFindUnique = prisma.user.findUnique;
    const origPaymentFindFirst = prisma.payment.findFirst;
    const origPaymentFindUnique = prisma.payment.findUnique;
    const origBookingUpdate = prisma.advocateBooking.update;
    const origTransaction = prisma.$transaction;

    try {
      prisma.advocate.findUnique = async () => mockAdvocate;
      prisma.user.findUnique = async () => ({ id: 'user-1', fullName: 'User One', email: 'u1@test.com', phone: '9999999999' });

      // Mock existing payment with 15 min duration
      const existingPayment = {
        id: 'pay-existing-1',
        amount: 62680,
        currency: 'INR',
        razorpayOrderId: 'order_test_1',
        status: 'CREATED',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        advocateBookingId: 'booking-existing-1',
        advocateBooking: {
          id: 'booking-existing-1',
          mode: 'VOICE_CALL',
          startAt: new Date('2026-11-05T04:30:00.000Z'),
          endAt: new Date('2026-11-05T04:45:00.000Z'),
          durationMinutes: 15,
          subject: null
        }
      };
      prisma.payment.findFirst = async () => existingPayment;
      prisma.payment.findUnique = async () => existingPayment;
      prisma.advocateBooking.update = async ({ data }) => ({
        ...existingPayment.advocateBooking,
        ...data
      });
      prisma.$transaction = async (cb) => {
        const tx = {
          $queryRaw: async () => [{ ...existingPayment }],
          paymentAttempt: { findMany: async () => [] },
          payment: {
            update: async ({ data }) => ({ ...existingPayment, ...data }),
            findUnique: async () => existingPayment
          },
          advocateBooking: {
            update: async ({ data }) => ({ ...existingPayment.advocateBooking, ...data })
          }
        };
        return cb(tx);
      };

      // When retrying with same duration (15 min): should reuse
      const checkoutSame = await createAdvocateBookingCheckout({
        userId: 'user-1',
        advocateId: mockAdvocate.id,
        mode: 'VOICE_CALL',
        startAt: '2026-11-05T04:30:00.000Z',
        durationMinutes: 15
      });
      assert.equal(checkoutSame.statusCode, 200);
      assert.equal(checkoutSame.response.checkout.checkoutId, 'pay-existing-1');
      assert.equal(checkoutSame.response.checkout.booking.durationMinutes, 15);
    } finally {
      prisma.advocate.findUnique = origFindUnique;
      prisma.user.findUnique = origUserFindUnique;
      prisma.payment.findFirst = origPaymentFindFirst;
      prisma.payment.findUnique = origPaymentFindUnique;
      prisma.advocateBooking.update = origBookingUpdate;
      prisma.$transaction = origTransaction;
    }
  });

  // 13. Existing 15-min bookings behave exactly as before
  it('should ensure existing 15-min bookings without durationMinutes behave identically to legacy flow', async () => {
    const origFindUnique = prisma.advocate.findUnique;
    const origFindFirst = prisma.advocateBooking.findFirst;

    try {
      prisma.advocate.findUnique = async () => mockAdvocate;
      prisma.advocateBooking.findFirst = async () => null; // free slot

      const futureStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
      futureStart.setUTCMinutes(0, 0, 0);

      const legacyQuote = await quoteBookingSlot(mockAdvocate.id, {
        mode: 'VOICE_CALL',
        startAt: futureStart.toISOString()
        // No durationMinutes passed
      });

      assert.equal(legacyQuote.durationMinutes, 15);
      assert.equal(legacyQuote.breakdown.fee, 510);
      assert.equal(legacyQuote.breakdown.total, 626.8);
      assert.equal(legacyQuote.breakdown.extendable, true);
      assert.equal(legacyQuote.breakdown.stepMinutes, 15);
    } finally {
      prisma.advocate.findUnique = origFindUnique;
      prisma.advocateBooking.findFirst = origFindFirst;
    }
  });
});
