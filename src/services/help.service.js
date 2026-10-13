import prisma from '../lib/prisma.js';
import crypto from 'crypto';

/**
 * Generates a secure, cryptographically random Help reference ID (e.g., VKLS-8F4K29).
 */
const generateReferenceId = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let ref = 'VKLS-';
  for (let i = 0; i < 6; i++) {
    ref += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return ref;
};

/**
 * Creates a public help concern request.
 * Generates a unique reference ID.
 */
export const createHelpRequest = async ({ name, email, phoneNumber, concern }) => {
  let referenceId;
  let exists = true;
  let attempts = 0;

  // Collision safety loop
  while (exists && attempts < 10) {
    referenceId = generateReferenceId();
    const existing = await prisma.helpRequest.findUnique({
      where: { referenceId }
    });
    if (!existing) {
      exists = false;
    }
    attempts++;
  }

  const data = {
    referenceId,
    name: name.trim(),
    email: email.toLowerCase().trim(),
    phoneNumber: phoneNumber.trim(),
    concern: concern.trim(),
    status: 'OPEN'
  };

  return await prisma.helpRequest.create({ data });
};

/**
 * Look up a public help request by reference ID and email.
 * This checks matching email to prevent enumeration blocks.
 * Strictly excludes responder audit fields to protect internal staff identity.
 */
export const lookupHelpRequest = async ({ referenceId, email }) => {
  const cleanRef = referenceId.trim();
  const cleanEmail = email.toLowerCase().trim();

  const helpRequest = await prisma.helpRequest.findUnique({
    where: { referenceId: cleanRef }
  });

  if (!helpRequest || helpRequest.email !== cleanEmail) {
    const err = new Error('Help request not found.');
    err.statusCode = 404;
    throw err;
  }

  // Remove responder audit fields from public output
  const { respondedById, respondedByType, respondedByName, ...publicHelpRequest } = helpRequest;
  return publicHelpRequest;
};

/**
 * Get details for admin by database ID.
 */
export const getHelpRequestAdmin = async (id) => {
  const helpRequest = await prisma.helpRequest.findUnique({
    where: { id }
  });

  if (!helpRequest) {
    const err = new Error('Help request not found.');
    err.statusCode = 404;
    throw err;
  }

  return helpRequest;
};

/**
 * Admin: List and filter help requests with pagination, status counts, and optional search.
 */
export const listAllHelpRequestsAdmin = async ({ page = 1, limit = 20, status, email, referenceId, search }) => {
  let parsedPage = parseInt(page, 10);
  if (isNaN(parsedPage) || parsedPage < 1) {
    parsedPage = 1;
  }

  let parsedLimit = parseInt(limit, 10);
  if (isNaN(parsedLimit) || parsedLimit < 1) {
    parsedLimit = 20;
  }
  if (parsedLimit > 100) {
    parsedLimit = 100;
  }

  const skip = (parsedPage - 1) * parsedLimit;
  const take = parsedLimit;

  const where = {};
  if (status) where.status = status;
  if (email) where.email = { contains: email.toLowerCase().trim(), mode: 'insensitive' };
  if (referenceId) where.referenceId = referenceId.trim();

  if (search && typeof search === 'string' && search.trim()) {
    const s = search.trim();
    where.OR = [
      { name: { contains: s, mode: 'insensitive' } },
      { email: { contains: s, mode: 'insensitive' } },
      { phoneNumber: { contains: s, mode: 'insensitive' } },
      { referenceId: { contains: s, mode: 'insensitive' } },
      { concern: { contains: s, mode: 'insensitive' } }
    ];
  }

  const [total, helpRequests, statusGroups] = await prisma.$transaction([
    prisma.helpRequest.count({ where }),
    prisma.helpRequest.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' }
    }),
    prisma.helpRequest.groupBy({
      by: ['status'],
      _count: {
        _all: true
      }
    })
  ]);

  const counts = {
    OPEN: 0,
    IN_PROGRESS: 0,
    RESOLVED: 0,
    CLOSED: 0,
    total: 0
  };

  statusGroups.forEach((group) => {
    const countVal = group._count._all || 0;
    if (Object.prototype.hasOwnProperty.call(counts, group.status)) {
      counts[group.status] = countVal;
    }
    counts.total += countVal;
  });

  return {
    helpRequests,
    counts,
    pagination: {
      total,
      page: parsedPage,
      limit: take,
      totalPages: Math.ceil(total / take)
    }
  };
};

/**
 * Support/Admin response submission.
 */
export const respondToHelpRequest = async (id, { response, status, responder = null }) => {
  const helpRequest = await prisma.helpRequest.findUnique({
    where: { id }
  });

  if (!helpRequest) {
    const err = new Error('Help request not found.');
    err.statusCode = 404;
    throw err;
  }

  const updateData = {
    response: response.trim(),
    status,
    respondedAt: new Date()
  };

  if (responder) {
    if (responder.id !== undefined) updateData.respondedById = responder.id;
    if (responder.type !== undefined) updateData.respondedByType = responder.type;
    if (responder.name !== undefined) updateData.respondedByName = responder.name;
  }

  return await prisma.helpRequest.update({
    where: { id },
    data: updateData
  });
};
