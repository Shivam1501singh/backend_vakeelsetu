import {
  escapeHtml,
  renderEmailLayout,
  COLORS
} from './emailLayout.template.js';

/**
 * Returns subject, heading, and action noun based on OTP purpose.
 * @param {string} purpose
 */
const getPurposeDetails = (purpose = '') => {
  const normalized = String(purpose).toUpperCase().trim();
  switch (normalized) {
    case 'LOGIN':
      return {
        subject: 'Your VakeelSetu login code',
        heading: 'Log in to VakeelSetu',
        actionLabel: 'login',
        codeLabel: 'Your login code'
      };
    case 'PASSWORD_RESET':
      return {
        subject: 'Reset your VakeelSetu password',
        heading: 'Reset your password',
        actionLabel: 'password reset',
        codeLabel: 'Your reset code'
      };
    case 'REGISTRATION':
    case 'EMAIL_VERIFICATION':
    default:
      return {
        subject: 'Your VakeelSetu verification code',
        heading: 'Verify your email address',
        actionLabel: 'registration',
        codeLabel: 'Your verification code'
      };
  }
};

/**
 * Generates branded OTP verification email (HTML, plain text, and subject).
 *
 * @param {object} params
 * @param {string|number} params.otp The 6-digit OTP
 * @param {number} [params.expiryMinutes=5] OTP validity duration
 * @param {string} [params.recipientName=''] Recipient name (optional)
 * @param {string} [params.purpose='REGISTRATION'] Purpose (REGISTRATION | LOGIN | PASSWORD_RESET)
 * @returns {{ subject: string, html: string, text: string, attachments: Array }}
 */
export const otpEmailTemplate = ({
  otp,
  expiryMinutes = 5,
  recipientName = '',
  purpose = 'REGISTRATION'
} = {}) => {
  const cleanOtp = String(otp || '').trim().replace(/\s+/g, '');
  const minutes = parseInt(expiryMinutes, 10) || 5;
  const { subject, heading, actionLabel, codeLabel } = getPurposeDetails(purpose);

  const safeName = recipientName ? escapeHtml(recipientName.trim()) : '';
  const greetingHtml = safeName
    ? `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">Hello <strong style="color:${COLORS.textMain};">${safeName}</strong>,</div>`
    : '';

  const preheader = `Your code is ${cleanOtp}. Valid for ${minutes} minutes.`;

  const bodyHtml = `
    ${greetingHtml}
    <h1 style="margin:14px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:22px;line-height:29px;font-weight:800;color:${COLORS.textMain};">${escapeHtml(heading)}</h1>
    <p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">Use the code below to continue your VakeelSetu ${actionLabel}. This code is valid for <strong>${minutes} minutes</strong>.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;"><tr><td align="center">
      <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#7a8799;">${escapeHtml(codeLabel)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;"><tr>
        <td class="otp-code" bgcolor="#fff4e5" style="padding:16px 34px;border:2px dashed ${COLORS.accent};border-radius:12px;background:#fff4e5;font-family:'Courier New',monospace;font-size:32px;line-height:38px;font-weight:800;letter-spacing:10px;color:${COLORS.textMain};">${escapeHtml(cleanOtp)}</td>
      </tr></table>
    </td></tr></table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border:1px solid ${COLORS.securityBorder};border-radius:10px;background:${COLORS.securityBg};"><tr>
      <td style="padding:12px 16px;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.securityText};"><strong>Keep this code private.</strong> VakeelSetu will never ask for your OTP on call, chat or email. If you didn't request this, you can ignore this email.</td>
    </tr></table>
  `;

  const { html, attachments } = renderEmailLayout({
    title: subject,
    preheader,
    bodyHtml,
    showSupport: true
  });

  const textGreeting = recipientName ? `Hello ${recipientName.trim()},\n\n` : '';
  const text = `${textGreeting}${heading}\nUse the code below to continue your VakeelSetu ${actionLabel}. This code is valid for ${minutes} minutes.\n\n${codeLabel}: ${cleanOtp}\n\nKeep this code private. VakeelSetu will never ask for your OTP on call, chat or email. If you didn't request this, you can ignore this email.`;

  return { subject, html, text, attachments };
};
