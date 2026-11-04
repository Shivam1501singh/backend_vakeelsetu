import {
  escapeHtml,
  renderDetailRows,
  renderEmailLayout,
  COLORS
} from './emailLayout.template.js';

/**
 * Returns formatted date in Asia/Kolkata timezone (e.g. 4 Nov 2026).
 * @param {Date|string} dateInput
 * @returns {string}
 */
export const formatSubmittedDateIst = (dateInput) => {
  const date = dateInput ? new Date(dateInput) : new Date();
  if (isNaN(date.getTime())) return '';
  const rawDateStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date);
  return rawDateStr.replace(/,\s*(\d{4})/, ' $1');
};

/**
 * Returns formatted time in Asia/Kolkata timezone (e.g. 4:40 PM IST).
 * @param {Date|string} dateInput
 * @returns {string}
 */
export const formatSubmittedTimeIst = (dateInput) => {
  const date = dateInput ? new Date(dateInput) : new Date();
  if (isNaN(date.getTime())) return '';
  const timeStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date).toUpperCase();
  return `${timeStr} IST`;
};

/**
 * Masks phone number to +91 XX...XX with first 2 and last 2 digits visible (e.g. +91 98XXXXXX21).
 * @param {string} phone
 * @returns {string}
 */
export const maskAdvocatePhone = (phone = '') => {
  if (!phone || typeof phone !== 'string') return '';
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  const localDigits = digits.length > 10 ? digits.slice(-10) : digits;
  if (localDigits.length < 4) {
    return trimmed;
  }
  const firstTwo = localDigits.slice(0, 2);
  const lastTwo = localDigits.slice(-2);
  const maskedCount = localDigits.length - 4;
  const maskedMiddle = 'X'.repeat(maskedCount);
  return `+91 ${firstTwo}${maskedMiddle}${lastTwo}`;
};

/**
 * Generates "Your profile is under review" email for advocate verification submission.
 *
 * @param {object} params
 * @param {object} [params.advocate={}]
 * @param {string} [params.advocate.fullName]
 * @param {string} [params.advocate.barCouncilId]
 * @param {string} [params.advocate.email]
 * @param {string} [params.advocate.phone]
 * @param {Date|string} [params.submittedAt]
 * @returns {{ subject: string, html: string, text: string, attachments: Array }}
 */
export const profileUnderReviewTemplate = ({ advocate = {}, submittedAt = new Date() } = {}) => {
  const subject = 'Your VakeelSetu profile is under review';
  const preheader = "We've received your profile. Our team is verifying your details.";

  const fullName = (advocate.fullName || '').trim();
  const barCouncilId = (advocate.barCouncilId || '').trim();
  const email = (advocate.email || '').trim();
  const phone = (advocate.phone || '').trim();
  const maskedPhone = maskAdvocatePhone(phone);

  const dateStr = formatSubmittedDateIst(submittedAt);
  const timeStr = formatSubmittedTimeIst(submittedAt);

  // Greeting
  const greetingHtml = fullName
    ? `<p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">Dear <strong style="color:${COLORS.textMain};">${escapeHtml(fullName)}</strong>,<br/>Thank you for completing your profile on VakeelSetu. We have received it and our verification team is now reviewing your details and documents.</p>`
    : `<p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">Thank you for completing your profile on VakeelSetu. We have received it and our verification team is now reviewing your details and documents.</p>`;

  // Dark Status Box
  const statusBoxHtml = `<!-- status box -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-radius:12px;background:${COLORS.primary};"><tr>
  <td style="padding:14px 18px;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Status</div>
    <div style="margin-top:4px;font-size:17px;font-weight:800;color:#ffffff;">Submitted for verification</div>
  </td>
  <td align="right" style="padding:14px 18px;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Submitted on</div>
    <div style="margin-top:4px;font-size:14px;font-weight:700;color:#ffffff;">${escapeHtml(dateStr)}<br/>${escapeHtml(timeStr)}</div>
  </td>
</tr></table>`;

  // Detail rows: omit empty fields
  const detailRows = [];
  if (fullName) {
    detailRows.push({ label: 'Name', value: fullName });
  }
  if (barCouncilId) {
    detailRows.push({ label: 'Bar Council ID', value: barCouncilId, isMono: true });
  }
  if (email) {
    detailRows.push({ label: 'Registered email', value: email });
  }
  if (maskedPhone) {
    detailRows.push({ label: 'Registered phone', value: maskedPhone });
  }
  detailRows.push({
    label: 'Profile status',
    value: `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:${COLORS.pillAmberBg};color:${COLORS.pillAmberText};font-size:12px;font-weight:800;">Under review</span>`,
    rawHtml: true
  });

  const bodyHtml = `
    <!-- status pill -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${COLORS.pillAmberBg}" style="padding:5px 12px;border-radius:20px;background:${COLORS.pillAmberBg};font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${COLORS.pillAmberText};">&#9203;&nbsp; Under review</td>
    </tr></table>

    <h1 style="margin:14px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:22px;line-height:29px;font-weight:800;color:${COLORS.textMain};">Your profile is under review</h1>

    ${greetingHtml}

    ${statusBoxHtml}

    ${renderDetailRows(detailRows)}

    <p style="margin:20px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;line-height:21px;color:${COLORS.textMuted};">We will email you as soon as your profile is approved. Until then, your profile will not be visible to clients. If we need any more information, our team will contact you.</p>
  `;

  const { html, attachments } = renderEmailLayout({
    title: subject,
    preheader,
    bodyHtml,
    showSupport: true,
    tagline: 'Advocate Partner'
  });

  // Plain-text alternative
  const greetingText = fullName ? `Dear ${fullName},\n` : '';
  const textLines = [
    subject,
    '',
    `${greetingText}Thank you for completing your profile on VakeelSetu. We have received it and our verification team is now reviewing your details and documents.`,
    '',
    'Status: Submitted for verification',
    `Submitted on: ${dateStr} / ${timeStr}`,
    ''
  ];
  if (fullName) textLines.push(`Name: ${fullName}`);
  if (barCouncilId) textLines.push(`Bar Council ID: ${barCouncilId}`);
  if (email) textLines.push(`Registered email: ${email}`);
  if (maskedPhone) textLines.push(`Registered phone: ${maskedPhone}`);
  textLines.push('Profile status: Under review');
  textLines.push('');
  textLines.push('We will email you as soon as your profile is approved. Until then, your profile will not be visible to clients. If we need any more information, our team will contact you.');

  const text = textLines.join('\n');

  return { subject, html, text, attachments };
};

