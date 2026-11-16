import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/lib/prisma.js';
import { setTransporter } from '../src/services/email.service.js';
import {
  hashToken,
  generateSecureToken,
  signTestSessionToken,
  verifyTestSessionToken,
  normalizePhone,
  normalizeBarCouncilId,
  shuffleArray,
  loginAdvocateTest,
  startAdvocateTest,
  saveAdvocateTestAnswers,
  submitAdvocateTest,
  requestAdvocateTestReschedule,
  processTestCronJobs,
  getTestConfig
} from '../src/services/advocateTest.service.js';
import * as advocateProfileController from '../src/controllers/advocate.profile.controller.js';
import * as adminController from '../src/controllers/admin.controller.js';
import {
  createTestQuestionSchema,
  updateTestQuestionSchema
} from '../src/validators/admin.validator.js';
import { requireAuth } from '../src/middleware/auth.middleware.js';

describe('Advocate Qualification Test Suite', () => {
  let originalPrisma;

  const mockRes = () => {
    const res = {
      statusCode: 200,
      jsonData: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.jsonData = data;
        return this;
      }
    };
    return res;
  };

  beforeEach(() => {
    originalPrisma = {
      advocate: { ...prisma.advocate },
      advocateTestInvite: { ...prisma.advocateTestInvite },
      advocateTestAttempt: { ...prisma.advocateTestAttempt },
      advocateTestQuestion: { ...prisma.advocateTestQuestion }
    };
    setTransporter({
      sendMail: async () => ({ messageId: 'msg-default-stub' })
    });
  });

  afterEach(() => {
    prisma.advocate = originalPrisma.advocate;
    prisma.advocateTestInvite = originalPrisma.advocateTestInvite;
    prisma.advocateTestAttempt = originalPrisma.advocateTestAttempt;
    prisma.advocateTestQuestion = originalPrisma.advocateTestQuestion;
    setTransporter(null);
  });

  describe('1. Link Generation & Submit Flow', () => {
    const mockAdvocate = {
      id: 'adv-100',
      fullName: 'Adv. Test User',
      email: 'advtest@example.com',
      phone: '+91 9876543210',
      barCouncilId: 'D/9999/2021',
      status: 'ACTIVE',
      approvalStatus: 'PENDING',
      testPassedAt: null,
      submittedForApprovalAt: null,
      profilePhotoUrl: 'https://cloudinary.com/p.jpg',
      bestPracticeArea: 'Civil Law',
      experienceYears: 5,
      about: 'Advocate profile about text',
      city: 'Delhi',
      state: 'Delhi',
      pincode: '110001'
    };

    it('1.1 Generates initial test link on first submit and sends email', async () => {
      let createdInvite = null;
      let sentMail = null;

      prisma.advocate.findUnique = async () => ({ ...mockAdvocate });
      prisma.advocate.update = async ({ data }) => ({ ...mockAdvocate, ...data });

      prisma.advocateTestInvite.findFirst = async () => null;
      prisma.advocateTestInvite.create = async ({ data }) => {
        createdInvite = { id: 'inv-1', ...data };
        return createdInvite;
      };
      prisma.advocateTestInvite.update = async ({ data }) => {
        Object.assign(createdInvite, data);
        return createdInvite;
      };

      setTransporter({
        sendMail: async (opts) => {
          sentMail = opts;
          return { messageId: 'msg-test-1' };
        }
      });

      const req = { user: { id: 'adv-100', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.success, true);
      assert.ok(res.jsonData.test);
      assert.equal(res.jsonData.test.required, true);
      assert.equal(res.jsonData.test.emailSentTo, 'ad***@example.com');
      assert.ok(res.jsonData.test.expiresAt);

      assert.ok(createdInvite);
      assert.equal(createdInvite.status, 'SENT');
      assert.equal(createdInvite.reason, 'INITIAL');
      assert.ok(createdInvite.tokenHash);
      assert.notEqual(createdInvite.tokenHash, '');

      assert.ok(sentMail);
      assert.equal(sentMail.to, 'advtest@example.com');
      assert.ok(sentMail.html.includes('Start Test'));
      assert.ok(sentMail.html.includes('20 questions'));
    });

    it('1.2 Skips test invite when advocate already passed (testPassedAt set)', async () => {
      let createdInvite = null;

      prisma.advocate.findUnique = async () => ({
        ...mockAdvocate,
        testPassedAt: new Date('2026-10-01T10:00:00Z')
      });
      prisma.advocate.update = async ({ data }) => ({ ...mockAdvocate, ...data });
      prisma.advocateTestInvite.create = async () => {
        createdInvite = true;
      };

      const req = { user: { id: 'adv-100', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.test.required, false);
      assert.equal(res.jsonData.test.passed, true);
      assert.equal(createdInvite, null);
    });

    it('1.3 Reuses active link if SENT link exists and not expired', async () => {
      const activeExpiry = new Date(Date.now() + 48 * 3600 * 1000);
      let createdInvite = null;

      prisma.advocate.findUnique = async () => ({ ...mockAdvocate });
      prisma.advocate.update = async ({ data }) => ({ ...mockAdvocate, ...data });
      prisma.advocateTestInvite.findFirst = async () => ({
        id: 'inv-active-1',
        status: 'SENT',
        expiresAt: activeExpiry,
        attempt: null
      });
      prisma.advocateTestInvite.create = async () => {
        createdInvite = true;
      };

      const req = { user: { id: 'adv-100', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.test.required, true);
      assert.equal(res.jsonData.test.linkAlreadySent, true);
      assert.equal(res.jsonData.test.expiresAt, activeExpiry);
      assert.equal(createdInvite, null);
    });

    it('1.4 If email fails, keeps status SCHEDULED for cron retry', async () => {
      let createdInvite = null;

      prisma.advocate.findUnique = async () => ({ ...mockAdvocate });
      prisma.advocate.update = async ({ data }) => ({ ...mockAdvocate, ...data });

      prisma.advocateTestInvite.findFirst = async () => null;
      prisma.advocateTestInvite.create = async ({ data }) => {
        createdInvite = { id: 'inv-fail', ...data };
        return createdInvite;
      };

      setTransporter({
        sendMail: async () => {
          throw new Error('SMTP Timeout');
        }
      });

      const req = { user: { id: 'adv-100', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.test.required, true);
      assert.equal(res.jsonData.test.scheduled, true);
      assert.equal(createdInvite.status, 'SCHEDULED');
    });
  });

  describe('2. Test Login Authentication & States', () => {
    const rawToken = 'my-secret-test-token-32bytes-long';
    const tokenHash = hashToken(rawToken);

    const baseAdvocate = {
      id: 'adv-101',
      fullName: 'Adv. Test Login',
      phone: '+91 9876543210',
      barCouncilId: 'D/5555/2020',
      testPassedAt: null
    };

    const baseInvite = {
      id: 'inv-101',
      advocateId: 'adv-101',
      tokenHash,
      status: 'SENT',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      advocate: baseAdvocate,
      attempt: null
    };

    it('2.1 Rejects mismatch with generic 401 INVALID_CREDENTIALS', async () => {
      prisma.advocateTestInvite.findUnique = async () => ({ ...baseInvite });

      // Wrong phone
      await assert.rejects(
        async () => {
          await loginAdvocateTest({
            token: rawToken,
            barCouncilId: 'D/5555/2020',
            phone: '9111111111'
          });
        },
        (err) => {
          assert.equal(err.statusCode, 401);
          assert.equal(err.code, 'INVALID_CREDENTIALS');
          assert.equal(err.message, "The details don't match this test link.");
          return true;
        }
      );

      // Wrong Bar Council ID
      await assert.rejects(
        async () => {
          await loginAdvocateTest({
            token: rawToken,
            barCouncilId: 'WRONG/ID',
            phone: '9876543210'
          });
        },
        (err) => {
          assert.equal(err.statusCode, 401);
          assert.equal(err.code, 'INVALID_CREDENTIALS');
          return true;
        }
      );
    });

    it('2.2 Normalizes Bar Council ID (case-insensitive, trimmed) and phone (last 10 digits)', async () => {
      prisma.advocateTestInvite.findUnique = async () => ({ ...baseInvite });

      const res = await loginAdvocateTest({
        token: rawToken,
        barCouncilId: '  d/5555/2020  ',
        phone: '+91 9876543210'
      });

      assert.equal(res.status, 'READY');
      assert.ok(res.testSession);
      assert.equal(res.rules.questions, 20);
      assert.equal(res.rules.passMark, 15);
    });

    it('2.3 Returns ALREADY_PASSED if testPassedAt is set', async () => {
      prisma.advocateTestInvite.findUnique = async () => ({
        ...baseInvite,
        advocate: { ...baseAdvocate, testPassedAt: new Date() }
      });

      const res = await loginAdvocateTest({
        token: rawToken,
        barCouncilId: 'D/5555/2020',
        phone: '9876543210'
      });

      assert.equal(res.status, 'ALREADY_PASSED');
    });

    it('2.4 Returns 410 LINK_EXPIRED if link expired with no attempt', async () => {
      prisma.advocateTestInvite.findUnique = async () => ({
        ...baseInvite,
        expiresAt: new Date(Date.now() - 1000),
        status: 'EXPIRED'
      });

      await assert.rejects(
        async () => {
          await loginAdvocateTest({
            token: rawToken,
            barCouncilId: 'D/5555/2020',
            phone: '9876543210'
          });
        },
        (err) => {
          assert.equal(err.statusCode, 410);
          assert.equal(err.code, 'LINK_EXPIRED');
          assert.equal(err.canRequestReschedule, true);
          return true;
        }
      );
    });

    it('2.5 Returns COMPLETED if attempt already submitted', async () => {
      prisma.advocateTestInvite.findUnique = async () => ({
        ...baseInvite,
        attempt: {
          submittedAt: new Date(),
          correctCount: 16,
          wrongCount: 4,
          totalQuestions: 20,
          passed: true
        }
      });

      const res = await loginAdvocateTest({
        token: rawToken,
        barCouncilId: 'D/5555/2020',
        phone: '9876543210'
      });

      assert.equal(res.status, 'COMPLETED');
      assert.equal(res.result.passed, true);
      assert.equal(res.canRequestReschedule, false);
    });

    it('2.6 Test session JWT is rejected by standard user/advocate requireAuth middleware', async () => {
      const sessionToken = signTestSessionToken({ inviteId: 'inv-1', advocateId: 'adv-1' });

      const req = {
        cookies: {},
        headers: { authorization: `Bearer ${sessionToken}` }
      };
      let nextError = null;

      await requireAuth(req, {}, (err) => {
        nextError = err;
      });

      assert.ok(nextError);
      assert.equal(nextError.statusCode, 401);
    });
  });

  describe('3. Test Start, Randomization & Snapshot', () => {
    const mockQuestions = Array.from({ length: 25 }, (_, i) => ({
      id: `q-${i + 1}`,
      question: `Question ${i + 1} text?`,
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      correctOption: i % 4,
      isActive: true,
      deletedAt: null
    }));

    it('3.1 Selects exactly 20 distinct questions, shuffles options, hides correct answers', async () => {
      prisma.advocateTestInvite.findUnique = async () => ({
        id: 'inv-start-1',
        advocateId: 'adv-100',
        status: 'SENT',
        expiresAt: new Date(Date.now() + 100000),
        attempt: null,
        advocate: { testPassedAt: null }
      });

      prisma.advocateTestQuestion.findMany = async () => mockQuestions;

      let savedAttempt = null;
      prisma.advocateTestAttempt.create = async ({ data }) => {
        savedAttempt = { id: 'att-1', ...data };
        return savedAttempt;
      };

      const result = await startAdvocateTest({ inviteId: 'inv-start-1', advocateId: 'adv-100' });

      assert.equal(result.attemptId, 'att-1');
      assert.equal(result.questions.length, 20);

      // Verify no correctOption or correctIndex leaked in response
      result.questions.forEach((q) => {
        assert.equal(q.correctOption, undefined);
        assert.equal(q.correctIndex, undefined);
        assert.equal(q.options.length, 4);
        assert.deepEqual(q.options.map((o) => o.key), ['A', 'B', 'C', 'D']);
      });

      // Verify snapshot in database contains correctIndex for server-side evaluation
      assert.ok(savedAttempt);
      assert.equal(savedAttempt.questions.length, 20);
      savedAttempt.questions.forEach((sq) => {
        assert.ok(Number.isInteger(sq.correctIndex));
        assert.ok(sq.correctIndex >= 0 && sq.correctIndex <= 3);
      });
    });

    it('3.2 Throws 503 TEST_UNAVAILABLE if active questions < 20', async () => {
      prisma.advocateTestInvite.findUnique = async () => ({
        id: 'inv-start-2',
        advocateId: 'adv-100',
        status: 'SENT',
        expiresAt: new Date(Date.now() + 100000),
        attempt: null,
        advocate: { testPassedAt: null }
      });

      prisma.advocateTestQuestion.findMany = async () => mockQuestions.slice(0, 15);

      await assert.rejects(
        async () => {
          await startAdvocateTest({ inviteId: 'inv-start-2', advocateId: 'adv-100' });
        },
        (err) => {
          assert.equal(err.statusCode, 503);
          assert.equal(err.code, 'TEST_UNAVAILABLE');
          return true;
        }
      );
    });

    it('3.3 Calling start test again returns existing attempt idempotently', async () => {
      const existingAttempt = {
        id: 'att-existing',
        deadlineAt: new Date(Date.now() + 15 * 60 * 1000),
        questions: [
          { question: 'Q1', options: ['A', 'B', 'C', 'D'], correctIndex: 1 }
        ],
        answers: [{ index: 0, selected: 'B' }]
      };

      prisma.advocateTestInvite.findUnique = async () => ({
        id: 'inv-start-3',
        advocateId: 'adv-100',
        attempt: existingAttempt,
        advocate: { testPassedAt: null }
      });

      const result = await startAdvocateTest({ inviteId: 'inv-start-3', advocateId: 'adv-100' });

      assert.equal(result.attemptId, 'att-existing');
      assert.equal(result.savedAnswers.length, 1);
      assert.equal(result.questions[0].correctIndex, undefined);
    });
  });

  describe('4. Timer, Autosave & Auto-Submit', () => {
    it('4.1 Autosaves answers while within deadline', async () => {
      let updatedAnswers = null;
      prisma.advocateTestAttempt.findUnique = async () => ({
        id: 'att-save',
        advocateId: 'adv-100',
        deadlineAt: new Date(Date.now() + 10 * 60 * 1000),
        submittedAt: null
      });

      prisma.advocateTestAttempt.update = async ({ data }) => {
        updatedAnswers = data.answers;
        return {};
      };

      const res = await saveAdvocateTestAnswers({
        inviteId: 'inv-save',
        advocateId: 'adv-100',
        answers: [{ index: 0, selected: 'A' }, { index: 1, selected: 'C' }]
      });

      assert.equal(res.success, true);
      assert.equal(updatedAnswers.length, 2);
    });

    it('4.2 Rejects answer save and auto-submits when past deadline + 60s grace', async () => {
      let finalSubmission = null;
      const pastDeadline = new Date(Date.now() - 65 * 1000); // 65 seconds ago (> 60s grace)

      prisma.advocateTestAttempt.findUnique = async () => ({
        id: 'att-timeout',
        inviteId: 'inv-timeout',
        advocateId: 'adv-100',
        deadlineAt: pastDeadline,
        submittedAt: null,
        answers: [{ index: 0, selected: 'B' }],
        questions: [
          { questionId: 'q-1', question: 'Q1', options: ['A', 'B', 'C', 'D'], correctIndex: 1 }
        ]
      });

      prisma.$transaction = async (cb) => {
        const tx = {
          advocateTestAttempt: {
            findUnique: async () => ({
              id: 'att-timeout',
              inviteId: 'inv-timeout',
              advocateId: 'adv-100',
              submittedAt: null,
              answers: [{ index: 0, selected: 'B' }],
              questions: [{ questionId: 'q-1', question: 'Q1', options: ['A', 'B', 'C', 'D'], correctIndex: 1 }]
            }),
            update: async ({ data }) => {
              finalSubmission = data;
              return {};
            }
          },
          advocateTestInvite: { update: async () => ({}) },
          advocate: { update: async () => ({}) }
        };
        return cb(tx);
      };

      const res = await saveAdvocateTestAnswers({
        inviteId: 'inv-timeout',
        advocateId: 'adv-100',
        answers: [{ index: 0, selected: 'C' }] // Attempt to change answer late
      });

      assert.equal(res.success, false);
      assert.equal(res.code, 'TIME_EXPIRED');
      assert.ok(finalSubmission);
      assert.equal(finalSubmission.autoSubmitted, true);
    });
  });

  describe('5. Scoring & Pass/Fail Rules', () => {
    const makeQuestionsSnapshot = (total = 20) => {
      return Array.from({ length: total }, (_, i) => ({
        questionId: `q-${i}`,
        question: `Question ${i}`,
        options: ['Opt0', 'Opt1', 'Opt2', 'Opt3'],
        correctIndex: 1 // 'B' is always correct in this test mock
      }));
    };

    it('5.1 Score >= 15 passes test, sets advocate.testPassedAt, marks invite USED', async () => {
      let updatedAttempt = null;
      let updatedInvite = null;
      let updatedAdvocate = null;

      const questions = makeQuestionsSnapshot(20);
      // 16 correct answers ('B'), 4 unanswered (null)
      const answers = Array.from({ length: 20 }, (_, i) => ({
        index: i,
        selected: i < 16 ? 'B' : null
      }));

      prisma.advocateTestAttempt.findUnique = async () => ({
        id: 'att-score-1',
        inviteId: 'inv-score-1',
        advocateId: 'adv-pass',
        deadlineAt: new Date(Date.now() + 10 * 60 * 1000),
        submittedAt: null,
        answers: []
      });

      prisma.$transaction = async (cb) => {
        const tx = {
          advocateTestAttempt: {
            findUnique: async () => ({
              id: 'att-score-1',
              inviteId: 'inv-score-1',
              advocateId: 'adv-pass',
              submittedAt: null,
              questions
            }),
            update: async ({ data }) => {
              updatedAttempt = data;
              return {};
            }
          },
          advocateTestInvite: {
            update: async ({ data }) => {
              updatedInvite = data;
              return {};
            }
          },
          advocate: {
            update: async ({ data }) => {
              updatedAdvocate = data;
              return {};
            }
          }
        };
        return cb(tx);
      };

      const result = await submitAdvocateTest({
        inviteId: 'inv-score-1',
        advocateId: 'adv-pass',
        answers
      });

      assert.equal(result.correct, 16);
      assert.equal(result.wrong, 4);
      assert.equal(result.total, 20);
      assert.equal(result.passed, true);
      assert.equal(result.canRequestReschedule, false);

      assert.ok(updatedAttempt);
      assert.equal(updatedAttempt.passed, true);
      assert.equal(updatedInvite.status, 'USED');
      assert.ok(updatedAdvocate.testPassedAt instanceof Date);
    });

    it('5.2 Score < 15 fails test, does NOT set testPassedAt, allows reschedule', async () => {
      let updatedAdvocate = null;
      const questions = makeQuestionsSnapshot(20);
      // 14 correct ('B'), 6 wrong ('A')
      const answers = Array.from({ length: 20 }, (_, i) => ({
        index: i,
        selected: i < 14 ? 'B' : 'A'
      }));

      prisma.advocateTestAttempt.findUnique = async () => ({
        id: 'att-score-2',
        inviteId: 'inv-score-2',
        advocateId: 'adv-fail',
        deadlineAt: new Date(Date.now() + 10 * 60 * 1000),
        submittedAt: null,
        answers: []
      });

      prisma.$transaction = async (cb) => {
        const tx = {
          advocateTestAttempt: {
            findUnique: async () => ({
              id: 'att-score-2',
              inviteId: 'inv-score-2',
              advocateId: 'adv-fail',
              submittedAt: null,
              questions
            }),
            update: async () => ({})
          },
          advocateTestInvite: { update: async () => ({}) },
          advocate: {
            update: async ({ data }) => {
              updatedAdvocate = data;
              return {};
            }
          }
        };
        return cb(tx);
      };

      const result = await submitAdvocateTest({
        inviteId: 'inv-score-2',
        advocateId: 'adv-fail',
        answers
      });

      assert.equal(result.correct, 14);
      assert.equal(result.wrong, 6);
      assert.equal(result.passed, false);
      assert.equal(result.canRequestReschedule, true);
      assert.equal(updatedAdvocate, null); // never updated testPassedAt
    });

    it('5.3 Unanswered questions strictly counted as wrong', async () => {
      const questions = makeQuestionsSnapshot(20);
      // Only 5 answered
      const answers = [{ index: 0, selected: 'B' }, { index: 1, selected: 'B' }];

      prisma.advocateTestAttempt.findUnique = async () => ({
        id: 'att-score-3',
        inviteId: 'inv-score-3',
        advocateId: 'adv-partial',
        deadlineAt: new Date(Date.now() + 10 * 60 * 1000),
        submittedAt: null
      });

      prisma.$transaction = async (cb) => {
        const tx = {
          advocateTestAttempt: {
            findUnique: async () => ({
              id: 'att-score-3',
              inviteId: 'inv-score-3',
              advocateId: 'adv-partial',
              submittedAt: null,
              questions
            }),
            update: async () => ({})
          },
          advocateTestInvite: { update: async () => ({}) }
        };
        return cb(tx);
      };

      const result = await submitAdvocateTest({
        inviteId: 'inv-score-3',
        advocateId: 'adv-partial',
        answers
      });

      assert.equal(result.correct, 2);
      assert.equal(result.wrong, 18);
      assert.equal(result.passed, false);
    });

    it('5.4 Re-submitting returns same score idempotently without re-scoring', async () => {
      prisma.advocateTestAttempt.findUnique = async () => ({
        id: 'att-idemp',
        inviteId: 'inv-idemp',
        advocateId: 'adv-idemp',
        submittedAt: new Date(),
        correctCount: 17,
        wrongCount: 3,
        totalQuestions: 20,
        passed: true
      });

      const result = await submitAdvocateTest({
        inviteId: 'inv-idemp',
        advocateId: 'adv-idemp',
        answers: []
      });

      assert.equal(result.correct, 17);
      assert.equal(result.passed, true);
    });
  });

  describe('6. Reschedule Workflow & Cron Jobs', () => {
    it('6.1 Reschedule rejected with 409 if advocate already passed', async () => {
      prisma.advocate.findUnique = async () => ({
        id: 'adv-passed',
        testPassedAt: new Date(),
        testInvites: []
      });

      await assert.rejects(
        async () => {
          await requestAdvocateTestReschedule({
            advocateId: 'adv-passed'
          });
        },
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.code, 'ALREADY_PASSED');
          return true;
        }
      );
    });

    it('6.2 Schedules new invite 60 min later after failed attempt, marks old EXPIRED', async () => {
      let createdInvite = null;
      let expiredOldInvite = null;

      prisma.advocate.findUnique = async () => ({
        id: 'adv-resched',
        testPassedAt: null,
        testInvites: [
          {
            id: 'inv-old',
            status: 'USED',
            attempt: { submittedAt: new Date(), passed: false }
          }
        ]
      });

      prisma.advocateTestInvite.update = async ({ where, data }) => {
        expiredOldInvite = { id: where.id, ...data };
        return expiredOldInvite;
      };

      prisma.advocateTestInvite.create = async ({ data }) => {
        createdInvite = { id: 'inv-rescheduled', ...data };
        return createdInvite;
      };

      const res = await requestAdvocateTestReschedule({ advocateId: 'adv-resched' });

      assert.equal(res.success, true);
      assert.equal(res.scheduled, true);
      assert.equal(res.message, 'Your test will be rescheduled within 2 hours.');

      assert.ok(createdInvite);
      assert.equal(createdInvite.reason, 'RESCHEDULE');
      assert.equal(createdInvite.status, 'SCHEDULED');
      // sendAt should be ~60 min from now
      const diffMinutes = (new Date(createdInvite.sendAt).getTime() - Date.now()) / (60 * 1000);
      assert.ok(diffMinutes >= 58 && diffMinutes <= 61);
    });

    it('6.3 Cron sends due SCHEDULED invites and updates status to SENT', async () => {
      const dueInv = {
        id: 'inv-due-1',
        advocateId: 'adv-due',
        reason: 'RESCHEDULE',
        status: 'SCHEDULED',
        sendAt: new Date(Date.now() - 5000),
        advocate: { fullName: 'Adv. Due', email: 'due@example.com' }
      };

      let inviteUpdated = null;
      let emailSent = null;

      prisma.advocate.findUnique = async () => ({
        id: 'adv-due',
        fullName: 'Adv. Due',
        email: 'due@example.com'
      });

      prisma.advocateTestInvite.findMany = async ({ where }) => {
        if (where.status === 'SCHEDULED') return [dueInv];
        if (where.status === 'SENT') return [];
        return [];
      };

      prisma.advocateTestInvite.update = async ({ where, data }) => {
        inviteUpdated = { id: where.id, ...data };
        return inviteUpdated;
      };

      prisma.advocateTestAttempt.findMany = async () => [];

      setTransporter({
        sendMail: async (opts) => {
          emailSent = opts;
          return { messageId: 'msg-due-1' };
        }
      });

      const cronResults = await processTestCronJobs();

      assert.equal(cronResults.invitesSent, 1);
      assert.ok(emailSent);
      assert.equal(emailSent.to, 'due@example.com');
      assert.ok(emailSent.subject.includes('rescheduled'));
      assert.equal(inviteUpdated.status, 'SENT');
    });
  });

  describe('7. Admin Question Bank & Advocate Test Detail', () => {
    it('7.1 createTestQuestionSchema validates 4 unique options and 0..3 correctOption', () => {
      // Valid
      const valid = createTestQuestionSchema.parse({
        question: 'What is the Indian Evidence Act now called?',
        options: ['BNS', 'BNSS', 'BSA', 'IPC'],
        correctOption: 2
      });
      assert.equal(valid.correctOption, 2);

      // Duplicate options rejected
      assert.throws(() => {
        createTestQuestionSchema.parse({
          question: 'Valid question text?',
          options: ['Option A', 'Option B', 'Option A', 'Option D'],
          correctOption: 1
        });
      });

      // Invalid correctOption > 3
      assert.throws(() => {
        createTestQuestionSchema.parse({
          question: 'Valid question text?',
          options: ['A', 'B', 'C', 'D'],
          correctOption: 4
        });
      });
    });

    it('7.2 Soft delete warns when active questions drop below 20', async () => {
      prisma.advocateTestQuestion.findUnique = async () => ({
        id: 'q-del',
        isActive: true,
        deletedAt: null
      });

      prisma.advocateTestQuestion.update = async () => ({});
      // Remaining active count is 19 (< 20)
      prisma.advocateTestQuestion.count = async () => 19;

      const req = { params: { id: 'q-del' }, user: { id: 'admin-1' } };
      const res = mockRes();

      await adminController.deleteTestQuestion(req, res, () => {});

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.success, true);
      assert.ok(res.jsonData.warning);
      assert.ok(res.jsonData.warning.includes('Fewer than 20 active questions'));
    });

    it('7.3 formatAdvocateTestSummary outputs correct test block for admin', () => {
      const advocate = {
        testPassedAt: null,
        testInvites: [
          {
            id: 'inv-1',
            status: 'SENT',
            expiresAt: new Date(Date.now() + 100000),
            attempt: {
              submittedAt: new Date(),
              passed: false
            }
          }
        ],
        testAttempts: [
          {
            startedAt: new Date('2026-11-01T10:00:00Z'),
            submittedAt: new Date('2026-11-01T10:15:00Z'),
            correctCount: 13,
            wrongCount: 7,
            totalQuestions: 20,
            passed: false,
            autoSubmitted: false
          },
          {
            startedAt: new Date('2026-11-02T10:00:00Z'),
            submittedAt: new Date('2026-11-02T10:18:00Z'),
            correctCount: 16,
            wrongCount: 4,
            totalQuestions: 20,
            passed: true,
            autoSubmitted: false
          }
        ]
      };

      const summary = adminController.formatAdvocateTestSummary(advocate);

      assert.equal(summary.attemptsCount, 2);
      assert.equal(summary.best.correct, 16);
      assert.equal(summary.best.wrong, 4);
      assert.equal(summary.latest.correct, 16);
    });

    it('7.4 Pre-existing pending advocate without test records has NOT_REQUIRED test status', () => {
      const advocate = {
        approvalStatus: 'PENDING',
        testPassedAt: null,
        testInvites: [],
        testAttempts: []
      };

      const summary = adminController.formatAdvocateTestSummary(advocate);

      assert.equal(summary.status, 'NOT_REQUIRED');
      assert.equal(summary.attemptsCount, 0);
      assert.equal(summary.latest, null);
    });
  });
});
