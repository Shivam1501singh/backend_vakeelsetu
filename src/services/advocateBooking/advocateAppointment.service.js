import prisma from '../../lib/prisma.js';

export const getAdvocateAppointments = async (advocateId, { status = 'UPCOMING', date, page = 1, limit = 10 } = {}) => {
  const now = new Date();
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const takeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
  const skip = (pageNum - 1) * takeLimit;

  // Base where clause: only this advocate and finalized appointments (never HOLD/EXPIRED)
  const baseWhere = {
    advocateId,
    status: { in: ['CONFIRMED', 'COMPLETED', 'REFUND_PENDING', 'REFUNDED'] }
  };

  // Optional date filter in Asia/Kolkata
  if (date) {
    const startOfDayUtc = new Date(`${date}T00:00:00+05:30`);
    const endOfDayUtc = new Date(`${date}T23:59:59.999+05:30`);
    baseWhere.startAt = {
      gte: startOfDayUtc,
      lte: endOfDayUtc
    };
  }

  // Fetch all matching non-paginated to compute group counts accurately
  const allEligible = await prisma.advocateBooking.findMany({
    where: baseWhere,
    select: {
      id: true,
      status: true,
      startAt: true,
      endAt: true
    }
  });

  const counts = {
    ALL: allEligible.length,
    UPCOMING: 0,
    PAST_DUE: 0,
    COMPLETED: 0,
    REFUNDED: 0
  };

  for (const b of allEligible) {
    if (b.status === 'COMPLETED') {
      counts.COMPLETED++;
    } else if (b.status === 'REFUNDED' || b.status === 'REFUND_PENDING') {
      counts.REFUNDED++;
    } else if (b.status === 'CONFIRMED') {
      if (b.endAt >= now) {
        counts.UPCOMING++;
      } else {
        counts.PAST_DUE++;
      }
    }
  }

  // Build filter for queried status group
  const queryWhere = { ...baseWhere };

  if (status === 'UPCOMING') {
    queryWhere.status = 'CONFIRMED';
    queryWhere.endAt = { gte: now };
  } else if (status === 'PAST_DUE') {
    queryWhere.status = 'CONFIRMED';
    queryWhere.endAt = { lt: now };
  } else if (status === 'COMPLETED') {
    queryWhere.status = 'COMPLETED';
  } else if (status === 'REFUNDED') {
    queryWhere.status = { in: ['REFUND_PENDING', 'REFUNDED'] };
  }
  // status === 'ALL' uses baseWhere

  const orderBy = status === 'UPCOMING' ? { startAt: 'asc' } : { startAt: 'desc' };

  const [total, items] = await prisma.$transaction([
    prisma.advocateBooking.count({ where: queryWhere }),
    prisma.advocateBooking.findMany({
      where: queryWhere,
      skip,
      take: takeLimit,
      orderBy,
      include: {
        payment: {
          select: {
            status: true,
            paidAt: true,
            razorpayOrderId: true
          }
        }
      }
    })
  ]);

  const appointments = items.map((b) => {
    const feeInRupees = parseFloat((b.feePaise / 100).toFixed(2));
    const message =
      b.mode === 'IN_PERSON'
        ? 'This user will visit your office at the booked time.'
        : 'This user has booked you. Please call the user at the booked time.';

    return {
      id: b.id,
      bookingId: b.bookingId,
      mode: b.mode,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
      durationMinutes: b.durationMinutes,
      subject: b.subject,
      status: b.status,
      user: {
        name: b.userName,
        phone: b.userPhone,
        email: b.userEmail
      },
      fee: feeInRupees,
      feePaise: b.feePaise,
      confirmedAt: b.confirmedAt ? b.confirmedAt.toISOString() : null,
      completedAt: b.completedAt ? b.completedAt.toISOString() : null,
      message
    };
  });

  return {
    appointments,
    counts,
    pagination: {
      page: pageNum,
      limit: takeLimit,
      total,
      totalPages: Math.ceil(total / takeLimit) || 1
    }
  };
};

export const getAdvocateAppointmentById = async (advocateId, appointmentId) => {
  const booking = await prisma.advocateBooking.findUnique({
    where: { id: appointmentId },
    include: {
      payment: {
        include: {
          attempts: {
            orderBy: { createdAt: 'desc' }
          }
        }
      }
    }
  });

  // Verify ownership and ensure no HOLD/EXPIRED access
  if (
    !booking ||
    booking.advocateId !== advocateId ||
    ['HOLD', 'EXPIRED'].includes(booking.status)
  ) {
    const error = new Error('Appointment not found.');
    error.statusCode = 404;
    throw error;
  }

  const feeInRupees = parseFloat((b => (b.feePaise / 100).toFixed(2))(booking));
  const message =
    booking.mode === 'IN_PERSON'
      ? 'This user will visit your office at the booked time.'
      : 'This user has booked you. Please call the user at the booked time.';

  return {
    id: booking.id,
    bookingId: booking.bookingId,
    mode: booking.mode,
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
    durationMinutes: booking.durationMinutes,
    subject: booking.subject,
    status: booking.status,
    user: {
      name: booking.userName,
      phone: booking.userPhone,
      email: booking.userEmail
    },
    fee: feeInRupees,
    feePaise: booking.feePaise,
    confirmedAt: booking.confirmedAt ? booking.confirmedAt.toISOString() : null,
    completedAt: booking.completedAt ? booking.completedAt.toISOString() : null,
    message,
    payment: booking.payment
      ? {
          status: booking.payment.status,
          paidAt: booking.payment.paidAt,
          razorpayOrderId: booking.payment.razorpayOrderId
        }
      : null
  };
};

export const completeAdvocateAppointment = async (advocateId, appointmentId) => {
  const booking = await prisma.advocateBooking.findUnique({
    where: { id: appointmentId }
  });

  if (
    !booking ||
    booking.advocateId !== advocateId ||
    ['HOLD', 'EXPIRED'].includes(booking.status)
  ) {
    const error = new Error('Appointment not found.');
    error.statusCode = 404;
    throw error;
  }

  // Idempotent completion check
  if (booking.status === 'COMPLETED') {
    return {
      id: booking.id,
      status: booking.status,
      completedAt: booking.completedAt
    };
  }

  if (booking.status !== 'CONFIRMED') {
    const error = new Error(`Cannot mark appointment completed. Current status is ${booking.status}.`);
    error.statusCode = 409;
    throw error;
  }

  const now = new Date();
  if (now < booking.startAt) {
    const error = new Error('You can mark this appointment completed only after it starts.');
    error.statusCode = 400;
    throw error;
  }

  const updated = await prisma.advocateBooking.update({
    where: { id: appointmentId },
    data: {
      status: 'COMPLETED',
      completedAt: now
    }
  });

  return {
    id: updated.id,
    status: updated.status,
    completedAt: updated.completedAt
  };
};
