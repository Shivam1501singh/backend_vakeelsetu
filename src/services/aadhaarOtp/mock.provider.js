/**
 * Mock Aadhaar OTP Provider
 * Used strictly for automated tests and local development when AADHAAR_OTP_PROVIDER=mock.
 * Isolated completely from production and live network paths.
 */

export const generateOtp = async ({ aadhaarNumber }) => {
  const cleanAadhaar = aadhaarNumber ? String(aadhaarNumber).replace(/\s/g, '') : '';
  const maskedAadhaar = cleanAadhaar.length >= 4 
    ? `XXXXXXXX${cleanAadhaar.slice(-4)}` 
    : 'XXXXXXXX';

  console.log(`[MOCK AADHAAR PROVIDER] generateOtp called for: ${maskedAadhaar}`);

  if (cleanAadhaar === '123456789000') {
    return {
      ok: false,
      reason: 'INVALID_AADHAAR',
      providerMessage: 'Invalid Aadhaar Number or Aadhaar not registered.'
    };
  }

  if (cleanAadhaar === '123456789001') {
    return {
      ok: false,
      reason: 'NO_MOBILE_LINKED',
      providerMessage: 'No mobile number linked with this Aadhaar.'
    };
  }

  return {
    ok: true,
    referenceId: `mock_ref_${Date.now()}`
  };
};

export const verifyOtp = async ({ referenceId, otp }) => {
  console.log(`[MOCK AADHAAR PROVIDER] verifyOtp called for reference: ${referenceId}`);

  if (otp === '123456') {
    return {
      ok: true,
      kyc: {
        fullName: 'Rahul Verma',
        dob: '1990-01-01',
        gender: 'M',
        aadhaarLast4: '9012',
        address: { country: 'India', state: 'Delhi' },
        zip: '110001'
      }
    };
  }

  if (otp === '000000') {
    return {
      ok: false,
      reason: 'OTP_EXPIRED',
      providerMessage: 'OTP has expired.'
    };
  }

  return {
    ok: false,
    reason: 'INVALID_OTP',
    providerMessage: 'Invalid OTP.'
  };
};
