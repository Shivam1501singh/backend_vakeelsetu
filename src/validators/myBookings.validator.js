import { z } from 'zod';

export const userBookingsQuerySchema = z.object({
  status: z.enum(['UPCOMING', 'PROCESSING', 'COMPLETED', 'REFUNDED', 'ALL'], {
    errorMap: () => ({ message: "Status must be one of 'UPCOMING', 'PROCESSING', 'COMPLETED', 'REFUNDED', or 'ALL'." })
  }).optional().default('ALL'),
  type: z.enum(['ALL', 'CONSULTANCY', 'ADVOCATE'], {
    errorMap: () => ({ message: "Type must be one of 'CONSULTANCY', 'ADVOCATE', or 'ALL'." })
  }).optional().default('ALL'),
  from: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  page: z.string().regex(/^\d+$/, { message: 'Page must be a positive integer.' })
    .transform(Number)
    .pipe(z.number().int().min(1, { message: 'Page must be at least 1.' }))
    .optional()
    .default('1'),
  limit: z.string().regex(/^\d+$/, { message: 'Limit must be a positive integer.' })
    .transform(Number)
    .pipe(z.number().int().min(1, { message: 'Limit must be at least 1.' }).max(50, { message: 'Limit cannot exceed 50.' }))
    .optional()
    .default('10')
});
