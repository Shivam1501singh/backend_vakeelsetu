import { z } from 'zod';

export const registerTokenSchema = z.object({
  token: z.string({ required_error: 'Device token is required' }).trim().min(1, 'Token cannot be empty'),
  deviceType: z.enum(['android', 'ios', 'web']).optional().default('android'),
  email: z.string().email().optional(),
  userId: z.string().optional(),
  userType: z.enum(['USER', 'ADVOCATE', 'ADMIN', 'GUEST']).optional().default('USER')
});

export const unregisterTokenSchema = z.object({
  token: z.string({ required_error: 'Device token is required' }).trim().min(1)
});

export const testPushSchema = z.object({
  token: z.string().optional(),
  topic: z.string().optional(),
  email: z.string().email().optional(),
  title: z.string().default('Test Notification - VakeelSetu'),
  body: z.string().default('This is a test push notification from VakeelSetu Firebase Service.'),
  data: z.record(z.any()).optional()
});

