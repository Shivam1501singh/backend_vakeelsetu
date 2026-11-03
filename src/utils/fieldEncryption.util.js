import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits standard for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits standard for GCM

let warnedMissingKey = false;

/**
 * Retrieves the 32-byte encryption key from PAYOUT_ENCRYPTION_KEY env var.
 * @returns {Buffer|null}
 */
export const getPayoutEncryptionKey = () => {
  const rawKey = process.env.PAYOUT_ENCRYPTION_KEY;
  if (!rawKey || !rawKey.trim()) {
    if (!warnedMissingKey) {
      console.error('[Payout Security] PAYOUT_ENCRYPTION_KEY is missing. Payout endpoints will return 503.');
      warnedMissingKey = true;
    }
    return null;
  }

  try {
    const keyBuf = Buffer.from(rawKey.trim(), 'base64');
    if (keyBuf.length !== 32) {
      if (!warnedMissingKey) {
        console.error(`[Payout Security] Invalid PAYOUT_ENCRYPTION_KEY length: expected 32 bytes (base64), got ${keyBuf.length} bytes.`);
        warnedMissingKey = true;
      }
      return null;
    }
    return keyBuf;
  } catch (err) {
    if (!warnedMissingKey) {
      console.error('[Payout Security] Failed to parse PAYOUT_ENCRYPTION_KEY base64 string.');
      warnedMissingKey = true;
    }
    return null;
  }
};

/**
 * Checks if payout encryption key is configured and valid.
 * @returns {boolean}
 */
export const isPayoutEncryptionConfigured = () => {
  return getPayoutEncryptionKey() !== null;
};

/**
 * Encrypts plain text using AES-256-GCM.
 * Output format: "iv:authTag:ciphertext" (all base64).
 *
 * @param {string} text
 * @returns {string}
 */
export const encryptField = (text) => {
  if (text === null || text === undefined || text === '') {
    return '';
  }

  const key = getPayoutEncryptionKey();
  if (!key) {
    const err = new Error('Payouts are not configured.');
    err.statusCode = 503;
    throw err;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const ciphertext = Buffer.concat([
    cipher.update(String(text), 'utf8'),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
};

/**
 * Decrypts a formatted "iv:authTag:ciphertext" string using AES-256-GCM.
 *
 * @param {string} encryptedStr
 * @returns {string}
 */
export const decryptField = (encryptedStr) => {
  if (!encryptedStr || typeof encryptedStr !== 'string') {
    return '';
  }

  const key = getPayoutEncryptionKey();
  if (!key) {
    const err = new Error('Payouts are not configured.');
    err.statusCode = 503;
    throw err;
  }

  try {
    const parts = encryptedStr.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted field format');
    }

    const [ivB64, authTagB64, cipherB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(cipherB64, 'base64');

    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error('Invalid IV or auth tag length');
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    // Never log raw ciphertext, keys, or plaintext in error message
    console.error('[Payout Security] Decryption failed.');
    const err = new Error('Failed to decrypt financial record.');
    err.statusCode = 500;
    throw err;
  }
};

/**
 * Masks a bank account number to show only the last 4 digits (e.g. XXXXXX1234).
 *
 * @param {string} accountNumber
 * @returns {string}
 */
export const maskAccountNumber = (accountNumber) => {
  if (!accountNumber) return '';
  const str = String(accountNumber).trim();
  const last4 = str.slice(-4);
  return `XXXXXX${last4}`;
};
