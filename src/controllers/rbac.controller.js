import * as rbacService from '../services/rbac.service.js';
import * as rbacValidator from '../validators/rbac.validator.js';

/**
 * Admin: Create a new Role
 * POST /api/admin/roles
 */
export const createRole = async (req, res, next) => {
  try {
    const validated = rbacValidator.createRoleSchema.parse(req.body);

    const role = await rbacService.createRole({
      name: validated.name,
      displayName: validated.displayName,
      description: validated.description,
      permissionIds: validated.permissionIds,
      permissionCodes: validated.permissionCodes
    });

    return res.status(201).json({
      success: true,
      message: `Role '${role.name}' created successfully.`,
      role
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: List all Roles
 * GET /api/admin/roles
 */
export const listRoles = async (req, res, next) => {
  try {
    const query = rbacValidator.listRolesQuerySchema.parse(req.query);

    const result = await rbacService.listRoles({
      page: query.page,
      limit: query.limit,
      search: query.search,
      isActive: query.isActive
    });

    return res.status(200).json({
      success: true,
      roles: result.roles,
      pagination: result.pagination
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Get single Role details
 * GET /api/admin/roles/:id
 */
export const getRoleDetails = async (req, res, next) => {
  try {
    const { id } = req.params;
    const role = await rbacService.getRoleById(id);

    return res.status(200).json({
      success: true,
      role
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Update Role
 * PUT/PATCH /api/admin/roles/:id
 */
export const updateRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const validated = rbacValidator.updateRoleSchema.parse(req.body);

    const role = await rbacService.updateRole(id, {
      name: validated.name,
      displayName: validated.displayName,
      description: validated.description,
      isActive: validated.isActive,
      permissionIds: validated.permissionIds,
      permissionCodes: validated.permissionCodes
    });

    return res.status(200).json({
      success: true,
      message: `Role '${role.name}' updated successfully.`,
      role
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Activate or Deactivate Role
 * PATCH /api/admin/roles/:id/status
 */
export const updateRoleStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const validated = rbacValidator.updateRoleStatusSchema.parse(req.body);

    const role = await rbacService.updateRoleStatus(id, validated.isActive);

    return res.status(200).json({
      success: true,
      message: `Role '${role.name}' ${validated.isActive ? 'activated' : 'deactivated'} successfully.`,
      role
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Delete Role
 * DELETE /api/admin/roles/:id
 */
export const deleteRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await rbacService.deleteRole(id);

    return res.status(200).json({
      success: true,
      message: result.message
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Assign permissions to a Role
 * POST /api/admin/roles/:id/permissions
 */
export const assignPermissionsToRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const validated = rbacValidator.rolePermissionsSchema.parse(req.body);

    const role = await rbacService.assignPermissionsToRole(id, {
      permissionIds: validated.permissionIds,
      permissionCodes: validated.permissionCodes
    });

    return res.status(200).json({
      success: true,
      message: 'Permissions assigned to role successfully.',
      role
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Remove permissions from a Role
 * DELETE /api/admin/roles/:id/permissions
 */
export const removePermissionsFromRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const validated = rbacValidator.rolePermissionsSchema.parse(req.body);

    const role = await rbacService.removePermissionsFromRole(id, {
      permissionIds: validated.permissionIds,
      permissionCodes: validated.permissionCodes
    });

    return res.status(200).json({
      success: true,
      message: 'Permissions removed from role successfully.',
      role
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: List all available system Permissions
 * GET /api/admin/permissions
 */
export const listPermissions = async (req, res, next) => {
  try {
    const query = rbacValidator.listPermissionsQuerySchema.parse(req.query);

    const result = await rbacService.listPermissions({
      module: query.module,
      search: query.search,
      grouped: query.grouped
    });

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Assign a Role to a User
 * POST /api/admin/users/:userId/roles
 */
export const assignRoleToUser = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const validated = rbacValidator.assignUserRoleSchema.parse(req.body);

    const result = await rbacService.assignRoleToUser({
      userId,
      roleId: validated.roleId,
      roleName: validated.roleName,
      userType: validated.userType
    });

    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Get roles and permissions for a User
 * GET /api/admin/users/:userId/roles
 */
export const getUserRoles = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const userType = req.query.userType || 'USER';

    const result = await rbacService.getUserRolesAndPermissions(userId, userType);

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin: Remove a Role from a User
 * DELETE /api/admin/users/:userId/roles/:roleId
 */
export const removeRoleFromUser = async (req, res, next) => {
  try {
    const { userId, roleId } = req.params;

    const result = await rbacService.removeRoleFromUser({
      userId,
      roleId
    });

    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

/**
 * Admin & Lead User: List Users
 * GET /api/admin/users
 */
export const listUsersAdmin = async (req, res, next) => {
  try {
    const query = rbacValidator.listUsersQuerySchema.parse(req.query);

    const result = await rbacService.listUsersAdmin({
      page: query.page,
      limit: query.limit,
      search: query.search,
      status: query.status,
      role: query.role
    });

    return res.status(200).json({
      success: true,
      users: result.users,
      pagination: result.pagination
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin & Lead User: Get User Details
 * GET /api/admin/users/:userId
 */
export const getUserDetailsAdmin = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const user = await rbacService.getUserDetailsAdmin(userId);

    return res.status(200).json({
      success: true,
      user
    });
  } catch (error) {
    next(error);
  }
};
