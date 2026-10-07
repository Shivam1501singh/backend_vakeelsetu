import { z } from 'zod';

export const createRoleSchema = z.object({
  name: z.string({ required_error: 'Role name is required.' })
    .trim()
    .min(2, { message: 'Role name must be at least 2 characters.' })
    .max(50, { message: 'Role name cannot exceed 50 characters.' })
    .regex(/^[A-Z0-9_]+$/, { message: 'Role name must contain only uppercase letters, numbers, and underscores (e.g. LEAD_USER).' })
    .transform(v => v.toUpperCase()),
  displayName: z.string({ required_error: 'Display name is required.' })
    .trim()
    .min(2, { message: 'Display name must be at least 2 characters.' })
    .max(100, { message: 'Display name cannot exceed 100 characters.' }),
  description: z.string().trim().max(500, { message: 'Description cannot exceed 500 characters.' }).optional().nullable(),
  permissionIds: z.array(z.string().uuid({ message: 'Each permission ID must be a valid UUID.' })).optional(),
  permissionCodes: z.array(z.string().trim()).optional()
}).strict();

export const updateRoleSchema = z.object({
  name: z.string()
    .trim()
    .min(2, { message: 'Role name must be at least 2 characters.' })
    .max(50, { message: 'Role name cannot exceed 50 characters.' })
    .regex(/^[A-Z0-9_]+$/, { message: 'Role name must contain only uppercase letters, numbers, and underscores.' })
    .transform(v => v.toUpperCase())
    .optional(),
  displayName: z.string()
    .trim()
    .min(2, { message: 'Display name must be at least 2 characters.' })
    .max(100, { message: 'Display name cannot exceed 100 characters.' })
    .optional(),
  description: z.string().trim().max(500, { message: 'Description cannot exceed 500 characters.' }).optional().nullable(),
  isActive: z.boolean({ invalid_type_error: 'isActive must be a boolean.' }).optional(),
  permissionIds: z.array(z.string().uuid({ message: 'Each permission ID must be a valid UUID.' })).optional(),
  permissionCodes: z.array(z.string().trim()).optional()
}).strict();

export const updateRoleStatusSchema = z.object({
  isActive: z.boolean({
    required_error: 'isActive is required.',
    invalid_type_error: 'isActive must be a boolean.'
  })
}).strict();

export const rolePermissionsSchema = z.object({
  permissionIds: z.array(z.string().uuid({ message: 'Each permission ID must be a valid UUID.' })).optional(),
  permissionCodes: z.array(z.string().trim()).optional()
}).refine(data => (data.permissionIds && data.permissionIds.length > 0) || (data.permissionCodes && data.permissionCodes.length > 0), {
  message: 'At least one permission ID or permission code must be provided.'
});

export const assignUserRoleSchema = z.object({
  roleId: z.string().uuid({ message: 'Invalid role ID format.' }).optional(),
  roleName: z.string().trim().optional(),
  userType: z.enum(['USER', 'CONTENT_CREATOR', 'ADVOCATE', 'ADMIN']).optional().default('USER')
}).refine(data => data.roleId || data.roleName, {
  message: 'Either roleId or roleName must be provided.'
});

export const listRolesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  isActive: z.enum(['true', 'false']).transform(v => v === 'true').optional()
});

export const listPermissionsQuerySchema = z.object({
  module: z.string().trim().optional(),
  search: z.string().trim().optional(),
  grouped: z.enum(['true', 'false']).transform(v => v === 'true').optional()
});

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  status: z.enum(['ACTIVE', 'DELETION_PENDING']).optional(),
  role: z.string().trim().optional()
});
