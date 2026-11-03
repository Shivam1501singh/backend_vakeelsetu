import nodemailer from 'nodemailer';
import prisma from '../lib/prisma.js';
import { getLogoAttachment } from '../templates/emailLayout.template.js';
import { otpEmailTemplate } from '../templates/otpEmail.template.js';
import {
  bookingConfirmedUserTemplate,
  newAppointmentAdvocateTemplate,
  consultancyBookedUserTemplate
} from '../templates/bookingEmail.template.js';

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
 * @param {string} params.subject
 * @param {string} params.html
 * @param {string} [params.text]
 * @param {Array} [params.attachments=[]]
 * @param {string} [params.emailType='EMAIL']
 * @returns {Promise<boolean>}
 */
export const sendBrandedMail = async ({
  to,
  subject,
  html,
  text,
  attachments = [],
  emailType = 'EMAIL'
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
    subject,
    text,
    html,
    attachments: finalAttachments
  };

  const transporter = getTransporter();

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email Service] ${emailType} sent to ${maskEmail(to)} | messageId: ${info?.messageId || 'ok'}`);
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

