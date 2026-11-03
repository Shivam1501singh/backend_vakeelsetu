import prisma from '../lib/prisma.js';
import { generateWithdrawalId } from '../utils/idFormat.js';
import {
  encryptField,
  decryptField,
  maskAccountNumber,
  isPayoutEncryptionConfigured
} from '../utils/fieldEncryption.util.js';

let warnedInvalidMinAmount = false;

/**
 * Resolves the minimum withdrawal amount in rupees from MIN_WITHDRAWAL_AMOUNT.
 * Default is 500 rupees.
 * @returns {number}
 */
export const getMinWithdrawalAmount = () => {
  const envVal = process.env.MIN_WITHDRAWAL_AMOUNT;
  if (!envVal || !envVal.trim()) {
    return 500;
  }
  const parsed = parseFloat(envVal.trim());
  if (isNaN(parsed) || parsed <= 0) {
    if (!warnedInvalidMinAmount) {
      console.warn(`[Config Warning] Invalid MIN_WITHDRAWAL_AMOUNT "${envVal}". Defaulting to 500 rupees.`);
      warnedInvalidMinAmount = true;
    }
    return 500;
  }
  return parsed;
};

/**
 * Normalizes advocate or account holder names for fuzzy/heuristic matching.
 * Strips common prefixes ("Adv.", "Advocate"), non-alphanumeric chars, and whitespace.
 * @param {string} name
 * @returns {string}
 */
export const normalizeName = (name) => {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/^(adv\.|advocate\s+)/i, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Computes an advocate's balance summary.
 * All financial calculations operate on integer paise and are converted to 2-decimal rupees at return.
 *
 * @param {string} advocateId
 * @param {object} [client=prisma]
 * @returns {Promise<object>}
 */
export const getAdvocateEarningsSummary = async (advocateId, client = prisma) => {
  const minWithdrawalRupees = getMinWithdrawalAmount();
  const minWithdrawalPaise = Math.round(minWithdrawalRupees * 100);

  // 1. Available balance from double-entry ledger: SUM(amountPaise)
  const ledgerSum = await client.advocateEarningLedger.aggregate({
    where: { advocateId },
    _sum: { amountPaise: true }
  });
  const availablePaise = ledgerSum._sum.amountPaise || 0;

  // 2. Pending balance: sum of fees from CONFIRMED appointments
  const pendingSum = await client.advocateBooking.aggregate({
    where: {
      advocateId,
      status: 'CONFIRMED'
    },
    _sum: { feePaise: true }
  });
  const pendingPaise = pendingSum._sum.feePaise || 0;

  // 3. In Process withdrawals: sum of REQUESTED or APPROVED
  const inProcessSum = await client.advocateWithdrawal.aggregate({
    where: {
      advocateId,
      status: { in: ['REQUESTED', 'APPROVED'] }
    },
    _sum: { amountPaise: true }
  });
  const inProcessPaise = inProcessSum._sum.amountPaise || 0;

  // 4. Withdrawn: sum of PAID withdrawals
  const withdrawnSum = await client.advocateWithdrawal.aggregate({
    where: {
      advocateId,
      status: 'PAID'
    },
    _sum: { amountPaise: true }
  });
  const withdrawnPaise = withdrawnSum._sum.amountPaise || 0;

  // 5. Total Earned: BOOKING_EARNING (+) plus REFUND_REVERSAL (-)
  const earnedSum = await client.advocateEarningLedger.aggregate({
    where: {
      advocateId,
      type: { in: ['BOOKING_EARNING', 'REFUND_REVERSAL'] }
    },
    _sum: { amountPaise: true }
  });
  const totalEarnedPaise = earnedSum._sum.amountPaise || 0;

  // 6. Current open withdrawal (if any)
  const openWithdrawalRecord = await client.advocateWithdrawal.findFirst({
    where: {
      advocateId,
      status: { in: ['REQUESTED', 'APPROVED'] }
    },
    orderBy: { createdAt: 'desc' }
  });

  const openWithdrawal = openWithdrawalRecord
    ? {
        withdrawalId: openWithdrawalRecord.withdrawalId,
        amount: parseFloat((openWithdrawalRecord.amountPaise / 100).toFixed(2)),
        status: openWithdrawalRecord.status,
        createdAt: openWithdrawalRecord.createdAt.toISOString()
      }
    : null;

  const payoutsConfigured = isPayoutEncryptionConfigured();
  const canWithdraw =
    availablePaise >= minWithdrawalPaise &&
    openWithdrawal === null &&
    payoutsConfigured;

  return {
    available: parseFloat((availablePaise / 100).toFixed(2)),
    availablePaise,
    pending: parseFloat((pendingPaise / 100).toFixed(2)),
    pendingPaise,
    inProcess: parseFloat((inProcessPaise / 100).toFixed(2)),
    inProcessPaise,
    withdrawn: parseFloat((withdrawnPaise / 100).toFixed(2)),
    withdrawnPaise,
    totalEarned: parseFloat((totalEarnedPaise / 100).toFixed(2)),
    totalEarnedPaise,
    minWithdrawal: minWithdrawalRupees,
    minWithdrawalPaise,
    canWithdraw,
    openWithdrawal,
    payoutsConfigured
  };
};

/**
 * Retrieves earnings summary and paginated ledger entries for an advocate.
 *
 * @param {string} advocateId
 * @param {object} options
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @returns {Promise<object>}
 */
export const getAdvocateEarningsAndLedger = async (advocateId, { page = 1, limit = 20 } = {}) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const takeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * takeLimit;

  const [summary, total, entries] = await Promise.all([
    getAdvocateEarningsSummary(advocateId),
    prisma.advocateEarningLedger.count({ where: { advocateId } }),
    prisma.advocateEarningLedger.findMany({
      where: { advocateId },
      skip,
      take: takeLimit,
      orderBy: { createdAt: 'desc' },
      include: {
        advocateBooking: {
          select: {
            id: true,
            bookingId: true,
            mode: true,
            startAt: true,
            userName: true
          }
        },
        withdrawal: {
          select: {
            id: true,
            withdrawalId: true,
            status: true
          }
        }
      }
    })
  ]);

  const ledger = entries.map((e) => {
    let label = e.note || e.type;
    const bId = e.advocateBooking?.bookingId || (e.advocateBookingId ? e.advocateBookingId.slice(0, 8) : null);
    const wId = e.withdrawal?.withdrawalId || (e.withdrawalId ? e.withdrawalId.slice(0, 8) : null);

    if (e.type === 'BOOKING_EARNING') {
      label = `Booking ${bId || ''} completed`.trim();
    } else if (e.type === 'WITHDRAWAL_HOLD') {
      label = `Withdrawal ${wId || ''} requested`.trim();
    } else if (e.type === 'WITHDRAWAL_RELEASE') {
      label = `Withdrawal ${wId || ''} rejected (funds released)`.trim();
    } else if (e.type === 'REFUND_REVERSAL') {
      label = `Refund reversal for booking ${bId || ''}`.trim();
    }

    const row = {
      id: e.id,
      type: e.type,
      label,
      amount: parseFloat((e.amountPaise / 100).toFixed(2)),
      amountPaise: e.amountPaise,
      createdAt: e.createdAt.toISOString()
    };

    if (e.advocateBooking) {
      row.booking = {
        bookingId: e.advocateBooking.bookingId,
        mode: e.advocateBooking.mode,
        scheduledAt: e.advocateBooking.startAt ? e.advocateBooking.startAt.toISOString() : null,
        userName: e.advocateBooking.userName
      };
    }

    if (e.withdrawal) {
      row.withdrawalId = e.withdrawal.withdrawalId;
    }

    return row;
  });

  return {
    summary: {
      available: summary.available,
      pending: summary.pending,
      inProcess: summary.inProcess,
      withdrawn: summary.withdrawn,
      totalEarned: summary.totalEarned,
      minWithdrawal: summary.minWithdrawal,
      canWithdraw: summary.canWithdraw,
      openWithdrawal: summary.openWithdrawal
    },
    ledger,
    pagination: {
      page: pageNum,
      limit: takeLimit,
      total,
      totalPages: Math.ceil(total / takeLimit) || 1,
      hasNextPage: skip + entries.length < total
    }
  };
};

/**
 * Retrieves the saved payout account for an advocate (masked for prefill).
 * Never returns full unencrypted account numbers.
 *
 * @param {string} advocateId
 * @returns {Promise<object|null>}
 */
export const getAdvocatePayoutAccount = async (advocateId) => {
  if (!isPayoutEncryptionConfigured()) {
    const err = new Error('Payouts are not configured.');
    err.statusCode = 503;
    throw err;
  }

  const account = await prisma.advocatePayoutAccount.findUnique({
    where: { advocateId }
  });

  if (!account) {
    return null;
  }

  return {
    accountHolderName: account.accountHolderName,
    accountNumberMasked: maskAccountNumber(account.accountNumberLast4),
    ifsc: account.ifsc,
    bankName: account.bankName,
    updatedAt: account.updatedAt.toISOString()
  };
};

/**
 * Creates a new withdrawal request for an advocate.
 * Uses atomic row locking on Advocate to prevent concurrent double-withdrawal race conditions.
 *
 * @param {string} advocateId
 * @param {object} payoutData
 * @returns {Promise<object>}
 */
export const requestWithdrawal = async (advocateId, {
  amount,
  accountHolderName,
  accountNumber,
  ifsc,
  bankName
}) => {
  if (!isPayoutEncryptionConfigured()) {
    const err = new Error('Payouts are not configured.');
    err.statusCode = 503;
    throw err;
  }

  const minWithdrawalRupees = getMinWithdrawalAmount();
  const numAmount = typeof amount === 'number' ? amount : parseFloat(amount);

  if (isNaN(numAmount) || numAmount < minWithdrawalRupees) {
    const err = new Error(`Withdrawal amount must be at least ₹${minWithdrawalRupees}.`);
    err.statusCode = 400;
    throw err;
  }

  const amountPaise = Math.round(numAmount * 100);
  const normalizedIfsc = ifsc.trim().toUpperCase();
  const cleanAccountNum = accountNumber.trim();
  const cleanHolderName = accountHolderName.trim();
  const cleanBankName = bankName.trim();

  // Execute in transaction with advocate row lock
  return await prisma.$transaction(async (tx) => {
    // 1. Lock advocate row
    await tx.$executeRaw`SELECT id FROM "Advocate" WHERE id = ${advocateId} FOR UPDATE`;

    const advocate = await tx.advocate.findUnique({
      where: { id: advocateId },
      select: { id: true, fullName: true, isActive: true, status: true }
    });

    if (!advocate) {
      const err = new Error('Advocate not found.');
      err.statusCode = 404;
      throw err;
    }

    // 2. Ensure NO open withdrawal (REQUESTED or APPROVED)
    const existingOpen = await tx.advocateWithdrawal.findFirst({
      where: {
        advocateId,
        status: { in: ['REQUESTED', 'APPROVED'] }
      }
    });

    if (existingOpen) {
      const err = new Error('You already have a withdrawal in process.');
      err.statusCode = 409;
      throw err;
    }

    // 3. Verify Available balance >= amount
    const ledgerAgg = await tx.advocateEarningLedger.aggregate({
      where: { advocateId },
      _sum: { amountPaise: true }
    });
    const currentAvailablePaise = ledgerAgg._sum.amountPaise || 0;

    if (amountPaise > currentAvailablePaise) {
      const err = new Error('Amount exceeds your available balance.');
      err.statusCode = 400;
      throw err;
    }

    // 4. Check whether bank details changed vs saved payout account
    const prevAccount = await tx.advocatePayoutAccount.findUnique({
      where: { advocateId }
    });

    let bankAccountChanged = false;
    if (prevAccount) {
      try {
        const prevDecryptedNumber = decryptField(prevAccount.accountNumberEncrypted);
        if (prevDecryptedNumber !== cleanAccountNum || prevAccount.ifsc !== normalizedIfsc) {
          bankAccountChanged = true;
        }
      } catch (e) {
        // If decrypting previous account fails, mark changed safely
        bankAccountChanged = true;
      }
    } else {
      bankAccountChanged = false; // False on first save
    }

    // 5. Name match heuristic (informational flag)
    const normAdv = normalizeName(advocate.fullName);
    const normHolder = normalizeName(cleanHolderName);
    const holderNameMatches =
      normAdv === normHolder ||
      (normAdv.length > 2 && normHolder.includes(normAdv)) ||
      (normHolder.length > 2 && normAdv.includes(normHolder));

    // 6. Encrypt sensitive account number
    const accountNumberEncrypted = encryptField(cleanAccountNum);
    const accountNumberLast4 = cleanAccountNum.slice(-4);

    // 7. Upsert AdvocatePayoutAccount
    await tx.advocatePayoutAccount.upsert({
      where: { advocateId },
      create: {
        advocateId,
        accountHolderName: cleanHolderName,
        accountNumberEncrypted,
        accountNumberLast4,
        ifsc: normalizedIfsc,
        bankName: cleanBankName
      },
      update: {
        accountHolderName: cleanHolderName,
        accountNumberEncrypted,
        accountNumberLast4,
        ifsc: normalizedIfsc,
        bankName: cleanBankName
      }
    });

    // 8. Generate unique withdrawal ID
    const withdrawalId = generateWithdrawalId();

    // 9. Create AdvocateWithdrawal in REQUESTED status
    const withdrawal = await tx.advocateWithdrawal.create({
      data: {
        withdrawalId,
        advocateId,
        amountPaise,
        status: 'REQUESTED',
        accountHolderName: cleanHolderName,
        accountNumberEncrypted,
        accountNumberLast4,
        ifsc: normalizedIfsc,
        bankName: cleanBankName,
        bankAccountChanged,
        holderNameMatches
      }
    });

    // 10. Debit ledger with WITHDRAWAL_HOLD
    await tx.advocateEarningLedger.create({
      data: {
        advocateId,
        type: 'WITHDRAWAL_HOLD',
        amountPaise: -amountPaise,
        withdrawalId: withdrawal.id,
        note: `Hold for withdrawal request ${withdrawalId}`,
        createdBy: 'system'
      }
    });

    return {
      withdrawalId: withdrawal.withdrawalId,
      amount: parseFloat((withdrawal.amountPaise / 100).toFixed(2)),
      status: withdrawal.status,
      bank: {
        accountHolderName: withdrawal.accountHolderName,
        accountNumberMasked: maskAccountNumber(withdrawal.accountNumberLast4),
        ifsc: withdrawal.ifsc,
        bankName: withdrawal.bankName
      },
      createdAt: withdrawal.createdAt.toISOString()
    };
  });
};

/**
 * Lists withdrawals for the authenticated advocate.
 *
 * @param {string} advocateId
 * @param {object} options
 * @param {string} [options.status]
 * @param {number} [options.page=1]
 * @param {number} [options.limit=20]
 * @returns {Promise<object>}
 */
export const getAdvocateWithdrawals = async (advocateId, { status, page = 1, limit = 20 } = {}) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const takeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * takeLimit;

  const where = { advocateId };
  if (status && ['REQUESTED', 'APPROVED', 'PAID', 'REJECTED'].includes(status.toUpperCase())) {
    where.status = status.toUpperCase();
  }

  const [total, items] = await Promise.all([
    prisma.advocateWithdrawal.count({ where }),
    prisma.advocateWithdrawal.findMany({
      where,
      skip,
      take: takeLimit,
      orderBy: { createdAt: 'desc' }
    })
  ]);

  const withdrawals = items.map((w) => ({
    id: w.id,
    withdrawalId: w.withdrawalId,
    amount: parseFloat((w.amountPaise / 100).toFixed(2)),
    status: w.status,
    bank: {
      accountHolderName: w.accountHolderName,
      accountNumberMasked: maskAccountNumber(w.accountNumberLast4),
      ifsc: w.ifsc,
      bankName: w.bankName
    },
    utr: w.utr || null,
    rejectionReason: w.rejectionReason || null,
    approvedAt: w.approvedAt ? w.approvedAt.toISOString() : null,
    paidAt: w.paidAt ? w.paidAt.toISOString() : null,
    rejectedAt: w.rejectedAt ? w.rejectedAt.toISOString() : null,
    createdAt: w.createdAt.toISOString()
  }));

  return {
    withdrawals,
    pagination: {
      page: pageNum,
      limit: takeLimit,
      total,
      totalPages: Math.ceil(total / takeLimit) || 1,
      hasNextPage: skip + items.length < total
    }
  };
};

/**
 * Retrieves a single withdrawal for the authenticated advocate.
 *
 * @param {string} advocateId
 * @param {string} idOrWithdrawalId
 * @returns {Promise<object>}
 */
export const getAdvocateWithdrawalById = async (advocateId, idOrWithdrawalId) => {
  const withdrawal = await prisma.advocateWithdrawal.findFirst({
    where: {
      OR: [
        { id: idOrWithdrawalId },
        { withdrawalId: idOrWithdrawalId }
      ]
    }
  });

  if (!withdrawal || withdrawal.advocateId !== advocateId) {
    const err = new Error('Withdrawal request not found.');
    err.statusCode = 404;
    throw err;
  }

  return {
    id: withdrawal.id,
    withdrawalId: withdrawal.withdrawalId,
    amount: parseFloat((withdrawal.amountPaise / 100).toFixed(2)),
    status: withdrawal.status,
    bank: {
      accountHolderName: withdrawal.accountHolderName,
      accountNumberMasked: maskAccountNumber(withdrawal.accountNumberLast4),
      ifsc: withdrawal.ifsc,
      bankName: withdrawal.bankName
    },
    utr: withdrawal.utr || null,
    rejectionReason: withdrawal.rejectionReason || null,
    approvedAt: withdrawal.approvedAt ? withdrawal.approvedAt.toISOString() : null,
    paidAt: withdrawal.paidAt ? withdrawal.paidAt.toISOString() : null,
    rejectedAt: withdrawal.rejectedAt ? withdrawal.rejectedAt.toISOString() : null,
    createdAt: withdrawal.createdAt.toISOString()
  };
};

// ============================================================================
// ADMIN SERVICE METHODS
// ============================================================================

/**
 * Lists withdrawals for Admin with status counts, search, and date filters.
 *
 * @param {object} queryOptions
 * @returns {Promise<object>}
 */
export const listAdminWithdrawals = async ({
  status = 'ALL',
  search,
  from,
  to,
  page = 1,
  limit = 20
} = {}) => {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const takeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * takeLimit;

  const where = {};
  const upperStatus = status ? status.toUpperCase() : 'ALL';
  if (upperStatus !== 'ALL' && ['REQUESTED', 'APPROVED', 'PAID', 'REJECTED'].includes(upperStatus)) {
    where.status = upperStatus;
  }

  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  if (search && search.trim()) {
    const q = search.trim();
    where.OR = [
      { withdrawalId: { contains: q, mode: 'insensitive' } },
      { utr: { contains: q, mode: 'insensitive' } },
      { advocate: { fullName: { contains: q, mode: 'insensitive' } } },
      { advocate: { phone: { contains: q, mode: 'insensitive' } } },
      { advocate: { barCouncilId: { contains: q, mode: 'insensitive' } } }
    ];
  }

  // Count by status groups
  const [allCount, requestedCount, approvedCount, paidCount, rejectedCount] = await Promise.all([
    prisma.advocateWithdrawal.count(),
    prisma.advocateWithdrawal.count({ where: { status: 'REQUESTED' } }),
    prisma.advocateWithdrawal.count({ where: { status: 'APPROVED' } }),
    prisma.advocateWithdrawal.count({ where: { status: 'PAID' } }),
    prisma.advocateWithdrawal.count({ where: { status: 'REJECTED' } })
  ]);

  const [total, items] = await Promise.all([
    prisma.advocateWithdrawal.count({ where }),
    prisma.advocateWithdrawal.findMany({
      where,
      skip,
      take: takeLimit,
      orderBy: { createdAt: 'desc' },
      include: {
        advocate: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            barCouncilId: true
          }
        }
      }
    })
  ]);

  const withdrawals = items.map((w) => ({
    id: w.id,
    withdrawalId: w.withdrawalId,
    amount: parseFloat((w.amountPaise / 100).toFixed(2)),
    status: w.status,
    advocate: {
      id: w.advocate?.id,
      name: w.advocate?.fullName,
      phone: w.advocate?.phone,
      barCouncilId: w.advocate?.barCouncilId
    },
    bank: {
      accountHolderName: w.accountHolderName,
      accountNumberMasked: maskAccountNumber(w.accountNumberLast4),
      ifsc: w.ifsc,
      bankName: w.bankName
    },
    flags: {
      bankAccountChanged: w.bankAccountChanged,
      holderNameMatches: w.holderNameMatches,
      warning: w.bankAccountChanged || !w.holderNameMatches
    },
    utr: w.utr || null,
    rejectionReason: w.rejectionReason || null,
    approvedAt: w.approvedAt ? w.approvedAt.toISOString() : null,
    approvedBy: w.approvedBy || null,
    paidAt: w.paidAt ? w.paidAt.toISOString() : null,
    paidBy: w.paidBy || null,
    rejectedAt: w.rejectedAt ? w.rejectedAt.toISOString() : null,
    rejectedBy: w.rejectedBy || null,
    createdAt: w.createdAt.toISOString()
  }));

  return {
    withdrawals,
    counts: {
      ALL: allCount,
      REQUESTED: requestedCount,
      APPROVED: approvedCount,
      PAID: paidCount,
      REJECTED: rejectedCount
    },
    pagination: {
      page: pageNum,
      limit: takeLimit,
      total,
      totalPages: Math.ceil(total / takeLimit) || 1,
      hasNextPage: skip + items.length < total
    }
  };
};

/**
 * Retrieves full withdrawal details for Admin review.
 * Decrypts account number ONLY if canManage is true (permission payouts:manage).
 *
 * @param {string} idOrWithdrawalId
 * @param {object} options
 * @param {boolean} [options.canManage=false]
 * @returns {Promise<object>}
 */
export const getAdminWithdrawalDetails = async (idOrWithdrawalId, { canManage = false } = {}) => {
  const withdrawal = await prisma.advocateWithdrawal.findFirst({
    where: {
      OR: [
        { id: idOrWithdrawalId },
        { withdrawalId: idOrWithdrawalId }
      ]
    },
    include: {
      advocate: {
        select: {
          id: true,
          fullName: true,
          phone: true,
          barCouncilId: true,
          email: true
        }
      }
    }
  });

  if (!withdrawal) {
    const err = new Error('Withdrawal request not found.');
    err.statusCode = 404;
    throw err;
  }

  // Advocate's current financial summary
  const summary = await getAdvocateEarningsSummary(withdrawal.advocateId);

  // Advocate's last 20 ledger rows
  const recentLedger = await prisma.advocateEarningLedger.findMany({
    where: { advocateId: withdrawal.advocateId },
    take: 20,
    orderBy: { createdAt: 'desc' }
  });

  // Advocate's previous withdrawals (excluding this one)
  const previousWithdrawals = await prisma.advocateWithdrawal.findMany({
    where: {
      advocateId: withdrawal.advocateId,
      id: { not: withdrawal.id }
    },
    take: 10,
    orderBy: { createdAt: 'desc' }
  });

  const bank = {
    accountHolderName: withdrawal.accountHolderName,
    accountNumberMasked: maskAccountNumber(withdrawal.accountNumberLast4),
    ifsc: withdrawal.ifsc,
    bankName: withdrawal.bankName
  };

  // Expose full decrypted account number only if admin holds payouts:manage
  if (canManage) {
    try {
      bank.accountNumber = decryptField(withdrawal.accountNumberEncrypted);
    } catch (e) {
      bank.accountNumber = null;
      bank.decryptionError = 'Failed to decrypt account number';
    }
  }

  return {
    id: withdrawal.id,
    withdrawalId: withdrawal.withdrawalId,
    amount: parseFloat((withdrawal.amountPaise / 100).toFixed(2)),
    status: withdrawal.status,
    advocate: {
      id: withdrawal.advocate?.id,
      fullName: withdrawal.advocate?.fullName,
      phone: withdrawal.advocate?.phone,
      barCouncilId: withdrawal.advocate?.barCouncilId,
      email: withdrawal.advocate?.email
    },
    bank,
    flags: {
      bankAccountChanged: withdrawal.bankAccountChanged,
      holderNameMatches: withdrawal.holderNameMatches,
      warning: withdrawal.bankAccountChanged || !withdrawal.holderNameMatches
    },
    reviewHistory: {
      approvedAt: withdrawal.approvedAt ? withdrawal.approvedAt.toISOString() : null,
      approvedBy: withdrawal.approvedBy || null,
      paidAt: withdrawal.paidAt ? withdrawal.paidAt.toISOString() : null,
      paidBy: withdrawal.paidBy || null,
      utr: withdrawal.utr || null,
      rejectedAt: withdrawal.rejectedAt ? withdrawal.rejectedAt.toISOString() : null,
      rejectedBy: withdrawal.rejectedBy || null,
      rejectionReason: withdrawal.rejectionReason || null
    },
    advocateSummary: {
      available: summary.available,
      pending: summary.pending,
      withdrawn: summary.withdrawn
    },
    recentLedger: recentLedger.map((l) => ({
      id: l.id,
      type: l.type,
      amount: parseFloat((l.amountPaise / 100).toFixed(2)),
      note: l.note,
      createdAt: l.createdAt.toISOString()
    })),
    previousWithdrawals: previousWithdrawals.map((pw) => ({
      id: pw.id,
      withdrawalId: pw.withdrawalId,
      amount: parseFloat((pw.amountPaise / 100).toFixed(2)),
      status: pw.status,
      utr: pw.utr || null,
      createdAt: pw.createdAt.toISOString()
    })),
    createdAt: withdrawal.createdAt.toISOString(),
    updatedAt: withdrawal.updatedAt.toISOString()
  };
};

/**
 * Approves a REQUESTED withdrawal.
 * State transition: REQUESTED -> APPROVED.
 * Uses conditional update to prevent double-processing.
 *
 * @param {string} idOrWithdrawalId
 * @param {object} adminUser
 * @returns {Promise<object>}
 */
export const approveWithdrawal = async (idOrWithdrawalId, adminUser) => {
  const withdrawal = await prisma.advocateWithdrawal.findFirst({
    where: {
      OR: [
        { id: idOrWithdrawalId },
        { withdrawalId: idOrWithdrawalId }
      ]
    }
  });

  if (!withdrawal) {
    const err = new Error('Withdrawal request not found.');
    err.statusCode = 404;
    throw err;
  }

  const now = new Date();
  const updateRes = await prisma.advocateWithdrawal.updateMany({
    where: {
      id: withdrawal.id,
      status: 'REQUESTED'
    },
    data: {
      status: 'APPROVED',
      approvedAt: now,
      approvedBy: adminUser.id
    }
  });

  if (updateRes.count === 0) {
    const fresh = await prisma.advocateWithdrawal.findUnique({ where: { id: withdrawal.id } });
    const err = new Error(`This withdrawal is already ${fresh?.status || 'processed'}.`);
    err.statusCode = 409;
    throw err;
  }

  return {
    id: withdrawal.id,
    withdrawalId: withdrawal.withdrawalId,
    status: 'APPROVED',
    approvedAt: now.toISOString(),
    approvedBy: adminUser.id
  };
};

/**
 * Marks an APPROVED withdrawal as PAID.
 * State transition: APPROVED -> PAID.
 * Uses conditional update to prevent double-processing.
 *
 * @param {string} idOrWithdrawalId
 * @param {object} payload
 * @param {string} payload.utr
 * @param {string} [payload.paidAt]
 * @param {object} adminUser
 * @returns {Promise<object>}
 */
export const markWithdrawalPaid = async (idOrWithdrawalId, { utr, paidAt }, adminUser) => {
  const withdrawal = await prisma.advocateWithdrawal.findFirst({
    where: {
      OR: [
        { id: idOrWithdrawalId },
        { withdrawalId: idOrWithdrawalId }
      ]
    }
  });

  if (!withdrawal) {
    const err = new Error('Withdrawal request not found.');
    err.statusCode = 404;
    throw err;
  }

  const paymentDate = paidAt ? new Date(paidAt) : new Date();
  const updateRes = await prisma.advocateWithdrawal.updateMany({
    where: {
      id: withdrawal.id,
      status: 'APPROVED'
    },
    data: {
      status: 'PAID',
      utr: utr.trim(),
      paidAt: paymentDate,
      paidBy: adminUser.id
    }
  });

  if (updateRes.count === 0) {
    const fresh = await prisma.advocateWithdrawal.findUnique({ where: { id: withdrawal.id } });
    const err = new Error(`This withdrawal is already ${fresh?.status || 'processed'}.`);
    err.statusCode = 409;
    throw err;
  }

  return {
    id: withdrawal.id,
    withdrawalId: withdrawal.withdrawalId,
    status: 'PAID',
    utr: utr.trim(),
    paidAt: paymentDate.toISOString(),
    paidBy: adminUser.id
  };
};

/**
 * Rejects a REQUESTED or APPROVED withdrawal and releases held funds back to Available balance.
 * State transition: REQUESTED | APPROVED -> REJECTED.
 *
 * @param {string} idOrWithdrawalId
 * @param {object} payload
 * @param {string} payload.reason
 * @param {object} adminUser
 * @returns {Promise<object>}
 */
export const rejectWithdrawal = async (idOrWithdrawalId, { reason }, adminUser) => {
  const withdrawal = await prisma.advocateWithdrawal.findFirst({
    where: {
      OR: [
        { id: idOrWithdrawalId },
        { withdrawalId: idOrWithdrawalId }
      ]
    }
  });

  if (!withdrawal) {
    const err = new Error('Withdrawal request not found.');
    err.statusCode = 404;
    throw err;
  }

  const now = new Date();
  const cleanReason = reason.trim();

  return await prisma.$transaction(async (tx) => {
    const updateRes = await tx.advocateWithdrawal.updateMany({
      where: {
        id: withdrawal.id,
        status: { in: ['REQUESTED', 'APPROVED'] }
      },
      data: {
        status: 'REJECTED',
        rejectedAt: now,
        rejectedBy: adminUser.id,
        rejectionReason: cleanReason
      }
    });

    if (updateRes.count === 0) {
      const fresh = await tx.advocateWithdrawal.findUnique({ where: { id: withdrawal.id } });
      const err = new Error(`This withdrawal is already ${fresh?.status || 'processed'}.`);
      err.statusCode = 409;
      throw err;
    }

    // Insert WITHDRAWAL_RELEASE to restore held funds
    await tx.advocateEarningLedger.create({
      data: {
        advocateId: withdrawal.advocateId,
        type: 'WITHDRAWAL_RELEASE',
        amountPaise: withdrawal.amountPaise,
        withdrawalId: withdrawal.id,
        note: `Release held funds for rejected withdrawal ${withdrawal.withdrawalId}`,
        createdBy: adminUser.id
      }
    });

    return {
      id: withdrawal.id,
      withdrawalId: withdrawal.withdrawalId,
      status: 'REJECTED',
      rejectionReason: cleanReason,
      rejectedAt: now.toISOString(),
      rejectedBy: adminUser.id
    };
  });
};

// ============================================================================
// SYSTEM HOOKS (Called from Booking & Refund Flows)
// ============================================================================

/**
 * Credits advocate consultation fee to ledger on appointment completion.
 * Idempotent: duplicate calls will not create extra credits.
 *
 * @param {string} advocateBookingId
 * @param {object} [tx=prisma]
 * @returns {Promise<object|null>}
 */
export const creditBookingEarning = async (advocateBookingId, tx = prisma) => {
  const booking = await tx.advocateBooking.findUnique({
    where: { id: advocateBookingId },
    select: { id: true, bookingId: true, advocateId: true, feePaise: true, status: true }
  });

  if (!booking) {
    return null;
  }

  // Check if earning already credited
  const existing = await tx.advocateEarningLedger.findUnique({
    where: {
      type_advocateBookingId: {
        type: 'BOOKING_EARNING',
        advocateBookingId: booking.id
      }
    }
  });

  if (existing) {
    return existing;
  }

  return await tx.advocateEarningLedger.create({
    data: {
      advocateId: booking.advocateId,
      type: 'BOOKING_EARNING',
      amountPaise: booking.feePaise,
      advocateBookingId: booking.id,
      note: `Earning for completed booking ${booking.bookingId || booking.id}`,
      createdBy: 'system'
    }
  });
};

/**
 * Reverses advocate consultation fee when a COMPLETED booking is refunded.
 * Idempotent: checks for existing REFUND_REVERSAL and only reverses if BOOKING_EARNING was credited.
 *
 * @param {string} advocateBookingId
 * @param {string} [userId='system']
 * @param {object} [tx=prisma]
 * @returns {Promise<object|null>}
 */
export const reverseBookingEarningOnRefund = async (advocateBookingId, userId = 'system', tx = prisma) => {
  const booking = await tx.advocateBooking.findUnique({
    where: { id: advocateBookingId },
    select: { id: true, bookingId: true, advocateId: true, feePaise: true }
  });

  if (!booking) {
    return null;
  }

  // Check if booking had an earning credited
  const earning = await tx.advocateEarningLedger.findUnique({
    where: {
      type_advocateBookingId: {
        type: 'BOOKING_EARNING',
        advocateBookingId: booking.id
      }
    }
  });

  if (!earning) {
    // If no earning was credited (e.g. was never completed), do not reverse
    return null;
  }

  // Check if reversal already exists
  const existingReversal = await tx.advocateEarningLedger.findUnique({
    where: {
      type_advocateBookingId: {
        type: 'REFUND_REVERSAL',
        advocateBookingId: booking.id
      }
    }
  });

  if (existingReversal) {
    return existingReversal;
  }

  return await tx.advocateEarningLedger.create({
    data: {
      advocateId: booking.advocateId,
      type: 'REFUND_REVERSAL',
      amountPaise: -booking.feePaise,
      advocateBookingId: booking.id,
      note: `Reversal of fee for refunded booking ${booking.bookingId || booking.id}`,
      createdBy: userId || 'system'
    }
  });
};
