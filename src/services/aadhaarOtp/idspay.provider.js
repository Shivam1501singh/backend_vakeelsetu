import axios from 'axios';
import dotenv from 'dotenv';

/**
 * IDSPay Auto-Verification Aadhaar OTP Provider
 * Endpoint: POST {IDSPAY_BASE_URL}/srv2/digital-kyc/aadhar/auto-verification
 */

const getRequiredEnv = () => {
  let baseUrl = process.env.IDSPAY_BASE_URL;
  let apiId = process.env.IDSPAY_API_ID;
  let apiKey = process.env.IDSPAY_API_KEY;
  let tokenId = process.env.IDSPAY_TOKEN_ID;

  // If any required var is missing in memory, reload from .env in case it was updated while server was running
  if (process.env.NODE_ENV !== 'test' && (!baseUrl || !apiId || !apiKey || !tokenId)) {
    dotenv.config({ override: true });
    baseUrl = process.env.IDSPAY_BASE_URL;
    apiId = process.env.IDSPAY_API_ID;
    apiKey = process.env.IDSPAY_API_KEY;
    tokenId = process.env.IDSPAY_TOKEN_ID;
  }

  const path = process.env.IDSPAY_AADHAAR_OTP_PATH || '/srv2/digital-kyc/aadhar/auto-verification';
  const timeoutMs = parseInt(process.env.AADHAAR_OTP_TIMEOUT_MS, 10) || 20000;

  const required = [
    { name: 'IDSPAY_BASE_URL', val: baseUrl },
    { name: 'IDSPAY_API_ID', val: apiId },
    { name: 'IDSPAY_API_KEY', val: apiKey },
    { name: 'IDSPAY_TOKEN_ID', val: tokenId }
  ];

  for (const item of required) {
    if (!item.val) {
      console.error(`IDSPay configuration missing: ${item.name}`);
      return {
        missingVar: item.name
      };
    }
  }

  return {
    baseUrl,
    apiId,
    apiKey,
    tokenId,
    path,
    timeoutMs
  };
};

/**
 * Generate Aadhaar OTP via IDSPay Auto-Verification
 */
export const generateOtp = async ({ aadhaarNumber }) => {
  const cleanAadhaar = aadhaarNumber ? String(aadhaarNumber).replace(/\s/g, '') : '';
  const maskedAadhaar = cleanAadhaar.length >= 4 
    ? `XXXXXXXX${cleanAadhaar.slice(-4)}` 
    : 'XXXXXXXX';

  const envConfig = getRequiredEnv();
  if (envConfig.missingVar) {
    return {
      ok: false,
      reason: 'PROVIDER_ERROR',
      isConfigMissing: true,
      missingVar: envConfig.missingVar,
      providerMessage: 'Aadhaar verification is temporarily unavailable.'
    };
  }

  const { baseUrl, apiId, apiKey, tokenId, path, timeoutMs } = envConfig;
  const targetUrl = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

  try {
    const response = await axios.post(
      targetUrl,
      {
        api_id: apiId,
        api_key: apiKey,
        token_id: tokenId,
        methodName: 'getotp',
        aadhaar_no: cleanAadhaar
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: timeoutMs
      }
    );

    const statusType = response.data?.status?.type;
    const statusCode = response.status;
    const responseData = response.data?.data;
    const subData = responseData?.data;
    const requestId = responseData?.request_id;

    console.log(`[IDSPAY] Method: getotp, Status: ${statusCode}, StatusType: ${statusType}, RequestId: ${requestId || 'N/A'}, Aadhaar: ${maskedAadhaar}`);

    const isSuccess = statusCode === 200 &&
      statusType === 'success' &&
      subData?.otp_sent === true &&
      requestId !== undefined &&
      requestId !== null;

    if (isSuccess) {
      return {
        ok: true,
        referenceId: String(requestId)
      };
    }

    // Explicit error condition mappings
    if (subData?.valid_aadhaar === false) {
      return {
        ok: false,
        reason: 'INVALID_AADHAAR',
        providerMessage: response.data?.message || 'Invalid Aadhaar Number or Aadhaar not registered.'
      };
    }

    if (subData?.if_number === false) {
      return {
        ok: false,
        reason: 'NO_MOBILE_LINKED',
        providerMessage: response.data?.message || 'No mobile number linked with this Aadhaar.'
      };
    }

    // TODO: refine with real failure samples
    return {
      ok: false,
      reason: 'PROVIDER_ERROR',
      providerMessage: response.data?.message || 'Failed to generate Aadhaar OTP with IDSPay.'
    };
  } catch (error) {
    const httpStatus = error.response?.status;
    console.warn(`[IDSPAY] Method: getotp error. HTTP Status: ${httpStatus || 'N/A'}, Code: ${error.code || 'UNKNOWN'}, Aadhaar: ${maskedAadhaar}`);

    return {
      ok: false,
      reason: 'PROVIDER_ERROR',
      providerMessage: error.response?.data?.message || error.message
    };
  }
};

/**
 * Validate Aadhaar OTP via IDSPay Auto-Verification
 */
export const verifyOtp = async ({ referenceId, otp }) => {
  const envConfig = getRequiredEnv();
  if (envConfig.missingVar) {
    return {
      ok: false,
      reason: 'PROVIDER_ERROR',
      isConfigMissing: true,
      missingVar: envConfig.missingVar,
      providerMessage: 'Aadhaar verification is temporarily unavailable.'
    };
  }

  const { baseUrl, apiId, apiKey, tokenId, path, timeoutMs } = envConfig;
  const targetUrl = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

  try {
    const response = await axios.post(
      targetUrl,
      {
        api_id: apiId,
        api_key: apiKey,
        token_id: tokenId,
        methodName: 'validateotp',
        request_id: String(referenceId),
        otp: String(otp)
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: timeoutMs
      }
    );

    const statusType = response.data?.status?.type;
    const statusCode = response.status;
    const kycData = response.data?.data;

    console.log(`[IDSPAY] Method: validateotp, Status: ${statusCode}, StatusType: ${statusType}, RequestId: ${referenceId}`);

    const isSuccess = statusCode === 200 &&
      statusType === 'success' &&
      Boolean(kycData && kycData.full_name);

    if (isSuccess) {
      const rawAadhaar = kycData.aadhaar_number ? String(kycData.aadhaar_number).replace(/\s/g, '') : '';
      const aadhaarLast4 = rawAadhaar.length >= 4 ? rawAadhaar.slice(-4) : '';

      return {
        ok: true,
        kyc: {
          fullName: kycData.full_name || '',
          dob: kycData.dob || '',
          gender: kycData.gender || '',
          aadhaarLast4,
          address: kycData.address || {},
          zip: kycData.zip || ''
        }
      };
    }

    // TODO: refine with real failure samples
    return {
      ok: false,
      reason: 'INVALID_OTP',
      providerMessage: response.data?.message || 'Invalid OTP.'
    };
  } catch (error) {
    const httpStatus = error.response?.status;
    console.warn(`[IDSPAY] Method: validateotp error. HTTP Status: ${httpStatus || 'N/A'}, Code: ${error.code || 'UNKNOWN'}, RequestId: ${referenceId}`);

    const isServerError = !httpStatus || httpStatus >= 500 || error.code === 'ECONNABORTED';

    return {
      ok: false,
      reason: isServerError ? 'PROVIDER_ERROR' : 'INVALID_OTP',
      providerMessage: error.response?.data?.message || error.message
    };
  }
};
