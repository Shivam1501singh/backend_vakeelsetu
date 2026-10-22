import prisma from '../lib/prisma.js';

/**
 * Format a ConsultancyRequest and its associated Payment into the standard booking shape
 */
const formatConsultancyBooking = (item) => {
  if (!item) return null;

  const payment = item.payment;
  const capturedAttempt = Array.isArray(payment?.attempts)
    ? payment.attempts.find(a => a.status === 'CAPTURED' || a.status === 'DUPLICATE_REFUNDED')
    : null;
  const razorpayPaymentId = capturedAttempt?.razorpayPaymentId || payment?.attempts?.[0]?.razorpayPaymentId || null;

  // Determine status, statusGroup, and statusLabel according to specification
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
  const title = item.callType === 'CALL'
    ? `Call Consultation • ${durationMinutes} min`
    : `Video Call Consultation • ${durationMinutes} min`;

  return {
    id: item.id,
    title,
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
    ? payment.attempts.find(a => a.status === 'CAPTURED' || a.status === 'DUPLICATE_REFUNDED')
    : null;
  const razorpayPaymentId = capturedAttempt?.razorpayPaymentId || payment.attempts?.[0]?.razorpayPaymentId || null;

  const durationMinutes = payment.duration;
  const title = payment.callType === 'CALL'
    ? `Call Consultation • ${durationMinutes} min`
    : `Video Call Consultation • ${durationMinutes} min`;

  return {
    id: payment.id,
    title,
    status: 'PAYMENT_PROCESSING',
    statusGroup: 'PROCESSING',
    statusLabel: "Payment processing – don't pay again",
    callType: payment.callType,
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

  if (booking.payment?.status === 'REFUND_PENDING') {
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

  // Sort chronological (earliest event first)
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
 * Retrieve user's bookings with filtering, pagination, and status tab counts
 */
export const listUserBookings = async (userId, { status = 'ALL', from, to, page = 1, limit = 10 } = {}) => {
  const dateFilter = buildDateFilter(from, to);

  // 1. Fetch user's consultancy requests (No N+1: include payment and its attempts in single query)
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
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ]
  });

  // 2. Fetch PAYMENT_PROCESSING items
  // Note: PAYMENT_PROCESSING items come from Payment rows, not ConsultancyRequest.
  // These represent transactions still processing at the gateway without a finalized ConsultancyRequest yet.
  // These are very few (typically 0 or 1 per user), so fetching them for the user and merging in memory before paginating is safe and efficient.
  const paymentWhere = {
    userId,
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
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ]
  });

  // 3. Format and merge in-memory
  const formattedConsultancies = consultancies.map(formatConsultancyBooking);
  const formattedProcessing = processingPayments.map(formatProcessingPaymentBooking);

  const allItems = [...formattedConsultancies, ...formattedProcessing];

  // Sort descending by createdAt with tie-breaker id
  allItems.sort((a, b) => {
    const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (diff !== 0) return diff;
    return String(b.id).localeCompare(String(a.id));
  });

  // 4. Compute statusGroup tab counts across all items (ignoring status query filter)
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
  const filteredItems = status === 'ALL'
    ? allItems
    : allItems.filter(item => item.statusGroup === status);

  // 6. Paginate
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
  const total = filteredItems.length;
  const totalPages = Math.ceil(total / parsedLimit) || 1;
  const skip = (parsedPage - 1) * parsedLimit;
  const paginatedItems = filteredItems.slice(skip, skip + parsedLimit);
  const hasNextPage = parsedPage < totalPages;

  return {
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
 * Retrieve a single booking by ID (consultancy UUID or processing payment UUID)
 */
export const getUserBooking = async (userId, id) => {
  // First, check ConsultancyRequest owned by userId
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

  // Next, check Payment owned by userId that is PAYMENT_PROCESSING
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      attempts: {
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  const isProcessingPayment = payment &&
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
