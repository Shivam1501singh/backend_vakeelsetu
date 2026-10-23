import crypto from 'crypto';

export const DEFAULT_HELP_REFERENCE_FORMAT = 'VKLS-{RAND6}';
export const DEFAULT_BOOKING_ID_FORMAT = 'VSB-{YYYY}{MONTH_LETTER}{RAND6}';
export const DEFAULT_ID_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_ID_RANDOM_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/O/1/I

const MONTH_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

// Allowed single tokens and their lengths
const FIXED_TOKEN_LENGTHS = {
  '{YYYY}': 4,
  '{YY}': 2,
  '{MM}': 2,
  '{DD}': 2,
  '{MONTH_LETTER}': 1
};

/**
 * Validates an ID template against system constraints:
 * - Only allowed tokens: {YYYY}, {YY}, {MM}, {DD}, {MONTH_LETTER}, and {RANDn} (4 <= n <= 12)
 * - Must contain at least one {RANDn} with n >= 4
 * - Literal text between tokens can only contain A–Z, 0–9, and '-'
 * - Total maximum expanded length <= 40 characters
 *
 * @param {string} template
 * @returns {{ isValid: boolean, error?: string, maxExpandedLength?: number }}
 */
export const validateTemplate = (template) => {
  if (typeof template !== 'string' || !template.trim()) {
    return { isValid: false, error: 'Template must be a non-empty string.' };
  }

  const str = template.trim();

  // Find all {...} occurrences
  const tokenRegex = /\{[^}]*\}/g;
  const matches = str.match(tokenRegex) || [];

  if (matches.length === 0) {
    return { isValid: false, error: 'Template must contain at least one token.' };
  }

  let hasValidRand = false;
  let totalLength = 0;

  // Verify each token
  for (const token of matches) {
    if (token in FIXED_TOKEN_LENGTHS) {
      totalLength += FIXED_TOKEN_LENGTHS[token];
    } else {
      const randMatch = token.match(/^\{RAND(\d+)\}$/);
      if (!randMatch) {
        return { isValid: false, error: `Disallowed token found: ${token}` };
      }
      const randLength = parseInt(randMatch[1], 10);
      if (isNaN(randLength) || randLength < 4 || randLength > 12) {
        return {
          isValid: false,
          error: `{RANDn} length 'n' must be between 4 and 12, got: ${token}`
        };
      }
      hasValidRand = true;
      totalLength += randLength;
    }
  }

  if (!hasValidRand) {
    return {
      isValid: false,
      error: 'Template must contain at least one {RANDn} token with n >= 4.'
    };
  }

  // Strip all tokens to inspect literal text
  const literalText = str.replace(tokenRegex, '');
  if (!/^[A-Z0-9-]*$/.test(literalText)) {
    return {
      isValid: false,
      error: `Literal text contains disallowed characters (only uppercase A-Z, 0-9, and '-' allowed): "${literalText}"`
    };
  }

  totalLength += literalText.length;

  if (totalLength > 40) {
    return {
      isValid: false,
      error: `Maximum expanded length exceeds 40 characters (calculated: ${totalLength}).`
    };
  }

  return { isValid: true, maxExpandedLength: totalLength };
};

/**
 * Extracts year, month, day, and month letter in the configured timezone.
 *
 * @param {Date|string|number} [date=new Date()]
 * @param {string} [timeZone]
 * @returns {{ yearStr: string, yyStr: string, mmStr: string, ddStr: string, monthLetter: string }}
 */
export const getTimezoneDateParts = (date = new Date(), timeZone = process.env.ID_TIMEZONE || DEFAULT_ID_TIMEZONE) => {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  const tz = timeZone || DEFAULT_ID_TIMEZONE;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(d);
  const yearStr = parts.find((p) => p.type === 'year').value;
  const yyStr = yearStr.slice(-2);
  const mmStr = parts.find((p) => p.type === 'month').value;
  const ddStr = parts.find((p) => p.type === 'day').value;
  const monthNum = parseInt(mmStr, 10);
  const monthLetter = MONTH_LETTERS[monthNum - 1];

  return { yearStr, yyStr, mmStr, ddStr, monthLetter };
};

/**
 * Formats an ID string from a template and options.
 *
 * @param {string} template
 * @param {object} [options]
 * @param {Date|string|number} [options.date=new Date()]
 * @param {string} [options.timeZone]
 * @param {string} [options.charset]
 * @returns {string}
 */
export const formatId = (
  template,
  {
    date = new Date(),
    timeZone = process.env.ID_TIMEZONE || DEFAULT_ID_TIMEZONE,
    charset = process.env.ID_RANDOM_CHARSET || DEFAULT_ID_RANDOM_CHARSET
  } = {}
) => {
  const { yearStr, yyStr, mmStr, ddStr, monthLetter } = getTimezoneDateParts(date, timeZone);
  const safeCharset = charset || DEFAULT_ID_RANDOM_CHARSET;

  return template
    .replace(/\{YYYY\}/g, yearStr)
    .replace(/\{YY\}/g, yyStr)
    .replace(/\{MM\}/g, mmStr)
    .replace(/\{DD\}/g, ddStr)
    .replace(/\{MONTH_LETTER\}/g, monthLetter)
    .replace(/\{RAND(\d+)\}/g, (_, nStr) => {
      const count = parseInt(nStr, 10);
      let rand = '';
      for (let i = 0; i < count; i++) {
        rand += safeCharset.charAt(crypto.randomInt(0, safeCharset.length));
      }
      return rand;
    });
};

/**
 * Resolves active Help Reference ID format from process.env or falls back to default.
 * @returns {string}
 */
export const getHelpReferenceFormat = () => {
  const envVal = process.env.HELP_REFERENCE_FORMAT;
  if (!envVal || !envVal.trim()) {
    return DEFAULT_HELP_REFERENCE_FORMAT;
  }
  const validation = validateTemplate(envVal.trim());
  if (!validation.isValid) {
    console.warn(
      `[Config Warning] Invalid HELP_REFERENCE_FORMAT "${envVal}": ${validation.error}. Falling back to default "${DEFAULT_HELP_REFERENCE_FORMAT}".`
    );
    return DEFAULT_HELP_REFERENCE_FORMAT;
  }
  return envVal.trim();
};

/**
 * Resolves active Booking ID format from process.env or falls back to default.
 * @returns {string}
 */
export const getBookingIdFormat = () => {
  const envVal = process.env.BOOKING_ID_FORMAT;
  if (!envVal || !envVal.trim()) {
    return DEFAULT_BOOKING_ID_FORMAT;
  }
  const validation = validateTemplate(envVal.trim());
  if (!validation.isValid) {
    console.warn(
      `[Config Warning] Invalid BOOKING_ID_FORMAT "${envVal}": ${validation.error}. Falling back to default "${DEFAULT_BOOKING_ID_FORMAT}".`
    );
    return DEFAULT_BOOKING_ID_FORMAT;
  }
  return envVal.trim();
};

/**
 * Generates a Help Request Reference ID using the configured template.
 *
 * @param {Date|string|number} [date=new Date()]
 * @returns {string}
 */
export const generateHelpReferenceId = (date = new Date()) => {
  const template = getHelpReferenceFormat();
  return formatId(template, { date });
};

/**
 * Generates a Booking ID using the configured template.
 *
 * @param {Date|string|number} [date=new Date()]
 * @returns {string}
 */
export const generateBookingId = (date = new Date()) => {
  const template = getBookingIdFormat();
  return formatId(template, { date });
};

/**
 * Validates environment templates on startup and logs any warnings.
 * Never throws or crashes the server.
 */
export const validateEnvTemplates = () => {
  const helpFormat = process.env.HELP_REFERENCE_FORMAT;
  if (helpFormat && helpFormat.trim()) {
    const res = validateTemplate(helpFormat.trim());
    if (!res.isValid) {
      console.warn(
        `[Config Warning] Invalid HELP_REFERENCE_FORMAT "${helpFormat}": ${res.error}. Will use default "${DEFAULT_HELP_REFERENCE_FORMAT}".`
      );
    }
  }

  const bookingFormat = process.env.BOOKING_ID_FORMAT;
  if (bookingFormat && bookingFormat.trim()) {
    const res = validateTemplate(bookingFormat.trim());
    if (!res.isValid) {
      console.warn(
        `[Config Warning] Invalid BOOKING_ID_FORMAT "${bookingFormat}": ${res.error}. Will use default "${DEFAULT_BOOKING_ID_FORMAT}".`
      );
    }
  }
};

// Validate on module load
validateEnvTemplates();
