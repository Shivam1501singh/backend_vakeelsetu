import nodemailer from 'nodemailer';
import prisma from '../lib/prisma.js';
import { getLogoAttachment } from '../templates/emailLayout.template.js';
import { otpEmailTemplate } from '../templates/otpEmail.template.js';
import {
  bookingConfirmedUserTemplate,
  newAppointmentAdvocateTemplate,
  consultancyBookedUserTemplate
} from '../templates/bookingEmail.template.js';
import {
  profileUnderReviewTemplate,
  advocateTestLinkTemplate,
  advocateTestResponseSheetTemplate
} from '../templates/advocateAccountEmail.template.js';
import { helpRequestEmailTemplate } from '../templates/helpRequestEmail.template.js';
import { getTestConfig } from './advocateTest.service.js';
import {
  sendPushNotification,
  sendBookingConfirmedPushNotification,
  sendConsultancyPushNotification
} from './pushNotification.service.js';

let transporterInstance = null;

/**
 * Returns a module-level singleton nodemailer transporter.
 */
export const getTransporter = () => {
  if (!transporterInstance) {
    transporterInstance = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT || '587', 10),
      secure: process.env.EMAIL_PORT === '465',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });
  }
  return transporterInstance;
};

/**
 * Allows injecting a stubbed transporter for unit tests.
 * @param {object|null} mock
 */
export const setTransporter = (mock) => {
  transporterInstance = mock;
};

/**
 * Safely masks email address for structured logging (e.g. ra***@gmail.com).
 * @param {string} email
 * @returns {string}
 */
export const maskEmail = (email = '') => {
  if (!email || typeof email !== 'string') return '***';
  const trimmed = email.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0) return '***';
  const user = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}***@${domain}`;
};

/**
 * Checks whether the current SMTP configuration is a placeholder.
 */
const isPlaceholderCredentials = () => {
  const user = process.env.EMAIL_USER;
  return (
    !user ||
    user === 'your-email@gmail.com' ||
    user === 'your-email@example.com' ||
    user.trim() === ''
  );
};

/**
 * Internal helper to send a branded email.
 * Always merges the CID logo attachment if the logo file exists on disk.
 *
 * @param {object} params
 * @param {string} params.to
 * @param {string|string[]} [params.bcc]
 * @param {string} params.subject
 * @param {string} params.html
 * @param {string} [params.text]
 * @param {Array} [params.attachments=[]]
 * @param {string} [params.emailType='EMAIL']
 * @returns {Promise<boolean>}
 */
export const sendBrandedMail = async ({
  to,
  bcc,
  subject,
  html,
  text,
  attachments = [],
  emailType = 'EMAIL',
  sendPush = false,
  pushTitle = null,
  pushBody = null,
  pushData = {}
}) => {
  const isProd = process.env.NODE_ENV === 'production';

  // Production check: missing or placeholder credentials must throw immediately
  if (isPlaceholderCredentials()) {
    if (isProd) {
      console.error(`[Email Service] Failed: SMTP credentials missing or invalid in production.`);
      throw new Error('Email sending failed. Please check credentials or try again.');
    }
    // Development fallback
    console.log(`[DEV EMAIL SERVICE] ${emailType} to ${maskEmail(to)} suppressed (placeholder credentials in dev)`);

    if (sendPush) {
      sendPushNotification({
        recipientEmail: to,
        title: pushTitle || subject || 'Notification - VakeelSetu',
        body: pushBody || (text ? text.slice(0, 150) : 'You have a new update from VakeelSetu'),
        data: pushData,
        type: emailType
      }).catch((pushErr) => console.error('[Email Service] Push notification trigger error:', pushErr.message));
    }

    return true;
  }

  // Combine provided attachments with the logo CID attachment if not already included
  const finalAttachments = [...attachments];
  const logoAttachment = getLogoAttachment();
  if (logoAttachment && !finalAttachments.some((a) => a.cid === 'vakeelsetu-logo')) {
    finalAttachments.push(logoAttachment);
  }

  const fromAddress = `"VakeelSetu" <${process.env.EMAIL_USER}>`;
  const mailOptions = {
    from: fromAddress,
    to,
    ...(bcc ? { bcc } : {}),
    subject,
    text,
    html,
    attachments: finalAttachments
  };

  const transporter = getTransporter();

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email Service] ${emailType} sent to ${maskEmail(to)} | messageId: ${info?.messageId || 'ok'}`);

    if (sendPush) {
      sendPushNotification({
        recipientEmail: to,
        title: pushTitle || subject || 'Notification - VakeelSetu',
        body: pushBody || (text ? text.slice(0, 150) : 'You have a new update from VakeelSetu'),
        data: pushData,
        type: emailType
      }).catch((pushErr) => console.error('[Email Service] Push notification trigger error:', pushErr.message));
    }

    return true;
  } catch (error) {
    console.error(`[Email Service] ${emailType} failed for ${maskEmail(to)}:`, error.message);
    throw new Error('Email sending failed. Please check credentials or try again.');
  }
};

/**
 * Sends an OTP email. Maintains backward compatibility with `sendEmailOtp(to, otp)`.
 *
 * @param {string} to
 * @param {string|number} otp
 * @param {object} [options={}]
 * @param {string} [options.recipientName]
 * @param {string} [options.purpose='REGISTRATION']
 * @param {number} [options.expiryMinutes]
 * @returns {Promise<boolean>}
 */
export const sendEmailOtp = async (to, otp, options = {}) => {
  const expiryMinutes =
    options.expiryMinutes ||
    parseInt(process.env.OTP_EXPIRY_MINUTES || '5', 10);

  const { subject, html, text, attachments } = otpEmailTemplate({
    otp,
    expiryMinutes,
    recipientName: options.recipientName || '',
    purpose: options.purpose || 'REGISTRATION'
  });

  // In non-production with dummy credentials, log OTP for local development ease
  if (isPlaceholderCredentials()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email sending failed. Please check credentials or try again.');
    }
    console.log(`[DEV EMAIL SERVICE] OTP to ${to}: ${otp}`);
    return true;
  }

  return await sendBrandedMail({
    to,
    subject,
    html,
    text,
    attachments,
    emailType: `OTP_${(options.purpose || 'VERIFICATION').toUpperCase()}`
  });
};

/**
 * Sends booking confirmation emails to both user and advocate.
 * Guarantees exactly-once delivery via atomic row claiming in AdvocateBooking.
 * Never throws an unhandled error so payment / booking flow is never disrupted.
 *
 * @param {string} bookingId AdvocateBooking UUID
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export const sendAdvocateBookingConfirmationEmails = async (bookingId) => {
  if (!bookingId) {
    return { success: false, message: 'bookingId is required' };
  }

  try {
    const booking = await prisma.advocateBooking.findUnique({
      where: { id: bookingId },
      include: {
        user: true,
        advocate: true,
        payment: {
          include: {
            attempts: {
              orderBy: { createdAt: 'desc' }
            }
          }
        }
      }
    });

    if (!booking) {
      console.warn(`[Email Service] AdvocateBooking ${bookingId} not found.`);
      return { success: false, message: 'Booking not found' };
    }

    // 1. User confirmation email
    const userEmail = (booking.userEmail || booking.user?.email || '').trim();
    if (!userEmail) {
      console.info(`[Email Service] Skipping user booking confirmation email for booking ${bookingId}: no email on record.`);
    } else {
      // Claim atomically
      const claimUser = await prisma.advocateBooking.updateMany({
        where: { id: bookingId, userConfirmationEmailSentAt: null },
        data: { userConfirmationEmailSentAt: new Date() }
      });

      if (claimUser.count > 0) {
        try {
          const { subject, html, text, attachments } = bookingConfirmedUserTemplate({
            booking,
            payment: booking.payment
          });

          // ⚡ Trigger push notification to user IMMEDIATELY (concurrently, don't block on SMTP)
          sendBookingConfirmedPushNotification({
            booking,
            recipientType: 'USER'
          }).catch((pushErr) => console.error(`[Email Service] User booking push error for ${bookingId}:`, pushErr.message));

          await sendBrandedMail({
            to: userEmail,
            subject,
            html,
            text,
            attachments,
            emailType: 'BOOKING_CONFIRMED_USER'
          });
        } catch (err) {
          // On failure: reset timestamp back to null so cron can retry
          await prisma.advocateBooking.update({
            where: { id: bookingId },
            data: { userConfirmationEmailSentAt: null }
          }).catch(() => {});
          console.error(`[Email Service] Failed sending user confirmation for booking ${bookingId}:`, err.message);
        }
      }
    }

    // 2. Advocate new appointment email
    const advocateEmail = (booking.advocate?.email || '').trim();
    if (!advocateEmail) {
      console.info(`[Email Service] Skipping advocate booking confirmation email for booking ${bookingId}: no advocate email on record.`);
    } else {
      // Claim atomically
      const claimAdvocate = await prisma.advocateBooking.updateMany({
        where: { id: bookingId, advocateConfirmationEmailSentAt: null },
        data: { advocateConfirmationEmailSentAt: new Date() }
      });

      if (claimAdvocate.count > 0) {
        try {
          const { subject, html, text, attachments } = newAppointmentAdvocateTemplate({
            booking
          });

          // ⚡ Trigger push notification to advocate IMMEDIATELY (concurrently, don't block on SMTP)
          sendBookingConfirmedPushNotification({
            booking,
            recipientType: 'ADVOCATE'
          }).catch((pushErr) => console.error(`[Email Service] Advocate appointment push error for ${bookingId}:`, pushErr.message));

          await sendBrandedMail({
            to: advocateEmail,
            subject,
            html,
            text,
            attachments,
            emailType: 'NEW_APPOINTMENT_ADVOCATE'
          });
        } catch (err) {
          // On failure: reset timestamp back to null so cron can retry
          await prisma.advocateBooking.update({
            where: { id: bookingId },
            data: { advocateConfirmationEmailSentAt: null }
          }).catch(() => {});
          console.error(`[Email Service] Failed sending advocate appointment email for booking ${bookingId}:`, err.message);
        }
      }
    }

    return { success: true };
  } catch (error) {
    console.error(`[Email Service] Unexpected error in sendAdvocateBookingConfirmationEmails for ${bookingId}:`, error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Sends a confirmation email to the user for a paid consultancy request.
 * Follows atomic claim pattern with rollback on failure.
 * Never throws, catches errors and returns { success, message }.
 *
 * @param {string} consultancyRequestId
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export const sendConsultancyConfirmationEmail = async (consultancyRequestId) => {
  if (!consultancyRequestId) {
    return { success: false, message: 'consultancyRequestId is required' };
  }

  try {
    const consultancy = await prisma.consultancyRequest.findUnique({
      where: { id: consultancyRequestId },
      include: {
        user: true,
        payment: {
          include: {
            attempts: {
              orderBy: { createdAt: 'desc' }
            }
          }
        }
      }
    });

    if (!consultancy) {
      console.warn(`[Email Service] ConsultancyRequest ${consultancyRequestId} not found.`);
      return { success: false, message: 'Consultancy not found' };
    }

    // Recipient priority: checkout email, fallback to user account email
    const recipientEmail = (consultancy.email || consultancy.user?.email || '').trim();
    if (!recipientEmail) {
      console.info(`[Email Service] Skipping consultancy confirmation email for ${consultancyRequestId}: no email on record.`);
      return { success: true, message: 'No email on record' };
    }

    // Atomic claim: only one process can claim and send
    const claim = await prisma.consultancyRequest.updateMany({
      where: { id: consultancyRequestId, confirmationEmailSentAt: null },
      data: { confirmationEmailSentAt: new Date() }
    });

    if (claim.count === 0) {
      // Already sent or claimed by another worker/cron
      return { success: true, message: 'Already sent or claimed' };
    }

    try {
      const { subject, html, text, attachments } = consultancyBookedUserTemplate({
        consultancy,
        payment: consultancy.payment,
        userName: consultancy.user?.fullName
      });

      // ⚡ Trigger push notification to user IMMEDIATELY (concurrently, don't block on SMTP)
      sendConsultancyPushNotification({
        consultancy
      }).catch((pushErr) => console.error(`[Email Service] Consultancy push error for ${consultancyRequestId}:`, pushErr.message));

      await sendBrandedMail({
        to: recipientEmail,
        subject,
        html,
        text,
        attachments,
        emailType: 'CONSULTANCY_BOOKED_USER'
      });

      return { success: true };
    } catch (err) {
      // On failure: reset timestamp back to null so cron can retry
      await prisma.consultancyRequest.update({
        where: { id: consultancyRequestId },
        data: { confirmationEmailSentAt: null }
      }).catch(() => {});

      console.error(`[Email Service] Failed sending consultancy confirmation for ${consultancyRequestId}:`, err.message);
      return { success: false, message: err.message };
    }
  } catch (error) {
    console.error(`[Email Service] Unexpected error in sendConsultancyConfirmationEmail for ${consultancyRequestId}:`, error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Sends a "Your profile is under review" email to the advocate when their profile is submitted for verification.
 * Informational only (no retry cron / no DB tracking column).
 * Awaited with an 8-second timeout. Never throws.
 *
 * @param {string} advocateId Advocate UUID
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export const sendProfileUnderReviewEmail = async (advocateId) => {
  if (!advocateId) {
    return { success: false, message: 'advocateId is required' };
  }

  let advocateEmail = '';
  try {
    const advocate = await prisma.advocate.findUnique({
      where: { id: advocateId }
    });

    if (!advocate) {
      console.warn(`[Email Service] Advocate ${advocateId} not found.`);
      return { success: false, message: 'Advocate not found' };
    }

    advocateEmail = (advocate.email || '').trim();
    if (!advocateEmail) {
      console.info(`[Email Service] Skipping profile under review email for advocate ${advocateId}: no email on record.`);
      return { success: true, message: 'No email on record' };
    }

    const { subject, html, text, attachments } = profileUnderReviewTemplate({
      advocate,
      submittedAt: advocate.submittedForApprovalAt || new Date()
    });

    const withTimeout = (promise, ms = 8000) => {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Profile under review email timed out after ${ms}ms`)), ms);
      });
      return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
    };

    await withTimeout(
      sendBrandedMail({
        to: advocateEmail,
        subject,
        html,
        text,
        attachments,
        emailType: 'ADVOCATE_PROFILE_UNDER_REVIEW'
      }),
      8000
    );

    console.log(`[Email Service] ADVOCATE_PROFILE_UNDER_REVIEW sent to ${maskEmail(advocateEmail)} for advocateId: ${advocateId}`);
    return { success: true };
  } catch (error) {
    console.error(`[Email Service] ADVOCATE_PROFILE_UNDER_REVIEW failed for ${maskEmail(advocateEmail)} (advocateId: ${advocateId}):`, error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Resolves the frontend URL with path fallback for Advocate Qualification Test.
 * @param {string} token
 * @returns {string}
 */
export const getAdvocateTestLink = (token) => {
  const clientBase = (process.env.FRONTEND_URL || process.env.WEB_CLIENT_URL || process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/+$/, '');
  const path = (process.env.FRONTEND_ADVOCATE_TEST_PATH || '/advocate-test').replace(/^\/?/, '/');
  return `${clientBase}${path}?token=${encodeURIComponent(token)}`;
};

/**
 * Sends Advocate Qualification Test Link Email (Initial or Reschedule).
 *
 * @param {object} params
 * @param {string} params.advocateId
 * @param {string} params.token Plain secret token (never logged)
 * @param {Date|string} [params.expiresAt]
 * @param {'INITIAL'|'RESCHEDULE'} [params.reason='INITIAL']
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export const sendAdvocateTestLinkEmail = async ({
  advocateId,
  token,
  expiresAt,
  reason = 'INITIAL'
}) => {
  if (!advocateId || !token) {
    return { success: false, message: 'advocateId and token are required' };
  }

  let advocateEmail = '';
  try {
    const advocate = await prisma.advocate.findUnique({
      where: { id: advocateId }
    });

    if (!advocate) {
      console.warn(`[Email Service] Advocate ${advocateId} not found.`);
      return { success: false, message: 'Advocate not found' };
    }

    advocateEmail = (advocate.email || '').trim();
    if (!advocateEmail) {
      console.info(`[Email Service] Skipping advocate test email for ${advocateId}: no email on record.`);
      return { success: true, message: 'No email on record' };
    }

    const link = getAdvocateTestLink(token);
    const { subject, html, text, attachments } = advocateTestLinkTemplate({
      name: advocate.fullName,
      link,
      expiresAt: expiresAt || new Date(Date.now() + 72 * 60 * 60 * 1000),
      reason
    });

    const withTimeout = (promise, ms = 8000) => {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Advocate test email timed out after ${ms}ms`)), ms);
      });
      return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
    };

    await withTimeout(
      sendBrandedMail({
        to: advocateEmail,
        subject,
        html,
        text,
        attachments,
        emailType: reason === 'RESCHEDULE' ? 'ADVOCATE_TEST_RESCHEDULE' : 'ADVOCATE_TEST_INITIAL'
      }),
      8000
    );

    console.log(`[Email Service] ADVOCATE_TEST_${reason} sent to ${maskEmail(advocateEmail)} for advocateId: ${advocateId}`);
    return { success: true };
  } catch (error) {
    console.error(`[Email Service] ADVOCATE_TEST_${reason} failed for ${maskEmail(advocateEmail)} (advocateId: ${advocateId}):`, error.message);
    return { success: false, message: error.message };
  }
};

let bccWarningLogged = false;

/**
 * Resets the single-warning state for invalid ADVOCATE_TEST_SHEET_BCC env (used in tests).
 */
export const resetBccWarningState = () => {
  bccWarningLogged = false;
};

/**
 * Parses and validates comma-separated BCC emails from ADVOCATE_TEST_SHEET_BCC env var.
 * Emits a single warning log if invalid emails are detected.
 *
 * @param {string} [raw=process.env.ADVOCATE_TEST_SHEET_BCC]
 * @returns {string[]}
 */
export const parseAdvocateTestSheetBcc = (raw = process.env.ADVOCATE_TEST_SHEET_BCC) => {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return [];
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const valid = [];
  const invalid = [];

  raw.split(',').forEach((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    if (emailRegex.test(trimmed)) {
      valid.push(trimmed);
    } else {
      invalid.push(trimmed);
    }
  });

  if (invalid.length > 0 && !bccWarningLogged) {
    bccWarningLogged = true;
    console.warn(`[Email Service] Invalid BCC email(s) ignored in ADVOCATE_TEST_SHEET_BCC: ${invalid.join(', ')}`);
  }

  return valid;
};

/**
 * Sends Test Response Sheet email to the advocate after an attempt is finalized.
 * Exactly-once delivery via atomic row claim on AdvocateTestAttempt.
 *
 * @param {string} attemptId UUID of AdvocateTestAttempt
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export const sendTestResponseSheetEmail = async (attemptId) => {
  if (!attemptId) {
    return { success: false, message: 'attemptId is required' };
  }

  let recipientEmail = '';
  let bccCount = 0;
  try {
    const attempt = await prisma.advocateTestAttempt.findUnique({
      where: { id: attemptId },
      include: { advocate: true }
    });

    if (!attempt) {
      console.warn(`[Email Service] AdvocateTestAttempt ${attemptId} not found.`);
      return { success: false, message: 'Attempt not found' };
    }

    if (!attempt.submittedAt) {
      console.warn(`[Email Service] AdvocateTestAttempt ${attemptId} is not finalized yet.`);
      return { success: false, message: 'Attempt is not finalized' };
    }

    recipientEmail = (attempt.advocate?.email || '').trim();
    if (!recipientEmail) {
      console.info(`[Email Service] Skipping test response sheet email for attempt ${attemptId}: no email on record.`);
      return { success: true, message: 'No email on record' };
    }

    // Atomic claim: exactly-once delivery
    const claim = await prisma.advocateTestAttempt.updateMany({
      where: { id: attemptId, responseSheetEmailSentAt: null },
      data: { responseSheetEmailSentAt: new Date() }
    });

    if (claim.count === 0) {
      return { success: true, message: 'Already sent or claimed' };
    }

    // Compute Attempt N: position among finalized attempts for this advocate
    let attemptNumber = 1;
    try {
      const count = await prisma.advocateTestAttempt.count({
        where: {
          advocateId: attempt.advocateId,
          submittedAt: { not: null },
          startedAt: { lte: attempt.startedAt }
        }
      });
      attemptNumber = Math.max(1, count);
    } catch (countErr) {
      console.warn(`[Email Service] Could not calculate attempt number for ${attemptId}, defaulting to 1:`, countErr.message);
    }

    let durationMinutes = 20;
    try {
      const config = getTestConfig();
      if (config && config.durationMinutes) {
        durationMinutes = config.durationMinutes;
      }
    } catch {
      // fallback
    }

    const bccList = parseAdvocateTestSheetBcc();
    bccCount = bccList.length;

    const { subject, html, text, attachments } = advocateTestResponseSheetTemplate({
      attempt,
      advocate: attempt.advocate,
      attemptNumber,
      durationMinutes
    });

    const withTimeout = (promise, ms = 8000) => {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Test response sheet email timed out after ${ms}ms`)), ms);
      });
      return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
    };

    await withTimeout(
      sendBrandedMail({
        to: recipientEmail,
        bcc: bccList.length > 0 ? bccList : undefined,
        subject,
        html,
        text,
        attachments,
        emailType: 'ADVOCATE_TEST_RESPONSE_SHEET'
      }),
      8000
    );

    console.log(`[Email Service] ADVOCATE_TEST_RESPONSE_SHEET sent to ${maskEmail(recipientEmail)} | attemptId: ${attemptId} | bccCount: ${bccCount}`);
    return { success: true };
  } catch (error) {
    // On failure/timeout: reset responseSheetEmailSentAt to null so cron can retry
    await prisma.advocateTestAttempt.update({
      where: { id: attemptId },
      data: { responseSheetEmailSentAt: null }
    }).catch(() => {});

    console.error(`[Email Service] ADVOCATE_TEST_RESPONSE_SHEET failed for ${maskEmail(recipientEmail)} (attemptId: ${attemptId}) | bccCount: ${bccCount}:`, error.message);
    return { success: false, message: error.message };
  }
};

let helpRequestBccWarningLogged = false;

export const resetHelpRequestBccWarningState = () => {
  helpRequestBccWarningLogged = false;
};

/**
 * Parses and validates comma-separated BCC emails from HELP_REQUEST_BCC env var.
 * Emits a single warning log if invalid emails are detected.
 *
 * @param {string} [raw=process.env.HELP_REQUEST_BCC]
 * @returns {string[]}
 */
export const parseHelpRequestBcc = (raw = process.env.HELP_REQUEST_BCC) => {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return [];
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const valid = [];
  const invalid = [];

  raw.split(',').forEach((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return;
    if (emailRegex.test(trimmed)) {
      valid.push(trimmed);
    } else {
      invalid.push(trimmed);
    }
  });

  if (invalid.length > 0 && !helpRequestBccWarningLogged) {
    helpRequestBccWarningLogged = true;
    console.warn(`[Email Service] Invalid BCC email(s) ignored in HELP_REQUEST_BCC: ${invalid.join(', ')}`);
  }

  return valid;
};

/**
 * Sends Help Request Acknowledgement email to the person who submitted the help request.
 * Exactly-once delivery via atomic row claim on HelpRequest.
 * Abuse limit: Skips if recipient received >= 3 emails in last 60 minutes.
 * Never throws, catches errors and returns { success, message }.
 *
 * @param {string} helpRequestId UUID of HelpRequest
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export const sendHelpRequestAcknowledgementEmail = async (helpRequestId) => {
  if (!helpRequestId) {
    return { success: false, message: 'helpRequestId is required' };
  }

  let recipientEmail = '';
  let referenceId = '';
  let bccCount = 0;

  try {
    const helpRequest = await prisma.helpRequest.findUnique({
      where: { id: helpRequestId }
    });

    if (!helpRequest) {
      console.warn(`[Email Service] HelpRequest ${helpRequestId} not found.`);
      return { success: false, message: 'Help request not found' };
    }

    referenceId = helpRequest.referenceId;
    recipientEmail = (helpRequest.email || '').trim();

    if (!recipientEmail) {
      console.info(`[Email Service] Skipping help request acknowledgement email for request ${helpRequestId} (${referenceId}): no email on record.`);
      return { success: true, message: 'No email on record' };
    }

    // Abuse limit check: max 3 acknowledgement emails to the same recipient in last 60 minutes
    const sixtyMinutesAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentSentCount = await prisma.helpRequest.count({
      where: {
        email: recipientEmail,
        acknowledgementEmailSentAt: { gte: sixtyMinutesAgo }
      }
    });

    if (recentSentCount >= 3) {
      console.warn(
        `[Email Service] HELP_REQUEST_ACKNOWLEDGEMENT skipped for ${maskEmail(recipientEmail)} | referenceId: ${referenceId}: abuse limit reached (3 emails in last 60m)`
      );
      return { success: false, message: 'Abuse limit reached' };
    }

    // Atomic claim: exactly-once delivery
    const claim = await prisma.helpRequest.updateMany({
      where: { id: helpRequestId, acknowledgementEmailSentAt: null },
      data: { acknowledgementEmailSentAt: new Date() }
    });

    if (claim.count === 0) {
      return { success: true, message: 'Already sent or claimed' };
    }

    const bccList = parseHelpRequestBcc();
    bccCount = bccList.length;

    const { subject, html, text, attachments } = helpRequestEmailTemplate({
      helpRequest
    });

    const withTimeout = (promise, ms = 8000) => {
      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Help request acknowledgement email timed out after ${ms}ms`)), ms);
      });
      return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
    };

    await withTimeout(
      sendBrandedMail({
        to: recipientEmail,
        bcc: bccList.length > 0 ? bccList : undefined,
        subject,
        html,
        text,
        attachments,
        emailType: 'HELP_REQUEST_ACKNOWLEDGEMENT'
      }),
      8000
    );

    console.log(
      `[Email Service] HELP_REQUEST_ACKNOWLEDGEMENT sent to ${maskEmail(recipientEmail)} | referenceId: ${referenceId} | bccCount: ${bccCount}`
    );
    return { success: true };
  } catch (error) {
    // On failure/timeout: reset acknowledgementEmailSentAt to null so cron can retry
    await prisma.helpRequest.update({
      where: { id: helpRequestId },
      data: { acknowledgementEmailSentAt: null }
    }).catch(() => {});

    console.error(
      `[Email Service] HELP_REQUEST_ACKNOWLEDGEMENT failed for ${maskEmail(recipientEmail)} | referenceId: ${referenceId} | bccCount: ${bccCount}:`,
      error.message
    );
    return { success: false, message: error.message };
  }
};





