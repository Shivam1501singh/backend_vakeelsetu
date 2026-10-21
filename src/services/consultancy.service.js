import prisma from '../lib/prisma.js';
import { getConsultancyPrice } from '../config/consultancyPricing.js';

/**
 * Format consultancy request object for API response
 */
const formatConsultancyRequest = (item) => {
  if (!item) return null;
  return {
    ...item,
    price: Number(item.price),
    payment: item.payment
      ? {
          id: item.payment.id,
          status: item.payment.status,
          amount: item.payment.amount,
          amountRupees: item.payment.amount ? item.payment.amount / 100 : 0,
          paidAt: item.payment.paidAt,
          refundEligibleAt: item.payment.refundEligibleAt,
          refundedAt: item.payment.refundedAt
        }
      : null
  };
};

/**
 * User: Create a new consultancy request (legacy free flow when payments disabled)
 */
export const createConsultancyRequest = async ({ userId, callType, duration, phoneNumber, email }) => {
  const calculatedPrice = getConsultancyPrice(callType, duration);

  const request = await prisma.consultancyRequest.create({
    data: {
      userId,
      callType,
      duration,
      price: calculatedPrice,
      phoneNumber: phoneNumber.trim(),
      email: email.trim().toLowerCase(),
      status: 'PENDING',
      completedAt: null
    },
    include: { payment: true }
  });

  return formatConsultancyRequest(request);
};

/**
 * User: Get consultancy history for authenticated user
 */
export const getUserConsultancyHistory = async ({ userId, page = 1, limit = 10 }) => {
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
  const skip = (parsedPage - 1) * parsedLimit;
  const take = parsedLimit;

  const where = { userId };

  const [total, items] = await prisma.$transaction([
    prisma.consultancyRequest.count({ where }),
    prisma.consultancyRequest.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: { payment: true }
    })
  ]);

  return {
    requests: items.map(formatConsultancyRequest),
    pagination: {
      total,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.ceil(total / parsedLimit) || 1
    }
  };
};

/**
 * User: Get single consultancy request by ID belonging to authenticated user
 */
export const getUserConsultancyRequestById = async ({ userId, id }) => {
  const request = await prisma.consultancyRequest.findUnique({
    where: { id },
    include: { payment: true }
  });

  if (!request || request.userId !== userId) {
    const err = new Error('Consultancy request not found.');
    err.statusCode = 404;
    throw err;
  }

  return formatConsultancyRequest(request);
};

/**
 * Admin: List consultancy requests with optional status filtering and FIFO ordering (createdAt ASC, id ASC)
 */
export const listAdminConsultancyRequests = async ({ page = 1, limit = 10, status }) => {
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
  const skip = (parsedPage - 1) * parsedLimit;
  const take = parsedLimit;

  const where = {};
  if (status) {
    where.status = status;
  }

  const [total, items] = await prisma.$transaction([
    prisma.consultancyRequest.count({ where }),
    prisma.consultancyRequest.findMany({
      where,
      skip,
      take,
      orderBy: [
        { createdAt: 'asc' },
        { id: 'asc' }
      ],
      include: {
        payment: true,
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true
          }
        }
      }
    })
  ]);

  return {
    requests: items.map(formatConsultancyRequest),
    pagination: {
      total,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.ceil(total / parsedLimit) || 1
    }
  };
};

/**
 * Admin: Mark a consultancy request as COMPLETED
 */
export const markConsultancyRequestCompleted = async (id) => {
  const existing = await prisma.consultancyRequest.findUnique({
    where: { id },
    include: {
      payment: true,
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true
        }
      }
    }
  });

  if (!existing) {
    const err = new Error('Consultancy request not found.');
    err.statusCode = 404;
    throw err;
  }

  // Block completion if payment is refunded or refund is pending
  if (existing.payment && (existing.payment.status === 'REFUNDED' || existing.payment.status === 'REFUND_PENDING')) {
    const err = new Error('Cannot complete a consultancy request that has been refunded or has a refund pending.');
    err.statusCode = 400;
    throw err;
  }

  // Idempotent completion if already completed
  if (existing.status === 'COMPLETED') {
    return formatConsultancyRequest(existing);
  }

  const updated = await prisma.consultancyRequest.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date()
    },
    include: {
      payment: true,
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true
        }
      }
    }
  });

  return formatConsultancyRequest(updated);
};
