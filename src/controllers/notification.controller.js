import prisma from '../lib/prisma.js';
import {
  registerDeviceToken,
  unregisterDeviceToken,
  sendPushNotification
} from '../services/pushNotification.service.js';
import {
  registerTokenSchema,
  unregisterTokenSchema,
  testPushSchema
} from '../validators/notification.validator.js';

export const registerToken = async (req, res, next) => {
  try {
    const validated = registerTokenSchema.parse(req.body);

    const userId = req.user?.id || validated.userId || null;
    const email = req.user?.email || validated.email || null;
    const userType = req.user?.role || req.user?.type || validated.userType || 'USER';

    const result = await registerDeviceToken({
      token: validated.token,
      deviceType: validated.deviceType,
      userId,
      email,
      userType
    });

    return res.status(200).json({
      success: true,
      message: 'Device token registered successfully',
      data: {
        id: result.id,
        userType: result.userType,
        deviceType: result.deviceType,
        isActive: result.isActive
      }
    });
  } catch (error) {
    next(error);
  }
};

export const unregisterToken = async (req, res, next) => {
  try {
    const validated = unregisterTokenSchema.parse(req.body);
    await unregisterDeviceToken(validated.token);

    return res.status(200).json({
      success: true,
      message: 'Device token unregistered successfully'
    });
  } catch (error) {
    next(error);
  }
};

export const testPushNotification = async (req, res, next) => {
  try {
    const validated = testPushSchema.parse(req.body);
    const result = await sendPushNotification({
      token: validated.token,
      topic: validated.topic,
      recipientEmail: validated.email,
      title: validated.title,
      body: validated.body,
      data: validated.data || {},
      type: 'TEST'
    });

    return res.status(200).json({
      success: result.success,
      deliveredCount: result.deliveredCount,
      tokensTargeted: result.tokensTargeted || 0,
      message: result.success
        ? 'Test push notification sent successfully'
        : 'Push notification attempted (check delivery count and logs)'
    });
  } catch (error) {
    next(error);
  }
};

export const getNotificationLogs = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page || '1', 10);
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.notificationLog.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.notificationLog.count()
    ]);

    return res.status(200).json({
      success: true,
      data: logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

export default {
  registerToken,
  unregisterToken,
  testPushNotification,
  getNotificationLogs
};

