import prisma from '../lib/prisma.js';
import { getFirebaseMessaging, isFirebaseInitialized } from '../config/firebase.js';

/**
 * Ensures all key-values in data payload are strings (FCM requirement).
 */
const sanitizeDataPayload = (raw = {}) => {
  if (!raw || typeof raw !== 'object') return {};
  const clean = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) {
      clean[key] = '';
    } else if (typeof value === 'object') {
      clean[key] = JSON.stringify(value);
    } else {
      clean[key] = String(value);
    }
  }
  return clean;
};

/**
 * Handles deactivating or cleaning up stale/invalid FCM tokens.
 */
const cleanupStaleTokens = async (staleTokens = []) => {
  if (!staleTokens.length) return;
  try {
    await prisma.deviceToken.updateMany({
      where: { token: { in: staleTokens } },
      data: { isActive: false }
    });
    console.log(`[Push Notification] Deactivated ${staleTokens.length} stale FCM device tokens.`);
  } catch (err) {
    console.error('[Push Notification] Error deactivating stale tokens:', err.message);
  }
};

/**
 * Logs notification dispatch attempt into the database (non-blocking).
 */
const recordNotificationLog = async ({
  recipientEmail,
  userId,
  userType,
  title,
  body,
  data,
  type = 'NOTIFICATION',
  status = 'SENT',
  errorMessage = null
}) => {
  try {
    await prisma.notificationLog.create({
      data: {
        recipientEmail: recipientEmail || null,
        userId: userId || null,
        userType: userType || null,
        title,
        body,
        data: data || {},
        type,
        status,
        errorMessage: errorMessage ? String(errorMessage) : null
      }
    });
  } catch (err) {
    // Non-fatal, just log to console
    console.warn('[Push Notification] Failed to write notification log:', err.message);
  }
};

/**
 * Core function to send push notifications via Firebase Cloud Messaging.
 * Safely looks up device tokens or topic, dispatches FCM, and logs the outcome.
 *
 * @param {object} params
 * @param {string|string[]} [params.token] Specific FCM registration token(s)
 * @param {string} [params.topic] FCM topic name
 * @param {string} [params.userId] User or Advocate ID
 * @param {string} [params.recipientEmail] Recipient email
 * @param {string} [params.userType] 'USER' | 'ADVOCATE' | 'ADMIN'
 * @param {string} params.title Notification title
 * @param {string} params.body Notification body text
 * @param {object} [params.data={}] Additional key-value metadata
 * @param {string} [params.type='GENERIC'] Notification categorization type
 * @returns {Promise<{ success: boolean, deliveredCount: number, error?: string }>}
 */
export const sendPushNotification = async ({
  token,
  topic,
  userId,
  recipientEmail,
  userType,
  title,
  body,
  data = {},
  type = 'GENERIC'
}) => {
  try {
    const messaging = getFirebaseMessaging();
    const sanitizedData = sanitizeDataPayload({ ...data, type });

    if (!messaging) {
      console.warn(`[Push Notification] Firebase messaging not available. Notification "${title}" suppressed.`);
      await recordNotificationLog({
        recipientEmail,
        userId,
        userType,
        title,
        body,
        data: sanitizedData,
        type,
        status: 'SKIPPED',
        errorMessage: 'Firebase Messaging not initialized'
      });
      return { success: false, deliveredCount: 0, error: 'Firebase Messaging not initialized' };
    }

    // 1. Gather all candidate device tokens
    const targetTokens = new Set();
    if (token) {
      if (Array.isArray(token)) {
        token.filter(Boolean).forEach((t) => targetTokens.add(t));
      } else if (typeof token === 'string' && token.trim()) {
        targetTokens.add(token.trim());
      }
    }

    // Lookup registered active tokens from database if userId or recipientEmail provided
    if (userId || recipientEmail) {
      try {
        const whereConditions = [];
        if (userId) whereConditions.push({ userId });
        if (recipientEmail) whereConditions.push({ email: recipientEmail.trim().toLowerCase() });

        const rows = await prisma.deviceToken.findMany({
          where: {
            isActive: true,
            OR: whereConditions
          },
          select: { token: true }
        });

        rows.forEach((r) => targetTokens.add(r.token));
      } catch (dbErr) {
        console.error('[Push Notification] DB lookup error for device tokens:', dbErr.message);
      }
    }

    const tokensList = Array.from(targetTokens);
    let deliveredCount = 0;
    const staleTokens = [];

    // 2. Dispatch to Device Tokens (Multicast or batch)
    if (tokensList.length > 0) {
      const multicastMessage = {
        tokens: tokensList,
        notification: {
          title,
          body
        },
        data: sanitizedData,
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'vakeelsetu_notifications',
            clickAction: 'FLUTTER_NOTIFICATION_CLICK'
          }
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: 1
            }
          }
        }
      };

      try {
        const response = await messaging.sendEachForMulticast(multicastMessage);
        deliveredCount += response.successCount;

        if (response.failureCount > 0) {
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              const errCode = resp.error?.code;
              if (
                errCode === 'messaging/registration-token-not-registered' ||
                errCode === 'messaging/invalid-registration-token'
              ) {
                staleTokens.push(tokensList[idx]);
              }
            }
          });
        }
      } catch (sendErr) {
        console.error('[Push Notification] sendEachForMulticast error:', sendErr.message);
      }
    }

    // 3. Dispatch to Topic if requested
    if (topic && typeof topic === 'string' && topic.trim()) {
      try {
        await messaging.send({
          topic: topic.trim(),
          notification: { title, body },
          data: sanitizedData,
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'vakeelsetu_notifications'
            }
          }
        });
        deliveredCount += 1;
      } catch (topicErr) {
        console.error(`[Push Notification] Topic send error for "${topic}":`, topicErr.message);
      }
    }

    // Cleanup any dead tokens asynchronously
    if (staleTokens.length > 0) {
      cleanupStaleTokens(staleTokens);
    }

    // 4. Log the notification
    const finalStatus = deliveredCount > 0 ? 'SENT' : (tokensList.length === 0 && !topic ? 'SKIPPED' : 'FAILED');
    const noteMsg = tokensList.length === 0 && !topic ? 'No active FCM tokens or topic found for recipient' : null;

    await recordNotificationLog({
      recipientEmail,
      userId,
      userType,
      title,
      body,
      data: sanitizedData,
      type,
      status: finalStatus,
      errorMessage: noteMsg
    });

    console.log(
      `[Push Notification] "${title}" | Recipient: ${recipientEmail || userId || topic || 'N/A'} | Delivered: ${deliveredCount}/${tokensList.length} tokens`
    );

    return {
      success: deliveredCount > 0,
      deliveredCount,
      tokensTargeted: tokensList.length
    };
  } catch (error) {
    console.error('[Push Notification] Unexpected push error:', error.message);
    await recordNotificationLog({
      recipientEmail,
      userId,
      userType,
      title,
      body,
      data,
      type,
      status: 'FAILED',
      errorMessage: error.message
    });
    return { success: false, deliveredCount: 0, error: error.message };
  }
};

/**
 * Triggered on OTP emails.
 */
export const sendOtpPushNotification = async ({ email, otp, purpose = 'VERIFICATION', userId = null }) => {
  const displayPurpose = String(purpose).replace(/_/g, ' ');
  const title = `Verification Code - VakeelSetu`;
  const body = `Your ${displayPurpose.toLowerCase()} OTP is ${otp}. Valid for 5 minutes. Do not share it with anyone.`;

  return await sendPushNotification({
    recipientEmail: email,
    userId,
    title,
    body,
    data: {
      type: 'OTP',
      otp: String(otp),
      purpose: String(purpose)
    },
    type: `OTP_${String(purpose).toUpperCase()}`
  });
};

/**
 * Triggered on Advocate Booking Confirmation (User + Advocate).
 */
export const sendBookingConfirmedPushNotification = async ({ booking, recipientType }) => {
  if (!booking) return;

  if (recipientType === 'USER') {
    const advocateName = booking.advocate?.fullName || 'Advocate';
    const dateStr = booking.scheduledDate
      ? new Date(booking.scheduledDate).toLocaleDateString('en-IN', { dateStyle: 'medium' })
      : 'your scheduled date';
    const timeStr = booking.scheduledTime || '';

    const title = 'Appointment Confirmed! - VakeelSetu';
    const body = `Your appointment with Adv. ${advocateName} is confirmed for ${dateStr}${timeStr ? ` at ${timeStr}` : ''}.`;

    return await sendPushNotification({
      userId: booking.userId,
      recipientEmail: booking.userEmail || booking.user?.email,
      userType: 'USER',
      title,
      body,
      data: {
        type: 'BOOKING_CONFIRMED',
        bookingId: booking.id,
        advocateId: booking.advocateId,
        advocateName
      },
      type: 'BOOKING_CONFIRMED_USER'
    });
  }

  if (recipientType === 'ADVOCATE') {
    const clientName = booking.userName || booking.user?.fullName || 'A client';
    const dateStr = booking.scheduledDate
      ? new Date(booking.scheduledDate).toLocaleDateString('en-IN', { dateStyle: 'medium' })
      : 'the scheduled date';
    const timeStr = booking.scheduledTime || '';

    const title = 'New Consultation Booked! - VakeelSetu';
    const body = `${clientName} has booked a consultation with you for ${dateStr}${timeStr ? ` at ${timeStr}` : ''}.`;

    return await sendPushNotification({
      userId: booking.advocateId,
      recipientEmail: booking.advocate?.email,
      userType: 'ADVOCATE',
      title,
      body,
      data: {
        type: 'NEW_APPOINTMENT',
        bookingId: booking.id,
        userId: booking.userId || '',
        clientName
      },
      type: 'NEW_APPOINTMENT_ADVOCATE'
    });
  }
};

/**
 * Triggered on Paid Consultancy Request Confirmation.
 */
export const sendConsultancyPushNotification = async ({ consultancy }) => {
  if (!consultancy) return;

  const title = 'Consultancy Confirmed! - VakeelSetu';
  const body = `Your legal consultancy request has been confirmed. A legal advisor will review your case shortly.`;

  return await sendPushNotification({
    userId: consultancy.userId,
    recipientEmail: consultancy.email || consultancy.user?.email,
    userType: 'USER',
    title,
    body,
    data: {
      type: 'CONSULTANCY_BOOKED',
      consultancyId: consultancy.id
    },
    type: 'CONSULTANCY_BOOKED_USER'
  });
};

/**
 * Registers or updates an FCM device token in the database.
 */
export const registerDeviceToken = async ({ token, userId, email, userType, deviceType }) => {
  if (!token || typeof token !== 'string' || !token.trim()) {
    throw new Error('Device token is required');
  }

  const cleanToken = token.trim();
  const cleanEmail = email ? email.trim().toLowerCase() : null;

  return await prisma.deviceToken.upsert({
    where: { token: cleanToken },
    update: {
      userId: userId || undefined,
      email: cleanEmail || undefined,
      userType: userType || undefined,
      deviceType: deviceType || undefined,
      isActive: true,
      updatedAt: new Date()
    },
    create: {
      token: cleanToken,
      userId: userId || null,
      email: cleanEmail || null,
      userType: userType || 'USER',
      deviceType: deviceType || 'android',
      isActive: true
    }
  });
};

/**
 * Unregisters / deactivates an FCM device token (e.g. on user logout).
 */
export const unregisterDeviceToken = async (token) => {
  if (!token) return null;
  return await prisma.deviceToken.updateMany({
    where: { token: token.trim() },
    data: { isActive: false }
  });
};

export default {
  sendPushNotification,
  sendOtpPushNotification,
  sendBookingConfirmedPushNotification,
  sendConsultancyPushNotification,
  registerDeviceToken,
  unregisterDeviceToken
};

