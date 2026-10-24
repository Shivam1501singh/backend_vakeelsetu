import prisma from '../../lib/prisma.js';

export const adminListAdvocateBookings = async (query = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 10));
  const skip = (page - 1) * limit;
  const now = new Date();

  const where = {};

  // Status Filter
  if (!query.status || query.status === 'ALL') {
    // Exclude HOLD and EXPIRED by default
    where.status = { in: ['CONFIRMED', 'COMPLETED', 'REFUND_PENDING', 'REFUNDED'] };
  } else if (query.status === 'PAST_DUE') {
    where.status = 'CONFIRMED';
    where.endAt = { lt: now };
  } else if (['HOLD', 'CONFIRMED', 'COMPLETED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED'].includes(query.status)) {
    where.status = query.status;
  }

  // Mode Filter
  if (query.mode) {
    where.mode = query.mode;
  }

  // Advocate / User Filter
  if (query.advocateId) {
    where.advocateId = query.advocateId;
  }
  if (query.userId) {
    where.userId = query.userId;
  }

  // Slot Date Filters (startAt)
  if (query.from || query.to) {
    where.startAt = {};
    if (query.from) where.startAt.gte = new Date(query.from);
    if (query.to) where.startAt.lte = new Date(query.to);
  }

  // Payment Date Filters (payment.paidAt)
  if (query.paidFrom || query.paidTo) {
    where.payment = {
      ...(where.payment || {}),
      paidAt: {}
    };
    if (query.paidFrom) where.payment.paidAt.gte = new Date(query.paidFrom);
    if (query.paidTo) where.payment.paidAt.lte = new Date(query.paidTo);
  }

  // Search Filter
  if (query.search && query.search.trim()) {
    const s = query.search.trim();
    where.OR = [
      { bookingId: { contains: s, mode: 'insensitive' } },
      { userName: { contains: s, mode: 'insensitive' } },
      { userPhone: { contains: s } },
      { userEmail: { contains: s, mode: 'insensitive' } },
      { advocateName: { contains: s, mode: 'insensitive' } },
      { advocate: { barCouncilId: { contains: s, mode: 'insensitive' } } },
      { payment: { razorpayOrderId: { contains: s, mode: 'insensitive' } } },
      { payment: { attempts: { some: { razorpayPaymentId: { contains: s } } } } }
    ];
  }

  const [total, items, statusGroupCounts, pastDueCount] = await prisma.$transaction([
    prisma.advocateBooking.count({ where }),
    prisma.advocateBooking.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true
          }
        },
        advocate: {
          select: {
            id: true,
            fullName: true,
            barCouncilId: true,
            phone: true
          }
        },
        payment: {
          include: {
            attempts: {
              where: { status: 'CAPTURED' },
              orderBy: { createdAt: 'asc' },
              take: 1
            }
          }
        }
      }
    }),
    prisma.advocateBooking.groupBy({
      by: ['status'],
      _count: { status: true }
    }),
    prisma.advocateBooking.count({
      where: {
        status: 'CONFIRMED',
        endAt: { lt: now }
      }
    })
  ]);

  const counts = {
    ALL: 0,
    CONFIRMED: 0,
    COMPLETED: 0,
    REFUND_PENDING: 0,
    REFUNDED: 0,
    PAST_DUE: pastDueCount,
    HOLD: 0,
    EXPIRED: 0
  };

  let activeTotal = 0;
  for (const group of statusGroupCounts) {
    counts[group.status] = group._count.status;
    if (['CONFIRMED', 'COMPLETED', 'REFUND_PENDING', 'REFUNDED'].includes(group.status)) {
      activeTotal += group._count.status;
    }
  }
  counts.ALL = activeTotal;

  const data = items.map((b) => {
    const capturedAttempt = b.payment?.attempts?.[0];

    return {
      id: b.id,
      bookingId: b.bookingId,
      status: b.status,
      mode: b.mode,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      durationMinutes: b.durationMinutes,
      subject: b.subject,
      user: {
        id: b.userId,
        name: b.userName || b.user?.fullName,
        phone: b.userPhone || b.user?.phone,
        email: b.userEmail || b.user?.email
      },
      advocate: {
        id: b.advocateId,
        fullName: b.advocateName || b.advocate?.fullName,
        barCouncilId: b.advocate?.barCouncilId,
        phone: b.advocate?.phone
      },
      breakdown: {
        fee: parseFloat((b.feePaise / 100).toFixed(2)),
        gst: parseFloat((b.gstPaise / 100).toFixed(2)),
        platformFee: parseFloat((b.platformFeePaise / 100).toFixed(2)),
        total: parseFloat((b.totalPaise / 100).toFixed(2))
      },
      payment: b.payment
        ? {
            status: b.payment.status,
            paidAt: b.payment.paidAt ? b.payment.paidAt.toISOString() : null,
            razorpayOrderId: b.payment.razorpayOrderId,
            razorpayPaymentId: capturedAttempt?.razorpayPaymentId || null,
            method: capturedAttempt?.method || null
          }
        : null,
      confirmedAt: b.confirmedAt ? b.confirmedAt.toISOString() : null,
      completedAt: b.completedAt ? b.completedAt.toISOString() : null,
      refundedAt: b.refundedAt ? b.refundedAt.toISOString() : null
    };
  });

  return {
    success: true,
    data,
    counts,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1
    }
  };
};

export const adminGetAdvocateBookingById = async (id) => {
  const booking = await prisma.advocateBooking.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          city: true,
          state: true
        }
      },
      advocate: {
        select: {
          id: true,
          fullName: true,
          barCouncilId: true,
          phone: true,
          email: true,
          city: true,
          state: true
        }
      },
      payment: {
        include: {
          attempts: {
            orderBy: { createdAt: 'desc' }
          }
        }
      }
    }
  });

  if (!booking) {
    const error = new Error('Advocate booking not found.');
    error.statusCode = 404;
    throw error;
  }

  // Construct timeline
  const timeline = [];
  if (booking.createdAt) {
    timeline.push({ at: booking.createdAt.toISOString(), event: 'HOLD_CREATED' });
  }
  if (booking.payment?.paidAt) {
    timeline.push({ at: booking.payment.paidAt.toISOString(), event: 'PAYMENT_CAPTURED' });
  }
  if (booking.confirmedAt) {
    timeline.push({ at: booking.confirmedAt.toISOString(), event: 'BOOKING_CONFIRMED' });
  }
  if (booking.completedAt) {
    timeline.push({ at: booking.completedAt.toISOString(), event: 'APPOINTMENT_COMPLETED' });
  }
  if (booking.status === 'REFUND_PENDING' || booking.payment?.status === 'REFUND_PENDING') {
    timeline.push({ at: booking.updatedAt.toISOString(), event: 'REFUND_INITIATED' });
  }
  if (booking.refundedAt || booking.payment?.refundedAt) {
    timeline.push({
      at: (booking.refundedAt || booking.payment?.refundedAt).toISOString(),
      event: 'REFUNDED'
    });
  }
  timeline.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const capturedAttempt = booking.payment?.attempts?.find((a) => a.status === 'CAPTURED');

  return {
    success: true,
    data: {
      id: booking.id,
      bookingId: booking.bookingId,
      status: booking.status,
      mode: booking.mode,
      startAt: booking.startAt.toISOString(),
      endAt: booking.endAt.toISOString(),
      durationMinutes: booking.durationMinutes,
      subject: booking.subject,
      user: {
        id: booking.userId,
        name: booking.userName || booking.user?.fullName,
        phone: booking.userPhone || booking.user?.phone,
        email: booking.userEmail || booking.user?.email,
        city: booking.user?.city,
        state: booking.user?.state
      },
      advocate: {
        id: booking.advocateId,
        fullName: booking.advocateName || booking.advocate?.fullName,
        barCouncilId: booking.advocate?.barCouncilId,
        phone: booking.advocate?.phone,
        email: booking.advocate?.email,
        city: booking.advocate?.city,
        state: booking.advocate?.state
      },
      breakdown: {
        fee: parseFloat((booking.feePaise / 100).toFixed(2)),
        gst: parseFloat((booking.gstPaise / 100).toFixed(2)),
        platformFee: parseFloat((booking.platformFeePaise / 100).toFixed(2)),
        total: parseFloat((booking.totalPaise / 100).toFixed(2))
      },
      payment: booking.payment
        ? {
            id: booking.payment.id,
            status: booking.payment.status,
            paidAt: booking.payment.paidAt ? booking.payment.paidAt.toISOString() : null,
            razorpayOrderId: booking.payment.razorpayOrderId,
            razorpayPaymentId: capturedAttempt?.razorpayPaymentId || null,
            method: capturedAttempt?.method || null,
            attempts: booking.payment.attempts.map((a) => ({
              id: a.id,
              razorpayPaymentId: a.razorpayPaymentId,
              status: a.status,
              amount: a.amount / 100,
              method: a.method,
              errorCode: a.errorCode,
              errorDescription: a.errorDescription,
              createdAt: a.createdAt.toISOString()
            }))
          }
        : null,
      confirmedAt: booking.confirmedAt ? booking.confirmedAt.toISOString() : null,
      completedAt: booking.completedAt ? booking.completedAt.toISOString() : null,
      refundedAt: booking.refundedAt ? booking.refundedAt.toISOString() : null,
      refundReason: booking.refundReason,
      timeline
    }
  };
};
