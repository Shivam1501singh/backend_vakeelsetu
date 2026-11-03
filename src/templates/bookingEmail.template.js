import {
  escapeHtml,
  renderDetailRows,
  renderButton,
  renderNote,
  renderEmailLayout,
  COLORS
} from './emailLayout.template.js';

/**
 * Formats paise into Indian Rupee notation with 2 decimals (e.g. ₹510.00).
 * Never recalculates; strictly uses stored snapshot values.
 * @param {number} paise
 * @returns {string}
 */
export const formatRupees = (paise) => {
  const amount = Number(paise || 0) / 100;
  return `₹${amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
};

/**
 * Returns formatted IST date string and time range from startAt & endAt.
 * @param {Date|string} startAt
 * @param {Date|string} endAt
 * @returns {{ dateStr: string, timeRangeStr: string, formattedRange: string }}
 */
export const formatBookingDateTimeIst = (startAt, endAt) => {
  const startDate = new Date(startAt);
  const endDate = new Date(endAt);

  const rawDateStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(startDate);

  // Normalize 'Sat, 7 Nov, 2026' -> 'Sat, 7 Nov 2026' (match demo style)
  const dateStr = rawDateStr.replace(/,\s*(\d{4})/, ' $1');

  const timeFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const startTimeStr = timeFormatter.format(startDate).toUpperCase();
  const endTimeStr = timeFormatter.format(endDate).toUpperCase();
  const timeRangeStr = `${startTimeStr} – ${endTimeStr}`;

  return {
    dateStr,
    timeRangeStr,
    formattedRange: `${dateStr} · ${timeRangeStr} IST`
  };
};

/**
 * Maps AdvocateBookingMode enum to human-friendly display label.
 * @param {string} mode
 */
export const getModeLabel = (mode = '') => {
  switch (String(mode).toUpperCase()) {
    case 'VOICE_CALL':
      return 'Voice call';
    case 'VIDEO_CALL':
      return 'Video call';
    case 'IN_PERSON':
      return 'In-person consultation';
    default:
      return 'Consultation';
  }
};

/**
 * Resolves the frontend URL with path fallback.
 * @param {'USER'|'ADVOCATE'} type
 * @returns {string}
 */
const getBookingDashboardUrl = (type = 'USER') => {
  const clientBase = (process.env.WEB_CLIENT_URL || process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/+$/, '');
  if (type === 'ADVOCATE') {
    if (process.env.FRONTEND_MY_APPOINTMENTS_URL?.trim()) {
      return process.env.FRONTEND_MY_APPOINTMENTS_URL.trim();
    }
    const path = (process.env.FRONTEND_MY_APPOINTMENTS_PATH || '/my-appointments').replace(/^\/?/, '/');
    return `${clientBase}${path}`;
  }

  if (process.env.FRONTEND_MY_BOOKINGS_URL?.trim()) {
    return process.env.FRONTEND_MY_BOOKINGS_URL.trim();
  }
  const path = (process.env.FRONTEND_MY_BOOKINGS_PATH || '/my-bookings').replace(/^\/?/, '/');
  return `${clientBase}${path}`;
};

/**
 * 1. Template: Booking confirmed – sent to USER.
 *
 * @param {object} params
 * @param {object} params.booking AdvocateBooking object (including stored fee snapshot & relations)
 * @param {object} [params.payment] Payment object (with attempts for payment ID display)
 * @returns {{ subject: string, html: string, text: string, attachments: Array }}
 */
export const bookingConfirmedUserTemplate = ({ booking, payment } = {}) => {
  if (!booking) throw new Error('booking object is required');

  const { dateStr, timeRangeStr } = formatBookingDateTimeIst(booking.startAt, booking.endAt);
  const modeLabel = getModeLabel(booking.mode);
  const durationText = `${modeLabel} · ${booking.durationMinutes} min`;
  const subject = `Booking confirmed – ${booking.advocateName}, ${dateStr} ${timeRangeStr} IST`;
  const preheader = `Your consultation with ${booking.advocateName} on ${dateStr} is confirmed.`;

  // Payment ID extraction (prefer captured razorpayPaymentId from attempts, else payment.id)
  let paymentIdDisplay = '';
  if (payment) {
    const capturedAttempt = payment.attempts?.find((a) => a.status === 'CAPTURED' || a.status === 'DUPLICATE_REFUNDED');
    paymentIdDisplay = capturedAttempt?.razorpayPaymentId || payment.id || '';
  }

  // Build detail rows
  const detailRows = [
    { label: 'Advocate', value: booking.advocateName },
    { label: 'Mode', value: durationText },
    { label: 'Consultation fee', value: formatRupees(booking.feePaise) },
    { label: `GST (${booking.gstPercent || 18}%)`, value: formatRupees(booking.gstPaise) },
    { label: 'Platform fee', value: formatRupees(booking.platformFeePaise) },
    { label: 'Total paid', value: formatRupees(booking.totalPaise), isHighlighted: true },
  ];

  // In-person specific: add office address and optional Google Maps link
  if (booking.mode === 'IN_PERSON') {
    const advocate = booking.advocate || {};
    const officeAddr = advocate.officeAddress || advocate.completeAddress;
    if (officeAddr && officeAddr.trim()) {
      detailRows.push({ label: 'Office address', value: officeAddr.trim() });

      let mapsUrl = '';
      if (advocate.officeLatitude && advocate.officeLongitude) {
        mapsUrl = `https://www.google.com/maps/search/?api=1&query=${advocate.officeLatitude},${advocate.officeLongitude}`;
      } else {
        mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(officeAddr.trim())}`;
      }

      detailRows.push({
        label: 'Directions',
        value: `<a href="${escapeHtml(mapsUrl)}" style="color:${COLORS.accentDark};font-weight:700;text-decoration:none;">View on Google Maps &rarr;</a>`,
        rawHtml: true
      });
    }
  }

  const bookingsUrl = getBookingDashboardUrl('USER');
  const footnoteText = paymentIdDisplay
    ? `Please keep your phone reachable at the booked time. Payment ID: ${paymentIdDisplay}`
    : 'Please keep your phone reachable at the booked time.';

  const bodyHtml = `
    <!-- status pill -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${COLORS.pillGreenBg}" style="padding:5px 12px;border-radius:20px;background:${COLORS.pillGreenBg};font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${COLORS.pillGreenText};">&#10003;&nbsp; Booking confirmed</td>
    </tr></table>

    <h1 style="margin:14px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:22px;line-height:29px;font-weight:800;color:${COLORS.textMain};">Your consultation is booked</h1>
    <p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">Dear <strong style="color:${COLORS.textMain};">${escapeHtml(booking.userName)}</strong>,<br/>Your payment was successful and your booking with <strong>${escapeHtml(booking.advocateName)}</strong> is confirmed. The advocate will contact you at the booked time.</p>

    <!-- reference box -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-radius:12px;background:${COLORS.primary};"><tr>
      <td style="padding:14px 18px;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Booking ID</div>
        <div style="margin-top:4px;font-family:'Courier New',monospace;font-size:20px;font-weight:800;letter-spacing:1px;color:#ffffff;">${escapeHtml(booking.bookingId || '')}</div>
      </td>
      <td align="right" style="padding:14px 18px;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">When</div>
        <div style="margin-top:4px;font-size:14px;font-weight:700;color:#ffffff;">${escapeHtml(dateStr)}<br/>${escapeHtml(timeRangeStr)} IST</div>
      </td>
    </tr></table>

    ${renderDetailRows(detailRows)}

    ${renderButton({ label: 'View My Bookings', url: bookingsUrl })}

    ${renderNote(footnoteText)}
  `;

  const { html, attachments } = renderEmailLayout({
    title: subject,
    preheader,
    bodyHtml,
    showSupport: true
  });

  const text = `Booking confirmed – ${booking.advocateName}\n\nDear ${booking.userName},\nYour payment was successful and your booking with ${booking.advocateName} is confirmed.\n\nBooking ID: ${booking.bookingId}\nWhen: ${dateStr}, ${timeRangeStr} IST\nMode: ${durationText}\nTotal Paid: ${formatRupees(booking.totalPaise)}\n\nView your bookings: ${bookingsUrl}\n\n${footnoteText}`;

  return { subject, html, text, attachments };
};

/**
 * 2. Template: New appointment – sent to ADVOCATE.
 *
 * @param {object} params
 * @param {object} params.booking AdvocateBooking object (including client contact & advocate fee snapshot)
 * @returns {{ subject: string, html: string, text: string, attachments: Array }}
 */
export const newAppointmentAdvocateTemplate = ({ booking } = {}) => {
  if (!booking) throw new Error('booking object is required');

  const { dateStr, timeRangeStr } = formatBookingDateTimeIst(booking.startAt, booking.endAt);
  const modeLabel = getModeLabel(booking.mode);
  const subject = `New appointment – ${dateStr} ${timeRangeStr} IST (${modeLabel})`;
  const preheader = `A client has booked a ${modeLabel} for ${dateStr} at ${timeRangeStr} IST.`;

  const cleanPhone = String(booking.userPhone || '').trim();
  const phoneHtml = cleanPhone
    ? `<a href="tel:${escapeHtml(cleanPhone.replace(/\s+/g, ''))}" style="color:${COLORS.textMain};text-decoration:none;">${escapeHtml(cleanPhone)}</a>`
    : '';

  const detailRows = [
    { label: 'Client name', value: booking.userName },
    { label: 'Client phone', value: phoneHtml, rawHtml: true },
    { label: 'Client email', value: booking.userEmail },
    { label: 'Booking ID', value: booking.bookingId, isMono: true },
    { label: 'Your consultation fee', value: formatRupees(booking.feePaise), isHighlighted: true },
  ];

  const appointmentsUrl = getBookingDashboardUrl('ADVOCATE');
  const footnoteText = "The client's contact details are shared only for this consultation. Please don't use them for any other purpose.";

  const bodyHtml = `
    <!-- status pill -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${COLORS.pillAmberBg}" style="padding:5px 12px;border-radius:20px;background:${COLORS.pillAmberBg};font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${COLORS.pillAmberText};">&#128197;&nbsp; New appointment</td>
    </tr></table>

    <h1 style="margin:14px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:22px;line-height:29px;font-weight:800;color:${COLORS.textMain};">A client has booked you</h1>
    <p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">Dear <strong style="color:${COLORS.textMain};">${escapeHtml(booking.advocateName)}</strong>,<br/>You have a new paid booking on VakeelSetu. Please contact the client at the booked time and mark the appointment as completed after the consultation.</p>

    <!-- reference box -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-radius:12px;background:${COLORS.primary};"><tr>
      <td style="padding:14px 18px;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">${escapeHtml(modeLabel)} &middot; ${booking.durationMinutes} min</div>
        <div style="margin-top:4px;font-size:17px;font-weight:800;color:#ffffff;">${escapeHtml(dateStr)} &middot; ${escapeHtml(timeRangeStr)} IST</div>
      </td>
    </tr></table>

    ${renderDetailRows(detailRows)}

    ${renderButton({ label: 'Open My Appointments', url: appointmentsUrl })}

    ${renderNote(footnoteText)}
  `;

  const { html, attachments } = renderEmailLayout({
    title: subject,
    preheader,
    bodyHtml,
    showSupport: true,
    tagline: 'Advocate Partner'
  });

  const text = `New appointment – ${dateStr} ${timeRangeStr} IST (${modeLabel})\n\nDear ${booking.advocateName},\nYou have a new paid booking on VakeelSetu.\n\nWhen: ${dateStr}, ${timeRangeStr} IST\nMode: ${modeLabel} · ${booking.durationMinutes} min\nClient: ${booking.userName} (${booking.userPhone}, ${booking.userEmail})\nBooking ID: ${booking.bookingId}\nYour Consultation Fee: ${formatRupees(booking.feePaise)}\n\nOpen My Appointments: ${appointmentsUrl}\n\n${footnoteText}`;

  return { subject, html, text, attachments };
};

/**
 * Returns a formatted date and time in Asia/Kolkata timezone (e.g. 3 Nov 2026, 2:45 PM IST).
 * @param {Date|string} dateInput
 * @returns {string}
 */
export const formatDateTimeIst = (dateInput) => {
  if (!dateInput) return '';
  const date = new Date(dateInput);
  if (isNaN(date.getTime())) return '';

  const rawDateStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date);

  const datePart = rawDateStr.replace(/,\s*(\d{4})/, ' $1');

  const timePart = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date).toUpperCase();

  return `${datePart}, ${timePart} IST`;
};

/**
 * Returns formatted date only in Asia/Kolkata timezone (e.g. 12 Nov 2026).
 * @param {Date|string} dateInput
 * @returns {string}
 */
export const formatDateOnlyIst = (dateInput) => {
  if (!dateInput) return '';
  const date = new Date(dateInput);
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
 * Maps ConsultancyCallType enum to human-friendly display label.
 * @param {string} callType
 * @returns {string}
 */
export const getConsultancyCallTypeLabel = (callType = '') => {
  switch (String(callType).toUpperCase()) {
    case 'VIDEO_CALL':
    case 'VIDEO':
      return 'Video Call';
    case 'CALL':
    case 'VOICE_CALL':
    case 'VOICE':
      return 'Call';
    default:
      return callType ? String(callType).replace(/_/g, ' ') : 'Consultation';
  }
};

/**
 * 3. Template: Consultancy booked – sent to the USER (Demo A).
 *
 * @param {object} params
 * @param {object} params.consultancy ConsultancyRequest object (with user, bookingId, duration, etc.)
 * @param {object} [params.payment] Associated Payment object (with amount, paidAt, refundEligibleAt, attempts)
 * @param {string} [params.userName] User full name override
 * @returns {{ subject: string, html: string, text: string, attachments: Array }}
 */
export const consultancyBookedUserTemplate = ({ consultancy, payment, userName } = {}) => {
  if (!consultancy && !payment) {
    throw new Error('Either consultancy or payment object is required');
  }

  const callType = consultancy?.callType || payment?.callType || 'CALL';
  const callTypeLabel = getConsultancyCallTypeLabel(callType);
  const duration = consultancy?.duration || payment?.duration || 15;
  const bookingId = consultancy?.bookingId || '—';

  const subject = `Consultancy booked – ${callTypeLabel} • ${duration} min`;
  const preheader = `Booking ${bookingId} confirmed. Our team will contact you shortly.`;

  const resolvedName = (userName || consultancy?.user?.fullName || '').trim();
  const safeName = escapeHtml(resolvedName);
  const safeCallTypeLabel = escapeHtml(callTypeLabel);
  const safeDuration = escapeHtml(duration);

  const introHtml = safeName
    ? `Dear <strong style="color:${COLORS.textMain};">${safeName}</strong>,<br/>Thank you for your payment. Your <strong>${safeCallTypeLabel} Consultation (${safeDuration} min)</strong> is confirmed. Our legal expert team will contact you shortly on the number below.`
    : `Thank you for your payment. Your <strong>${safeCallTypeLabel} Consultation (${safeDuration} min)</strong> is confirmed. Our legal expert team will contact you shortly on the number below.`;

  const phone = (consultancy?.phoneNumber || payment?.phoneNumber || consultancy?.user?.phone || '').trim();
  const phoneHtml = phone
    ? `<a href="tel:${escapeHtml(phone.replace(/\s+/g, ''))}" style="color:${COLORS.textMain};text-decoration:none;">${escapeHtml(phone)}</a>`
    : '';

  const email = (consultancy?.email || payment?.email || consultancy?.user?.email || '').trim();
  const bookedOn = formatDateTimeIst(payment?.paidAt || consultancy?.createdAt || new Date());

  const latestAttempt = payment?.attempts && Array.isArray(payment.attempts) && payment.attempts.length > 0
    ? payment.attempts[0]
    : null;
  const paymentId = latestAttempt?.razorpayPaymentId || payment?.id || '—';

  // Amount in paise
  const amountPaise = payment?.amount !== undefined && payment?.amount !== null
    ? payment.amount
    : (consultancy?.price ? Math.round(Number(consultancy.price) * 100) : 0);

  const detailRows = [
    { label: 'Contact phone', value: phoneHtml, rawHtml: true },
    { label: 'Contact email', value: email },
    { label: 'Booked on', value: bookedOn },
    { label: 'Payment ID', value: paymentId, isMono: true },
    { label: 'Amount paid', value: formatRupees(amountPaise), isHighlighted: true },
  ];

  const dashboardUrl = getBookingDashboardUrl('USER');

  const bodyHtml = `
    <!-- status pill -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${COLORS.pillGreenBg}" style="padding:5px 12px;border-radius:20px;background:${COLORS.pillGreenBg};font-family:'Segoe UI',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${COLORS.pillGreenText};">&#10003;&nbsp; Consultancy booked</td>
    </tr></table>

    <h1 style="margin:14px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:22px;line-height:29px;font-weight:800;color:${COLORS.textMain};">Your expert consultation is booked</h1>
    <p style="margin:10px 0 0;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.textMuted};">${introHtml}</p>

    <!-- reference box -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;border-radius:12px;background:${COLORS.primary};"><tr>
      <td style="padding:14px 18px;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Booking ID</div>
        <div style="margin-top:4px;font-family:'Courier New',monospace;font-size:20px;font-weight:800;letter-spacing:1px;color:#ffffff;">${escapeHtml(bookingId)}</div>
      </td>
      <td align="right" style="padding:14px 18px;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="font-size:10.5px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${COLORS.accent};">Package</div>
        <div style="margin-top:4px;font-size:14px;font-weight:700;color:#ffffff;">${escapeHtml(callTypeLabel)}<br/>${escapeHtml(duration)} min</div>
      </td>
    </tr></table>

    ${renderDetailRows(detailRows)}

    ${renderButton({ label: 'View My Bookings', url: dashboardUrl })}
  `;

  const { html, attachments } = renderEmailLayout({
    title: subject,
    preheader,
    bodyHtml,
    showSupport: true,
    tagline: 'Bridge to the right advocate'
  });

  const textLines = [
    `${subject}`,
    '',
    resolvedName ? `Dear ${resolvedName},` : '',
    `Thank you for your payment. Your ${callTypeLabel} Consultation (${duration} min) is confirmed. Our legal expert team will contact you shortly on the number below.`,
    '',
    `Booking ID: ${bookingId}`,
    `Package: ${callTypeLabel} (${duration} min)`,
    `Contact phone: ${phone}`,
    `Contact email: ${email}`,
    `Booked on: ${bookedOn}`,
    `Payment ID: ${paymentId}`,
    `Amount paid: ${formatRupees(amountPaise)}`,
    '',
    `View My Bookings: ${dashboardUrl}`
  ].filter((line, idx, arr) => line !== '' || (idx > 0 && arr[idx - 1] !== ''));

  const text = textLines.join('\n').trim();

  return { subject, html, text, attachments };
};

