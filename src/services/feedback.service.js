import prisma from '../lib/prisma.js';

/**
 * Submit feedback for User or Advocate
 * Populates name and phone from the authenticated profile
 */
export const submitFeedback = async ({ accountId, userId, userType = 'USER', description }) => {
  const resolvedId = accountId || userId;
  const normalizedType = (userType || 'USER').toUpperCase();

  let name = '';
  let phone = '';
  let targetUserId = null;
  let targetAdvocateId = null;

  if (normalizedType === 'ADVOCATE') {
    const advocate = await prisma.advocate.findUnique({
      where: { id: resolvedId },
      select: {
        id: true,
        fullName: true,
        phone: true
      }
    });

    if (!advocate) {
      const err = new Error('Advocate account not found.');
      err.statusCode = 404;
      throw err;
    }

    name = advocate.fullName;
    phone = advocate.phone;
    targetAdvocateId = advocate.id;
  } else {
    const user = await prisma.user.findUnique({
      where: { id: resolvedId },
      select: {
        id: true,
        fullName: true,
        phone: true
      }
    });

    if (!user) {
      const err = new Error('User account not found.');
      err.statusCode = 404;
      throw err;
    }

    name = user.fullName;
    phone = user.phone;
    targetUserId = user.id;
  }

  const feedback = await prisma.feedback.create({
    data: {
      name,
      phone,
      description: description.trim(),
      userType: normalizedType,
      userId: targetUserId,
      advocateId: targetAdvocateId
    }
  });

  return feedback;
};

/**
 * Admin: List all submitted feedback with pagination (latest first)
 * Supports optional filtering by userType ('USER' | 'ADVOCATE')
 */
export const listFeedbacksAdmin = async ({ page = 1, limit = 10, userType } = {}) => {
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
  const skip = (parsedPage - 1) * parsedLimit;
  const take = parsedLimit;

  const where = {};
  if (userType && ['USER', 'ADVOCATE'].includes(userType.toUpperCase())) {
    where.userType = userType.toUpperCase();
  }

  const [total, feedbacks] = await prisma.$transaction([
    prisma.feedback.count({ where }),
    prisma.feedback.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        phone: true,
        description: true,
        userType: true,
        userId: true,
        advocateId: true,
        createdAt: true,
        updatedAt: true
      }
    })
  ]);

  return {
    feedbacks,
    pagination: {
      total,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.ceil(total / parsedLimit) || 1
    }
  };
};

/**
 * Admin: Delete feedback by ID
 */
export const deleteFeedbackAdmin = async (id) => {
  const existingFeedback = await prisma.feedback.findUnique({
    where: { id }
  });

  if (!existingFeedback) {
    const err = new Error('Feedback not found.');
    err.statusCode = 404;
    throw err;
  }

  const deletedFeedback = await prisma.feedback.delete({
    where: { id }
  });

  return deletedFeedback;
};
