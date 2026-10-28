import test, { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import * as idspayProvider from '../src/services/aadhaarOtp/idspay.provider.js';
import * as aadhaarOtpRouter from '../src/services/aadhaarOtp/index.js';
import * as authService from '../src/services/auth.service.js';
import prisma from '../src/lib/prisma.js';

describe('Aadhaar OTP - IDSPay Provider Unit Tests (Stubbed HTTP)', () => {
  let originalAxiosPost;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.IDSPAY_BASE_URL = 'https://javabackend.idspay.in/api/v1/prod';
    process.env.IDSPAY_API_ID = 'test_api_id';
    process.env.IDSPAY_API_KEY = 'test_api_key';
    process.env.IDSPAY_TOKEN_ID = 'test_token_id';
    process.env.IDSPAY_AADHAAR_OTP_PATH = '/srv2/digital-kyc/aadhar/auto-verification';
    process.env.AADHAAR_OTP_TIMEOUT_MS = '5000';
    process.env.AADHAAR_OTP_PROVIDER = 'idspay';
    originalAxiosPost = axios.post;
  });

  const restoreAxios = () => {
    axios.post = originalAxiosPost;
  };

  it('1. generate success: converts numeric request_id to string referenceId', async () => {
    axios.post = async () => ({
      status: 200,
      data: {
        status: { code: 200, type: 'success', message: 'Aadhaar verification OTP sent successfully.' },
        message: 'Aadhaar verification OTP sent successfully.',
        data: {
          data: { otp_sent: true, if_number: true, valid_aadhaar: true, status: 'generate_otp_success' },
          status_code: 200,
          message: 'OTP Sent.',
          status: 'success',
          request_id: 16746854
        }
      }
    });

    const res = await idspayProvider.generateOtp({ aadhaarNumber: '123456789012' });
    assert.equal(res.ok, true);
    assert.equal(typeof res.referenceId, 'string');
    assert.equal(res.referenceId, '16746854');
    restoreAxios();
  });

  it('2. valid_aadhaar:false maps to INVALID_AADHAAR', async () => {
    axios.post = async () => ({
      status: 200,
      data: {
        status: { code: 200, type: 'failed', message: 'Invalid Aadhaar' },
        message: 'Invalid Aadhaar Number',
        data: {
          data: { otp_sent: false, if_number: false, valid_aadhaar: false, status: 'failed' },
          status_code: 400
        }
      }
    });

    const res = await idspayProvider.generateOtp({ aadhaarNumber: '000000000000' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'INVALID_AADHAAR');
    restoreAxios();
  });

  it('3. otp_sent:false without specific flags maps to PROVIDER_ERROR', async () => {
    axios.post = async () => ({
      status: 200,
      data: {
        status: { code: 200, type: 'failed', message: 'Internal provider issue' },
        data: {
          data: { otp_sent: false, if_number: true, valid_aadhaar: true }
        }
      }
    });

    const res = await idspayProvider.generateOtp({ aadhaarNumber: '123456789012' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'PROVIDER_ERROR');
    restoreAxios();
  });

  it('4. HTTP 500 returns PROVIDER_ERROR', async () => {
    axios.post = async () => {
      const err = new Error('Request failed with status code 500');
      err.response = { status: 500, data: { message: 'Internal Server Error' } };
      throw err;
    };

    const res = await idspayProvider.generateOtp({ aadhaarNumber: '123456789012' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'PROVIDER_ERROR');
    restoreAxios();
  });

  it('5. Timeout (ECONNABORTED) returns PROVIDER_ERROR', async () => {
    axios.post = async () => {
      const err = new Error('timeout of 20000ms exceeded');
      err.code = 'ECONNABORTED';
      throw err;
    };

    const res = await idspayProvider.generateOtp({ aadhaarNumber: '123456789012' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'PROVIDER_ERROR');
    restoreAxios();
  });

  it('6. Garbage response body returns PROVIDER_ERROR', async () => {
    axios.post = async () => ({
      status: 200,
      data: '<html>502 Bad Gateway</html>'
    });

    const res = await idspayProvider.generateOtp({ aadhaarNumber: '123456789012' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'PROVIDER_ERROR');
    restoreAxios();
  });

  it('7. verify success: returns normalized KYC data', async () => {
    axios.post = async () => ({
      status: 200,
      data: {
        status: { code: 200, type: 'success', message: 'Aadhaar verified successfully.' },
        message: 'Aadhaar verified successfully.',
        data: {
          full_name: 'Test Advocate',
          aadhaar_number: 'XXXXXXXX9012',
          dob: '1985-05-15',
          gender: 'M',
          address: { state: 'Delhi', dist: 'New Delhi' },
          zip: '110001',
          profile_image: 'base64junk'
        }
      }
    });

    const res = await idspayProvider.verifyOtp({ referenceId: '16746854', otp: '123456' });
    assert.equal(res.ok, true);
    assert.equal(res.kyc.fullName, 'Test Advocate');
    assert.equal(res.kyc.aadhaarLast4, '9012');
    assert.equal(res.kyc.gender, 'M');
    assert.equal(res.kyc.zip, '110001');
    assert.equal(res.kyc.profile_image, undefined); // profile_image stripped
    restoreAxios();
  });

  it('8. verify non-success returns INVALID_OTP', async () => {
    axios.post = async () => ({
      status: 200,
      data: {
        status: { code: 400, type: 'failed', message: 'Invalid OTP' },
        message: 'Invalid OTP'
      }
    });

    const res = await idspayProvider.verifyOtp({ referenceId: '16746854', otp: '999999' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'INVALID_OTP');
    restoreAxios();
  });

  it('9. verify success with missing full_name maps to failure', async () => {
    axios.post = async () => ({
      status: 200,
      data: {
        status: { code: 200, type: 'success', message: 'OK' },
        data: {
          // full_name missing
          aadhaar_number: 'XXXXXXXX9012'
        }
      }
    });

    const res = await idspayProvider.verifyOtp({ referenceId: '16746854', otp: '123456' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'INVALID_OTP');
    restoreAxios();
  });

  it('10. missing required IDSPAY env var returns 503 config error', async () => {
    delete process.env.IDSPAY_TOKEN_ID;
    const res = await idspayProvider.generateOtp({ aadhaarNumber: '123456789012' });
    assert.equal(res.ok, false);
    assert.equal(res.isConfigMissing, true);
    assert.equal(res.missingVar, 'IDSPAY_TOKEN_ID');
    process.env.IDSPAY_TOKEN_ID = 'test_token_id';
    restoreAxios();
  });
});

describe('Aadhaar OTP - Service Layer & Provider Router Tests', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.IDSPAY_BASE_URL = 'https://javabackend.idspay.in/api/v1/prod';
    process.env.IDSPAY_API_ID = 'test_api_id';
    process.env.IDSPAY_API_KEY = 'test_api_key';
    process.env.IDSPAY_TOKEN_ID = 'test_token_id';
    process.env.IDSPAY_AADHAAR_OTP_PATH = '/srv2/digital-kyc/aadhar/auto-verification';
    process.env.AADHAAR_OTP_PROVIDER = 'mock';
  });

  it('1. NODE_ENV=production + AADHAAR_OTP_PROVIDER=mock returns 503', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AADHAAR_OTP_PROVIDER = 'mock';

    const resGen = await aadhaarOtpRouter.generateOtp({ aadhaarNumber: '123456789012' });
    assert.equal(resGen.ok, false);
    assert.equal(resGen.statusCode, 503);

    const resVer = await aadhaarOtpRouter.verifyOtp({ referenceId: '123', otp: '123456' });
    assert.equal(resVer.ok, false);
    assert.equal(resVer.statusCode, 503);

    process.env.NODE_ENV = 'test';
  });

  it('2. Service Layer: reference mismatch throws 400', async () => {
    const originalFindUnique = prisma.registrationSession.findUnique;
    prisma.registrationSession.findUnique = async () => ({
      id: 'session-uuid-1',
      accountType: 'ADVOCATE',
      expiresAt: new Date(Date.now() + 3600000),
      aadhaarVerificationId: 'valid-reference-123',
      aadhaarVerificationAttempts: 0,
      aadhaarBlockedUntil: null,
      aadhaarVerified: false
    });

    await assert.rejects(
      async () => {
        await authService.verifyAadhaarOtpService({
          registrationId: 'session-uuid-1',
          reference_id: 'wrong-reference-999',
          otp: '123456'
        });
      },
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /Invalid or expired OTP session/i);
        return true;
      }
    );

    prisma.registrationSession.findUnique = originalFindUnique;
  });

  it('3. Service Layer: Cooldown throws 429 within 60s', async () => {
    const originalFindUnique = prisma.registrationSession.findUnique;
    const originalUpdate = prisma.registrationSession.update;

    prisma.registrationSession.findUnique = async () => ({
      id: 'cooldown-session-1',
      accountType: 'ADVOCATE',
      expiresAt: new Date(Date.now() + 3600000),
      aadhaarVerificationAttempts: 0,
      aadhaarBlockedUntil: null,
      aadhaarVerified: false
    });
    prisma.registrationSession.update = async () => ({});

    // First call: succeeds
    const firstRes = await authService.generateAadhaarOtpService({
      registrationId: 'cooldown-session-1',
      aadhaarNumber: '123456789012'
    });
    assert.equal(firstRes.success, true);

    // Immediate second call: must reject with 429
    await assert.rejects(
      async () => {
        await authService.generateAadhaarOtpService({
          registrationId: 'cooldown-session-1',
          aadhaarNumber: '123456789012'
        });
      },
      (err) => {
        assert.equal(err.statusCode, 429);
        assert.equal(typeof err.retryAfterSeconds, 'number');
        assert.ok(err.retryAfterSeconds <= 60 && err.retryAfterSeconds >= 58);
        return true;
      }
    );

    prisma.registrationSession.findUnique = originalFindUnique;
    prisma.registrationSession.update = originalUpdate;
  });

  it('4. Service Layer: INVALID_OTP decrements attempts and blocks after 3rd attempt', async () => {
    let currentAttempts = 2;
    let savedBlockedUntil = null;

    const originalFindUnique = prisma.registrationSession.findUnique;
    const originalUpdate = prisma.registrationSession.update;

    prisma.registrationSession.findUnique = async () => ({
      id: 'block-test-session',
      accountType: 'ADVOCATE',
      expiresAt: new Date(Date.now() + 3600000),
      aadhaarVerificationId: 'mock_ref_123',
      aadhaarNumber: '123456789012',
      aadhaarVerificationAttempts: currentAttempts,
      aadhaarBlockedUntil: null,
      aadhaarVerified: false
    });

    prisma.registrationSession.update = async ({ data }) => {
      currentAttempts = data.aadhaarVerificationAttempts;
      savedBlockedUntil = data.aadhaarBlockedUntil;
      return {};
    };

    // Submitting wrong OTP for attempt 3 -> should block session for 24 hours with 403
    await assert.rejects(
      async () => {
        await authService.verifyAadhaarOtpService({
          registrationId: 'block-test-session',
          reference_id: 'mock_ref_123',
          otp: '999999' // wrong OTP in mock provider
        });
      },
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.equal(err.blocked, true);
        assert.equal(err.remainingAttempts, 0);
        assert.ok(err.blockedUntil instanceof Date);
        return true;
      }
    );

    assert.equal(currentAttempts, 3);
    assert.ok(savedBlockedUntil instanceof Date);

    prisma.registrationSession.findUnique = originalFindUnique;
    prisma.registrationSession.update = originalUpdate;
  });

  it('5. Service Layer: PROVIDER_ERROR does NOT increment attempts', async () => {
    process.env.AADHAAR_OTP_PROVIDER = 'idspay';

    let updateCalled = false;
    const originalFindUnique = prisma.registrationSession.findUnique;
    const originalUpdate = prisma.registrationSession.update;
    const originalAxiosPost = axios.post;

    prisma.registrationSession.findUnique = async () => ({
      id: 'provider-err-session',
      accountType: 'ADVOCATE',
      expiresAt: new Date(Date.now() + 3600000),
      aadhaarVerificationId: 'ref_123',
      aadhaarNumber: '123456789012',
      aadhaarVerificationAttempts: 1,
      aadhaarBlockedUntil: null,
      aadhaarVerified: false
    });

    prisma.registrationSession.update = async () => {
      updateCalled = true;
      return {};
    };

    // Simulate 500 error from IDSPay
    axios.post = async () => {
      const err = new Error('Gateway Timeout');
      err.response = { status: 504 };
      throw err;
    };

    await assert.rejects(
      async () => {
        await authService.verifyAadhaarOtpService({
          registrationId: 'provider-err-session',
          reference_id: 'ref_123',
          otp: '123456'
        });
      },
      (err) => {
        assert.equal(err.statusCode, 502);
        return true;
      }
    );

    // Crucial: session attempts must NOT have been incremented
    assert.equal(updateCalled, false);

    prisma.registrationSession.findUnique = originalFindUnique;
    prisma.registrationSession.update = originalUpdate;
    axios.post = originalAxiosPost;
  });
});
