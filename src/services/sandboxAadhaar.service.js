/**
 * @deprecated Use src/services/aadhaarOtp/index.js instead.
 * This file is retained for backward compatibility with existing imports.
 */
import * as aadhaarOtp from './aadhaarOtp/index.js';

export const generateAadhaarOtpSandbox = async (aadhaarNumber) => {
  const result = await aadhaarOtp.generateOtp({ aadhaarNumber });
  if (result.ok) {
    return {
      code: 200,
      data: {
        reference_id: result.referenceId,
        message: 'OTP sent successfully'
      }
    };
  }

  return {
    code: result.statusCode || (result.reason === 'INVALID_AADHAAR' ? 400 : 502),
    message: result.providerMessage || 'Failed to generate Aadhaar OTP.'
  };
};

export const verifyAadhaarOtpSandbox = async (referenceId, otp) => {
  const result = await aadhaarOtp.verifyOtp({ referenceId, otp });
  if (result.ok) {
    return {
      code: 200,
      data: {
        status: 'VALID',
        name: result.kyc?.fullName || '',
        dob: result.kyc?.dob || '',
        gender: result.kyc?.gender || '',
        message: 'Aadhaar verified successfully'
      }
    };
  }

  return {
    code: result.statusCode || (result.reason === 'INVALID_OTP' ? 400 : 502),
    message: result.providerMessage || 'Aadhaar verification failed.'
  };
};
