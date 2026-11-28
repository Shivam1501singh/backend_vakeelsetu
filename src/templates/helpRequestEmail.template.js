import {
  escapeHtml,
  renderEmailLayout,
  COLORS
} from './emailLayout.template.js';

/**
 * Formats a Date into Asia/Kolkata date string (e.g. "28 Nov 2026").
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
 * Formats a Date into Asia/Kolkata time string (e.g. "5:24 PM IST").
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
 * Masks phone number to +91 XX...XX with first 2 and last 2 digits visible (e.g. +91 88XXXXXX68).
 * @param {string} phone
 * @returns {string}
 */
export const maskPhone = (phone = '') => {
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
 * Truncates concern text to maximum 1000 characters with ellipsis.
 * @param {string} text
 * @returns {string}
 */
export const truncateConcern = (text = '') => {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length > 1000) {
    return trimmed.slice(0, 1000) + '…';
  }
  return trimmed;
};

/**
 * Generates user-facing "Help request received" acknowledgement email.
 *
 * @param {object} params
 * @param {object} params.helpRequest
 * @param {string} params.helpRequest.referenceId
 * @param {string} [params.helpRequest.name]
 * @param {string} [params.helpRequest.email]
 * @param {string} [params.helpRequest.phoneNumber]
 * @param {string} [params.helpRequest.concern]
 * @param {string} [params.helpRequest.subject] Optional subject/category if present
 * @param {Date|string} [params.helpRequest.createdAt]
 * @returns {{ subject: string, html: string, text: string, attachments: Array }}
 */
export const helpRequestEmailTemplate = ({ helpRequest = {} } = {}) => {
  const referenceId = (helpRequest.referenceId || '').trim();
  const name = (helpRequest.name || '').trim();
  const email = (helpRequest.email || '').trim();
  const phone = (helpRequest.phoneNumber || '').trim();
  const maskedPhone = maskPhone(phone);
  const categorySubject = (helpRequest.subject || helpRequest.category || '').trim();
  const rawConcern = (helpRequest.concern || '').trim();
  const truncated = truncateConcern(rawConcern);
  const escapedConcern = escapeHtml(truncated);
  const createdAt = helpRequest.createdAt || new Date();

  const dateStr = formatSubmittedDateIst(createdAt);
  const timeStr = formatSubmittedTimeIst(createdAt);

  const subject = `We've received your request – ${referenceId}`;
  const preheader = `Your reference ID is ${referenceId}. Our team will get back to you soon.`;

  // Salutation
  const greetingHtml = name
    ? `Dear <strong style="color:${COLORS.textMain};">${escapeHtml(name)}</strong>,<br/>Thank you for reaching out to VakeelSetu. Our support team will review your request and get back to you soon.`
    : `Hello,<br/>Thank you for reaching out to VakeelSetu. Our support team will review your request and get back to you soon.`;

  // Dynamic Detail Rows (omitting empty values)
  const detailRows = [];
  if (name) {
    detailRows.push({ label: 'Name', value: escapeHtml(name) });
  }
  if (email) {
    detailRows.push({ label: 'Email', value: escapeHtml(email) });
  }
  if (maskedPhone) {
    detailRows.push({ label: 'Phone', value: escapeHtml(maskedPhone) });
  }
  if (categorySubject) {
    detailRows.push({ label: 'Subject', value: escapeHtml(categorySubject) });
  }
  // Status chip row
  detailRows.push({
    label: 'Status',
    value: `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#e6f6ee;color:#13804f;font-size:12px;font-weight:800;">Received</span>`,
    rawHtml: true
  });

  const detailRowsHtml = detailRows.map((row, idx) => {
    const isLast = idx === detailRows.length - 1;
    const borderStyle = isLast ? '' : `border-bottom:1px solid ${COLORS.border};`;
    const labelStyle = `width:40%;padding:12px 18px;${borderStyle}font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};`;
    const valueStyle = `padding:12px 18px;${borderStyle}font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;word-break:break-word;`;
    const valueContent = row.rawHtml ? row.value : escapeHtml(row.value);
    return `<tr><td class="detail-label" width="40%" style="${labelStyle}">${escapeHtml(row.label)}</td><td class="detail-value" align="right" style="${valueStyle}">${valueContent}</td></tr>`;
  }).join('');

  const bodyHtml = `
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#e6f6ee" style="padding:5px 12px;border-radius:20px;background:#e6f6ee;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#13804f;">&#10003;&nbsp; Request received</td></tr></table>

<h1 style="margin:14px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:22px;line-height:29px;font-weight:800;color:${COLORS.textMain};">We've received your help request</h1>

<p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">${greetingHtml}</p>

<!-- Reference ID & Submitted On Dark Box -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-radius:12px;background:${COLORS.primary};"><tr>
  <td style="padding:14px 18px;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Reference ID</div>
    <div style="margin-top:4px;font-family:'Courier New',monospace;font-size:22px;font-weight:800;letter-spacing:1px;color:#ffffff;">${escapeHtml(referenceId)}</div>
  </td>
  <td align="right" style="padding:14px 18px;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Submitted on</div>
    <div style="margin-top:4px;font-size:14px;font-weight:700;color:#ffffff;">${escapeHtml(dateStr)}<br/>${escapeHtml(timeStr)}</div>
  </td>
</tr></table>

<!-- Details Table -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border:1px solid ${COLORS.border};border-radius:12px;border-collapse:separate;background:${COLORS.boxLight};">
  ${detailRowsHtml}
</table>

<!-- Your Concern -->
<div style="margin-top:22px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.textSubtle};">Your concern</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;border:1px solid ${COLORS.border};border-left:3px solid ${COLORS.accent};border-radius:8px;background:${COLORS.surface};"><tr>
  <td style="padding:12px 14px;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;line-height:21px;color:${COLORS.textMuted};white-space:pre-wrap;word-break:break-word;">${escapedConcern}</td>
</tr></table>

<!-- Tracking instruction -->
<p style="margin:20px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;line-height:21px;color:${COLORS.textMuted};">Please keep your reference ID <strong style="color:${COLORS.textMain};">${escapeHtml(referenceId)}</strong> for any follow-up. You can simply log in to VakeelSetu and track your request.</p>
`;

  const { html, attachments } = renderEmailLayout({
    title: subject,
    preheader,
    bodyHtml,
    showSupport: true
  });

  // Plain-Text Version
  const textGreeting = name ? `Dear ${name},` : 'Hello,';
  const textDetails = [];
  if (name) textDetails.push(`- Name: ${name}`);
  if (email) textDetails.push(`- Email: ${email}`);
  if (maskedPhone) textDetails.push(`- Phone: ${maskedPhone}`);
  if (categorySubject) textDetails.push(`- Subject: ${categorySubject}`);
  textDetails.push(`- Status: Received`);

  const text = `VakeelSetu - Request received
==================================================

We've received your help request

${textGreeting}
Thank you for reaching out to VakeelSetu. Our support team will review your request and get back to you soon.

Reference ID: ${referenceId}
Submitted on: ${dateStr} ${timeStr}

Details:
${textDetails.join('\n')}

Your concern:
${truncated}

Please keep your reference ID ${referenceId} for any follow-up. You can simply log in to VakeelSetu and track your request.
`;

  return {
    subject,
    html,
    text,
    attachments
  };
};
