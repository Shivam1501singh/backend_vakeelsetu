import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/lib/prisma.js';
import {
  encryptField,
  decryptField,
  maskAccountNumber,
  getPayoutEncryptionKey,
  isPayoutEncryptionConfigured
} from '../src/utils/fieldEncryption.util.js';
import {
  getMinWithdrawalAmount,
  normalizeName,
  getAdvocateEarningsSummary,
  getAdvocateEarningsAndLedger,
  getAdvocatePayoutAccount,
  requestWithdrawal,
  approveWithdrawal,
  markWithdrawalPaid,
  rejectWithdrawal,
  creditBookingEarning,
  reverseBookingEarningOnRefund
} from '../src/services/advocateEarnings.service.js';
import { advocateWithdrawalRequestSchema } from '../src/validators/advocate.validator.js';
import {
  adminMarkPaidWithdrawalSchema,
  adminRejectWithdrawalSchema,
  adminWithdrawalListQuerySchema
} from '../src/validators/admin.validator.js';
import * as adminController from '../src/controllers/admin.controller.js';
import * as advocateBookingController from '../src/controllers/advocateBooking.controller.js';

describe('Advocate Earnings & Withdrawals (Stubbed Prisma & In-Memory Logic)', () => {
  const originalEnv = { ...process.env };
  const mockKey = crypto.randomBytes(32).toString('base64');

  let originalPrisma;

  beforeEach(() => {
    process.env.PAYOUT_ENCRYPTION_KEY = mockKey;
    process.env.MIN_WITHDRAWAL_AMOUNT = '500';

    originalPrisma = {
      advocateEarningLedger: { ...prisma.advocateEarningLedger },
      advocatePayoutAccount: { ...prisma.advocatePayoutAccount },
      advocateWithdrawal: { ...prisma.advocateWithdrawal },
      advocateBooking: { ...prisma.advocateBooking },
      advocate: { ...prisma.advocate },
      $transaction: prisma.$transaction,
      $executeRaw: prisma.$executeRaw
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    prisma.advocateEarningLedger = originalPrisma.advocateEarningLedger;
    prisma.advocatePayoutAccount = originalPrisma.advocatePayoutAccount;
    prisma.advocateWithdrawal = originalPrisma.advocateWithdrawal;
    prisma.advocateBooking = originalPrisma.advocateBooking;
    prisma.advocate = originalPrisma.advocate;
    prisma.$transaction = originalPrisma.$transaction;
    prisma.$executeRaw = originalPrisma.$executeRaw;
  });

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

  // 1. Encryption round-trip & masking
  describe('1. Security & Field Encryption', () => {
    it('encrypts and decrypts bank account numbers accurately (AES-256-GCM)', () => {
      const raw = '123456789012';
      const encrypted = encryptField(raw);
      assert.notEqual(encrypted, raw);
      assert.equal(encrypted.split(':').length, 3);

      const decrypted = decryptField(encrypted);
      assert.equal(decrypted, raw);
    });

    it('throws 500 on tampering or decrypt failure without leaking data', () => {
      const encrypted = encryptField('999988887777');
      const parts = encrypted.split(':');
      // Tamper ciphertext
      const tampered = `${parts[0]}:${parts[1]}:invalidCiphertext`;
      assert.throws(() => decryptField(tampered), (err) => {
        assert.equal(err.statusCode, 500);
        assert.equal(err.message, 'Failed to decrypt financial record.');
        return true;
      });
    });

    it('returns 503 when PAYOUT_ENCRYPTION_KEY is missing', () => {
      delete process.env.PAYOUT_ENCRYPTION_KEY;
      assert.equal(isPayoutEncryptionConfigured(), false);
      assert.throws(() => encryptField('123456789'), (err) => {
        assert.equal(err.statusCode, 503);
        assert.equal(err.message, 'Payouts are not configured.');
        return true;
      });
    });

    it('masks account numbers properly', () => {
      assert.equal(maskAccountNumber('123456789012'), 'XXXXXX9012');
      assert.equal(maskAccountNumber('987654321'), 'XXXXXX4321');
    });
  });

  // 2. Summary math & balance calculation
  describe('2. Balance Summary Math', () => {
    it('computes available, pending, inProcess, withdrawn, and totalEarned correctly', async () => {
      const advocateId = 'adv-123';

      // Stub aggregate queries
      prisma.advocateEarningLedger.aggregate = async ({ where }) => {
        if (where.type && where.type.in) {
          // totalEarned query: BOOKING_EARNING (+) + REFUND_REVERSAL (-)
          return { _sum: { amountPaise: 453000 } }; // ₹4530.00
        }
        // available query: all ledger
        return { _sum: { amountPaise: 153000 } }; // ₹1530.00
      };

      prisma.advocateBooking.aggregate = async () => ({
        _sum: { feePaise: 51000 } // pending: ₹510.00
      });

      prisma.advocateWithdrawal.aggregate = async ({ where }) => {
        if (where.status === 'PAID') {
          return { _sum: { amountPaise: 200000 } }; // withdrawn: ₹2000.00
        }
        return { _sum: { amountPaise: 100000 } }; // inProcess: ₹1000.00
      };

      prisma.advocateWithdrawal.findFirst = async () => null; // No open withdrawal

      const summary = await getAdvocateEarningsSummary(advocateId);

      assert.equal(summary.available, 1530.00);
      assert.equal(summary.pending, 510.00);
      assert.equal(summary.inProcess, 1000.00);
      assert.equal(summary.withdrawn, 2000.00);
      assert.equal(summary.totalEarned, 4530.00);
      assert.equal(summary.minWithdrawal, 500.00);
      assert.equal(summary.canWithdraw, true);
      assert.equal(summary.openWithdrawal, null);
    });

    it('canWithdraw is false if available < minWithdrawal or open withdrawal exists', async () => {
      const advocateId = 'adv-123';

      prisma.advocateEarningLedger.aggregate = async () => ({ _sum: { amountPaise: 30000 } }); // ₹300 (< 500)
      prisma.advocateBooking.aggregate = async () => ({ _sum: { feePaise: 0 } });
      prisma.advocateWithdrawal.aggregate = async () => ({ _sum: { amountPaise: 0 } });
      prisma.advocateWithdrawal.findFirst = async () => null;

      const summary = await getAdvocateEarningsSummary(advocateId);
      assert.equal(summary.canWithdraw, false);

      // Now available >= 500, but open withdrawal exists
      prisma.advocateEarningLedger.aggregate = async () => ({ _sum: { amountPaise: 60000 } });
      prisma.advocateWithdrawal.findFirst = async () => ({
        withdrawalId: 'VSW-2026KA1B2C',
        amountPaise: 50000,
        status: 'REQUESTED',
        createdAt: new Date()
      });

      const summaryWithOpen = await getAdvocateEarningsSummary(advocateId);
      assert.equal(summaryWithOpen.canWithdraw, false);
      assert.notEqual(summaryWithOpen.openWithdrawal, null);
      assert.equal(summaryWithOpen.openWithdrawal.withdrawalId, 'VSW-2026KA1B2C');
    });
  });

  // 3. Earning on completion & reversal on refund
  describe('3. Earning on Completion & Reversal on Refund', () => {
    it('credits booking earning once (feePaise only) on completion; idempotent on repeat calls', async () => {
      const bookingId = 'bk-123';
      let createdRow = null;

      const mockTx = {
        advocateBooking: {
          findUnique: async () => ({
            id: bookingId,
            bookingId: 'VLB-2026TEST1',
            advocateId: 'adv-1',
            feePaise: 51000,
            status: 'COMPLETED'
          })
        },
        advocateEarningLedger: {
          findUnique: async ({ where }) => {
            if (createdRow && where.type_advocateBookingId?.advocateBookingId === bookingId) {
              return createdRow;
            }
            return null;
          },
          create: async ({ data }) => {
            createdRow = { id: 'led-1', ...data };
            return createdRow;
          }
        }
      };

      const result1 = await creditBookingEarning(bookingId, mockTx);
      assert.equal(result1.amountPaise, 51000);
      assert.equal(result1.type, 'BOOKING_EARNING');

      // Second call must return existing row without creating another
      const result2 = await creditBookingEarning(bookingId, mockTx);
      assert.equal(result2.id, result1.id);
    });

    it('creates REFUND_REVERSAL for completed booking; idempotent; does nothing if booking had no earning', async () => {
      const bookingId = 'bk-completed';
      let reversalRow = null;

      const mockTx = {
        advocateBooking: {
          findUnique: async () => ({
            id: bookingId,
            bookingId: 'VLB-2026COMP',
            advocateId: 'adv-1',
            feePaise: 51000
          })
        },
        advocateEarningLedger: {
          findUnique: async ({ where }) => {
            const { type, advocateBookingId } = where.type_advocateBookingId;
            if (type === 'BOOKING_EARNING' && advocateBookingId === bookingId) {
              return { id: 'led-earn', type: 'BOOKING_EARNING' };
            }
            if (type === 'REFUND_REVERSAL' && advocateBookingId === bookingId && reversalRow) {
              return reversalRow;
            }
            return null;
          },
          create: async ({ data }) => {
            reversalRow = { id: 'led-rev', ...data };
            return reversalRow;
          }
        }
      };

      const rev1 = await reverseBookingEarningOnRefund(bookingId, 'admin-1', mockTx);
      assert.equal(rev1.amountPaise, -51000);
      assert.equal(rev1.type, 'REFUND_REVERSAL');

      // Idempotency check
      const rev2 = await reverseBookingEarningOnRefund(bookingId, 'admin-1', mockTx);
      assert.equal(rev2.id, rev1.id);

      // For confirmed-only booking with no BOOKING_EARNING row, returns null (no reversal created)
      const mockTxNoEarn = {
        advocateBooking: {
          findUnique: async () => ({ id: 'bk-confirmed', feePaise: 51000 })
        },
        advocateEarningLedger: {
          findUnique: async () => null,
          create: async () => { throw new Error('Should not create reversal'); }
        }
      };
      const noRev = await reverseBookingEarningOnRefund('bk-confirmed', 'admin-1', mockTxNoEarn);
      assert.equal(noRev, null);
    });
  });

  // 4. Withdrawal Request Validations & Flow
  describe('4. Withdrawal Request Logic', () => {
    it('validates schema: amount decimals, account number match, IFSC format', () => {
      // Good payload
      const valid = advocateWithdrawalRequestSchema.parse({
        amount: 500,
        accountHolderName: 'Adv. Shivam Singh',
        accountNumber: '123456789012',
        confirmAccountNumber: '123456789012',
        ifsc: 'HDFC0001234',
        bankName: 'HDFC Bank'
      });
      assert.equal(valid.amount, 500);
      assert.equal(valid.ifsc, 'HDFC0001234');

      // More than 2 decimal places -> rejected
      assert.throws(() => {
        advocateWithdrawalRequestSchema.parse({
          amount: 500.123,
          accountHolderName: 'Adv. Shivam Singh',
          accountNumber: '123456789012',
          confirmAccountNumber: '123456789012',
          ifsc: 'HDFC0001234',
          bankName: 'HDFC Bank'
        });
      });

      // Mismatched account numbers -> rejected
      assert.throws(() => {
        advocateWithdrawalRequestSchema.parse({
          amount: 500,
          accountHolderName: 'Adv. Shivam Singh',
          accountNumber: '123456789012',
          confirmAccountNumber: '999999999999',
          ifsc: 'HDFC0001234',
          bankName: 'HDFC Bank'
        });
      });

      // Invalid IFSC -> rejected
      assert.throws(() => {
        advocateWithdrawalRequestSchema.parse({
          amount: 500,
          accountHolderName: 'Adv. Shivam Singh',
          accountNumber: '123456789012',
          confirmAccountNumber: '123456789012',
          ifsc: 'INVALIDIFSC',
          bankName: 'HDFC Bank'
        });
      });
    });

    it('rejects withdrawal if amount > available balance or open withdrawal exists', async () => {
      const advocateId = 'adv-123';

      prisma.$transaction = async (cb) => {
        const tx = {
          $executeRaw: async () => {},
          advocate: {
            findUnique: async () => ({ id: advocateId, fullName: 'Shivam Singh' })
          },
          advocateWithdrawal: {
            findFirst: async () => null // no open withdrawal
          },
          advocateEarningLedger: {
            aggregate: async () => ({ _sum: { amountPaise: 40000 } }) // only ₹400 available
          }
        };
        return cb(tx);
      };

      await assert.rejects(
        requestWithdrawal(advocateId, {
          amount: 500,
          accountHolderName: 'Shivam Singh',
          accountNumber: '123456789012',
          ifsc: 'HDFC0001234',
          bankName: 'HDFC Bank'
        }),
        (err) => {
          assert.equal(err.statusCode, 400);
          assert.equal(err.message, 'Amount exceeds your available balance.');
          return true;
        }
      );

      // Test open withdrawal -> 409
      prisma.$transaction = async (cb) => {
        const tx = {
          $executeRaw: async () => {},
          advocate: {
            findUnique: async () => ({ id: advocateId, fullName: 'Shivam Singh' })
          },
          advocateWithdrawal: {
            findFirst: async () => ({ id: 'w-open', status: 'REQUESTED' })
          }
        };
        return cb(tx);
      };

      await assert.rejects(
        requestWithdrawal(advocateId, {
          amount: 500,
          accountHolderName: 'Shivam Singh',
          accountNumber: '123456789012',
          ifsc: 'HDFC0001234',
          bankName: 'HDFC Bank'
        }),
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.message, 'You already have a withdrawal in process.');
          return true;
        }
      );
    });

    it('detects bankAccountChanged and holderNameMatches correctly and creates hold ledger entry', async () => {
      const advocateId = 'adv-123';
      let createdWithdrawal = null;
      let createdHold = null;

      prisma.$transaction = async (cb) => {
        const tx = {
          $executeRaw: async () => {},
          advocate: {
            findUnique: async () => ({ id: advocateId, fullName: 'Adv. Shivam Singh' })
          },
          advocateWithdrawal: {
            findFirst: async () => null,
            create: async ({ data }) => {
              createdWithdrawal = { id: 'w-1', ...data, createdAt: new Date() };
              return createdWithdrawal;
            }
          },
          advocateEarningLedger: {
            aggregate: async () => ({ _sum: { amountPaise: 200000 } }), // ₹2000 available
            create: async ({ data }) => {
              createdHold = { id: 'h-1', ...data };
              return createdHold;
            }
          },
          advocatePayoutAccount: {
            findUnique: async () => null, // First time save
            upsert: async () => {}
          }
        };
        return cb(tx);
      };

      const result = await requestWithdrawal(advocateId, {
        amount: 1000,
        accountHolderName: 'Shivam Singh',
        accountNumber: '123456789012',
        ifsc: 'HDFC0001234',
        bankName: 'HDFC Bank'
      });

      assert.equal(result.amount, 1000.00);
      assert.equal(result.status, 'REQUESTED');
      assert.equal(result.bank.accountNumberMasked, 'XXXXXX9012');
      assert.equal(createdWithdrawal.holderNameMatches, true);
      assert.equal(createdWithdrawal.bankAccountChanged, false); // false on first save
      assert.equal(createdHold.type, 'WITHDRAWAL_HOLD');
      assert.equal(createdHold.amountPaise, -100000);
    });

    it('concurrency: two simultaneous requests for same advocate -> only one succeeds, second gets 409', async () => {
      const advocateId = 'adv-concurrent';
      let activeOpenWithdrawal = null;
      let availablePaise = 200000; // ₹2000 available

      // In-memory serialized lock simulation
      let lockPromise = Promise.resolve();

      prisma.$transaction = async (cb) => {
        // Enforce lock serialization (representing FOR UPDATE row lock)
        const currentLock = lockPromise;
        let releaseLock;
        lockPromise = new Promise((resolve) => { releaseLock = resolve; });

        await currentLock;
        try {
          const tx = {
            $executeRaw: async () => {},
            advocate: {
              findUnique: async () => ({ id: advocateId, fullName: 'Adv. Test Lawyer' })
            },
            advocateWithdrawal: {
              findFirst: async () => activeOpenWithdrawal,
              create: async ({ data }) => {
                activeOpenWithdrawal = { id: 'w-c1', ...data, createdAt: new Date() };
                return activeOpenWithdrawal;
              }
            },
            advocateEarningLedger: {
              aggregate: async () => ({ _sum: { amountPaise: availablePaise } }),
              create: async ({ data }) => {
                availablePaise += data.amountPaise;
                return data;
              }
            },
            advocatePayoutAccount: {
              findUnique: async () => null,
              upsert: async () => {}
            }
          };

          return await cb(tx);
        } finally {
          releaseLock();
        }
      };

      const reqBody = {
        amount: 500,
        accountHolderName: 'Test Lawyer',
        accountNumber: '111122223333',
        ifsc: 'HDFC0001234',
        bankName: 'HDFC Bank'
      };

      // Launch both simultaneously
      const [res1, res2] = await Promise.allSettled([
        requestWithdrawal(advocateId, reqBody),
        requestWithdrawal(advocateId, reqBody)
      ]);

      const successCount = [res1, res2].filter((r) => r.status === 'fulfilled').length;
      const rejected = [res1, res2].find((r) => r.status === 'rejected');

      assert.equal(successCount, 1, 'Exactly one concurrent request must succeed');
      assert.notEqual(rejected, undefined);
      assert.equal(rejected.reason.statusCode, 409);
      assert.equal(rejected.reason.message, 'You already have a withdrawal in process.');
    });
  });

  // 5. Admin workflow: approve, mark-paid, reject
  describe('5. Admin Workflow (State Machine)', () => {
    it('approve: REQUESTED -> APPROVED; wrong state throws 409', async () => {
      prisma.advocateWithdrawal.findFirst = async () => ({
        id: 'w-1',
        withdrawalId: 'VSW-123',
        status: 'REQUESTED'
      });

      prisma.advocateWithdrawal.updateMany = async ({ where }) => {
        if (where.status === 'REQUESTED') return { count: 1 };
        return { count: 0 };
      };

      const approved = await approveWithdrawal('w-1', { id: 'admin-1' });
      assert.equal(approved.status, 'APPROVED');

      // Attempting again -> updateMany count is 0 -> 409
      prisma.advocateWithdrawal.updateMany = async () => ({ count: 0 });
      prisma.advocateWithdrawal.findUnique = async () => ({ id: 'w-1', status: 'APPROVED' });

      await assert.rejects(
        approveWithdrawal('w-1', { id: 'admin-1' }),
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.match(err.message, /already APPROVED/);
          return true;
        }
      );
    });

    it('mark-paid: APPROVED -> PAID with UTR; wrong state throws 409', async () => {
      prisma.advocateWithdrawal.findFirst = async () => ({
        id: 'w-1',
        withdrawalId: 'VSW-123',
        status: 'APPROVED'
      });

      prisma.advocateWithdrawal.updateMany = async ({ where }) => {
        if (where.status === 'APPROVED') return { count: 1 };
        return { count: 0 };
      };

      const paid = await markWithdrawalPaid('w-1', { utr: 'UTR123456789' }, { id: 'admin-1' });
      assert.equal(paid.status, 'PAID');
      assert.equal(paid.utr, 'UTR123456789');

      // Wrong state (already paid)
      prisma.advocateWithdrawal.updateMany = async () => ({ count: 0 });
      prisma.advocateWithdrawal.findUnique = async () => ({ id: 'w-1', status: 'PAID' });

      await assert.rejects(
        markWithdrawalPaid('w-1', { utr: 'UTR123456789' }, { id: 'admin-1' }),
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.match(err.message, /already PAID/);
          return true;
        }
      );
    });

    it('reject: releases held funds via WITHDRAWAL_RELEASE (+amountPaise) in transaction', async () => {
      let releasedHold = null;

      prisma.advocateWithdrawal.findFirst = async () => ({
        id: 'w-1',
        withdrawalId: 'VSW-123',
        advocateId: 'adv-1',
        amountPaise: 100000,
        status: 'REQUESTED'
      });

      prisma.$transaction = async (cb) => {
        const tx = {
          advocateWithdrawal: {
            updateMany: async () => ({ count: 1 }),
            findUnique: async () => null
          },
          advocateEarningLedger: {
            create: async ({ data }) => {
              releasedHold = data;
              return data;
            }
          }
        };
        return cb(tx);
      };

      const rejected = await rejectWithdrawal('w-1', { reason: 'Incorrect IFSC code' }, { id: 'admin-1' });
      assert.equal(rejected.status, 'REJECTED');
      assert.equal(rejected.rejectionReason, 'Incorrect IFSC code');
      assert.equal(releasedHold.type, 'WITHDRAWAL_RELEASE');
      assert.equal(releasedHold.amountPaise, 100000); // Positive credit restoring Available
    });
  });

  // 6. Admin details and permissions: payouts:view vs payouts:manage
  describe('6. Permissions & Plain Account Number Masking', () => {
    it('shows full decrypted account number only if canManage is true', async () => {
      const encrypted = encryptField('987654321012');

      prisma.advocateWithdrawal.findFirst = async () => ({
        id: 'w-1',
        withdrawalId: 'VSW-123',
        advocateId: 'adv-1',
        amountPaise: 100000,
        status: 'REQUESTED',
        accountHolderName: 'Shivam Singh',
        accountNumberEncrypted: encrypted,
        accountNumberLast4: '1012',
        ifsc: 'HDFC0001234',
        bankName: 'HDFC Bank',
        bankAccountChanged: false,
        holderNameMatches: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      // Stub summary & ledger queries
      prisma.advocateEarningLedger.aggregate = async () => ({ _sum: { amountPaise: 100000 } });
      prisma.advocateBooking.aggregate = async () => ({ _sum: { feePaise: 0 } });
      prisma.advocateWithdrawal.aggregate = async () => ({ _sum: { amountPaise: 0 } });
      prisma.advocateEarningLedger.findMany = async () => [];
      prisma.advocateWithdrawal.findMany = async () => [];

      // Case A: payouts:view only (canManage = false)
      const resViewOnly = await adminController.getAdminWithdrawalDetails;
      const reqView = { params: { id: 'w-1' }, user: { id: 'staff-1', role: 'CONTENT_CREATOR', type: 'CONTENT_CREATOR' } };
      const resView = mockRes();
      let nextError = null;

      // When canManage is false:
      const detailsViewOnly = await (async () => {
        const { getAdminWithdrawalDetails } = await import('../src/services/advocateEarnings.service.js');
        return getAdminWithdrawalDetails('w-1', { canManage: false });
      })();

      assert.equal(detailsViewOnly.bank.accountNumberMasked, 'XXXXXX1012');
      assert.equal(detailsViewOnly.bank.accountNumber, undefined);

      // Case B: payouts:manage (canManage = true)
      const detailsManage = await (async () => {
        const { getAdminWithdrawalDetails } = await import('../src/services/advocateEarnings.service.js');
        return getAdminWithdrawalDetails('w-1', { canManage: true });
      })();

      assert.equal(detailsManage.bank.accountNumberMasked, 'XXXXXX1012');
      assert.equal(detailsManage.bank.accountNumber, '987654321012');
    });
  });
});
