import { z } from 'zod';

export const bookingQuoteSchema = z.object({
  mode: z.enum(['VOICE_CALL', 'VIDEO_CALL', 'IN_PERSON'], {
    errorMap: () => ({ message: 'Invalid booking mode. Must be VOICE_CALL, VIDEO_CALL, or IN_PERSON.' })
  }),
  startAt: z.string({ required_error: 'startAt is required.' }).min(1, 'startAt cannot be empty.')
});

export const advocateCheckoutSchema = z.object({
  advocateId: z.string({ required_error: 'advocateId is required.' }).uuid('advocateId must be a valid UUID.'),
  mode: z.enum(['VOICE_CALL', 'VIDEO_CALL', 'IN_PERSON'], {
    errorMap: () => ({ message: 'Invalid booking mode. Must be VOICE_CALL, VIDEO_CALL, or IN_PERSON.' })
  }),
  startAt: z.string({ required_error: 'startAt is required.' }).min(1, 'startAt cannot be empty.')
});

export const advocateAppointmentQuerySchema = z.object({
  status: z.enum(['UPCOMING', 'PAST_DUE', 'COMPLETED', 'REFUNDED', 'ALL']).optional().default('UPCOMING'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format').optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10)
});

export const adminAdvocateBookingQuerySchema = z.object({
  status: z.enum(['HOLD', 'CONFIRMED', 'COMPLETED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED', 'PAST_DUE', 'ALL']).optional(),
  mode: z.enum(['VOICE_CALL', 'VIDEO_CALL', 'IN_PERSON']).optional(),
  advocateId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  paidFrom: z.string().optional(),
  paidTo: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10)
});
