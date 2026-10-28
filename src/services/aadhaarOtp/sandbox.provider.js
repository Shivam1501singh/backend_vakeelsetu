/**
 * @deprecated Sandbox Aadhaar OKYC API was discontinued by UIDAI (HTTP 410 Gone).
 * Kept strictly for reference and rollback capability via AADHAAR_OTP_PROVIDER=sandbox.
 */
import axios from 'axios';
import { getSandboxToken } from '../sandboxAuth.service.js';

export const generateOtp = async ({ aadhaarNumber }) => {
  const cleanAadhaar = aadhaarNumber ? String(aadhaarNumber).replace(/\s/g, '') : '';
  const maskedAadhaar = cleanAadhaar.length >= 4 
    ? `XXXXXXXX${cleanAadhaar.slice(-4)}` 
    : 'XXXXXXXX';

  const baseUrl = process.env.SANDBOX_API_BASE_URL || 'https://api.sandbox.co.in';
  const apiVersion = process.env.SANDBOX_API_VERSION || '2.0';
  const apiKey = process.env.SANDBOX_API_KEY;

  if (!apiKey) {
    console.error('Sandbox API key is missing.');
    return {
      ok: false,
      reason: 'PROVIDER_ERROR',
      providerMessage: 'Sandbox API key is missing.'
    };
  }

  try {
    const token = await getSandboxToken();
    const response = await axios.post(
      `${baseUrl}/kyc/aadhaar/okyc/otp`,
      {
        '@entity': 'in.co.sandbox.kyc.aadhaar.okyc.otp.request',
        aadhaar_number: cleanAadhaar,
        consent: 'Y',
        reason: 'Advocate registration Aadhaar verification'
      },
      {
        headers: {
          'Authorization': token,
          'x-api-key': apiKey,
          'x-api-version': apiVersion,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    console.log(`[SANDBOX] Method: getotp, Status: ${response.status}, Aadhaar: ${maskedAadhaar}`);

    if (response.data && response.data.code === 200 && response.data.data?.reference_id) {
      return {
        ok: true,
        referenceId: String(response.data.data.reference_id)
      };
    }

    return {
      ok: false,
      reason: 'PROVIDER_ERROR',
      providerMessage: response.data?.message || 'Failed to generate Aadhaar OTP with Sandbox.'
    };
  } catch (error) {
    const statusCode = error.response?.status;
    const errorData = error.response?.data;
    console.warn(`[SANDBOX] Generate OTP failed. Status: ${statusCode}`);

    return {
      ok: false,
      reason: 'PROVIDER_ERROR',
      providerMessage: errorData?.message || error.message
    };
  }
};

export const verifyOtp = async ({ referenceId, otp }) => {
  const baseUrl = process.env.SANDBOX_API_BASE_URL || 'https://api.sandbox.co.in';
  const apiVersion = process.env.SANDBOX_API_VERSION || '2.0';
  const apiKey = process.env.SANDBOX_API_KEY;

  if (!apiKey) {
    console.error('Sandbox API key is missing.');
    return {
      ok: false,
      reason: 'PROVIDER_ERROR',
      providerMessage: 'Sandbox API key is missing.'
    };
  }

  try {
    const token = await getSandboxToken();
    const response = await axios.post(
      `${baseUrl}/kyc/aadhaar/okyc/otp/verify`,
      {
        '@entity': 'in.co.sandbox.kyc.aadhaar.okyc.request',
        reference_id: referenceId,
        otp: otp
      },
      {
        headers: {
          'Authorization': token,
          'x-api-key': apiKey,
          'x-api-version': apiVersion,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    console.log(`[SANDBOX] Method: validateotp, Status: ${response.status}, ReferenceId: ${referenceId}`);

    const statusStr = String(response.data?.data?.status || '').toUpperCase();
    if (response.data && response.data.code === 200 && (statusStr === 'VALID' || statusStr === 'SUCCESS' || statusStr === 'VERIFIED')) {
      return {
        ok: true,
        kyc: {
          fullName: response.data.data.name || '',
          dob: response.data.data.dob || '',
          gender: response.data.data.gender || '',
          aadhaarLast4: '',
          address: {},
          zip: ''
        }
      };
    }

    return {
      ok: false,
      reason: 'INVALID_OTP',
      providerMessage: response.data?.message || 'Invalid OTP.'
    };
  } catch (error) {
    const statusCode = error.response?.status;
    const errorData = error.response?.data;
    console.warn(`[SANDBOX] Verify OTP failed. Status: ${statusCode}`);

    return {
      ok: false,
      reason: statusCode >= 500 ? 'PROVIDER_ERROR' : 'INVALID_OTP',
      providerMessage: errorData?.message || error.message
    };
  }
};
