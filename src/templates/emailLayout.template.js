import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const stripQuotesAndWhitespace = (val) => {
  if (!val || typeof val !== 'string') return '';
  let str = val.trim();
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }
  return str;
};

/**
 * Validates and normalizes URLs. Accepts http/https.
 * If no scheme is present but it looks like a domain, automatically prefixes https://.
 * @param {string|undefined} val
 * @returns {string}
 */
export const sanitizeUrl = (val) => {
  let str = stripQuotesAndWhitespace(val);
  if (!str) return '';
  if (!/^https?:\/\//i.test(str)) {
    if (str.startsWith('//')) {
      str = 'https:' + str;
    } else if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(str)) {
      str = 'https://' + str;
    } else {
      return '';
    }
  }
  try {
    const parsed = new URL(str);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return str;
    }
  } catch {
    return '';
  }
  return '';
};

/**
 * Validates basic email format (user@domain.tld).
 * @param {string|undefined} val
 * @returns {string}
 */
export const sanitizeEmail = (val) => {
  const str = stripQuotesAndWhitespace(val);
  if (!str) return '';
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(str) ? str : '';
};

/**
 * Strips surrounding quotes and whitespace from plain strings.
 * @param {string|undefined} val
 * @returns {string}
 */
export const sanitizeString = (val) => {
  return stripQuotesAndWhitespace(val);
};

let brandWarningLogged = false;

/**
 * Logs a single warning at startup listing any empty or invalid BRAND_* variables (names only).
 */
export const logBrandStartupWarning = () => {
  if (brandWarningLogged) return;
  brandWarningLogged = true;

  const checks = [
    { key: 'BRAND_WEBSITE_URL', valid: Boolean(sanitizeUrl(process.env.BRAND_WEBSITE_URL)) },
    { key: 'BRAND_TERMS_URL', valid: Boolean(sanitizeUrl(process.env.BRAND_TERMS_URL)) },
    { key: 'BRAND_CONTACT_URL', valid: Boolean(sanitizeUrl(process.env.BRAND_CONTACT_URL)) },
    { key: 'BRAND_SUPPORT_PHONE', valid: Boolean(sanitizeString(process.env.BRAND_SUPPORT_PHONE)) },
    { key: 'BRAND_SUPPORT_EMAIL', valid: Boolean(sanitizeEmail(process.env.BRAND_SUPPORT_EMAIL)) },
    { key: 'BRAND_ADDRESS', valid: Boolean(sanitizeString(process.env.BRAND_ADDRESS)) }
  ];

  const emptyOrInvalid = checks.filter((c) => !c.valid).map((c) => c.key);
  if (emptyOrInvalid.length > 0) {
    console.warn(`[Brand Config] The following BRAND_* variables are empty or invalid: ${emptyOrInvalid.join(', ')}`);
  }
};

/**
 * Reads brand metadata dynamically from environment variables at CALL time.
 * Empty/missing/invalid values become '' causing respective email sections to hide cleanly.
 */
export const getBrand = () => {
  logBrandStartupWarning();

  return {
    name: 'VakeelSetu',
    tagline: 'Bridge to the right advocate',
    websiteUrl: sanitizeUrl(process.env.BRAND_WEBSITE_URL),
    termsUrl: sanitizeUrl(process.env.BRAND_TERMS_URL),
    contactUrl: sanitizeUrl(process.env.BRAND_CONTACT_URL),
    supportPhone: sanitizeString(process.env.BRAND_SUPPORT_PHONE),
    supportEmail: sanitizeEmail(process.env.BRAND_SUPPORT_EMAIL),
    address: sanitizeString(process.env.BRAND_ADDRESS)
  };
};

/**
 * Dynamic BRAND proxy preserving backward compatibility with direct property access.
 */
export const BRAND = new Proxy({}, {
  get: (_, prop) => getBrand()[prop]
});

export const COLORS = {
  primary: '#020317',
  accent: '#f59f0b',
  accentDark: '#d97706',
  surface: '#ffffff',
  bg: '#f7f4ef',
  textMain: '#14161f',
  textMuted: '#3d4b5c',
  textSubtle: '#6b7a8d',
  border: '#ece6dc',
  boxLight: '#fbfaf8',
  pillGreenBg: '#e6f6ee',
  pillGreenText: '#13804f',
  pillAmberBg: '#fff1de',
  pillAmberText: '#b8650f',
  securityBorder: '#f1d9d9',
  securityBg: '#fff6f6',
  securityText: '#7a3b3b',
  supportBorder: '#f4d5a8',
  supportBg: '#fff5e8',
  footerText: '#a9adc2',
  footerDivider: 'rgba(255,255,255,0.12)',
};

/**
 * Strictly escapes HTML entities in user/dynamic values to prevent injection.
 * @param {*} val
 * @returns {string}
 */
export const escapeHtml = (val) => {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

/**
 * Returns the resolved absolute path to src/assets/email/logo.png
 */
export const getLogoPath = () => {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(currentDir, '../assets/email/logo.png');
  } catch {
    return path.resolve(process.cwd(), 'src/assets/email/logo.png');
  }
};

/**
 * Returns the CID attachment object for nodemailer if logo.png exists on disk, else null.
 */
export const getLogoAttachment = () => {
  const logoPath = getLogoPath();
  if (fs.existsSync(logoPath)) {
    return {
      filename: 'logo.png',
      path: logoPath,
      cid: 'vakeelsetu-logo'
    };
  }
  return null;
};

/**
 * Renders an array of key-value detail rows for booking confirmation emails.
 * Any row whose value is empty/null/undefined is omitted.
 *
 * @param {Array<{ label: string, value: string, isHighlighted?: boolean, isMono?: boolean, rawHtml?: boolean }>} details
 * @returns {string} HTML table string or ''
 */
export const renderDetailRows = (details = []) => {
  const validRows = details.filter((d) => d && d.value !== null && d.value !== undefined && String(d.value).trim() !== '');
  if (validRows.length === 0) return '';

  const rowsHtml = validRows.map((row, idx) => {
    const isLast = idx === validRows.length - 1;
    const borderStyle = isLast ? '' : `border-bottom:1px solid ${COLORS.border};`;
    const labelStyle = row.isHighlighted
      ? `width:45%;padding:12px 18px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:700;color:${COLORS.textMain};${borderStyle}`
      : `width:45%;padding:12px 18px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};${borderStyle}`;

    const valueColor = row.isHighlighted ? COLORS.accentDark : COLORS.textMain;
    const valueSize = row.isHighlighted ? '17px' : '13.5px';
    const valueWeight = row.isHighlighted ? '800' : '700';
    const fontFam = row.isMono ? "'Courier New',monospace" : "'Segoe UI',Arial,sans-serif";
    const valueStyle = `padding:12px 18px;font-family:${fontFam};font-size:${valueSize};font-weight:${valueWeight};color:${valueColor};text-align:right;${borderStyle}`;

    const labelEscaped = escapeHtml(row.label);
    const valueRendered = row.rawHtml ? String(row.value) : escapeHtml(row.value);

    return `<tr><td class="detail-label" width="45%" style="${labelStyle}">${labelEscaped}</td><td class="detail-value" align="right" style="${valueStyle}">${valueRendered}</td></tr>`;
  }).join('');

  return `<!-- details -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border:1px solid ${COLORS.border};border-radius:12px;border-collapse:separate;background:${COLORS.boxLight};">
  ${rowsHtml}
</table>`;
};

/**
 * Renders an action button.
 * If either label or url is absent or empty, renders nothing ('').
 *
 * @param {{ label?: string, url?: string }} options
 * @returns {string}
 */
export const renderButton = ({ label, url } = {}) => {
  if (!label || !url || !String(label).trim() || !String(url).trim()) return '';
  const safeLabel = escapeHtml(label.trim());
  const safeUrl = escapeHtml(url.trim());

  return `<!-- button -->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:26px auto 0;"><tr>
  <td align="center" bgcolor="${COLORS.accent}" style="border-radius:9px;background:${COLORS.accent};">
    <a href="${safeUrl}" style="display:inline-block;min-width:180px;padding:13px 28px;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:800;color:${COLORS.primary};text-decoration:none;text-align:center;">${safeLabel}</a>
  </td>
</tr></table>`;
};

/**
 * Renders a note callout box with amber left-border.
 * If text is empty, renders nothing ('').
 *
 * @param {string} text
 * @param {{ rawHtml?: boolean }} [options]
 * @returns {string}
 */
export const renderNote = (text, { rawHtml = false } = {}) => {
  if (!text || !String(text).trim()) return '';
  const renderedText = rawHtml ? String(text).trim() : escapeHtml(String(text).trim());

  return `<!-- footnote -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;border-left:3px solid ${COLORS.accent};background:${COLORS.supportBg};"><tr>
  <td style="padding:11px 14px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:19px;color:#6b4313;">${renderedText}</td>
</tr></table>`;
};

/**
 * Renders the master email wrapper layout.
 *
 * @param {object} params
 * @param {string} [params.title] Document title
 * @param {string} [params.preheader] Hidden inbox preview text
 * @param {string} params.bodyHtml The email content body HTML
 * @param {boolean} [params.showSupport=true] Whether to include the support block
 * @param {string} [params.tagline] Tagline in header (defaults to BRAND.tagline)
 * @returns {{ html: string, attachments: Array }}
 */
export const renderEmailLayout = ({
  title = 'VakeelSetu',
  preheader = '',
  bodyHtml = '',
  showSupport = true,
  tagline
} = {}) => {
  const brand = getBrand();
  const currentYear = new Date().getFullYear();
  const safeTitle = escapeHtml(title);
  const safeTagline = escapeHtml(tagline || brand.tagline);
  const safePreheader = escapeHtml(preheader);

  // Hidden preheader block (email client preview)
  const preheaderHtml = safePreheader
    ? `<div style="display:none;font-size:1px;color:#333333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${safePreheader}</div>`
    : '';

  // Logo rendering: inline CID if logo.png exists on filesystem, else amber fallback with scales mark ⚖
  const logoAttachment = getLogoAttachment();
  const logoCellHtml = logoAttachment
    ? `<td width="54" height="54" align="center" valign="middle" style="width:54px;height:54px;">
         <img src="cid:vakeelsetu-logo" width="54" height="54" alt="${escapeHtml(brand.name)}" style="display:block;border:0;border-radius:13px;" />
       </td>`
    : `<td width="54" height="54" align="center" valign="middle" bgcolor="${COLORS.accent}" style="width:54px;height:54px;border-radius:13px;background:${COLORS.accent};font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:54px;font-weight:700;color:${COLORS.primary};">&#9878;</td>`;

  // Header right link (only if websiteUrl is populated and valid)
  let headerRightHtml = '';
  if (brand.websiteUrl && brand.websiteUrl.trim()) {
    try {
      const urlObj = new URL(brand.websiteUrl);
      const displayHost = urlObj.hostname.replace(/^www\./, '');
      headerRightHtml = `<a href="${escapeHtml(brand.websiteUrl)}" style="color:${COLORS.footerText};text-decoration:none;">${escapeHtml(displayHost)}</a>`;
    } catch {
      headerRightHtml = `<a href="${escapeHtml(brand.websiteUrl)}" style="color:${COLORS.footerText};text-decoration:none;">${escapeHtml(brand.websiteUrl)}</a>`;
    }
  }

  // Support section: only rendered if showSupport is true AND at least one contact channel is non-empty
  let supportBlockHtml = '';
  if (showSupport && (brand.supportPhone.trim() || brand.supportEmail.trim())) {
    const parts = [];
    if (brand.supportPhone.trim()) {
      parts.push(`Call <a href="tel:${escapeHtml(brand.supportPhone.replace(/\s+/g, ''))}" style="color:${COLORS.textMain};font-weight:800;text-decoration:none;">${escapeHtml(brand.supportPhone)}</a>`);
    }
    if (brand.supportEmail.trim()) {
      parts.push(`email <a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:${COLORS.textMain};font-weight:800;text-decoration:none;">${escapeHtml(brand.supportEmail)}</a>`);
    }
    supportBlockHtml = `<!-- SUPPORT -->
<tr><td class="email-support" style="padding:18px 40px 26px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${COLORS.supportBorder};border-radius:11px;background:${COLORS.supportBg};"><tr>
    <td style="padding:13px 16px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;line-height:19px;color:${COLORS.textMuted};"><strong style="color:${COLORS.textMain};">Need help?</strong> ${parts.join(' or ')}</td>
  </tr></table>
</td></tr>`;
  }

  // Footer address & links: omitted if empty (no placeholder strings)
  const footerAddressHtml = brand.address && brand.address.trim()
    ? `<div style="margin-top:6px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;line-height:17px;color:${COLORS.footerText};">${escapeHtml(brand.address)}</div>`
    : '';

  const footerLinks = [];
  if (brand.websiteUrl && brand.websiteUrl.trim()) {
    footerLinks.push(`<a href="${escapeHtml(brand.websiteUrl)}" style="color:#ffffff;text-decoration:none;font-weight:700;">Website</a>`);
  }
  if (brand.termsUrl && brand.termsUrl.trim()) {
    footerLinks.push(`<a href="${escapeHtml(brand.termsUrl)}" style="color:#ffffff;text-decoration:none;font-weight:700;">Terms</a>`);
  }
  if (brand.contactUrl && brand.contactUrl.trim()) {
    footerLinks.push(`<a href="${escapeHtml(brand.contactUrl)}" style="color:#ffffff;text-decoration:none;font-weight:700;">Contact</a>`);
  }

  const footerLinksHtml = footerLinks.length > 0
    ? `<td class="footer-col" width="40%" valign="top" align="right" style="width:40%;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;line-height:20px;">${footerLinks.join('&nbsp;<span style="color:#3b3f5c;">|</span>&nbsp;')}</td>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<meta name="color-scheme" content="light only" />
<title>${safeTitle}</title>
<style>
  body { margin:0; padding:0; background:${COLORS.bg}; }
  table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; }
  table { border-spacing:0; }
  img { -ms-interpolation-mode:bicubic; }
  @media only screen and (max-width:620px) {
    .email-shell { width:100% !important; }
    .email-content { padding:24px 18px 8px !important; }
    .email-support { padding:6px 18px 22px !important; }
    .email-header, .email-footer { padding:20px 18px !important; }
    .detail-label, .detail-value { display:block !important; width:100% !important; box-sizing:border-box !important; text-align:left !important; }
    .detail-label { padding:12px 14px 2px !important; border-bottom:0 !important; }
    .detail-value { padding:2px 14px 12px !important; }
    .footer-col { display:block !important; width:100% !important; padding:0 0 14px !important; }
    .otp-code { font-size:26px !important; letter-spacing:6px !important; padding:14px 18px !important; }
  }
</style>
</head>
<body>
${preheaderHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.bg};">
<tr><td align="center" style="padding:16px 8px 32px;">
  <table class="email-shell" role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${COLORS.surface};border-radius:16px;border:1px solid ${COLORS.border};">

    <!-- HEADER -->
    <tr><td class="email-header" bgcolor="${COLORS.primary}" style="padding:22px 32px;border-radius:16px 16px 0 0;background:${COLORS.primary};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            ${logoCellHtml}
            <td style="padding-left:14px;">
              <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:23px;line-height:27px;font-weight:800;color:#ffffff;letter-spacing:0.3px;">Vakeel<span style="color:${COLORS.accent};">Setu</span></div>
              <div style="margin-top:3px;font-family:'Segoe UI',Arial,sans-serif;font-size:9.5px;line-height:13px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${COLORS.accent};">${safeTagline}</div>
            </td>
          </tr></table>
        </td>
        <td align="right" valign="middle" style="font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:700;color:${COLORS.footerText};">
          ${headerRightHtml}
        </td>
      </tr></table>
    </td></tr>

    <!-- BODY -->
    <tr><td class="email-content" style="padding:32px 40px 10px;">
      ${bodyHtml}
    </td></tr>

    ${supportBlockHtml}

    <!-- FOOTER -->
    <tr><td style="padding:16px 0 0;"></td></tr>
    <tr><td class="email-footer" bgcolor="${COLORS.primary}" style="padding:22px 32px 18px;border-radius:0 0 16px 16px;background:${COLORS.primary};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td class="footer-col" width="${footerLinks.length > 0 ? '60%' : '100%'}" valign="top" style="width:${footerLinks.length > 0 ? '60%' : '100%'};">
          <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:800;color:#ffffff;">Vakeel<span style="color:${COLORS.accent};">Setu</span></div>
          ${footerAddressHtml}
        </td>
        ${footerLinksHtml}
      </tr></table>
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid ${COLORS.footerDivider};font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:${COLORS.footerText};text-align:center;">&copy; ${currentYear} VakeelSetu. All rights reserved.</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  const attachments = logoAttachment ? [logoAttachment] : [];
  return { html, attachments };
};
