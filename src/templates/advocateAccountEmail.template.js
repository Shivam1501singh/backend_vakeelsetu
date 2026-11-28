import {
  escapeHtml,
  renderDetailRows,
  renderEmailLayout,
  renderButton,
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

/**
 * Generates Test Response Sheet email sent to advocate after every test attempt.
 *
 * @param {object} params
 * @param {object} params.attempt The AdvocateTestAttempt record with snapshot questions & answers
 * @param {object} [params.advocate] The Advocate record
 * @param {number} [params.attemptNumber=1] 1-based attempt sequence number
 * @param {number} [params.durationMinutes=20] Test duration in minutes for capping time taken
 * @returns {{ subject: string, html: string, text: string, attachments: Array }}
 */
export const advocateTestResponseSheetTemplate = ({
  attempt = {},
  advocate = {},
  attemptNumber = 1,
  durationMinutes = 20
} = {}) => {
  const passed = Boolean(attempt.passed);
  const correctCount = attempt.correctCount ?? 0;
  const wrongCount = attempt.wrongCount ?? 0;
  const totalQuestions = attempt.totalQuestions ?? (correctCount + wrongCount);

  const subject = passed
    ? `Your VakeelSetu test result – Passed (${correctCount}/${totalQuestions})`
    : `Your VakeelSetu test result – Not passed (${correctCount}/${totalQuestions})`;

  const preheader = passed
    ? `Test passed with ${correctCount}/${totalQuestions} correct. View your response sheet.`
    : `Test not passed with ${correctCount}/${totalQuestions} correct. View your response sheet.`;

  const rawName = (advocate.fullName || '').trim();
  const formattedName = rawName
    ? (rawName.startsWith('Adv.') || rawName.startsWith('Adv ') ? rawName : `Adv. ${rawName}`)
    : 'Advocate';

  const barCouncilId = (advocate.barCouncilId || '').trim();

  const startedAt = attempt.startedAt ? new Date(attempt.startedAt) : new Date();
  const submittedAt = attempt.submittedAt ? new Date(attempt.submittedAt) : startedAt;
  const dateStr = formatSubmittedDateIst(startedAt);
  const timeStr = formatSubmittedTimeIst(startedAt);

  // Time taken calculation capped at test duration
  const maxDurationSeconds = durationMinutes * 60;
  const diffSeconds = Math.max(0, Math.floor((submittedAt.getTime() - startedAt.getTime()) / 1000));
  const cappedSeconds = Math.min(diffSeconds, maxDurationSeconds);
  const minutes = Math.floor(cappedSeconds / 60);
  const seconds = cappedSeconds % 60;
  const timeTakenStr = `${minutes} min ${seconds} sec`;

  const autoSubmitted = Boolean(attempt.autoSubmitted);
  const submittedStr = autoSubmitted ? 'Automatically (time over)' : 'By you';

  // Greeting
  const greetingHtml = `<p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">Dear <strong style="color:${COLORS.textMain};">${escapeHtml(formattedName)}</strong>,<br/>Thank you for taking the VakeelSetu advocate qualification test. Here is a summary of your attempt and your answers.</p>`;

  // Score Box
  const scoreBoxHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-radius:12px;background:${COLORS.primary};"><tr>
<td align="center" width="33%" style="padding:16px 8px;font-family:'Segoe UI',Arial,sans-serif;"><div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Correct</div><div style="margin-top:4px;font-size:26px;font-weight:800;color:#ffffff;">${correctCount}</div></td>
<td align="center" width="33%" style="padding:16px 8px;font-family:'Segoe UI',Arial,sans-serif;border-left:1px solid rgba(255,255,255,0.12);"><div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Wrong</div><div style="margin-top:4px;font-size:26px;font-weight:800;color:#ffffff;">${wrongCount}</div></td>
<td align="center" width="33%" style="padding:16px 8px;font-family:'Segoe UI',Arial,sans-serif;border-left:1px solid rgba(255,255,255,0.12);"><div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Total</div><div style="margin-top:4px;font-size:26px;font-weight:800;color:#ffffff;">${totalQuestions}</div></td></tr></table>`;

  // Details Table
  const resultChipHtml = passed
    ? `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#e6f6ee;color:#13804f;font-size:12px;font-weight:800;">Passed</span>`
    : `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#fde8e8;color:#b42318;font-size:12px;font-weight:800;">Not passed</span>`;

  const detailsTableHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border:1px solid ${COLORS.border};border-radius:12px;border-collapse:separate;background:${COLORS.boxLight};"><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Name</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(formattedName)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Bar Council ID</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Courier New',monospace;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(barCouncilId || '—')}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Test date &amp; time</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(dateStr)}, ${escapeHtml(timeStr)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Attempt</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">Attempt ${escapeHtml(attemptNumber)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Time taken</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(timeTakenStr)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Submitted</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(submittedStr)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Result</td><td class="detail-value" align="right" style="padding:12px 18px;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${resultChipHtml}</td></tr></table>`;

  // Question Analysis (from snapshot)
  const questionsSnapshot = Array.isArray(attempt.questions) ? attempt.questions : [];
  const answersList = Array.isArray(attempt.answers) ? attempt.answers : [];

  const answerMap = new Map();
  answersList.forEach((ans) => {
    if (ans && ans.index !== undefined) {
      answerMap.set(Number(ans.index), ans.selected ? String(ans.selected).trim().toUpperCase() : null);
    }
  });

  const wrongOrUnanswered = [];
  const correctList = [];

  questionsSnapshot.forEach((q, idx) => {
    const selectedKey = answerMap.get(idx);
    const selectedIndex = selectedKey ? selectedKey.charCodeAt(0) - 65 : -1;
    const isAnswered = selectedKey !== null && selectedKey !== undefined && selectedIndex >= 0 && Array.isArray(q.options) && selectedIndex < q.options.length;
    const isCorrect = isAnswered && selectedIndex === q.correctIndex;

    const userAnswer = isAnswered ? q.options[selectedIndex] : null;
    const correctAnswer = Array.isArray(q.options) && q.options[q.correctIndex] !== undefined ? q.options[q.correctIndex] : '';

    const itemData = {
      num: idx + 1,
      question: q.question || '',
      isAnswered,
      isCorrect,
      userAnswer,
      correctAnswer
    };

    if (isCorrect) {
      correctList.push(itemData);
    } else {
      wrongOrUnanswered.push(itemData);
    }
  });

  // Render Wrong / Not Answered section
  let wrongSectionHtml = '';
  if (wrongOrUnanswered.length > 0) {
    const wrongRows = wrongOrUnanswered.map((item) => {
      const chipHtml = item.isAnswered
        ? `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#fde8e8;color:#b42318;font-size:12px;font-weight:800;">&#10007; Wrong</span>`
        : `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#eef0f3;color:#5b6472;font-size:12px;font-weight:800;">Not answered</span>`;

      const yourAnswerHtml = item.isAnswered
        ? `<strong style="color:#b42318;">${escapeHtml(item.userAnswer)}</strong>`
        : `<strong style="color:#b42318;"><em style="color:#8a94a3;">Not answered</em></strong>`;

      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border:1px solid #f3cfcf;border-radius:10px;background:#fff6f6;"><tr><td style="padding:12px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:20px;font-weight:700;color:${COLORS.textMain};">Q${item.num}. ${escapeHtml(item.question)}</td><td valign="top" align="right" width="110" style="width:110px;padding-left:8px;">${chipHtml}</td></tr></table>
<div style="margin-top:8px;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.textMuted};">Your answer: ${yourAnswerHtml}</div>
<div style="margin-top:2px;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.textMuted};">Correct answer: <strong style="color:#13804f;">${escapeHtml(item.correctAnswer)}</strong></div></td></tr></table>`;
    }).join('');

    wrongSectionHtml = `<div style="margin-top:24px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.textSubtle};">Wrong / not answered (${wrongOrUnanswered.length})</div>${wrongRows}`;
  }

  // Render Correct section
  let correctSectionHtml = '';
  if (correctList.length > 0) {
    const correctRows = correctList.map((item) => {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border:1px solid #c9ead8;border-radius:10px;background:#f4fbf7;"><tr><td style="padding:12px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:20px;font-weight:700;color:${COLORS.textMain};">Q${item.num}. ${escapeHtml(item.question)}</td><td valign="top" align="right" width="110" style="width:110px;padding-left:8px;"><span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#e6f6ee;color:#13804f;font-size:12px;font-weight:800;">&#10003; Correct</span></td></tr></table>
<div style="margin-top:8px;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.textMuted};">Your answer: <strong style="color:#13804f;">${escapeHtml(item.userAnswer)}</strong></div></td></tr></table>`;
    }).join('');

    correctSectionHtml = `<div style="margin-top:24px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.textSubtle};">Correct (${correctList.length})</div>${correctRows}`;
  }

  // Closing Notice
  const closingHtml = passed
    ? `<p style="margin:22px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;line-height:21px;color:${COLORS.textMuted};">Our team will now review your profile. We will email you once it is approved.</p>`
    : `<p style="margin:22px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;line-height:21px;color:${COLORS.textMuted};">You can request a new test from the test page using <strong>Request reschedule</strong>.</p>`;

  // Status Pill
  const statusPillHtml = passed
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#e6f6ee" style="padding:5px 12px;border-radius:20px;background:#e6f6ee;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#13804f;">&#10003;&nbsp; Test passed</td></tr></table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#fde8e8" style="padding:5px 12px;border-radius:20px;background:#fde8e8;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#b42318;">&#10007;&nbsp; Test not passed</td></tr></table>`;

  const bodyHtml = `
    ${statusPillHtml}

    <h1 style="margin:14px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:22px;line-height:29px;font-weight:800;color:${COLORS.textMain};">Your test response sheet</h1>

    ${greetingHtml}

    ${scoreBoxHtml}

    ${detailsTableHtml}

    ${wrongSectionHtml}

    ${correctSectionHtml}

    ${closingHtml}
  `;

  const { html, attachments } = renderEmailLayout({
    title: subject,
    preheader,
    bodyHtml,
    showSupport: true,
    tagline: 'Advocate Partner'
  });

  // Plain-text version
  const textLines = [
    subject,
    '',
    `Dear ${formattedName},`,
    'Thank you for taking the VakeelSetu advocate qualification test. Here is a summary of your attempt and your answers.',
    '',
    `Result: ${passed ? 'PASSED' : 'NOT PASSED'}`,
    `Score: ${correctCount} Correct / ${wrongCount} Wrong / ${totalQuestions} Total`,
    '',
    'Attempt Details:',
    `- Name: ${formattedName}`,
    `- Bar Council ID: ${barCouncilId || '—'}`,
    `- Test date & time: ${dateStr}, ${timeStr}`,
    `- Attempt: Attempt ${attemptNumber}`,
    `- Time taken: ${timeTakenStr}`,
    `- Submitted: ${submittedStr}`,
    `- Result: ${passed ? 'Passed' : 'Not passed'}`,
    ''
  ];

  if (wrongOrUnanswered.length > 0) {
    textLines.push(`--- Wrong / not answered (${wrongOrUnanswered.length}) ---`);
    wrongOrUnanswered.forEach((item) => {
      const statusLabel = item.isAnswered ? 'Wrong' : 'Not answered';
      textLines.push(`Q${item.num}. ${item.question} [${statusLabel}]`);
      textLines.push(`   Your answer: ${item.userAnswer || 'Not answered'}`);
      textLines.push(`   Correct answer: ${item.correctAnswer}`);
    });
    textLines.push('');
  }

  if (correctList.length > 0) {
    textLines.push(`--- Correct (${correctList.length}) ---`);
    correctList.forEach((item) => {
      textLines.push(`Q${item.num}. ${item.question} [Correct]`);
      textLines.push(`   Your answer: ${item.userAnswer}`);
    });
    textLines.push('');
  }

  textLines.push(passed
    ? 'Our team will now review your profile. We will email you once it is approved.'
    : 'You can request a new test from the test page using Request reschedule.');

  const text = textLines.join('\n');

  return { subject, html, text, attachments };
};

/**
 * Generates Test Response Sheet email sent to advocate after every test attempt.
 *
 * @param {object} params
 * @param {object} params.attempt The AdvocateTestAttempt record with snapshot questions & answers
 * @param {object} [params.advocate] The Advocate record
 * @param {number} [params.attemptNumber=1] 1-based attempt sequence number
 * @param {number} [params.durationMinutes=20] Test duration in minutes for capping time taken
 * @returns {{ subject: string, html: string, text: string, attachments: Array }}
 */
export const advocateTestResponseSheetTemplate = ({
  attempt = {},
  advocate = {},
  attemptNumber = 1,
  durationMinutes = 20
} = {}) => {
  const passed = Boolean(attempt.passed);
  const correctCount = attempt.correctCount ?? 0;
  const wrongCount = attempt.wrongCount ?? 0;
  const totalQuestions = attempt.totalQuestions ?? (correctCount + wrongCount);

  const subject = passed
    ? `Your VakeelSetu test result – Passed (${correctCount}/${totalQuestions})`
    : `Your VakeelSetu test result – Not passed (${correctCount}/${totalQuestions})`;

  const preheader = passed
    ? `Test passed with ${correctCount}/${totalQuestions} correct. View your response sheet.`
    : `Test not passed with ${correctCount}/${totalQuestions} correct. View your response sheet.`;

  const rawName = (advocate.fullName || '').trim();
  const formattedName = rawName
    ? (rawName.startsWith('Adv.') || rawName.startsWith('Adv ') ? rawName : `Adv. ${rawName}`)
    : 'Advocate';

  const barCouncilId = (advocate.barCouncilId || '').trim();

  const startedAt = attempt.startedAt ? new Date(attempt.startedAt) : new Date();
  const submittedAt = attempt.submittedAt ? new Date(attempt.submittedAt) : startedAt;
  const dateStr = formatSubmittedDateIst(startedAt);
  const timeStr = formatSubmittedTimeIst(startedAt);

  // Time taken calculation capped at test duration
  const maxDurationSeconds = durationMinutes * 60;
  const diffSeconds = Math.max(0, Math.floor((submittedAt.getTime() - startedAt.getTime()) / 1000));
  const cappedSeconds = Math.min(diffSeconds, maxDurationSeconds);
  const minutes = Math.floor(cappedSeconds / 60);
  const seconds = cappedSeconds % 60;
  const timeTakenStr = `${minutes} min ${seconds} sec`;

  const autoSubmitted = Boolean(attempt.autoSubmitted);
  const submittedStr = autoSubmitted ? 'Automatically (time over)' : 'By you';

  // Greeting
  const greetingHtml = `<p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">Dear <strong style="color:${COLORS.textMain};">${escapeHtml(formattedName)}</strong>,<br/>Thank you for taking the VakeelSetu advocate qualification test. Here is a summary of your attempt and your answers.</p>`;

  // Score Box
  const scoreBoxHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-radius:12px;background:${COLORS.primary};"><tr>
<td align="center" width="33%" style="padding:16px 8px;font-family:'Segoe UI',Arial,sans-serif;"><div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Correct</div><div style="margin-top:4px;font-size:26px;font-weight:800;color:#ffffff;">${correctCount}</div></td>
<td align="center" width="33%" style="padding:16px 8px;font-family:'Segoe UI',Arial,sans-serif;border-left:1px solid rgba(255,255,255,0.12);"><div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Wrong</div><div style="margin-top:4px;font-size:26px;font-weight:800;color:#ffffff;">${wrongCount}</div></td>
<td align="center" width="33%" style="padding:16px 8px;font-family:'Segoe UI',Arial,sans-serif;border-left:1px solid rgba(255,255,255,0.12);"><div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Total</div><div style="margin-top:4px;font-size:26px;font-weight:800;color:#ffffff;">${totalQuestions}</div></td></tr></table>`;

  // Details Table
  const resultChipHtml = passed
    ? `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#e6f6ee;color:#13804f;font-size:12px;font-weight:800;">Passed</span>`
    : `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#fde8e8;color:#b42318;font-size:12px;font-weight:800;">Not passed</span>`;

  const detailsTableHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border:1px solid ${COLORS.border};border-radius:12px;border-collapse:separate;background:${COLORS.boxLight};"><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Name</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(formattedName)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Bar Council ID</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Courier New',monospace;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(barCouncilId || '—')}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Test date &amp; time</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(dateStr)}, ${escapeHtml(timeStr)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Attempt</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">Attempt ${escapeHtml(attemptNumber)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Time taken</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(timeTakenStr)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Submitted</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(submittedStr)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Result</td><td class="detail-value" align="right" style="padding:12px 18px;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${resultChipHtml}</td></tr></table>`;

  // Question Analysis (from snapshot)
  const questionsSnapshot = Array.isArray(attempt.questions) ? attempt.questions : [];
  const answersList = Array.isArray(attempt.answers) ? attempt.answers : [];

  const answerMap = new Map();
  answersList.forEach((ans) => {
    if (ans && ans.index !== undefined) {
      answerMap.set(Number(ans.index), ans.selected ? String(ans.selected).trim().toUpperCase() : null);
    }
  });

  const wrongOrUnanswered = [];
  const correctList = [];

  questionsSnapshot.forEach((q, idx) => {
    const selectedKey = answerMap.get(idx);
    const selectedIndex = selectedKey ? selectedKey.charCodeAt(0) - 65 : -1;
    const isAnswered = selectedKey !== null && selectedKey !== undefined && selectedIndex >= 0 && Array.isArray(q.options) && selectedIndex < q.options.length;
    const isCorrect = isAnswered && selectedIndex === q.correctIndex;

    const userAnswer = isAnswered ? q.options[selectedIndex] : null;
    const correctAnswer = Array.isArray(q.options) && q.options[q.correctIndex] !== undefined ? q.options[q.correctIndex] : '';

    const itemData = {
      num: idx + 1,
      question: q.question || '',
      isAnswered,
      isCorrect,
      userAnswer,
      correctAnswer
    };

    if (isCorrect) {
      correctList.push(itemData);
    } else {
      wrongOrUnanswered.push(itemData);
    }
  });

  // Render Wrong / Not Answered section
  let wrongSectionHtml = '';
  if (wrongOrUnanswered.length > 0) {
    const wrongRows = wrongOrUnanswered.map((item) => {
      const chipHtml = item.isAnswered
        ? `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#fde8e8;color:#b42318;font-size:12px;font-weight:800;">&#10007; Wrong</span>`
        : `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#eef0f3;color:#5b6472;font-size:12px;font-weight:800;">Not answered</span>`;

      const yourAnswerHtml = item.isAnswered
        ? `<strong style="color:#b42318;">${escapeHtml(item.userAnswer)}</strong>`
        : `<strong style="color:#b42318;"><em style="color:#8a94a3;">Not answered</em></strong>`;

      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border:1px solid #f3cfcf;border-radius:10px;background:#fff6f6;"><tr><td style="padding:12px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:20px;font-weight:700;color:${COLORS.textMain};">Q${item.num}. ${escapeHtml(item.question)}</td><td valign="top" align="right" width="110" style="width:110px;padding-left:8px;">${chipHtml}</td></tr></table>
<div style="margin-top:8px;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.textMuted};">Your answer: ${yourAnswerHtml}</div>
<div style="margin-top:2px;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.textMuted};">Correct answer: <strong style="color:#13804f;">${escapeHtml(item.correctAnswer)}</strong></div></td></tr></table>`;
    }).join('');

    wrongSectionHtml = `<div style="margin-top:24px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.textSubtle};">Wrong / not answered (${wrongOrUnanswered.length})</div>${wrongRows}`;
  }

  // Render Correct section
  let correctSectionHtml = '';
  if (correctList.length > 0) {
    const correctRows = correctList.map((item) => {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border:1px solid #c9ead8;border-radius:10px;background:#f4fbf7;"><tr><td style="padding:12px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:20px;font-weight:700;color:${COLORS.textMain};">Q${item.num}. ${escapeHtml(item.question)}</td><td valign="top" align="right" width="110" style="width:110px;padding-left:8px;"><span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#e6f6ee;color:#13804f;font-size:12px;font-weight:800;">&#10003; Correct</span></td></tr></table>
<div style="margin-top:8px;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.textMuted};">Your answer: <strong style="color:#13804f;">${escapeHtml(item.userAnswer)}</strong></div></td></tr></table>`;
    }).join('');

    correctSectionHtml = `<div style="margin-top:24px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.textSubtle};">Correct (${correctList.length})</div>${correctRows}`;
  }

  // Closing Notice
  const closingHtml = passed
    ? `<p style="margin:22px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;line-height:21px;color:${COLORS.textMuted};">Our team will now review your profile. We will email you once it is approved.</p>`
    : `<p style="margin:22px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;line-height:21px;color:${COLORS.textMuted};">You can request a new test from the test page using <strong>Request reschedule</strong>.</p>`;

  // Status Pill
  const statusPillHtml = passed
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#e6f6ee" style="padding:5px 12px;border-radius:20px;background:#e6f6ee;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#13804f;">&#10003;&nbsp; Test passed</td></tr></table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#fde8e8" style="padding:5px 12px;border-radius:20px;background:#fde8e8;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#b42318;">&#10007;&nbsp; Test not passed</td></tr></table>`;

  const bodyHtml = `
    ${statusPillHtml}

    <h1 style="margin:14px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:22px;line-height:29px;font-weight:800;color:${COLORS.textMain};">Your test response sheet</h1>

    ${greetingHtml}

    ${scoreBoxHtml}

    ${detailsTableHtml}

    ${wrongSectionHtml}

    ${correctSectionHtml}

    ${closingHtml}
  `;

  const { html, attachments } = renderEmailLayout({
    title: subject,
    preheader,
    bodyHtml,
    showSupport: true,
    tagline: 'Advocate Partner'
  });

  // Plain-text version
  const textLines = [
    subject,
    '',
    `Dear ${formattedName},`,
    'Thank you for taking the VakeelSetu advocate qualification test. Here is a summary of your attempt and your answers.',
    '',
    `Result: ${passed ? 'PASSED' : 'NOT PASSED'}`,
    `Score: ${correctCount} Correct / ${wrongCount} Wrong / ${totalQuestions} Total`,
    '',
    'Attempt Details:',
    `- Name: ${formattedName}`,
    `- Bar Council ID: ${barCouncilId || '—'}`,
    `- Test date & time: ${dateStr}, ${timeStr}`,
    `- Attempt: Attempt ${attemptNumber}`,
    `- Time taken: ${timeTakenStr}`,
    `- Submitted: ${submittedStr}`,
    `- Result: ${passed ? 'Passed' : 'Not passed'}`,
    ''
  ];

  if (wrongOrUnanswered.length > 0) {
    textLines.push(`--- Wrong / not answered (${wrongOrUnanswered.length}) ---`);
    wrongOrUnanswered.forEach((item) => {
      const statusLabel = item.isAnswered ? 'Wrong' : 'Not answered';
      textLines.push(`Q${item.num}. ${item.question} [${statusLabel}]`);
      textLines.push(`   Your answer: ${item.userAnswer || 'Not answered'}`);
      textLines.push(`   Correct answer: ${item.correctAnswer}`);
    });
    textLines.push('');
  }

  if (correctList.length > 0) {
    textLines.push(`--- Correct (${correctList.length}) ---`);
    correctList.forEach((item) => {
      textLines.push(`Q${item.num}. ${item.question} [Correct]`);
      textLines.push(`   Your answer: ${item.userAnswer}`);
    });
    textLines.push('');
  }

  textLines.push(passed
    ? 'Our team will now review your profile. We will email you once it is approved.'
    : 'You can request a new test from the test page using Request reschedule.');

  const text = textLines.join('\n');

  return { subject, html, text, attachments };
};



/**
 * Generates test link email for advocate qualification test (INITIAL or RESCHEDULE).
 *
 * @param {object} params
 * @param {string} [params.name]
 * @param {string} [params.link]
 * @param {Date|string} [params.expiresAt]
 * @param {'INITIAL'|'RESCHEDULE'} [params.reason='INITIAL']
 * @returns {{ subject: string, html: string, text: string, attachments: Array }}
 */
export const advocateTestLinkTemplate = ({
  name = '',
  link = '',
  expiresAt = new Date(),
  reason = 'INITIAL'
} = {}) => {
  const isReschedule = String(reason).toUpperCase() === 'RESCHEDULE';
  const subject = isReschedule
    ? 'Your VakeelSetu test has been rescheduled'
    : 'Complete your VakeelSetu advocate test';

  const preheader = '20 questions · 20 minutes · pass with 15 correct';
  const fullName = (name || '').trim();
  const dateStr = formatSubmittedDateIst(expiresAt);
  const timeStr = formatSubmittedTimeIst(expiresAt);

  const introMessage = isReschedule
    ? 'Your advocate qualification test has been rescheduled. Please complete the test using the link below to proceed with your verification on VakeelSetu.'
    : 'Thank you for submitting your profile for verification on VakeelSetu. Before your profile can be approved, you are required to complete a qualification test.';

  const greetingHtml = fullName
    ? `<p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">Dear <strong style="color:${COLORS.textMain};">${escapeHtml(fullName)}</strong>,<br/>${escapeHtml(introMessage)}</p>`
    : `<p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">${escapeHtml(introMessage)}</p>`;

  // Rules Box
  const rulesBoxHtml = `<!-- rules box -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-radius:12px;background:${COLORS.cardBg};border:1px solid ${COLORS.cardBorder};">
  <tr>
    <td style="padding:16px 20px;font-family:'Segoe UI',Arial,sans-serif;">
      <div style="font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:${COLORS.primary};">Test Rules</div>
      <div style="margin-top:8px;font-size:15px;font-weight:700;color:${COLORS.textMain};">20 questions &middot; 20 minutes &middot; pass with 15 correct</div>
      <p style="margin:8px 0 0;font-size:13px;line-height:20px;color:${COLORS.textMuted};">
        When opening the link, you will be asked to log in with your <strong>Bar Council ID</strong> and <strong>registered phone number</strong>.
      </p>
    </td>
  </tr>
</table>`;

  const buttonHtml = renderButton({
    label: 'Start Test',
    url: link
  });

  const validityNoticeHtml = `
    <p style="margin:24px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:20px;text-align:center;color:${COLORS.textMuted};">
      This link is valid until <strong>${escapeHtml(dateStr)} ${escapeHtml(timeStr)}</strong> (72 hours).
    </p>
  `;

  const bodyHtml = `
    <!-- header badge -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${COLORS.pillAmberBg}" style="padding:5px 12px;border-radius:20px;background:${COLORS.pillAmberBg};font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${COLORS.pillAmberText};">&#9997;&nbsp; Qualification Test</td>
    </tr></table>

    <h1 style="margin:14px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:22px;line-height:29px;font-weight:800;color:${COLORS.textMain};">Advocate Qualification Test</h1>

    ${greetingHtml}

    ${rulesBoxHtml}

    ${buttonHtml}

    ${validityNoticeHtml}

    <p style="margin:20px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.textMuted};">
      Please ensure you have an uninterrupted internet connection for 20 minutes before starting. Once started, the timer cannot be paused.
    </p>
  `;

  const { html, attachments } = renderEmailLayout({
    title: subject,
    preheader,
    bodyHtml,
    showSupport: true,
    tagline: 'Advocate Partner'
  });

  const greetingText = fullName ? `Dear ${fullName},\n\n` : '';
  const text = [
    subject,
    '',
    `${greetingText}${introMessage}`,
    '',
    'Test Rules: 20 questions · 20 minutes · pass with 15 correct',
    'Log in with your Bar Council ID and registered phone number.',
    '',
    `Start your test here: ${link}`,
    '',
    `This link is valid until ${dateStr} ${timeStr} (72 hours).`,
    '',
    'Please ensure you have an uninterrupted internet connection before starting.'
  ].join('\n');

  return { subject, html, text, attachments };
};

/**
 * Generates Test Response Sheet email sent to advocate after every test attempt.
 *
 * @param {object} params
 * @param {object} params.attempt The AdvocateTestAttempt record with snapshot questions & answers
 * @param {object} [params.advocate] The Advocate record
 * @param {number} [params.attemptNumber=1] 1-based attempt sequence number
 * @param {number} [params.durationMinutes=20] Test duration in minutes for capping time taken
 * @returns {{ subject: string, html: string, text: string, attachments: Array }}
 */
export const advocateTestResponseSheetTemplate = ({
  attempt = {},
  advocate = {},
  attemptNumber = 1,
  durationMinutes = 20
} = {}) => {
  const passed = Boolean(attempt.passed);
  const correctCount = attempt.correctCount ?? 0;
  const wrongCount = attempt.wrongCount ?? 0;
  const totalQuestions = attempt.totalQuestions ?? (correctCount + wrongCount);

  const subject = passed
    ? `Your VakeelSetu test result – Passed (${correctCount}/${totalQuestions})`
    : `Your VakeelSetu test result – Not passed (${correctCount}/${totalQuestions})`;

  const preheader = passed
    ? `Test passed with ${correctCount}/${totalQuestions} correct. View your response sheet.`
    : `Test not passed with ${correctCount}/${totalQuestions} correct. View your response sheet.`;

  const rawName = (advocate.fullName || '').trim();
  const formattedName = rawName
    ? (rawName.startsWith('Adv.') || rawName.startsWith('Adv ') ? rawName : `Adv. ${rawName}`)
    : 'Advocate';

  const barCouncilId = (advocate.barCouncilId || '').trim();

  const startedAt = attempt.startedAt ? new Date(attempt.startedAt) : new Date();
  const submittedAt = attempt.submittedAt ? new Date(attempt.submittedAt) : startedAt;
  const dateStr = formatSubmittedDateIst(startedAt);
  const timeStr = formatSubmittedTimeIst(startedAt);

  // Time taken calculation capped at test duration
  const maxDurationSeconds = durationMinutes * 60;
  const diffSeconds = Math.max(0, Math.floor((submittedAt.getTime() - startedAt.getTime()) / 1000));
  const cappedSeconds = Math.min(diffSeconds, maxDurationSeconds);
  const minutes = Math.floor(cappedSeconds / 60);
  const seconds = cappedSeconds % 60;
  const timeTakenStr = `${minutes} min ${seconds} sec`;

  const autoSubmitted = Boolean(attempt.autoSubmitted);
  const submittedStr = autoSubmitted ? 'Automatically (time over)' : 'By you';

  // Greeting
  const greetingHtml = `<p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">Dear <strong style="color:${COLORS.textMain};">${escapeHtml(formattedName)}</strong>,<br/>Thank you for taking the VakeelSetu advocate qualification test. Here is a summary of your attempt and your answers.</p>`;

  // Score Box
  const scoreBoxHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-radius:12px;background:${COLORS.primary};"><tr>
<td align="center" width="33%" style="padding:16px 8px;font-family:'Segoe UI',Arial,sans-serif;"><div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Correct</div><div style="margin-top:4px;font-size:26px;font-weight:800;color:#ffffff;">${correctCount}</div></td>
<td align="center" width="33%" style="padding:16px 8px;font-family:'Segoe UI',Arial,sans-serif;border-left:1px solid rgba(255,255,255,0.12);"><div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Wrong</div><div style="margin-top:4px;font-size:26px;font-weight:800;color:#ffffff;">${wrongCount}</div></td>
<td align="center" width="33%" style="padding:16px 8px;font-family:'Segoe UI',Arial,sans-serif;border-left:1px solid rgba(255,255,255,0.12);"><div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Total</div><div style="margin-top:4px;font-size:26px;font-weight:800;color:#ffffff;">${totalQuestions}</div></td></tr></table>`;

  // Details Table
  const resultChipHtml = passed
    ? `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#e6f6ee;color:#13804f;font-size:12px;font-weight:800;">Passed</span>`
    : `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#fde8e8;color:#b42318;font-size:12px;font-weight:800;">Not passed</span>`;

  const detailsTableHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border:1px solid ${COLORS.border};border-radius:12px;border-collapse:separate;background:${COLORS.boxLight};"><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Name</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(formattedName)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Bar Council ID</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Courier New',monospace;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(barCouncilId || '—')}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Test date &amp; time</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(dateStr)}, ${escapeHtml(timeStr)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Attempt</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">Attempt ${escapeHtml(attemptNumber)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Time taken</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(timeTakenStr)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Submitted</td><td class="detail-value" align="right" style="padding:12px 18px;border-bottom:1px solid ${COLORS.border};font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${escapeHtml(submittedStr)}</td></tr><tr><td class="detail-label" width="45%" style="width:45%;padding:12px 18px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;font-weight:600;color:${COLORS.textSubtle};">Result</td><td class="detail-value" align="right" style="padding:12px 18px;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;font-weight:700;color:${COLORS.textMain};text-align:right;">${resultChipHtml}</td></tr></table>`;

  // Question Analysis (from snapshot)
  const questionsSnapshot = Array.isArray(attempt.questions) ? attempt.questions : [];
  const answersList = Array.isArray(attempt.answers) ? attempt.answers : [];

  const answerMap = new Map();
  answersList.forEach((ans) => {
    if (ans && ans.index !== undefined) {
      answerMap.set(Number(ans.index), ans.selected ? String(ans.selected).trim().toUpperCase() : null);
    }
  });

  const wrongOrUnanswered = [];
  const correctList = [];

  questionsSnapshot.forEach((q, idx) => {
    const selectedKey = answerMap.get(idx);
    const selectedIndex = selectedKey ? selectedKey.charCodeAt(0) - 65 : -1;
    const isAnswered = selectedKey !== null && selectedKey !== undefined && selectedIndex >= 0 && Array.isArray(q.options) && selectedIndex < q.options.length;
    const isCorrect = isAnswered && selectedIndex === q.correctIndex;

    const userAnswer = isAnswered ? q.options[selectedIndex] : null;
    const correctAnswer = Array.isArray(q.options) && q.options[q.correctIndex] !== undefined ? q.options[q.correctIndex] : '';

    const itemData = {
      num: idx + 1,
      question: q.question || '',
      isAnswered,
      isCorrect,
      userAnswer,
      correctAnswer
    };

    if (isCorrect) {
      correctList.push(itemData);
    } else {
      wrongOrUnanswered.push(itemData);
    }
  });

  // Render Wrong / Not Answered section
  let wrongSectionHtml = '';
  if (wrongOrUnanswered.length > 0) {
    const wrongRows = wrongOrUnanswered.map((item) => {
      const chipHtml = item.isAnswered
        ? `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#fde8e8;color:#b42318;font-size:12px;font-weight:800;">&#10007; Wrong</span>`
        : `<span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#eef0f3;color:#5b6472;font-size:12px;font-weight:800;">Not answered</span>`;

      const yourAnswerHtml = item.isAnswered
        ? `<strong style="color:#b42318;">${escapeHtml(item.userAnswer)}</strong>`
        : `<strong style="color:#b42318;"><em style="color:#8a94a3;">Not answered</em></strong>`;

      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border:1px solid #f3cfcf;border-radius:10px;background:#fff6f6;"><tr><td style="padding:12px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:20px;font-weight:700;color:${COLORS.textMain};">Q${item.num}. ${escapeHtml(item.question)}</td><td valign="top" align="right" width="110" style="width:110px;padding-left:8px;">${chipHtml}</td></tr></table>
<div style="margin-top:8px;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.textMuted};">Your answer: ${yourAnswerHtml}</div>
<div style="margin-top:2px;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.textMuted};">Correct answer: <strong style="color:#13804f;">${escapeHtml(item.correctAnswer)}</strong></div></td></tr></table>`;
    }).join('');

    wrongSectionHtml = `<div style="margin-top:24px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.textSubtle};">Wrong / not answered (${wrongOrUnanswered.length})</div>${wrongRows}`;
  }

  // Render Correct section
  let correctSectionHtml = '';
  if (correctList.length > 0) {
    const correctRows = correctList.map((item) => {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;border:1px solid #c9ead8;border-radius:10px;background:#f4fbf7;"><tr><td style="padding:12px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:20px;font-weight:700;color:${COLORS.textMain};">Q${item.num}. ${escapeHtml(item.question)}</td><td valign="top" align="right" width="110" style="width:110px;padding-left:8px;"><span style="display:inline-block;padding:3px 10px;border-radius:12px;background:#e6f6ee;color:#13804f;font-size:12px;font-weight:800;">&#10003; Correct</span></td></tr></table>
<div style="margin-top:8px;font-family:'Segoe UI',Arial,sans-serif;font-size:12.5px;line-height:19px;color:${COLORS.textMuted};">Your answer: <strong style="color:#13804f;">${escapeHtml(item.userAnswer)}</strong></div></td></tr></table>`;
    }).join('');

    correctSectionHtml = `<div style="margin-top:24px;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.textSubtle};">Correct (${correctList.length})</div>${correctRows}`;
  }

  // Closing Notice
  const closingHtml = passed
    ? `<p style="margin:22px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;line-height:21px;color:${COLORS.textMuted};">Our team will now review your profile. We will email you once it is approved.</p>`
    : `<p style="margin:22px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13.5px;line-height:21px;color:${COLORS.textMuted};">You can request a new test from the test page using <strong>Request reschedule</strong>.</p>`;

  // Status Pill
  const statusPillHtml = passed
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#e6f6ee" style="padding:5px 12px;border-radius:20px;background:#e6f6ee;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#13804f;">&#10003;&nbsp; Test passed</td></tr></table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#fde8e8" style="padding:5px 12px;border-radius:20px;background:#fde8e8;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#b42318;">&#10007;&nbsp; Test not passed</td></tr></table>`;

  const bodyHtml = `
    ${statusPillHtml}

    <h1 style="margin:14px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:22px;line-height:29px;font-weight:800;color:${COLORS.textMain};">Your test response sheet</h1>

    ${greetingHtml}

    ${scoreBoxHtml}

    ${detailsTableHtml}

    ${wrongSectionHtml}

    ${correctSectionHtml}

    ${closingHtml}
  `;

  const { html, attachments } = renderEmailLayout({
    title: subject,
    preheader,
    bodyHtml,
    showSupport: true,
    tagline: 'Advocate Partner'
  });

  // Plain-text version
  const textLines = [
    subject,
    '',
    `Dear ${formattedName},`,
    'Thank you for taking the VakeelSetu advocate qualification test. Here is a summary of your attempt and your answers.',
    '',
    `Result: ${passed ? 'PASSED' : 'NOT PASSED'}`,
    `Score: ${correctCount} Correct / ${wrongCount} Wrong / ${totalQuestions} Total`,
    '',
    'Attempt Details:',
    `- Name: ${formattedName}`,
    `- Bar Council ID: ${barCouncilId || '—'}`,
    `- Test date & time: ${dateStr}, ${timeStr}`,
    `- Attempt: Attempt ${attemptNumber}`,
    `- Time taken: ${timeTakenStr}`,
    `- Submitted: ${submittedStr}`,
    `- Result: ${passed ? 'Passed' : 'Not passed'}`,
    ''
  ];

  if (wrongOrUnanswered.length > 0) {
    textLines.push(`--- Wrong / not answered (${wrongOrUnanswered.length}) ---`);
    wrongOrUnanswered.forEach((item) => {
      const statusLabel = item.isAnswered ? 'Wrong' : 'Not answered';
      textLines.push(`Q${item.num}. ${item.question} [${statusLabel}]`);
      textLines.push(`   Your answer: ${item.userAnswer || 'Not answered'}`);
      textLines.push(`   Correct answer: ${item.correctAnswer}`);
    });
    textLines.push('');
  }

  if (correctList.length > 0) {
    textLines.push(`--- Correct (${correctList.length}) ---`);
    correctList.forEach((item) => {
      textLines.push(`Q${item.num}. ${item.question} [Correct]`);
      textLines.push(`   Your answer: ${item.userAnswer}`);
    });
    textLines.push('');
  }

  textLines.push(passed
    ? 'Our team will now review your profile. We will email you once it is approved.'
    : 'You can request a new test from the test page using Request reschedule.');

  const text = textLines.join('\n');

  return { subject, html, text, attachments };
};



