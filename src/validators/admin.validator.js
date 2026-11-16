import { z } from 'zod';
import {
  advocateProfileUpdateSchema,
  advocateProfileUpdateBaseSchema,
  validateOfficeCoordinates,
  validateLocationPairs,
  genderSchema,
  barCouncilIdSchema,
  officeAddressSchema
} from './advocate.validator.js';

export const rejectProfileChangeSchema = z.object({
  reason: z.string({ required_error: 'Rejection reason is required.' })
    .trim()
    .min(5, { message: 'Reason must be at least 5 characters.' })
    .max(500, { message: 'Reason cannot exceed 500 characters.' })
}).strict();

export const rejectOfficeChangeSchema = rejectProfileChangeSchema;

export const adminApproveAdvocateSchema = z.object({
  approvalStatus: z.enum(['APPROVED', 'REJECTED']).optional(),
  callAvailability: z.boolean({
    invalid_type_error: 'callAvailability must be a boolean.'
  }).optional()
}).strict();

export const adminUpdateAdvocateCallAvailabilitySchema = z.object({
  callAvailability: z.boolean({
    required_error: 'callAvailability is required.',
    invalid_type_error: 'callAvailability must be a boolean.'
  })
}).strict();

export const adminUpdateAdvocateStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
  callAvailability: z.boolean({
    invalid_type_error: 'callAvailability must be a boolean.'
  }).optional()
}).strict();

export const createStaffAccountSchema = z.object({
  fullName: z.string()
    .trim()
    .min(2, { message: 'Full name must be at least 2 characters.' })
    .max(100, { message: 'Full name cannot exceed 100 characters.' })
    .optional(),
  name: z.string()
    .trim()
    .min(2, { message: 'Full name must be at least 2 characters.' })
    .max(100, { message: 'Full name cannot exceed 100 characters.' })
    .optional(),
  email: z.string({ required_error: 'Email is required.' })
    .trim()
    .email({ message: 'Please provide a valid email address.' })
    .transform(v => v.toLowerCase()),
  password: z.string({ required_error: 'Password is required.' })
    .min(8, { message: 'Password must be at least 8 characters long.' }),
  roleIds: z.array(z.string().uuid({ message: 'Each role ID must be a valid UUID.' })).optional(),
  roleNames: z.array(z.string().trim().min(1).transform(v => v.toUpperCase())).optional()
}).strict().refine(data => Boolean(data.fullName || data.name), {
  message: 'Full name is required.',
  path: ['fullName']
}).transform(data => ({
  ...data,
  fullName: data.fullName || data.name
}));

export const updateStaffRolesSchema = z.object({
  roleIds: z.array(z.string().uuid({ message: 'Each role ID must be a valid UUID.' })).optional(),
  roleNames: z.array(z.string().trim().min(1).transform(v => v.toUpperCase())).optional()
}).strict().refine(data => (Array.isArray(data.roleIds) && data.roleIds.length > 0) || (Array.isArray(data.roleNames) && data.roleNames.length > 0), {
  message: 'At least one role is required.'
});

export const adminAdvocateProfileUpdateSchema = advocateProfileUpdateBaseSchema.extend({
  fullName: z.string()
    .trim()
    .min(2, { message: 'Full name must be at least 2 characters.' })
    .max(100, { message: 'Full name cannot exceed 100 characters.' })
    .optional(),
  gender: genderSchema.optional(),
  barCouncilId: barCouncilIdSchema.optional(),
}).strict().superRefine(validateLocationPairs).refine((data) => Object.keys(data).length > 0, {
  message: 'Provide at least one field to update.'
});

export const adminMarkPaidWithdrawalSchema = z.object({
  utr: z.string({ required_error: 'UTR / bank reference number is required.' })
    .trim()
    .min(6, { message: 'UTR must be at least 6 characters.' })
    .max(40, { message: 'UTR cannot exceed 40 characters.' })
    .regex(/^[a-zA-Z0-9_-]+$/, { message: 'UTR must be alphanumeric.' }),
  paidAt: z.string()
    .datetime({ message: 'paidAt must be a valid ISO datetime string.' })
    .optional()
}).strict();

export const adminRejectWithdrawalSchema = z.object({
  reason: z.string({ required_error: 'Rejection reason is required.' })
    .trim()
    .min(5, { message: 'Rejection reason must be at least 5 characters.' })
    .max(500, { message: 'Rejection reason cannot exceed 500 characters.' })
}).strict();

export const adminWithdrawalListQuerySchema = z.object({
  status: z.enum(['REQUESTED', 'APPROVED', 'PAID', 'REJECTED', 'ALL']).optional().default('ALL'),
  search: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  page: z.union([z.number(), z.string()]).optional(),
  limit: z.union([z.number(), z.string()]).optional()
});

export const createTestQuestionSchema = z.object({
  question: z.string({ required_error: 'Question is required.' })
    .trim()
    .min(5, { message: 'Question must be between 5 and 1000 characters.' })
    .max(1000, { message: 'Question must be between 5 and 1000 characters.' }),
  options: z.array(
    z.string()
      .trim()
      .min(1, { message: 'Each option must be between 1 and 300 characters.' })
      .max(300, { message: 'Each option must be between 1 and 300 characters.' })
  )
    .length(4, { message: 'Exactly 4 options are required.' })
    .refine(
      (opts) => new Set(opts.map((o) => o.trim().toLowerCase())).size === 4,
      { message: 'Options cannot contain duplicates.' }
    ),
  correctOption: z.number({ required_error: 'correctOption is required.' })
    .int({ message: 'correctOption must be an integer.' })
    .min(0, { message: 'correctOption must be between 0 and 3.' })
    .max(3, { message: 'correctOption must be between 0 and 3.' }),
  isActive: z.boolean({ invalid_type_error: 'isActive must be a boolean.' }).optional().default(true)
}).strict();

export const updateTestQuestionSchema = z.object({
  question: z.string()
    .trim()
    .min(5, { message: 'Question must be between 5 and 1000 characters.' })
    .max(1000, { message: 'Question must be between 5 and 1000 characters.' })
    .optional(),
  options: z.array(
    z.string()
      .trim()
      .min(1, { message: 'Each option must be between 1 and 300 characters.' })
      .max(300, { message: 'Each option must be between 1 and 300 characters.' })
  )
    .length(4, { message: 'Exactly 4 options are required.' })
    .refine(
      (opts) => new Set(opts.map((o) => o.trim().toLowerCase())).size === 4,
      { message: 'Options cannot contain duplicates.' }
    )
    .optional(),
  correctOption: z.number()
    .int({ message: 'correctOption must be an integer.' })
    .min(0, { message: 'correctOption must be between 0 and 3.' })
    .max(3, { message: 'correctOption must be between 0 and 3.' })
    .optional(),
  isActive: z.boolean({ invalid_type_error: 'isActive must be a boolean.' }).optional()
}).strict();



