import prisma from '../lib/prisma.js';

/**
 * Format a ConsultancyRequest and its associated Payment into the standard booking shape
 */
const formatConsultancyBooking = (item) => {
  if (!item) return null;

  const payment = item.payment;
  const capturedAttempt = Array.isArray(payment?.attempts)
    ? payment.attempts.find((a) => a.status === 'CAPTURED' || a.status === 'DUPLICATE_REFUNDED')
    : null;
  const razorpayPaymentId = capturedAttempt?.razorpayPaymentId || payment?.attempts?.[0]?.razorpayPaymentId || null;

  let status = 'CONFIRMED';
  let statusGroup = 'UPCOMING';
  let statusLabel = 'Confirmed – our team will call you';

  if (item.status === 'COMPLETED') {
    status = 'COMPLETED';
    statusGroup = 'COMPLETED';
    statusLabel = 'Completed';
  } else if (item.status === 'REFUNDED' || payment?.status === 'REFUNDED') {
    status = 'REFUNDED';
    statusGroup = 'REFUNDED';
    statusLabel = 'Refunded';
  } else if (payment?.status === 'REFUND_PENDING') {
    status = 'REFUND_IN_PROGRESS';
    statusGroup = 'REFUNDED';
    statusLabel = 'Refund in progress';
  } else if (!payment) {
    status = 'REQUESTED';
    statusGroup = 'UPCOMING';
    statusLabel = 'Request received';
  } else if (payment.status === 'PAID') {
    status = 'CONFIRMED';
    statusGroup = 'UPCOMING';
    statusLabel = 'Confirmed – our team will call you';
  }

  const now = new Date();
  const isPaid = payment?.status === 'PAID';
  const isNotCompleted = item.status !== 'COMPLETED';
  const isPastRefundEligibleAt = payment?.refundEligibleAt ? now >= new Date(payment.refundEligibleAt) : false;
  const notRefundedOrPending = payment
    ? !['REFUND_PENDING', 'REFUNDED'].includes(payment.status) && item.status !== 'REFUNDED'
    : item.status !== 'REFUNDED';
  const refundEligibleNow = Boolean(isPaid && isNotCompleted && isPastRefundEligibleAt && notRefundedOrPending);
  const canViewReceipt = Boolean(payment && ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(payment.status));

  const durationMinutes = item.duration;
  const title =
    item.callType === 'CALL'
      ? `Call Consultation • ${durationMinutes} min`
      : `Video Call Consultation • ${durationMinutes} min`;
  const callStatus = item.status === 'COMPLETED' || item.completedAt ? 'COMPLETED' : 'PENDING';

  return {
    id: item.id,
    bookingType: 'CONSULTANCY',
    bookingId: item.bookingId || null,
    title,
    callStatus,
    status,
    statusGroup,
    statusLabel,
    callType: item.callType,
    durationMinutes,
    price: Number(item.price),
    currency: 'INR',
    contact: {
      phoneNumber: item.phoneNumber,
      email: item.email
    },
    payment: payment
      ? {
          status: payment.status,
          amount: payment.amount ? payment.amount / 100 : 0,
          paidAt: payment.paidAt,
          razorpayOrderId: payment.razorpayOrderId,
          razorpayPaymentId,
          refundEligibleAt: payment.refundEligibleAt,
          refundedAt: payment.refundedAt
        }
      : null,
    completedAt: item.completedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    actions: {
      canViewReceipt,
      refundEligibleNow
    }
  };
};

/**
 * Format a Payment with status PROCESSING (or CREATED with attempts) into the standard booking shape
 */
const formatProcessingPaymentBooking = (payment) => {
  if (!payment) return null;

  const capturedAttempt = Array.isArray(payment.attempts)
    ? payment.attempts.find((a) => a.status === 'CAPTURED' || a.status === 'DUPLICATE_REFUNDED')
    : null;
  const razorpayPaymentId = capturedAttempt?.razorpayPaymentId || payment.attempts?.[0]?.razorpayPaymentId || null;

  const durationMinutes = payment.duration || 15;
  const title =
    payment.callType === 'CALL'
      ? `Call Consultation • ${durationMinutes} min`
      : `Video Call Consultation • ${durationMinutes} min`;

  return {
    id: payment.id,
    bookingType: 'CONSULTANCY',
    bookingId: null,
    title,
    callStatus: 'PENDING',
    status: 'PAYMENT_PROCESSING',
    statusGroup: 'PROCESSING',
    statusLabel: "Payment processing – don't pay again",
    callType: payment.callType || 'CALL',
    durationMinutes,
    price: payment.amount ? payment.amount / 100 : 0,
    currency: payment.currency || 'INR',
    contact: {
      phoneNumber: payment.phoneNumber,
      email: payment.email
    },
    payment: {
      status: payment.status,
      amount: payment.amount ? payment.amount / 100 : 0,
      paidAt: payment.paidAt,
      razorpayOrderId: payment.razorpayOrderId,
      razorpayPaymentId,
      refundEligibleAt: payment.refundEligibleAt,
      refundedAt: payment.refundedAt
    },
    completedAt: null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    actions: {
      canViewReceipt: false,
      refundEligibleNow: false
    }
  };
};

/**
 * Format an AdvocateBooking into the standard user booking shape
 */
const formatAdvocateBooking = (item) => {
  if (!item) return null;

  const payment = item.payment;
  const capturedAttempt = Array.isArray(payment?.attempts)
    ? payment.attempts.find((a) => a.status === 'CAPTURED' || a.status === 'DUPLICATE_REFUNDED')
    : null;
  const razorpayPaymentId = capturedAttempt?.razorpayPaymentId || payment?.attempts?.[0]?.razorpayPaymentId || null;

  let status = 'CONFIRMED';
  let statusGroup = 'UPCOMING';
  let statusLabel = 'Confirmed – the advocate will contact you';
  let callStatus = 'PENDING';

  if (item.status === 'COMPLETED') {
    status = 'COMPLETED';
    statusGroup = 'COMPLETED';
    statusLabel = 'Completed';
    callStatus = 'COMPLETED';
  } else if (item.status === 'REFUNDED' || payment?.status === 'REFUNDED') {
    status = 'REFUNDED';
    statusGroup = 'REFUNDED';
    statusLabel = 'Refunded';
    callStatus = 'CANCELLED';
  } else if (item.status === 'REFUND_PENDING' || payment?.status === 'REFUND_PENDING') {
    status = 'REFUND_IN_PROGRESS';
    statusGroup = 'REFUNDED';
    statusLabel = 'Refund in progress';
    callStatus = 'CANCELLED';
  } else if (item.status === 'HOLD' && payment?.status === 'PROCESSING') {
    status = 'PAYMENT_PROCESSING';
    statusGroup = 'PROCESSING';
    statusLabel = "Payment processing – don't pay again";
    callStatus = 'PENDING';
  } else if (item.status === 'CONFIRMED') {
    status = 'CONFIRMED';
    statusGroup = 'UPCOMING';
    statusLabel = 'Confirmed – the advocate will contact you';
    callStatus = 'PENDING';
  }

  const modeLabel =
    item.mode === 'VOICE_CALL'
      ? 'Voice Call'
      : item.mode === 'VIDEO_CALL'
      ? 'Video Call'
      : 'In-Person Meeting';

  const title = `${modeLabel} Consultation • ${item.durationMinutes} min`;
  const canViewReceipt = Boolean(payment && ['PAID', 'REFUND_PENDING', 'REFUNDED'].includes(payment.status));

  return {
    id: item.id,
    bookingType: 'ADVOCATE',
    bookingId: item.bookingId || null,
    title,
    callStatus,
    status,
    statusGroup,
    statusLabel,
    mode: item.mode,
    scheduledAt: item.startAt,
    startAt: item.startAt,
    endAt: item.endAt,
    durationMinutes: item.durationMinutes,
    subject: item.subject,
    advocate: item.advocate
      ? {
          id: item.advocate.id,
          fullName: item.advocate.fullName,
          profilePhotoUrl: item.advocate.profilePhotoUrl,
          bestPracticeArea: item.advocate.bestPracticeArea || item.advocate.practiceAreas?.[0] || null
        }
      : null,
    breakdown: {
      fee: parseFloat((item.feePaise / 100).toFixed(2)),
      gst: parseFloat((item.gstPaise / 100).toFixed(2)),
      gstPercent: item.gstPercent,
      platformFee: parseFloat((item.platformFeePaise / 100).toFixed(2)),
      total: parseFloat((item.totalPaise / 100).toFixed(2))
    },
    contact: {
      phoneNumber: item.userPhone,
      email: item.userEmail
    },
    payment: payment
      ? {
          status: payment.status,
          amount: payment.amount ? payment.amount / 100 : 0,
          paidAt: payment.paidAt,
          razorpayOrderId: payment.razorpayOrderId,
          razorpayPaymentId,
          refundEligibleAt: null,
          refundedAt: payment.refundedAt
        }
      : null,
    completedAt: item.completedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    actions: {
      canViewReceipt,
      refundEligibleNow: false
    }
  };
};

/**
 * Builds chronological timeline for booking detail view
 */
const buildTimeline = (booking) => {
  const events = [];

  if (booking.payment?.paidAt) {
    events.push({
      at: booking.payment.paidAt,
      event: 'PAYMENT_PAID'
    });
  }

  if (booking.status !== 'PAYMENT_PROCESSING' && booking.createdAt) {
    events.push({
      at: booking.createdAt,
      event: 'BOOKING_CONFIRMED'
    });
  }

  if (booking.completedAt) {
    events.push({
      at: booking.completedAt,
      event: 'COMPLETED'
    });
  }

  if (booking.payment?.status === 'REFUND_PENDING' || booking.status === 'REFUND_IN_PROGRESS') {
    events.push({
      at: booking.updatedAt,
      event: 'REFUND_INITIATED'
    });
  }

  if (booking.status === 'REFUNDED' || booking.payment?.status === 'REFUNDED') {
    events.push({
      at: booking.payment?.refundedAt || booking.updatedAt,
      event: 'REFUNDED'
    });
  }

  return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
};

/**
 * Build date range filter for createdAt if from/to are provided
 */
const buildDateFilter = (from, to) => {
  if (!from && !to) return null;
  const filter = {};
  if (from) filter.gte = new Date(from);
  if (to) filter.lte = new Date(to);
  return filter;
};

/**
 * Retrieve user's bookings with filtering across Consultancy and Advocate bookings,
 * unified pagination, and statusGroup tab counts.
 */
export const listUserBookings = async (
  userId,
  { status = 'ALL', type = 'ALL', from, to, page = 1, limit = 10 } = {}
) => {
  const dateFilter = buildDateFilter(from, to);

  const shouldFetchConsultancy = type === 'ALL' || type === 'CONSULTANCY';
  const shouldFetchAdvocate = type === 'ALL' || type === 'ADVOCATE';

  let formattedConsultancies = [];
  let formattedProcessingConsultancy = [];
  let formattedAdvocateBookings = [];

  // 1. Fetch Consultancy Bookings if requested
  if (shouldFetchConsultancy) {
    const consultancyWhere = {
      userId,
      ...(dateFilter ? { createdAt: dateFilter } : {})
    };

    const consultancies = await prisma.consultancyRequest.findMany({
      where: consultancyWhere,
      include: {
        payment: {
          include: {
            attempts: {
              orderBy: { createdAt: 'desc' }
            }
          }
        }
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    });

    const paymentWhere = {
      userId,
      purpose: 'CONSULTANCY',
      consultancyRequestId: null,
      OR: [
        { status: 'PROCESSING' },
        { status: 'CREATED', attempts: { some: {} } }
      ],
      ...(dateFilter ? { createdAt: dateFilter } : {})
    };

    const processingPayments = await prisma.payment.findMany({
      where: paymentWhere,
      include: {
        attempts: {
          orderBy: { createdAt: 'desc' }
        }
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    });

    formattedConsultancies = consultancies.map(formatConsultancyBooking);
    formattedProcessingConsultancy = processingPayments.map(formatProcessingPaymentBooking);
  }

  // 2. Fetch Advocate Bookings if requested
  if (shouldFetchAdvocate) {
    // Only fetch finalized bookings or HOLD with active PROCESSING payment
    const advocateWhere = {
      userId,
      OR: [
        { status: { in: ['CONFIRMED', 'COMPLETED', 'REFUND_PENDING', 'REFUNDED'] } },
        {
          status: 'HOLD',
          payment: { status: 'PROCESSING' }
        }
      ],
      ...(dateFilter ? { createdAt: dateFilter } : {})
    };

    const advocateBookings = await prisma.advocateBooking.findMany({
      where: advocateWhere,
      include: {
        advocate: {
          select: {
            id: true,
            fullName: true,
            profilePhotoUrl: true,
            bestPracticeArea: true,
            practiceAreas: true
          }
        },
        payment: {
          include: {
            attempts: {
              orderBy: { createdAt: 'desc' }
            }
          }
        }
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    });

    formattedAdvocateBookings = advocateBookings.map(formatAdvocateBooking);
  }

  // 3. Merge all items in memory
  // Note: To paginate properly across both tables, we fetch user records, merge in memory,
  // sort by createdAt descending, and slice for the requested page.
  const allItems = [
    ...formattedConsultancies,
    ...formattedProcessingConsultancy,
    ...formattedAdvocateBookings
  ];

  allItems.sort((a, b) => {
    const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (diff !== 0) return diff;
    return String(b.id).localeCompare(String(a.id));
  });

  // 4. Compute statusGroup tab counts across all merged items (ignoring status query filter)
  const counts = {
    ALL: allItems.length,
    UPCOMING: 0,
    PROCESSING: 0,
    COMPLETED: 0,
    REFUNDED: 0
  };

  for (const item of allItems) {
    if (counts[item.statusGroup] !== undefined) {
      counts[item.statusGroup] += 1;
    }
  }

  // 5. Apply statusGroup filter
  const filteredItems = status === 'ALL' ? allItems : allItems.filter((item) => item.statusGroup === status);

  // 6. Paginate
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
  const total = filteredItems.length;
  const totalPages = Math.ceil(total / parsedLimit) || 1;
  const skip = (parsedPage - 1) * parsedLimit;
  const paginatedItems = filteredItems.slice(skip, skip + parsedLimit);
  const hasNextPage = parsedPage < totalPages;

  return {
    availableTypes: ['CONSULTANCY', 'ADVOCATE'],
    bookings: paginatedItems,
    pagination: {
      page: parsedPage,
      limit: parsedLimit,
      total,
      totalPages,
      hasNextPage
    },
    counts
  };
};

/**
 * Retrieve a single booking by ID (consultancy UUID, advocate booking UUID, or processing payment UUID)
 */
export const getUserBooking = async (userId, id) => {
  // 1. Check ConsultancyRequest owned by userId
  const consultancy = await prisma.consultancyRequest.findUnique({
    where: { id },
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

  if (consultancy && consultancy.userId === userId) {
    const booking = formatConsultancyBooking(consultancy);
    return {
      ...booking,
      timeline: buildTimeline(booking)
    };
  }

  // 2. Check AdvocateBooking owned by userId
  const advocateBooking = await prisma.advocateBooking.findUnique({
    where: { id },
    include: {
      advocate: {
        select: {
          id: true,
          fullName: true,
          profilePhotoUrl: true,
          bestPracticeArea: true,
          practiceAreas: true
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

  if (
    advocateBooking &&
    advocateBooking.userId === userId &&
    (!['HOLD', 'EXPIRED'].includes(advocateBooking.status) || advocateBooking.payment?.status === 'PROCESSING')
  ) {
    const booking = formatAdvocateBooking(advocateBooking);
    return {
      ...booking,
      timeline: buildTimeline(booking)
    };
  }

  // 3. Check Payment owned by userId that is PAYMENT_PROCESSING
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      attempts: {
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  const isProcessingPayment =
    payment &&
    payment.userId === userId &&
    payment.consultancyRequestId === null &&
    (payment.status === 'PROCESSING' || (payment.status === 'CREATED' && payment.attempts.length > 0));

  if (isProcessingPayment) {
    const booking = formatProcessingPaymentBooking(payment);
    return {
      ...booking,
      timeline: buildTimeline(booking)
    };
  }

  // Uniform 404 to avoid leaking ID existence across users
  const err = new Error('Booking not found.');
  err.statusCode = 404;
  throw err;
};

/**
 * Retrieve booking counts by statusGroup for user
 */
export const getUserBookingCounts = async (userId) => {
  const result = await listUserBookings(userId, { status: 'ALL', page: 1, limit: 1 });
  return result.counts;
};
