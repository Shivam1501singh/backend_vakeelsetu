import * as idspayProvider from './idspay.provider.js';
import * as sandboxProvider from './sandbox.provider.js';
import * as mockProvider from './mock.provider.js';

const getProviderName = () => {
  return (process.env.AADHAAR_OTP_PROVIDER || 'idspay').toLowerCase().trim();
};

// Startup check for safety
if (process.env.NODE_ENV === 'production' && getProviderName() === 'mock') {
  console.error('[CRITICAL CONFIG ERROR] AADHAAR_OTP_PROVIDER is set to "mock" in production environment! All mock verification requests will be rejected with 503.');
}

const getActiveProvider = () => {
  const provider = getProviderName();

  if (process.env.NODE_ENV === 'production' && provider === 'mock') {
    return {
      generateOtp: async () => ({
        ok: false,
        reason: 'PROVIDER_ERROR',
        isConfigMissing: true,
        statusCode: 503,
        providerMessage: 'Mock Aadhaar OTP provider is disabled in production.'
      }),
      verifyOtp: async () => ({
        ok: false,
        reason: 'PROVIDER_ERROR',
        isConfigMissing: true,
        statusCode: 503,
        providerMessage: 'Mock Aadhaar OTP provider is disabled in production.'
      })
    };
  }

  switch (provider) {
    case 'sandbox':
      return sandboxProvider;
    case 'mock':
      return mockProvider;
    case 'idspay':
    default:
      return idspayProvider;
  }
};

/**
 * Normalized generateOtp
 * @param {{ aadhaarNumber: string }} params
 * @returns {Promise<{ ok: true, referenceId: string } | { ok: false, reason: string, providerMessage?: string, isConfigMissing?: boolean, statusCode?: number }>}
 */
export const generateOtp = async ({ aadhaarNumber }) => {
  const provider = getActiveProvider();
  return await provider.generateOtp({ aadhaarNumber });
};

/**
 * Normalized verifyOtp
 * @param {{ referenceId: string, otp: string }} params
 * @returns {Promise<{ ok: true, kyc: object } | { ok: false, reason: string, providerMessage?: string, isConfigMissing?: boolean, statusCode?: number }>}
 */
export const verifyOtp = async ({ referenceId, otp }) => {
  const provider = getActiveProvider();
  return await provider.verifyOtp({ referenceId, otp });
};

export default {
  generateOtp,
  verifyOtp
};
