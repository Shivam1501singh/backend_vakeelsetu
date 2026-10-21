import { z } from 'zod';

export const checkoutVerifySchema = z.object({
  razorpay_order_id: z.string({ required_error: 'razorpay_order_id is required' }).trim().min(1),
  razorpay_payment_id: z.string({ required_error: 'razorpay_payment_id is required' }).trim().min(1),
  razorpay_signature: z.string({ required_error: 'razorpay_signature is required' }).trim().min(1)
}).strict();

export const adminPaymentQuerySchema = z.object({
  status: z.enum([
    'CREATED',
    'PROCESSING',
    'PAID',
    'FAILED',
    'EXPIRED',
    'REFUND_PENDING',
    'REFUNDED'
  ]).optional(),
  refundEligible: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  search: z.string().trim().optional(),
  from: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  page: z.string().regex(/^\d+$/).transform(Number).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional()
});

export const adminRefundSchema = z.object({
  reason: z.string({ required_error: 'Refund reason is required' })
    .trim()
    .min(5, { message: 'Reason must be at least 5 characters long' })
    .max(500, { message: 'Reason cannot exceed 500 characters' }),
  force: z.boolean().optional().default(false)
}).strict();

export const userPaymentQuerySchema = z.object({
  page: z.string().regex(/^\d+$/).transform(Number).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).optional()
});
