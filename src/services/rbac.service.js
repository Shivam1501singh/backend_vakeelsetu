import prisma from '../lib/prisma.js';

/**
 * Format role object for response
 */
export const formatRoleResponse = (role) => {
  if (!role) return null;

  const permissions = role.permissions
    ? role.permissions.map((rp) => rp.permission || rp).filter(Boolean)
    : [];

  return {
    id: role.id,
    name: role.name,
    displayName: role.displayName,
    description: role.description || null,
    isActive: role.isActive,
    isSystem: role.isSystem || false,
    permissionsCount: permissions.length,
    permissions: permissions.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      module: p.module,
      description: p.description || null
    })),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt
  };
};

/**
 * Resolve permission IDs from a mix of IDs and Codes
 */
export const resolvePermissionIds = async ({ permissionIds = [], permissionCodes = [] }) => {
  const ids = new Set(permissionIds);

  if (permissionCodes && permissionCodes.length > 0) {
    const permissions = await prisma.permission.findMany({
      where: {
        code: { in: permissionCodes }
      },
      select: { id: true }
    });
    permissions.forEach((p) => ids.add(p.id));
  }

  return Array.from(ids);
};

/**
 * Create a new Role
 */
export const createRole = async ({ name, displayName, description, permissionIds = [], permissionCodes = [] }) => {
  const normalizedName = name.trim().toUpperCase();

  const existing = await prisma.role.findUnique({
    where: { name: normalizedName }
  });

  if (existing) {
    const err = new Error(`Role with name '${normalizedName}' already exists.`);
    err.statusCode = 409;
    throw err;
  }

  const targetPermissionIds = await resolvePermissionIds({ permissionIds, permissionCodes });

  // Validate that all permission IDs exist
  if (targetPermissionIds.length > 0) {
    const count = await prisma.permission.count({
      where: { id: { in: targetPermissionIds } }
    });
    if (count !== targetPermissionIds.length) {
      const err = new Error('One or more specified permission IDs are invalid.');
      err.statusCode = 400;
      throw err;
    }
  }

  const role = await prisma.role.create({
    data: {
      name: normalizedName,
      displayName: displayName.trim(),
      description: description ? description.trim() : null,
      permissions: targetPermissionIds.length > 0 ? {
        create: targetPermissionIds.map((permissionId) => ({
          permissionId
        }))
      } : undefined
    },
    include: {
      permissions: {
        include: {
          permission: true
        }
      }
    }
  });

  return formatRoleResponse(role);
};

/**
 * List all Roles with filtering and pagination
 */
export const listRoles = async ({ page = 1, limit = 20, search, isActive } = {}) => {
  const where = {};

  if (typeof isActive === 'boolean') {
    where.isActive = isActive;
  }

  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { displayName: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } }
    ];
  }

  const skip = (page - 1) * limit;

  const [roles, totalRoles] = await prisma.$transaction([
    prisma.role.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
      include: {
        permissions: {
          include: {
            permission: true
          }
        }
      }
    }),
    prisma.role.count({ where })
  ]);

  const totalPages = Math.ceil(totalRoles / limit) || 1;

  return {
    roles: roles.map(formatRoleResponse),
    pagination: {
      currentPage: page,
      limit,
      totalRoles,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1
    }
  };
};

/**
 * Get single Role by ID with its permissions
 */
export const getRoleById = async (roleId) => {
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: {
      permissions: {
        include: {
          permission: true
        }
      }
    }
  });

  if (!role) {
    const err = new Error('Role not found.');
    err.statusCode = 404;
    throw err;
  }

  return formatRoleResponse(role);
};

/**
 * Update Role details and/or its permissions
 */
export const updateRole = async (roleId, { name, displayName, description, isActive, permissionIds, permissionCodes }) => {
  const existingRole = await prisma.role.findUnique({
    where: { id: roleId }
  });

  if (!existingRole) {
    const err = new Error('Role not found.');
    err.statusCode = 404;
    throw err;
  }

  const updateData = {};

  if (name) {
    const normalizedName = name.trim().toUpperCase();
    if (normalizedName !== existingRole.name) {
      const duplicate = await prisma.role.findUnique({
        where: { name: normalizedName }
      });
      if (duplicate) {
        const err = new Error(`Role with name '${normalizedName}' already exists.`);
        err.statusCode = 409;
        throw err;
      }
      updateData.name = normalizedName;
    }
  }

  if (displayName !== undefined) {
    updateData.displayName = displayName.trim();
  }

  if (description !== undefined) {
    updateData.description = description ? description.trim() : null;
  }

  if (isActive !== undefined) {
    updateData.isActive = isActive;
  }

  // Handle permission assignment update if specified
  let permissionsUpdate = undefined;
  if (permissionIds !== undefined || permissionCodes !== undefined) {
    const targetPermissionIds = await resolvePermissionIds({
      permissionIds: permissionIds || [],
      permissionCodes: permissionCodes || []
    });

    if (targetPermissionIds.length > 0) {
      const count = await prisma.permission.count({
        where: { id: { in: targetPermissionIds } }
      });
      if (count !== targetPermissionIds.length) {
        const err = new Error('One or more specified permission IDs are invalid.');
        err.statusCode = 400;
        throw err;
      }
    }

    permissionsUpdate = {
      deleteMany: {},
      create: targetPermissionIds.map((pId) => ({ permissionId: pId }))
    };
  }

  if (permissionsUpdate) {
    updateData.permissions = permissionsUpdate;
  }

  const updated = await prisma.role.update({
    where: { id: roleId },
    data: updateData,
    include: {
      permissions: {
        include: {
          permission: true
        }
      }
    }
  });

  return formatRoleResponse(updated);
};

/**
 * Toggle or update Role active status
 */
export const updateRoleStatus = async (roleId, isActive) => {
  const existingRole = await prisma.role.findUnique({
    where: { id: roleId }
  });

  if (!existingRole) {
    const err = new Error('Role not found.');
    err.statusCode = 404;
    throw err;
  }

  const updated = await prisma.role.update({
    where: { id: roleId },
    data: { isActive },
    include: {
      permissions: {
        include: {
          permission: true
        }
      }
    }
  });

  return formatRoleResponse(updated);
};

/**
 * Delete a Role
 */
export const deleteRole = async (roleId) => {
  const existingRole = await prisma.role.findUnique({
    where: { id: roleId }
  });

  if (!existingRole) {
    const err = new Error('Role not found.');
    err.statusCode = 404;
    throw err;
  }

  if (existingRole.isSystem) {
    const err = new Error('System roles cannot be deleted. You may deactivate them instead.');
    err.statusCode = 400;
    throw err;
  }

  await prisma.role.delete({
    where: { id: roleId }
  });

  return { success: true, message: `Role '${existingRole.name}' deleted successfully.` };
};

/**
 * Assign permissions to a Role
 */
export const assignPermissionsToRole = async (roleId, { permissionIds = [], permissionCodes = [] }) => {
  const role = await prisma.role.findUnique({
    where: { id: roleId }
  });

  if (!role) {
    const err = new Error('Role not found.');
    err.statusCode = 404;
    throw err;
  }

  const targetPermissionIds = await resolvePermissionIds({ permissionIds, permissionCodes });

  if (targetPermissionIds.length === 0) {
    const err = new Error('No valid permissions provided to assign.');
    err.statusCode = 400;
    throw err;
  }

  // Insert permissions that are not already assigned (idempotent)
  for (const permissionId of targetPermissionIds) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId,
          permissionId
        }
      },
      update: {},
      create: {
        roleId,
        permissionId
      }
    });
  }

  return getRoleById(roleId);
};

/**
 * Remove permissions from a Role
 */
export const removePermissionsFromRole = async (roleId, { permissionIds = [], permissionCodes = [] }) => {
  const role = await prisma.role.findUnique({
    where: { id: roleId }
  });

  if (!role) {
    const err = new Error('Role not found.');
    err.statusCode = 404;
    throw err;
  }

  const targetPermissionIds = await resolvePermissionIds({ permissionIds, permissionCodes });

  if (targetPermissionIds.length === 0) {
    const err = new Error('No valid permissions provided to remove.');
    err.statusCode = 400;
    throw err;
  }

  await prisma.rolePermission.deleteMany({
    where: {
      roleId,
      permissionId: { in: targetPermissionIds }
    }
  });

  return getRoleById(roleId);
};

/**
 * List all available Permissions in the system
 */
export const listPermissions = async ({ module, search, grouped = false } = {}) => {
  const where = {};

  if (module) {
    where.module = module.trim().toUpperCase();
  }

  if (search) {
    where.OR = [
      { code: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } }
    ];
  }

  const permissions = await prisma.permission.findMany({
    where,
    orderBy: [
      { module: 'asc' },
      { code: 'asc' }
    ]
  });

  if (grouped) {
    const groupedPermissions = {};
    for (const p of permissions) {
      if (!groupedPermissions[p.module]) {
        groupedPermissions[p.module] = [];
      }
      groupedPermissions[p.module].push({
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description || null
      });
    }
    return {
      grouped: true,
      totalPermissions: permissions.length,
      modules: groupedPermissions
    };
  }

  return {
    grouped: false,
    totalPermissions: permissions.length,
    permissions: permissions.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      module: p.module,
      description: p.description || null,
      createdAt: p.createdAt
    }))
  };
};

/**
 * Helper to resolve user account and account type
 */
export const resolveUserAccount = async (userId, userType = 'USER') => {
  const normalizedType = (userType || 'USER').toUpperCase();

  if (normalizedType === 'USER') {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user) return { account: user, userType: 'USER' };
  } else if (normalizedType === 'CONTENT_CREATOR') {
    const creator = await prisma.contentCreator.findUnique({ where: { id: userId } });
    if (creator) return { account: creator, userType: 'CONTENT_CREATOR' };
  } else if (normalizedType === 'ADVOCATE') {
    const adv = await prisma.advocate.findUnique({ where: { id: userId } });
    if (adv) return { account: adv, userType: 'ADVOCATE' };
  } else if (normalizedType === 'ADMIN') {
    const adm = await prisma.admin.findUnique({ where: { id: userId } });
    if (adm) return { account: adm, userType: 'ADMIN' };
  }

  // Fallback search across tables if not found with initial type
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user) return { account: user, userType: 'USER' };

  const creator = await prisma.contentCreator.findUnique({ where: { id: userId } });
  if (creator) return { account: creator, userType: 'CONTENT_CREATOR' };

  const adv = await prisma.advocate.findUnique({ where: { id: userId } });
  if (adv) return { account: adv, userType: 'ADVOCATE' };

  const adm = await prisma.admin.findUnique({ where: { id: userId } });
  if (adm) return { account: adm, userType: 'ADMIN' };

  return { account: null, userType: null };
};

/**
 * Assign a Role to a User (Idempotent)
 */
export const assignRoleToUser = async ({ userId, roleId, roleName, userType = 'USER' }) => {
  const { account, userType: resolvedType } = await resolveUserAccount(userId, userType);

  if (!account) {
    const err = new Error('Target user account not found.');
    err.statusCode = 404;
    throw err;
  }

  let role;
  if (roleId) {
    role = await prisma.role.findUnique({ where: { id: roleId } });
  } else if (roleName) {
    role = await prisma.role.findUnique({ where: { name: roleName.trim().toUpperCase() } });
  }

  if (!role) {
    const err = new Error('Role not found.');
    err.statusCode = 404;
    throw err;
  }

  if (!role.isActive) {
    const err = new Error(`Cannot assign deactivated role '${role.name}'. Please activate the role first.`);
    err.statusCode = 400;
    throw err;
  }

  const userRole = await prisma.userRole.upsert({
    where: {
      userId_roleId: {
        userId,
        roleId: role.id
      }
    },
    update: {
      userType: resolvedType
    },
    create: {
      userId,
      roleId: role.id,
      userType: resolvedType
    },
    include: {
      role: {
        include: {
          permissions: {
            include: {
              permission: true
            }
          }
        }
      }
    }
  });

  return {
    success: true,
    message: `Role '${role.name}' assigned to user successfully.`,
    userRole: {
      id: userRole.id,
      userId: userRole.userId,
      userType: userRole.userType,
      role: formatRoleResponse(userRole.role),
      createdAt: userRole.createdAt
    }
  };
};

/**
 * Remove a Role from a User
 */
export const removeRoleFromUser = async ({ userId, roleId, roleName }) => {
  let targetRoleId = roleId;

  if (!targetRoleId && roleName) {
    const role = await prisma.role.findUnique({ where: { name: roleName.trim().toUpperCase() } });
    if (role) {
      targetRoleId = role.id;
    }
  }

  if (!targetRoleId) {
    const err = new Error('Role ID or Role name is required.');
    err.statusCode = 400;
    throw err;
  }

  const userRole = await prisma.userRole.findUnique({
    where: {
      userId_roleId: {
        userId,
        roleId: targetRoleId
      }
    }
  });

  if (!userRole) {
    const err = new Error('Assigned role not found for this user.');
    err.statusCode = 404;
    throw err;
  }

  await prisma.userRole.delete({
    where: { id: userRole.id }
  });

  return {
    success: true,
    message: 'Role removed from user successfully.'
  };
};

/**
 * Get all roles and permissions assigned to a user
 */
export const getUserRolesAndPermissions = async (userId, userType = null) => {
  const userRoles = await prisma.userRole.findMany({
    where: {
      userId,
      role: { isActive: true }
    },
    include: {
      role: {
        include: {
          permissions: {
            include: {
              permission: true
            }
          }
        }
      }
    }
  });

  const roles = userRoles.map((ur) => formatRoleResponse(ur.role));
  const permissionSet = new Set();
  const permissionsList = [];

  for (const r of roles) {
    for (const p of r.permissions) {
      if (!permissionSet.has(p.code)) {
        permissionSet.add(p.code);
        permissionsList.push(p);
      }
    }
  }

  return {
    userId,
    roles,
    roleNames: roles.map((r) => r.name),
    permissions: permissionsList,
    permissionCodes: Array.from(permissionSet)
  };
};

/**
 * Core Permission Check engine:
 * Evaluates whether a user has the required permission(s).
 */
export const checkUserPermission = async (userId, requiredPermissions = [], userType = null) => {
  if (!requiredPermissions || requiredPermissions.length === 0) {
    return true;
  }

  const permissionsToCheck = Array.isArray(requiredPermissions)
    ? requiredPermissions
    : [requiredPermissions];

  const { permissionCodes, roleNames } = await getUserRolesAndPermissions(userId, userType);

  // Fallback: If user has default CONTENT_CREATOR type and no explicit UserRole yet,
  // load the active CONTENT_CREATOR role from DB
  if (userType && userType.toLowerCase() === 'content_creator' && roleNames.length === 0) {
    const defaultCreatorRole = await prisma.role.findUnique({
      where: { name: 'CONTENT_CREATOR' },
      include: {
        permissions: {
          include: {
            permission: true
          }
        }
      }
    });

    if (defaultCreatorRole && defaultCreatorRole.isActive) {
      const defaultCodes = defaultCreatorRole.permissions.map((rp) => rp.permission?.code).filter(Boolean);
      defaultCodes.forEach((code) => permissionCodes.push(code));
    }
  }

  const userPermissionSet = new Set(permissionCodes);

  // Returns true if ANY of the required permissions is present
  return permissionsToCheck.some((perm) => userPermissionSet.has(perm));
};

/**
 * List Users for Admin and Lead User management
 */
export const listUsersAdmin = async ({ page = 1, limit = 20, search, status, role } = {}) => {
  const where = {};

  if (status) {
    where.status = status;
  }

  if (search) {
    where.OR = [
      { fullName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search, mode: 'insensitive' } },
      { city: { contains: search, mode: 'insensitive' } },
      { state: { contains: search, mode: 'insensitive' } }
    ];
  }

  const skip = (page - 1) * limit;

  const [users, totalUsers] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        city: true,
        state: true,
        pincode: true,
        emailVerified: true,
        phoneVerified: true,
        isActive: true,
        status: true,
        createdAt: true,
        updatedAt: true
      }
    }),
    prisma.user.count({ where })
  ]);

  // Fetch assigned roles for these users
  const userIds = users.map((u) => u.id);
  const userRoles = await prisma.userRole.findMany({
    where: {
      userId: { in: userIds }
    },
    include: {
      role: {
        select: {
          id: true,
          name: true,
          displayName: true,
          isActive: true
        }
      }
    }
  });

  const rolesByUserId = {};
  userRoles.forEach((ur) => {
    if (!rolesByUserId[ur.userId]) {
      rolesByUserId[ur.userId] = [];
    }
    rolesByUserId[ur.userId].push({
      id: ur.role.id,
      name: ur.role.name,
      displayName: ur.role.displayName,
      isActive: ur.role.isActive
    });
  });

  let formattedUsers = users.map((u) => ({
    ...u,
    assignedRoles: rolesByUserId[u.id] || []
  }));

  if (role) {
    const filterRole = role.trim().toUpperCase();
    formattedUsers = formattedUsers.filter((u) =>
      u.assignedRoles.some((r) => r.name === filterRole)
    );
  }

  const totalPages = Math.ceil(totalUsers / limit) || 1;

  return {
    users: formattedUsers,
    pagination: {
      currentPage: page,
      limit,
      totalUsers,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1
    }
  };
};

/**
 * Get User Details by ID for Admin/Lead User
 */
export const getUserDetailsAdmin = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  if (!user) {
    const err = new Error('User not found.');
    err.statusCode = 404;
    throw err;
  }

  const userRolesInfo = await getUserRolesAndPermissions(userId, 'USER');

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    city: user.city,
    state: user.state,
    pincode: user.pincode,
    emailVerified: user.emailVerified,
    phoneVerified: user.phoneVerified,
    isActive: user.isActive,
    status: user.status,
    deletionRequestedAt: user.deletionRequestedAt,
    scheduledDeletionAt: user.scheduledDeletionAt,
    roles: userRolesInfo.roles,
    permissions: userRolesInfo.permissions,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
};
