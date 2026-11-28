import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';
import { sendAdvocateTestLinkEmail, sendTestResponseSheetEmail } from './email.service.js';

let warnedConfig = false;

/**
 * Parses integer env var with fallback and one startup warning.
 */
const parsePositiveIntEnv = (key, fallback) => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  if (!warnedConfig) {
    console.warn(`[Advocate Test Config] Invalid ${key}="${raw}". Using default: ${fallback}`);
  }
  return fallback;
};

/**
 * Returns test configuration values.
 */
export const getTestConfig = () => {
  const config = {
    questionCount: parsePositiveIntEnv('ADVOCATE_TEST_QUESTION_COUNT', 20),
    passMark: parsePositiveIntEnv('ADVOCATE_TEST_PASS_MARK', 15),
    durationMinutes: parsePositiveIntEnv('ADVOCATE_TEST_DURATION_MINUTES', 20),
    linkValidHours: parsePositiveIntEnv('ADVOCATE_TEST_LINK_VALID_HOURS', 72),
    rescheduleDelayMinutes: parsePositiveIntEnv('ADVOCATE_TEST_RESCHEDULE_DELAY_MINUTES', 60)
  };
  warnedConfig = true;
  return config;
};

/**
 * Hashes raw string using SHA-256.
 * @param {string} token
 * @returns {string}
 */
export const hashToken = (token) => {
  if (!token || typeof token !== 'string') return '';
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
};

/**
 * Generates secure random 32-byte base64url token.
 * @returns {string}
 */
export const generateSecureToken = () => {
  return crypto.randomBytes(32).toString('base64url');
};

/**
 * Creates short-lived test session JWT (30 min).
 * @param {{ inviteId: string, advocateId: string }} payload
 * @returns {string}
 */
export const signTestSessionToken = ({ inviteId, advocateId }) => {
  const secret = process.env.JWT_SECRET || 'supersecretjwtsigningkeychangeinproduction';
  return jwt.sign(
    {
      type: 'advocate_test',
      inviteId,
      advocateId
    },
    secret,
    { expiresIn: '30m' }
  );
};

/**
 * Verifies test session JWT.
 * @param {string} token
 * @returns {{ type: string, inviteId: string, advocateId: string }|null}
 */
export const verifyTestSessionToken = (token) => {
  try {
    const secret = process.env.JWT_SECRET || 'supersecretjwtsigningkeychangeinproduction';
    const decoded = jwt.verify(token, secret);
    if (!decoded || decoded.type !== 'advocate_test' || !decoded.inviteId || !decoded.advocateId) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
};

/**
 * Normalizes phone number to last 10 digits.
 * @param {string} phone
 * @returns {string}
 */
export const normalizePhone = (phone = '') => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

/**
 * Normalizes Bar Council ID (trim + case-insensitive compare).
 * @param {string} id
 * @returns {string}
 */
export const normalizeBarCouncilId = (id = '') => {
  return String(id || '').trim().toUpperCase();
};

/**
 * Cryptographically random shuffle using Fisher-Yates algorithm.
 * @param {Array} array
 * @returns {Array} New shuffled array
 */
export const shuffleArray = (array) => {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

/**
 * Authenticates advocate for test access and determines page state.
 *
 * @param {object} params
 * @param {string} params.token
 * @param {string} params.barCouncilId
 * @param {string} params.phone
 * @returns {Promise<object>}
 */
export const loginAdvocateTest = async ({ token, barCouncilId, phone }) => {
  if (!token || !barCouncilId || !phone) {
    const err = new Error("The details don't match this test link.");
    err.code = 'INVALID_CREDENTIALS';
    err.statusCode = 401;
    throw err;
  }

  const tokenHash = hashToken(token);
  const invite = await prisma.advocateTestInvite.findUnique({
    where: { tokenHash },
    include: {
      advocate: true,
      attempt: true
    }
  });

  if (!invite || !invite.advocate) {
    const err = new Error("The details don't match this test link.");
    err.code = 'INVALID_CREDENTIALS';
    err.statusCode = 401;
    throw err;
  }

  const advocate = invite.advocate;
  const inputBarId = normalizeBarCouncilId(barCouncilId);
  const inputPhone = normalizePhone(phone);
  const advocateBarId = normalizeBarCouncilId(advocate.barCouncilId);
  const advocatePhone = normalizePhone(advocate.phone);

  if (inputBarId !== advocateBarId || inputPhone !== advocatePhone) {
    const err = new Error("The details don't match this test link.");
    err.code = 'INVALID_CREDENTIALS';
    err.statusCode = 401;
    throw err;
  }

  const config = getTestConfig();
  const now = new Date();

  // 1. Advocate already passed test previously
  if (advocate.testPassedAt) {
    return {
      status: 'ALREADY_PASSED',
      passedAt: advocate.testPassedAt
    };
  }

  const attempt = invite.attempt;

  // 2. Link already used and attempt completed/submitted
  if (attempt && attempt.submittedAt) {
    return {
      status: 'COMPLETED',
      result: {
        correct: attempt.correctCount ?? 0,
        wrong: attempt.wrongCount ?? 0,
        total: attempt.totalQuestions,
        passed: Boolean(attempt.passed)
      },
      canRequestReschedule: !attempt.passed
    };
  }

  // 3. Link expired (and no attempt made yet)
  const isLinkExpired =
    invite.status === 'EXPIRED' ||
    (invite.status === 'SENT' && invite.expiresAt && now > new Date(invite.expiresAt));

  if (!attempt && isLinkExpired) {
    const err = new Error('This test link has expired. Please request a reschedule.');
    err.code = 'LINK_EXPIRED';
    err.statusCode = 410;
    err.canRequestReschedule = true;
    throw err;
  }

  const testSession = signTestSessionToken({
    inviteId: invite.id,
    advocateId: advocate.id
  });

  // 4. Attempt in progress (within deadline + 60s grace)
  if (attempt && !attempt.submittedAt) {
    const graceDeadline = new Date(attempt.deadlineAt.getTime() + 60000);
    if (now <= graceDeadline) {
      return {
        status: 'IN_PROGRESS',
        testSession,
        attemptId: attempt.id
      };
    }
  }

  // 5. Valid link, ready to start test
  return {
    status: 'READY',
    testSession,
    rules: {
      questions: config.questionCount,
      minutes: config.durationMinutes,
      passMark: config.passMark
    }
  };
};

/**
 * Starts or resumes a test attempt for an invite.
 *
 * @param {object} params
 * @param {string} params.inviteId
 * @param {string} params.advocateId
 * @returns {Promise<object>}
 */
export const startAdvocateTest = async ({ inviteId, advocateId }) => {
  const invite = await prisma.advocateTestInvite.findUnique({
    where: { id: inviteId },
    include: { attempt: true, advocate: true }
  });

  if (!invite || invite.advocateId !== advocateId) {
    const err = new Error('Invalid test invite.');
    err.code = 'INVALID_INVITE';
    err.statusCode = 404;
    throw err;
  }

  if (invite.advocate.testPassedAt) {
    const err = new Error('You have already passed the qualification test.');
    err.code = 'ALREADY_PASSED';
    err.statusCode = 409;
    throw err;
  }

  const config = getTestConfig();
  const now = new Date();

  // If attempt already exists, return it idempotently
  if (invite.attempt) {
    const attempt = invite.attempt;
    const questionsSnapshot = Array.isArray(attempt.questions) ? attempt.questions : [];

    const publicQuestions = questionsSnapshot.map((q, idx) => ({
      index: idx,
      question: q.question,
      options: (q.options || []).map((optText, optIdx) => ({
        key: String.fromCharCode(65 + optIdx),
        text: optText
      }))
    }));

    return {
      attemptId: attempt.id,
      serverNow: now,
      deadlineAt: attempt.deadlineAt,
      questions: publicQuestions,
      savedAnswers: attempt.answers || []
    };
  }

  // Verify link is not expired
  if (
    invite.status === 'EXPIRED' ||
    (invite.status === 'SENT' && invite.expiresAt && now > new Date(invite.expiresAt))
  ) {
    const err = new Error('This test link has expired. Please request a reschedule.');
    err.code = 'LINK_EXPIRED';
    err.statusCode = 410;
    err.canRequestReschedule = true;
    throw err;
  }

  // Fetch active non-deleted questions
  const activeQuestions = await prisma.advocateTestQuestion.findMany({
    where: {
      isActive: true,
      deletedAt: null
    }
  });

  if (activeQuestions.length < config.questionCount) {
    const err = new Error('Test is currently unavailable. Please contact support.');
    err.code = 'TEST_UNAVAILABLE';
    err.statusCode = 503;
    throw err;
  }

  // Pick random questions and shuffle
  const selectedPool = shuffleArray(activeQuestions).slice(0, config.questionCount);

  // Snapshot generation with shuffled options per question
  const snapshotQuestions = selectedPool.map((q) => {
    const originalOptions = Array.isArray(q.options) ? q.options : [];
    const optionIndices = [0, 1, 2, 3];
    const shuffledIndices = shuffleArray(optionIndices);

    const shuffledOptions = shuffledIndices.map((i) => originalOptions[i] || '');
    const correctIndex = shuffledIndices.indexOf(q.correctOption);

    return {
      questionId: q.id,
      question: q.question,
      options: shuffledOptions,
      correctIndex
    };
  });

  const startedAt = now;
  const deadlineAt = new Date(startedAt.getTime() + config.durationMinutes * 60 * 1000);

  const attempt = await prisma.advocateTestAttempt.create({
    data: {
      advocateId,
      inviteId,
      questions: snapshotQuestions,
      answers: [],
      startedAt,
      deadlineAt,
      totalQuestions: snapshotQuestions.length
    }
  });

  const publicQuestions = snapshotQuestions.map((q, idx) => ({
    index: idx,
    question: q.question,
    options: q.options.map((optText, optIdx) => ({
      key: String.fromCharCode(65 + optIdx),
      text: optText
    }))
  }));

  return {
    attemptId: attempt.id,
    serverNow: startedAt,
    deadlineAt,
    questions: publicQuestions,
    savedAnswers: []
  };
};

/**
 * Autosaves answers for an ongoing attempt.
 *
 * @param {object} params
 * @param {string} params.inviteId
 * @param {string} params.advocateId
 * @param {Array<{ index: number, selected: string|null }>} params.answers
 * @returns {Promise<object>}
 */
export const saveAdvocateTestAnswers = async ({ inviteId, advocateId, answers }) => {
  const attempt = await prisma.advocateTestAttempt.findUnique({
    where: { inviteId }
  });

  if (!attempt || attempt.advocateId !== advocateId) {
    const err = new Error('Test attempt not found.');
    err.code = 'NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  if (attempt.submittedAt) {
    const err = new Error('Test has already been submitted.');
    err.code = 'ALREADY_SUBMITTED';
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();
  const graceDeadline = new Date(attempt.deadlineAt.getTime() + 60000);

  // If past deadline + grace, auto-submit and reject new edits
  if (now > graceDeadline) {
    const result = await scoreAndFinalizeAttempt({
      attemptId: attempt.id,
      submittedAnswers: attempt.answers || [],
      autoSubmitted: true
    });
    // Send response sheet email asynchronously on auto-submit
    sendTestResponseSheetEmail(attempt.id).catch((emailErr) => {
      console.error(`[Advocate Test Service] Failed sending response sheet email on auto-submit for attempt ${attempt.id}:`, emailErr.message);
    });
    return {
      success: false,
      code: 'TIME_EXPIRED',
      message: 'Time limit expired. Test has been auto-submitted.',
      result
    };
  }

  // Validate and sanitize answers array
  const sanitizedAnswers = Array.isArray(answers)
    ? answers.map((ans) => ({
        index: Number(ans.index),
        selected: ans.selected ? String(ans.selected).trim().toUpperCase() : null
      }))
    : [];

  await prisma.advocateTestAttempt.update({
    where: { id: attempt.id },
    data: {
      answers: sanitizedAnswers
    }
  });

  return {
    success: true,
    savedAt: now
  };
};

/**
 * Scores and finalizes an attempt.
 */
const scoreAndFinalizeAttempt = async ({ attemptId, submittedAnswers = null, autoSubmitted = false }) => {
  return await prisma.$transaction(async (tx) => {
    const attempt = await tx.advocateTestAttempt.findUnique({
      where: { id: attemptId },
      include: { invite: true, advocate: true }
    });

    if (!attempt) {
      throw new Error('Attempt not found');
    }

    if (attempt.submittedAt) {
      return {
        correct: attempt.correctCount ?? 0,
        wrong: attempt.wrongCount ?? 0,
        total: attempt.totalQuestions,
        passed: Boolean(attempt.passed),
        message: attempt.passed ? 'You have passed the test.' : 'Test completed.',
        canRequestReschedule: !attempt.passed
      };
    }

    const config = getTestConfig();
    const questionsSnapshot = Array.isArray(attempt.questions) ? attempt.questions : [];
    const finalAnswers = submittedAnswers !== null ? submittedAnswers : attempt.answers || [];

    const answerMap = new Map();
    if (Array.isArray(finalAnswers)) {
      finalAnswers.forEach((ans) => {
        if (ans && ans.index !== undefined) {
          answerMap.set(Number(ans.index), ans.selected ? String(ans.selected).trim().toUpperCase() : null);
        }
      });
    }

    let correctCount = 0;
    questionsSnapshot.forEach((q, idx) => {
      const selectedKey = answerMap.get(idx);
      if (selectedKey) {
        const selectedIndex = selectedKey.charCodeAt(0) - 65; // 'A' -> 0, 'B' -> 1, etc.
        if (selectedIndex === q.correctIndex) {
          correctCount++;
        }
      }
    });

    const totalQuestions = questionsSnapshot.length;
    const wrongCount = totalQuestions - correctCount;
    const passed = correctCount >= config.passMark;
    const now = new Date();

    await tx.advocateTestAttempt.update({
      where: { id: attempt.id },
      data: {
        answers: finalAnswers,
        submittedAt: now,
        autoSubmitted,
        correctCount,
        wrongCount,
        passed
      }
    });

    await tx.advocateTestInvite.update({
      where: { id: attempt.inviteId },
      data: {
        status: 'USED'
      }
    });

    if (passed) {
      await tx.advocate.update({
        where: { id: attempt.advocateId },
        data: {
          testPassedAt: now
        }
      });
    }

    return {
      correct: correctCount,
      wrong: wrongCount,
      total: totalQuestions,
      passed,
      message: passed ? 'You have passed the test.' : 'Test completed.',
      canRequestReschedule: !passed
    };
  });
};

/**
 * Submits test answers and scores the attempt. Idempotent.
 *
 * @param {object} params
 * @param {string} params.inviteId
 * @param {string} params.advocateId
 * @param {Array<{ index: number, selected: string|null }>} [params.answers]
 * @returns {Promise<object>}
 */
export const submitAdvocateTest = async ({ inviteId, advocateId, answers }) => {
  const attempt = await prisma.advocateTestAttempt.findUnique({
    where: { inviteId }
  });

  if (!attempt || attempt.advocateId !== advocateId) {
    const err = new Error('Test attempt not found.');
    err.code = 'NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  // Idempotent return if already submitted
  if (attempt.submittedAt) {
    return {
      correct: attempt.correctCount ?? 0,
      wrong: attempt.wrongCount ?? 0,
      total: attempt.totalQuestions,
      passed: Boolean(attempt.passed),
      message: attempt.passed ? 'You have passed the test.' : 'Test completed.',
      canRequestReschedule: !attempt.passed,
      responseSheetEmailed: Boolean(attempt.responseSheetEmailSentAt)
    };
  }

  const now = new Date();
  const graceDeadline = new Date(attempt.deadlineAt.getTime() + 60000);
  const isPastGrace = now > graceDeadline;

  // If past grace, answers parameter is ignored; only saved answers are used
  const submittedAnswers = isPastGrace
    ? attempt.answers || []
    : Array.isArray(answers)
      ? answers.map((ans) => ({
          index: Number(ans.index),
          selected: ans.selected ? String(ans.selected).trim().toUpperCase() : null
        }))
      : attempt.answers || [];

  const finalizeResult = await scoreAndFinalizeAttempt({
    attemptId: attempt.id,
    submittedAnswers,
    autoSubmitted: isPastGrace
  });

  let responseSheetEmailed = false;
  try {
    const emailResult = await sendTestResponseSheetEmail(attempt.id);
    responseSheetEmailed = Boolean(emailResult?.success);
  } catch (emailErr) {
    console.error(`[Advocate Test Service] Failed sending response sheet email for attempt ${attempt.id}:`, emailErr.message);
  }

  return {
    ...finalizeResult,
    responseSheetEmailed
  };
};

/**
 * Requests test reschedule.
 * Accepts either { inviteId, advocateId } from testSession OR { token, barCouncilId, phone }.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export const requestAdvocateTestReschedule = async ({
  inviteId,
  advocateId,
  token,
  barCouncilId,
  phone
}) => {
  let resolvedAdvocateId = advocateId;
  let resolvedInviteId = inviteId;

  // If called without testSession, authenticate with credentials
  if (!resolvedAdvocateId) {
    if (!token || !barCouncilId || !phone) {
      const err = new Error("The details don't match this test link.");
      err.code = 'INVALID_CREDENTIALS';
      err.statusCode = 401;
      throw err;
    }

    const tokenHash = hashToken(token);
    const invite = await prisma.advocateTestInvite.findUnique({
      where: { tokenHash },
      include: { advocate: true }
    });

    if (!invite || !invite.advocate) {
      const err = new Error("The details don't match this test link.");
      err.code = 'INVALID_CREDENTIALS';
      err.statusCode = 401;
      throw err;
    }

    const inputBarId = normalizeBarCouncilId(barCouncilId);
    const inputPhone = normalizePhone(phone);
    const advBarId = normalizeBarCouncilId(invite.advocate.barCouncilId);
    const advPhone = normalizePhone(invite.advocate.phone);

    if (inputBarId !== advBarId || inputPhone !== advPhone) {
      const err = new Error("The details don't match this test link.");
      err.code = 'INVALID_CREDENTIALS';
      err.statusCode = 401;
      throw err;
    }

    resolvedAdvocateId = invite.advocateId;
    resolvedInviteId = invite.id;
  }

  const advocate = await prisma.advocate.findUnique({
    where: { id: resolvedAdvocateId },
    include: {
      testInvites: {
        orderBy: { createdAt: 'desc' },
        include: { attempt: true }
      }
    }
  });

  if (!advocate) {
    const err = new Error('Advocate not found.');
    err.code = 'NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  if (advocate.testPassedAt) {
    const err = new Error('You have already passed the qualification test.');
    err.code = 'ALREADY_PASSED';
    err.statusCode = 409;
    throw err;
  }

  // Idempotency: If a SCHEDULED invite already exists, return success
  const existingScheduled = advocate.testInvites.find((inv) => inv.status === 'SCHEDULED');
  if (existingScheduled) {
    return {
      success: true,
      message: 'Your test will be rescheduled within 2 hours.',
      scheduled: true
    };
  }

  const latestInvite = advocate.testInvites[0];
  const now = new Date();

  // Validate eligibility: latest link expired OR latest attempt failed
  let isEligible = false;
  if (!latestInvite) {
    isEligible = true;
  } else {
    const attempt = latestInvite.attempt;
    const isExpired =
      latestInvite.status === 'EXPIRED' ||
      (latestInvite.status === 'SENT' && latestInvite.expiresAt && now > new Date(latestInvite.expiresAt));

    if (attempt && attempt.submittedAt && attempt.passed === false) {
      isEligible = true;
    } else if (!attempt && isExpired) {
      isEligible = true;
    }
  }

  if (!isEligible) {
    const err = new Error('You are not currently eligible to request a reschedule.');
    err.code = 'NOT_ELIGIBLE';
    err.statusCode = 400;
    throw err;
  }

  const config = getTestConfig();
  const sendAt = new Date(now.getTime() + config.rescheduleDelayMinutes * 60 * 1000);

  // Expire latest invite if not USED
  if (latestInvite && latestInvite.status !== 'USED' && latestInvite.status !== 'EXPIRED') {
    await prisma.advocateTestInvite.update({
      where: { id: latestInvite.id },
      data: { status: 'EXPIRED' }
    });
  }

  // Placeholder token hash; actual plain token is generated when sent by cron
  const placeholderToken = generateSecureToken();
  const tokenHash = hashToken(placeholderToken);

  await prisma.advocateTestInvite.create({
    data: {
      advocateId: advocate.id,
      reason: 'RESCHEDULE',
      status: 'SCHEDULED',
      sendAt,
      tokenHash
    }
  });

  return {
    success: true,
    message: 'Your test will be rescheduled within 2 hours.',
    scheduled: true
  };
};

/**
 * Cron execution logic to process advocate test background tasks.
 * 1. Dispatches due SCHEDULED invites.
 * 2. Marks expired SENT links as EXPIRED.
 * 3. Auto-finalizes abandoned attempts past deadline + grace.
 */
export const processTestCronJobs = async () => {
  const now = new Date();
  const config = getTestConfig();
  const results = {
    invitesSent: 0,
    linksExpired: 0,
    attemptsAutoSubmitted: 0,
    errors: []
  };

  // 1. Send due invites (status = SCHEDULED and sendAt <= now)
  const dueInvites = await prisma.advocateTestInvite.findMany({
    where: {
      status: 'SCHEDULED',
      sendAt: { lte: now }
    },
    take: 25,
    orderBy: { sendAt: 'asc' },
    include: { advocate: true }
  });

  for (const inv of dueInvites) {
    try {
      const plainToken = generateSecureToken();
      const tokenHash = hashToken(plainToken);
      const expiresAt = new Date(now.getTime() + config.linkValidHours * 60 * 60 * 1000);

      // Atomically assign token hash and mark ready
      await prisma.advocateTestInvite.update({
        where: { id: inv.id },
        data: { tokenHash }
      });

      const emailResult = await sendAdvocateTestLinkEmail({
        advocateId: inv.advocateId,
        token: plainToken,
        expiresAt,
        reason: inv.reason
      });

      if (emailResult.success) {
        await prisma.advocateTestInvite.update({
          where: { id: inv.id },
          data: {
            status: 'SENT',
            sentAt: now,
            expiresAt
          }
        });
        results.invitesSent++;
      } else {
        results.errors.push({ inviteId: inv.id, error: emailResult.message || 'Email delivery failed' });
      }
    } catch (err) {
      results.errors.push({ inviteId: inv.id, error: err.message });
    }
  }

  // 2. Expire links (status = SENT and expiresAt < now and no attempt)
  const expiredInvites = await prisma.advocateTestInvite.findMany({
    where: {
      status: 'SENT',
      expiresAt: { lte: now },
      attempt: null
    },
    select: { id: true }
  });

  if (expiredInvites.length > 0) {
    const expiredIds = expiredInvites.map((i) => i.id);
    const updateRes = await prisma.advocateTestInvite.updateMany({
      where: { id: { in: expiredIds } },
      data: { status: 'EXPIRED' }
    });
    results.linksExpired = updateRes.count;
  }

  // 3. Auto-submit abandoned attempts past deadline + 60s grace
  const graceThreshold = new Date(now.getTime() - 60000);
  const pendingAttempts = await prisma.advocateTestAttempt.findMany({
    where: {
      submittedAt: null,
      deadlineAt: { lte: graceThreshold }
    },
    take: 25,
    select: { id: true, answers: true }
  });

  for (const att of pendingAttempts) {
    try {
      await scoreAndFinalizeAttempt({
        attemptId: att.id,
        submittedAnswers: att.answers || [],
        autoSubmitted: true
      });
      results.attemptsAutoSubmitted++;
      try {
        await sendTestResponseSheetEmail(att.id);
      } catch (sheetErr) {
        results.errors.push({ attemptId: att.id, error: sheetErr.message });
      }
    } catch (err) {
      results.errors.push({ attemptId: att.id, error: err.message });
    }
  }

  return results;
};

