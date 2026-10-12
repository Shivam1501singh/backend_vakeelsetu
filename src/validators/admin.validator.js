import { z } from 'zod';

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
