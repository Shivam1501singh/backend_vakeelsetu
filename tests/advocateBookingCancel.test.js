import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/lib/prisma.js';
import {
  cancelAdvocateBookingCheckout,
  createAdvocateBookingCheckout,
  quoteBookingSlot,
  getAdvocateBookingHoldMinutes,
  resetHoldMinutesWarned,
  setAdvocateBookingRzpClient,
  getAdvocateBusySlots
} from '../src/services/advocateBooking/advocateBooking.service.js';
import {
  isSlotFree,
  checkUserSlotConflict,
  getAdvocateBusySlots as slotValidationGetAdvocateBusySlots
} from '../src/services/advocateBooking/slotValidation.js';
import { syncPaymentFromRazorpay, setPaymentRzpClient } from '../src/services/payment.service.js';

describe('Advocate Booking Cancel & Safe Hold Release', () => {
  const mockAdvocateId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const otherUserId = '33333333-3333-3333-3333-333333333333';

  // Helper for dynamic future date aligned to 15 min
  const getFutureSlot = (hoursAhead = 2) => {
    const start = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    return { start, end };
  };

  // -------------------------------------------------------------
  // 1. Cancel Checkout API logic
  // -------------------------------------------------------------
  describe('Task 1: Cancel Checkout Service', () => {
    it('returns 404 when checkout does not exist or user is not the owner', async () => {
      const origFindUnique = prisma.payment.findUnique;
      try {
        prisma.payment.findUnique = async () => null;
        await assert.rejects(
          async () => {
            await cancelAdvocateBookingCheckout({ checkoutId: 'non-existent', userId: mockUserId });
          },
          (err) => {
            assert.equal(err.statusCode, 404);
            assert.equal(err.message, 'Checkout not found.');
            return true;
          }
        );

        // Different user ID
        prisma.payment.findUnique = async () => ({
          id: 'pay-1',
          userId: otherUserId,
          purpose: 'ADVOCATE_BOOKING',
          advocateBooking: { status: 'HOLD' }
        });
        await assert.rejects(
          async () => {
            await cancelAdvocateBookingCheckout({ checkoutId: 'pay-1', userId: mockUserId });
          },
          (err) => {
            assert.equal(err.statusCode, 404);
            return true;
          }
        );
      } finally {
        prisma.payment.findUnique = origFindUnique;
      }
    });

    it('returns PAID when booking is already CONFIRMED', async () => {
      const origFindUnique = prisma.payment.findUnique;
      try {
        prisma.payment.findUnique = async () => ({
          id: 'pay-confirmed',
          userId: mockUserId,
          purpose: 'ADVOCATE_BOOKING',
          status: 'PAID',
          advocateBooking: {
            id: 'book-confirmed',
            status: 'CONFIRMED',
            bookingId: 'VLB-2026NOV999999'
          }
        });

        const res = await cancelAdvocateBookingCheckout({ checkoutId: 'pay-confirmed', userId: mockUserId });
        assert.equal(res.success, true);
        assert.equal(res.result, 'PAID');
        assert.equal(res.bookingId, 'VLB-2026NOV999999');
      } finally {
        prisma.payment.findUnique = origFindUnique;
      }
    });

    it('returns ALREADY_CLOSED when booking is already EXPIRED / cancelled', async () => {
      const origFindUnique = prisma.payment.findUnique;
      try {
        prisma.payment.findUnique = async () => ({
          id: 'pay-expired',
          userId: mockUserId,
          purpose: 'ADVOCATE_BOOKING',
          status: 'EXPIRED',
          advocateBooking: {
            id: 'book-expired',
            status: 'EXPIRED'
          }
        });

        const res = await cancelAdvocateBookingCheckout({ checkoutId: 'pay-expired', userId: mockUserId });
        assert.equal(res.success, true);
        assert.equal(res.result, 'ALREADY_CLOSED');
        assert.equal(res.status, 'EXPIRED');
      } finally {
        prisma.payment.findUnique = origFindUnique;
      }
    });

    it('releases slot (RELEASED) when Razorpay reports no payment attempts or only failed', async () => {
      const origFindUnique = prisma.payment.findUnique;
      const origTransaction = prisma.$transaction;

      let bookingUpdatedStatus = null;
      let paymentUpdatedStatus = null;
      let failureReasonRecorded = null;

      try {
        prisma.payment.findUnique = async () => ({
          id: 'pay-hold-1',
          userId: mockUserId,
          purpose: 'ADVOCATE_BOOKING',
          status: 'CREATED',
          razorpayOrderId: 'order_empty_attempts',
          advocateBookingId: 'book-hold-1',
          advocateBooking: {
            id: 'book-hold-1',
            status: 'HOLD'
          }
        });

        setAdvocateBookingRzpClient({
          orders: {
            fetchPayments: async () => ({ items: [{ id: 'attempt-1', status: 'failed' }] })
          }
        });

        prisma.$transaction = async (cb) => {
          const tx = {
            advocateBooking: {
              findUnique: async () => ({ id: 'book-hold-1', status: 'HOLD' }),
              update: async ({ data }) => {
                bookingUpdatedStatus = data.status;
                return { id: 'book-hold-1', status: data.status };
              }
            },
            payment: {
              update: async ({ data }) => {
                paymentUpdatedStatus = data.status;
                failureReasonRecorded = data.failureReason;
                return { id: 'pay-hold-1', ...data };
              }
            }
          };
          return cb(tx);
        };

        const res = await cancelAdvocateBookingCheckout({ checkoutId: 'pay-hold-1', userId: mockUserId });
        assert.equal(res.success, true);
        assert.equal(res.result, 'RELEASED');
        assert.equal(res.message, 'Slot released.');
        assert.equal(bookingUpdatedStatus, 'EXPIRED');
        assert.equal(paymentUpdatedStatus, 'EXPIRED');
        assert.equal(failureReasonRecorded, 'USER_CANCELLED');
      } finally {
        prisma.payment.findUnique = origFindUnique;
        prisma.$transaction = origTransaction;
        setAdvocateBookingRzpClient(null);
      }
    });

    it('returns PAYMENT_PROCESSING and keeps hold when payment attempt is created (pending)', async () => {
      const origFindUnique = prisma.payment.findUnique;

      try {
        prisma.payment.findUnique = async () => ({
          id: 'pay-hold-pending',
          userId: mockUserId,
          purpose: 'ADVOCATE_BOOKING',
          status: 'CREATED',
          razorpayOrderId: 'order_pending_attempt',
          advocateBookingId: 'book-hold-pending',
          advocateBooking: {
            id: 'book-hold-pending',
            status: 'HOLD'
          }
        });

        setAdvocateBookingRzpClient({
          orders: {
            fetchPayments: async () => ({ items: [{ id: 'attempt-pending', status: 'created' }] })
          }
        });

        const res = await cancelAdvocateBookingCheckout({ checkoutId: 'pay-hold-pending', userId: mockUserId });
        assert.equal(res.success, true);
        assert.equal(res.result, 'PAYMENT_PROCESSING');
        assert.match(res.message, /payment is being confirmed/);
      } finally {
        prisma.payment.findUnique = origFindUnique;
        setAdvocateBookingRzpClient(null);
      }
    });

    it('returns PAID and triggers confirmation when payment was captured/authorized', async () => {
      const origFindUnique = prisma.payment.findUnique;
      const origFindFirst = prisma.payment.findFirst;
      const origTransaction = prisma.$transaction;
      const origBookingFindFirst = prisma.advocateBooking.findFirst;

      try {
        const paymentObj = {
          id: 'pay-hold-captured',
          userId: mockUserId,
          purpose: 'ADVOCATE_BOOKING',
          amount: 62680,
          currency: 'INR',
          status: 'CREATED',
          razorpayOrderId: 'order_captured',
          advocateBookingId: 'book-hold-captured',
          advocateBooking: {
            id: 'book-hold-captured',
            advocateId: mockAdvocateId,
            startAt: new Date(Date.now() + 2 * 3600 * 1000),
            endAt: new Date(Date.now() + 2 * 3600 * 1000 + 15 * 60 * 1000),
            status: 'HOLD',
            bookingId: 'VLB-2026NOV111111',
            userConfirmationEmailSentAt: new Date(),
            advocateConfirmationEmailSentAt: new Date()
          }
        };

        let paymentState = { ...paymentObj };
        let bookingState = { ...paymentObj.advocateBooking };

        prisma.payment.findUnique = async () => ({
          ...paymentState,
          advocateBooking: bookingState,
          attempts: [{ razorpayPaymentId: 'pay_captured_1', status: 'CAPTURED', amount: 62680 }]
        });
        prisma.payment.findFirst = async () => paymentState;
        prisma.paymentAttempt = {
          upsert: async () => ({})
        };
        prisma.advocateBooking.findFirst = async () => null; // slot is free

        const mockClient = {
          orders: {
            fetchPayments: async () => ({
              items: [{ id: 'pay_captured_1', status: 'captured', amount: 62680, currency: 'INR', order_id: 'order_captured' }]
            })
          }
        };
        setAdvocateBookingRzpClient(mockClient);
        setPaymentRzpClient(mockClient);

        prisma.$transaction = async (cb) => {
          const tx = {
            $queryRaw: async () => [paymentState],
            paymentAttempt: {
              findMany: async () => [
                { razorpayPaymentId: 'pay_captured_1', status: 'CAPTURED', amount: 62680 }
              ]
            },
            payment: {
              findUnique: async () => ({
                ...paymentState,
                attempts: [{ razorpayPaymentId: 'pay_captured_1', status: 'CAPTURED', amount: 62680 }]
              }),
              update: async ({ data }) => {
                paymentState = { ...paymentState, ...data };
                return paymentState;
              }
            },
            advocateBooking: {
              findUnique: async () => bookingState,
              findFirst: async () => null,
              update: async ({ data }) => {
                bookingState = { ...bookingState, ...data };
                return bookingState;
              }
            }
          };
          return cb(tx);
        };

        const res = await cancelAdvocateBookingCheckout({ checkoutId: 'pay-hold-captured', userId: mockUserId });
        assert.equal(res.success, true);
        assert.equal(res.result, 'PAID');
        assert.equal(res.bookingId, 'VLB-2026NOV111111');
      } finally {
        prisma.payment.findUnique = origFindUnique;
        prisma.payment.findFirst = origFindFirst;
        setAdvocateBookingRzpClient(null);
        setPaymentRzpClient(null);
        prisma.$transaction = origTransaction;
        prisma.advocateBooking.findFirst = origBookingFindFirst;
      }
    });

    it('returns HOLD_KEPT when Razorpay errors or times out', async () => {
      const origFindUnique = prisma.payment.findUnique;

      try {
        prisma.payment.findUnique = async () => ({
          id: 'pay-hold-timeout',
          userId: mockUserId,
          purpose: 'ADVOCATE_BOOKING',
          status: 'CREATED',
          razorpayOrderId: 'order_timeout',
          advocateBookingId: 'book-hold-timeout',
          advocateBooking: {
            id: 'book-hold-timeout',
            status: 'HOLD'
          }
        });

        setAdvocateBookingRzpClient({
          orders: {
            fetchPayments: async () => {
              throw new Error('Gateway Connection Timeout');
            }
          }
        });

        const res = await cancelAdvocateBookingCheckout({ checkoutId: 'pay-hold-timeout', userId: mockUserId });
        assert.equal(res.success, true);
        assert.equal(res.result, 'HOLD_KEPT');
        assert.match(res.message, /released automatically/);
      } finally {
        prisma.payment.findUnique = origFindUnique;
        setAdvocateBookingRzpClient(null);
      }
    });
  });

  // -------------------------------------------------------------
  // 2. Own Hold Non-Blocking (Quote, Conflict, Checkout)
  // -------------------------------------------------------------
  describe('Task 2: Own Hold Rules (Quote & Checkout Non-Blocking)', () => {
    it('isSlotFree excludes active HOLD if it belongs to the querying user (excludeUserIdHold)', async () => {
      const origFindFirst = prisma.advocateBooking.findFirst;
      const slot = getFutureSlot(3);

      try {
        // Mock DB returns conflicting booking if not excluded
        prisma.advocateBooking.findFirst = async ({ where }) => {
          const holdCondition = where.OR.find(c => c.status === 'HOLD');
          if (holdCondition && holdCondition.userId && holdCondition.userId.not === mockUserId) {
            // User excluded -> no conflict
            return null;
          }
          // Another user -> conflicting booking
          return { id: 'booking-hold-user1' };
        };

        // Querying with mockUserId excludes mockUserId's own hold -> free
        const freeForOwner = await isSlotFree(mockAdvocateId, slot.start, slot.end, prisma, null, mockUserId);
        assert.equal(freeForOwner, true);

        // Querying for other user -> busy (not free)
        const freeForOther = await isSlotFree(mockAdvocateId, slot.start, slot.end, prisma, null, otherUserId);
        assert.equal(freeForOther, false);
      } finally {
        prisma.advocateBooking.findFirst = origFindFirst;
      }
    });

    it('checkUserSlotConflict ignores own active HOLD when ignoreUserHolds is true', async () => {
      const origFindFirst = prisma.advocateBooking.findFirst;
      const slot = getFutureSlot(3);

      try {
        prisma.advocateBooking.findFirst = async ({ where }) => {
          const hasHold = where.OR.some(c => c.status === 'HOLD');
          if (hasHold) {
            return { id: 'my-own-hold', startAt: slot.start, endAt: slot.end };
          }
          return null;
        };

        // When ignoreUserHolds is true, does NOT throw
        await checkUserSlotConflict(mockUserId, slot.start, slot.end, prisma, null, true);

        // When ignoreUserHolds is false, throws USER_SLOT_CONFLICT
        await assert.rejects(
          async () => {
            await checkUserSlotConflict(mockUserId, slot.start, slot.end, prisma, null, false);
          },
          (err) => {
            assert.equal(err.code, 'USER_SLOT_CONFLICT');
            return true;
          }
        );
      } finally {
        prisma.advocateBooking.findFirst = origFindFirst;
      }
    });

    it('quoteBookingSlot succeeds when user already holds that slot', async () => {
      const origAdvocateFindUnique = prisma.advocate.findUnique;
      const origBookingFindFirst = prisma.advocateBooking.findFirst;
      const slot = getFutureSlot(3);

      try {
        prisma.advocate.findUnique = async () => ({
          id: mockAdvocateId,
          fullName: 'Adv. Test',
          isActive: true,
          status: 'ACTIVE',
          approvalStatus: 'APPROVED',
          deletionStatus: 'NONE',
          voiceCallPricePer15Min: 500,
          videoCallPricePer15Min: 700,
          offlineVisitingFee: 1500,
          officeVisitDurationMinutes: 60
        });

        // isSlotFree with excludeUserIdHold returns true; checkUserSlotConflict with ignoreUserHolds returns true
        prisma.advocateBooking.findFirst = async () => null;

        const quoteRes = await quoteBookingSlot(
          mockAdvocateId,
          { mode: 'VOICE_CALL', startAt: slot.start.toISOString(), durationMinutes: 15 },
          mockUserId
        );

        assert.equal(quoteRes.available, true);
        assert.equal(quoteRes.durationMinutes, 15);
      } finally {
        prisma.advocate.findUnique = origAdvocateFindUnique;
        prisma.advocateBooking.findFirst = origBookingFindFirst;
      }
    });

    it('createAdvocateBookingCheckout auto-releases previous HOLDs across any advocate when user starts new checkout', async () => {
      const origAdvocateFindUnique = prisma.advocate.findUnique;
      const origUserFindUnique = prisma.user.findUnique;
      const origPaymentFindFirst = prisma.payment.findFirst;
      const origPaymentFindMany = prisma.payment.findMany;
      const origTransaction = prisma.$transaction;
      const slot = getFutureSlot(3);

      let otherHoldCancelled = false;

      try {
        prisma.advocate.findUnique = async () => ({
          id: mockAdvocateId,
          fullName: 'Adv. Test',
          isActive: true,
          status: 'ACTIVE',
          approvalStatus: 'APPROVED',
          deletionStatus: 'NONE',
          voiceCallPricePer15Min: 500,
          videoCallPricePer15Min: 700,
          offlineVisitingFee: 1500,
          officeVisitDurationMinutes: 60
        });

        prisma.user.findUnique = async () => ({
          id: mockUserId,
          fullName: 'Test User',
          email: 'test@user.com',
          phone: '9876543210'
        });

        // No existing hold for this slot
        prisma.payment.findFirst = async () => null;

        // One other active hold exists for this user on another slot
        const otherHold = {
          id: 'other-pay-1',
          userId: mockUserId,
          advocateBookingId: 'other-book-1',
          razorpayOrderId: 'other_order_1',
          status: 'CREATED',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          advocateBooking: { id: 'other-book-1', status: 'HOLD' }
        };
        prisma.payment.findMany = async () => [otherHold];

        setAdvocateBookingRzpClient({
          orders: {
            fetchPayments: async () => ({ items: [] }), // no payments -> RELEASE
            create: async () => ({ id: 'rzp_new_order_1' })
          }
        });

        prisma.$transaction = async (cb) => {
          const tx = {
            $queryRaw: async () => [{ id: mockAdvocateId }],
            advocateBooking: {
              findFirst: async () => null, // slot is free
              create: async ({ data }) => ({ id: 'new-book-1', ...data }),
              update: async ({ where, data }) => {
                if (where.id === 'other-book-1' && data.status === 'EXPIRED') {
                  otherHoldCancelled = true;
                }
                return { id: where.id, ...data };
              }
            },
            payment: {
              create: async ({ data }) => ({ id: 'new-pay-1', ...data }),
              update: async ({ where, data }) => ({ id: where.id, ...data })
            }
          };
          return cb(tx);
        };

        const result = await createAdvocateBookingCheckout({
          userId: mockUserId,
          advocateId: mockAdvocateId,
          mode: 'VOICE_CALL',
          startAt: slot.start.toISOString(),
          durationMinutes: 15
        });

        assert.equal(result.statusCode, 201);
        assert.equal(otherHoldCancelled, true);
      } finally {
        prisma.advocate.findUnique = origAdvocateFindUnique;
        prisma.user.findUnique = origUserFindUnique;
        prisma.payment.findFirst = origPaymentFindFirst;
        prisma.payment.findMany = origPaymentFindMany;
        prisma.$transaction = origTransaction;
        setAdvocateBookingRzpClient(null);
      }
    });

    it('createAdvocateBookingCheckout rejects with 409 PAYMENT_PROCESSING if other hold has pending payment', async () => {
      const origAdvocateFindUnique = prisma.advocate.findUnique;
      const origUserFindUnique = prisma.user.findUnique;
      const origPaymentFindFirst = prisma.payment.findFirst;
      const origPaymentFindMany = prisma.payment.findMany;
      const slot = getFutureSlot(3);

      try {
        prisma.advocate.findUnique = async () => ({
          id: mockAdvocateId,
          fullName: 'Adv. Test',
          isActive: true,
          status: 'ACTIVE',
          approvalStatus: 'APPROVED',
          deletionStatus: 'NONE',
          voiceCallPricePer15Min: 500,
          videoCallPricePer15Min: 700,
          offlineVisitingFee: 1500,
          officeVisitDurationMinutes: 60
        });

        prisma.user.findUnique = async () => ({
          id: mockUserId,
          fullName: 'Test User',
          email: 'test@user.com',
          phone: '9876543210'
        });

        prisma.payment.findFirst = async () => null;
        prisma.payment.findMany = async () => [
          {
            id: 'other-pay-pending',
            userId: mockUserId,
            advocateBookingId: 'other-book-pending',
            razorpayOrderId: 'other_order_pending',
            status: 'CREATED',
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            advocateBooking: { id: 'other-book-pending', status: 'HOLD' }
          }
        ];

        setAdvocateBookingRzpClient({
          orders: {
            fetchPayments: async () => ({ items: [{ id: 'attempt-1', status: 'created' }] })
          }
        });

        await assert.rejects(
          async () => {
            await createAdvocateBookingCheckout({
              userId: mockUserId,
              advocateId: mockAdvocateId,
              mode: 'VOICE_CALL',
              startAt: slot.start.toISOString(),
              durationMinutes: 15
            });
          },
          (err) => {
            assert.equal(err.statusCode, 409);
            assert.equal(err.code, 'PAYMENT_PROCESSING');
            assert.equal(err.checkoutId, 'other-pay-pending');
            return true;
          }
        );
      } finally {
        prisma.advocate.findUnique = origAdvocateFindUnique;
        prisma.user.findUnique = origUserFindUnique;
        prisma.payment.findFirst = origPaymentFindFirst;
        prisma.payment.findMany = origPaymentFindMany;
        setAdvocateBookingRzpClient(null);
      }
    });
  });

  // -------------------------------------------------------------
  // 3. Busy Slots Behavior (Anonymous vs Authenticated)
  // -------------------------------------------------------------
  describe('Task 2.5: Busy Slots Response (myHolds separation)', () => {
    it('returns anonymous busy slots without myHolds', async () => {
      const origFindMany = prisma.advocateBooking.findMany;
      const slot = getFutureSlot(3);

      try {
        prisma.advocateBooking.findMany = async () => [
          {
            id: 'b1',
            userId: mockUserId,
            status: 'HOLD',
            startAt: slot.start,
            endAt: slot.end,
            holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            payment: { id: 'pay-1' }
          }
        ];

        const res = await slotValidationGetAdvocateBusySlots(mockAdvocateId, '2026-11-20', prisma, null);
        assert.equal(res.busy.length, 1);
        assert.equal(res.myHolds, undefined);
      } finally {
        prisma.advocateBooking.findMany = origFindMany;
      }
    });

    it('separates user own active holds into myHolds and removes them from busy array', async () => {
      const origFindMany = prisma.advocateBooking.findMany;
      const slotOwn = getFutureSlot(3);
      const slotOther = getFutureSlot(4);

      try {
        prisma.advocateBooking.findMany = async () => [
          {
            id: 'b-own',
            userId: mockUserId,
            status: 'HOLD',
            startAt: slotOwn.start,
            endAt: slotOwn.end,
            holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            payment: { id: 'pay-own-1' }
          },
          {
            id: 'b-other',
            userId: otherUserId,
            status: 'CONFIRMED',
            startAt: slotOther.start,
            endAt: slotOther.end,
            holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
            payment: { id: 'pay-other-1' }
          }
        ];

        const res = await slotValidationGetAdvocateBusySlots(mockAdvocateId, '2026-11-20', prisma, mockUserId);
        assert.equal(res.busy.length, 1);
        assert.equal(res.busy[0].startAt, slotOther.start.toISOString());
        assert.equal(res.myHolds.length, 1);
        assert.equal(res.myHolds[0].checkoutId, 'pay-own-1');
        assert.equal(res.myHolds[0].startAt, slotOwn.start.toISOString());
      } finally {
        prisma.advocateBooking.findMany = origFindMany;
      }
    });
  });

  // -------------------------------------------------------------
  // 4. Late Payment Safety Net (syncPaymentFromRazorpay)
  // -------------------------------------------------------------
  describe('Task 3: Late Payment Safety Net', () => {
    it('confirms booking when slot is still free after hold expiry', async () => {
      const origFindUnique = prisma.payment.findUnique;
      const origFindFirst = prisma.payment.findFirst;
      const origTransaction = prisma.$transaction;
      const slot = getFutureSlot(3);

      let confirmedStatus = null;

      try {
        const paymentObj = {
          id: 'pay-late-free',
          userId: mockUserId,
          purpose: 'ADVOCATE_BOOKING',
          amount: 62680,
          currency: 'INR',
          status: 'CREATED',
          razorpayOrderId: 'order_late_free',
          advocateBookingId: 'book-late-free',
          advocateBooking: {
            id: 'book-late-free',
            advocateId: mockAdvocateId,
            startAt: slot.start,
            endAt: slot.end,
            status: 'EXPIRED', // Hold was expired
            bookingId: null,
            userConfirmationEmailSentAt: new Date(),
            advocateConfirmationEmailSentAt: new Date()
          }
        };

        let paymentState = { ...paymentObj };
        let bookingState = { ...paymentObj.advocateBooking };

        prisma.payment.findUnique = async () => ({
          ...paymentState,
          advocateBooking: bookingState,
          attempts: [{ razorpayPaymentId: 'pay_late_1', status: 'CAPTURED', amount: 62680 }]
        });
        prisma.payment.findFirst = async () => paymentState;
        prisma.paymentAttempt = { upsert: async () => ({}) };

        setPaymentRzpClient({
          orders: {
            fetchPayments: async () => ({
              items: [{ id: 'pay_late_1', status: 'captured', amount: 62680, currency: 'INR', order_id: 'order_late_free' }]
            })
          }
        });

        prisma.$transaction = async (cb) => {
          const tx = {
            $queryRaw: async () => [paymentState],
            paymentAttempt: {
              findMany: async () => [
                { razorpayPaymentId: 'pay_late_1', status: 'CAPTURED', amount: 62680 }
              ]
            },
            payment: {
              findUnique: async () => ({
                ...paymentState,
                attempts: [{ razorpayPaymentId: 'pay_late_1', status: 'CAPTURED', amount: 62680 }]
              }),
              update: async ({ data }) => {
                paymentState = { ...paymentState, ...data };
                return paymentState;
              }
            },
            advocateBooking: {
              findUnique: async () => bookingState,
              findFirst: async () => null, // Slot is free!
              update: async ({ data }) => {
                confirmedStatus = data.status;
                bookingState = { ...bookingState, ...data };
                return bookingState;
              }
            }
          };
          return cb(tx);
        };

        await syncPaymentFromRazorpay({ paymentId: 'pay-late-free' });
        assert.equal(confirmedStatus, 'CONFIRMED');
      } finally {
        prisma.payment.findUnique = origFindUnique;
        prisma.payment.findFirst = origFindFirst;
        setPaymentRzpClient(null);
        prisma.$transaction = origTransaction;
      }
    });

    it('auto-refunds with SLOT_NO_LONGER_AVAILABLE when slot is taken after expiry', async () => {
      const origFindUnique = prisma.payment.findUnique;
      const origFindFirst = prisma.payment.findFirst;
      const origTransaction = prisma.$transaction;
      const slot = getFutureSlot(3);

      let refundReasonLogged = null;
      let rzpRefundTriggered = false;

      try {
        const paymentObj = {
          id: 'pay-late-taken',
          userId: mockUserId,
          purpose: 'ADVOCATE_BOOKING',
          amount: 62680,
          currency: 'INR',
          status: 'CREATED',
          razorpayOrderId: 'order_late_taken',
          advocateBookingId: 'book-late-taken',
          advocateBooking: {
            id: 'book-late-taken',
            advocateId: mockAdvocateId,
            startAt: slot.start,
            endAt: slot.end,
            status: 'EXPIRED'
          }
        };

        let paymentState = { ...paymentObj };
        let bookingState = { ...paymentObj.advocateBooking };

        prisma.payment.findUnique = async () => ({
          ...paymentState,
          advocateBooking: bookingState,
          attempts: [{ razorpayPaymentId: 'pay_late_taken_1', status: 'CAPTURED', amount: 62680 }]
        });
        prisma.payment.findFirst = async () => paymentState;
        prisma.paymentAttempt = { upsert: async () => ({}) };

        setPaymentRzpClient({
          orders: {
            fetchPayments: async () => ({
              items: [{ id: 'pay_late_taken_1', status: 'captured', amount: 62680, currency: 'INR', order_id: 'order_late_taken' }]
            })
          },
          payments: {
            refund: async (id, opts) => {
              if (opts.notes?.reason === 'SLOT_NO_LONGER_AVAILABLE') {
                rzpRefundTriggered = true;
              }
              return { id: 'rfnd_1' };
            }
          }
        });

        prisma.$transaction = async (cb) => {
          const tx = {
            $queryRaw: async () => [paymentState],
            paymentAttempt: {
              findMany: async () => [
                { razorpayPaymentId: 'pay_late_taken_1', status: 'CAPTURED', amount: 62680 }
              ]
            },
            payment: {
              findUnique: async () => ({
                ...paymentState,
                attempts: [{ razorpayPaymentId: 'pay_late_taken_1', status: 'CAPTURED', amount: 62680 }]
              }),
              update: async ({ data }) => {
                paymentState = { ...paymentState, ...data };
                return paymentState;
              }
            },
            advocateBooking: {
              findUnique: async () => bookingState,
              findFirst: async () => ({ id: 'someone-else-booking' }), // Slot was TAKEN!
              update: async ({ data }) => {
                refundReasonLogged = data.refundReason;
                bookingState = { ...bookingState, ...data };
                return bookingState;
              }
            }
          };
          return cb(tx);
        };

        await syncPaymentFromRazorpay({ paymentId: 'pay-late-taken' });
        assert.equal(refundReasonLogged, 'SLOT_NO_LONGER_AVAILABLE');
        assert.equal(rzpRefundTriggered, true);
      } finally {
        prisma.payment.findUnique = origFindUnique;
        prisma.payment.findFirst = origFindFirst;
        setPaymentRzpClient(null);
        prisma.$transaction = origTransaction;
      }
    });
  });

  // -------------------------------------------------------------
  // 5. Hold Minutes Env Variable Validation
  // -------------------------------------------------------------
  describe('Task 4: ADVOCATE_BOOKING_HOLD_MINUTES Env Config', () => {
    const origEnv = process.env.ADVOCATE_BOOKING_HOLD_MINUTES;

    it('defaults to 10 when env is not set or empty', () => {
      delete process.env.ADVOCATE_BOOKING_HOLD_MINUTES;
      assert.equal(getAdvocateBookingHoldMinutes(), 10);

      process.env.ADVOCATE_BOOKING_HOLD_MINUTES = '   ';
      assert.equal(getAdvocateBookingHoldMinutes(), 10);
    });

    it('accepts valid values between 3 and 30', () => {
      process.env.ADVOCATE_BOOKING_HOLD_MINUTES = '5';
      assert.equal(getAdvocateBookingHoldMinutes(), 5);

      process.env.ADVOCATE_BOOKING_HOLD_MINUTES = '15';
      assert.equal(getAdvocateBookingHoldMinutes(), 15);

      process.env.ADVOCATE_BOOKING_HOLD_MINUTES = '30';
      assert.equal(getAdvocateBookingHoldMinutes(), 30);
    });

    it('warns and falls back to default 10 for out-of-range (<3 or >30) or non-integer', () => {
      resetHoldMinutesWarned();

      process.env.ADVOCATE_BOOKING_HOLD_MINUTES = '2';
      assert.equal(getAdvocateBookingHoldMinutes(), 10);

      process.env.ADVOCATE_BOOKING_HOLD_MINUTES = '60';
      assert.equal(getAdvocateBookingHoldMinutes(), 10);

      process.env.ADVOCATE_BOOKING_HOLD_MINUTES = 'not_a_number';
      assert.equal(getAdvocateBookingHoldMinutes(), 10);
    });

    // Cleanup
    process.env.ADVOCATE_BOOKING_HOLD_MINUTES = origEnv;
  });
});
