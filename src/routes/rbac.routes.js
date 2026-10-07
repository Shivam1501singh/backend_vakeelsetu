import express from 'express';
import * as rbacController from '../controllers/rbac.controller.js';
import { requireAuth, requirePermission } from '../middleware/auth.middleware.js';
import { generalLimiter } from '../middleware/rate-limit.middleware.js';

const router = express.Router();

// 1. Roles Management (Admin / roles:manage)
router.post(
  '/roles',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.createRole
);

router.get(
  '/roles',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.listRoles
);

router.get(
  '/roles/:id',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.getRoleDetails
);

router.put(
  '/roles/:id',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.updateRole
);

router.patch(
  '/roles/:id',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.updateRole
);

router.patch(
  '/roles/:id/status',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.updateRoleStatus
);

router.delete(
  '/roles/:id',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.deleteRole
);

router.post(
  '/roles/:id/permissions',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.assignPermissionsToRole
);

router.delete(
  '/roles/:id/permissions',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.removePermissionsFromRole
);

// 2. Permissions Management
router.get(
  '/permissions',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.listPermissions
);

// 3. User Role Assignment
router.post(
  '/users/:userId/roles',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.assignRoleToUser
);

router.get(
  '/users/:userId/roles',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.getUserRoles
);

router.delete(
  '/users/:userId/roles/:roleId',
  requireAuth,
  requirePermission('roles:manage'),
  generalLimiter,
  rbacController.removeRoleFromUser
);

// 4. Users Listing for Admin & Lead Users (Protected by users:view permission)
router.get(
  '/users',
  requireAuth,
  requirePermission('users:view'),
  generalLimiter,
  rbacController.listUsersAdmin
);

router.get(
  '/users/:userId',
  requireAuth,
  requirePermission('users:view'),
  generalLimiter,
  rbacController.getUserDetailsAdmin
);

export default router;
