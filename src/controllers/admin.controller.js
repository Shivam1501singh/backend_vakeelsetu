import prisma from '../lib/prisma.js';
import { signToken, sendTokenCookie, clearTokenCookie } from '../utils/jwt.js';
import bcrypt from 'bcryptjs';
import { computeEffectiveOnlineStatus } from '../utils/advocateStatus.js';
import { finalizeAdvocateDeletion } from '../services/advocateDeletion.service.js';
import {
  adminApproveAdvocateSchema,
  adminUpdateAdvocateCallAvailabilitySchema,
  adminUpdateAdvocateStatusSchema,
  createStaffAccountSchema,
  updateStaffRolesSchema
} from '../validators/admin.validator.js';
import * as blogValidator from '../validators/blog.validator.js';
import { getCurrentUserProfile } from '../services/auth.service.js';
import { checkUserPermission } from '../services/rbac.service.js';

/**
 * Admin / Staff Unified Login
 * POST /api/admin/login
 * Validates credentials against environment variables (Admin) or ContentCreator table (Staff)
 */
export const loginAdmin = async (req, res, next) => {
  try {
    const validated = blogValidator.loginSchema.parse(req.body || {});
    const { email, password } = validated;

    const normalizedInputEmail = email.toLowerCase().trim();
    const envAdminEmail = process.env.ADMIN_USER_EMAIL;
    const envAdminPassword = process.env.ADMIN_USER_PASSWORD;

    // 1. If email/password match ADMIN_USER_EMAIL / ADMIN_USER_PASSWORD -> signToken({ id: 'admin', type: 'admin' })
    // If env admin creds are missing, skip step 1 (do not 500)
    if (envAdminEmail && envAdminPassword) {
      const normalizedEnvEmail = envAdminEmail.toLowerCase().trim();
      if (normalizedInputEmail === normalizedEnvEmail && password === envAdminPassword) {
        const token = signToken({ id: 'admin', type: 'admin' });
        sendTokenCookie(res, token);

        return res.status(200).json({
          success: true,
          message: 'Admin login successful',
          token,
          admin: {
            id: 'admin',
            fullName: 'System Administrator',
            email: envAdminEmail,
            accountType: 'ADMIN',
            roles: ['ADMIN'],
            permissions: ['*']
          }
        });
      }
    }

    // 2. Else find prisma.contentCreator by lowercased email; if found, isActive, and bcrypt.compare passes ->
    //    signToken({ id: creator.id, type: 'content_creator' })
    const creator = await prisma.contentCreator.findUnique({
      where: { email: normalizedInputEmail }
    });

    if (creator && creator.isActive) {
      const isMatch = await bcrypt.compare(password, creator.passwordHash);
      if (isMatch) {
        const token = signToken({ id: creator.id, type: 'content_creator' });
        sendTokenCookie(res, token);

        const profile = await getCurrentUserProfile(creator.id, 'content_creator');

        return res.status(200).json({
          success: true,
          message: 'Admin login successful',
          token,
          admin: {
            id: creator.id,
            fullName: creator.fullName,
            email: creator.email,
            accountType: 'CONTENT_CREATOR',
            roles: profile?.roles || ['CONTENT_CREATOR'],
            permissions: profile?.permissions || []
          }
        });
      }
    }

    // 3. Else 401 { success:false, message:'Invalid email or password.' }
    return res.status(401).json({
      success: false,
      message: 'Invalid email or password.'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create Staff Account (Content Creator) with inline Roles
 * POST /api/admin/content-creators
 */
export const createContentCreator = async (req, res, next) => {
  try {
    const validated = createStaffAccountSchema.parse(req.body);
    const { fullName, email, password, roleIds, roleNames } = validated;

    const normalizedEmail = email.toLowerCase().trim();

    // Reject if email matches env admin
    const envAdminEmail = (process.env.ADMIN_USER_EMAIL || '').toLowerCase().trim();
    if (envAdminEmail && normalizedEmail === envAdminEmail) {
      return res.status(400).json({
        success: false,
        message: 'This email is reserved for the main admin account.'
      });
    }

    // Check duplicate staff email
    const existing = await prisma.contentCreator.findUnique({
      where: { email: normalizedEmail }
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'A staff account with this email already exists.'
      });
    }

    // Check privilege escalation: caller must have roles:manage or be main admin if roles provided
    const isCallerAdmin = req.user?.type?.toLowerCase() === 'admin' || req.user?.role === 'ADMIN';
    const rolesProvided = (Array.isArray(roleIds) && roleIds.length > 0) || (Array.isArray(roleNames) && roleNames.length > 0);

    if (rolesProvided && !isCallerAdmin) {
      const hasRolesManage = await checkUserPermission(req.user.id, ['roles:manage'], req.user.type);
      if (!hasRolesManage) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Requires roles:manage permission to assign roles.'
        });
      }
    }

    // Resolve roles (default to CONTENT_CREATOR if neither provided)
    let targetRoleIds = roleIds || [];
    let targetRoleNames = roleNames || [];

    if (targetRoleIds.length === 0 && targetRoleNames.length === 0) {
      targetRoleNames = ['CONTENT_CREATOR'];
    }

    const [rolesById, rolesByName] = await Promise.all([
      targetRoleIds.length > 0
        ? prisma.role.findMany({
            where: { id: { in: targetRoleIds } },
            include: {
              permissions: {
                include: { permission: true }
              }
            }
          })
        : [],
      targetRoleNames.length > 0
        ? prisma.role.findMany({
            where: { name: { in: targetRoleNames } },
            include: {
              permissions: {
                include: { permission: true }
              }
            }
          })
        : []
    ]);

    const invalidRoles = [];
    const rolesByIdMap = new Map(rolesById.map((r) => [r.id, r]));
    const rolesByNameMap = new Map(rolesByName.map((r) => [r.name, r]));

    for (const rid of targetRoleIds) {
      const r = rolesByIdMap.get(rid);
      if (!r || !r.isActive) {
        invalidRoles.push(rid);
      }
    }

    for (const rname of targetRoleNames) {
      const r = rolesByNameMap.get(rname);
      if (!r || !r.isActive) {
        invalidRoles.push(rname);
      }
    }

    if (invalidRoles.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'One or more roles are invalid or inactive.',
        invalidRoles: Array.from(new Set(invalidRoles))
      });
    }

    // Merge and deduplicate resolved roles
    const roleMap = new Map();
    for (const r of rolesById) roleMap.set(r.id, r);
    for (const r of rolesByName) roleMap.set(r.id, r);
    const resolvedRoles = Array.from(roleMap.values());

    const permSet = new Set();
    for (const r of resolvedRoles) {
      for (const rp of r.permissions) {
        if (rp.permission?.code) {
          permSet.add(rp.permission.code);
        }
      }
    }
    const permissions = Array.from(permSet);

    const passwordHash = await bcrypt.hash(password, 10);

    const creator = await prisma.$transaction(async (tx) => {
      const newCreator = await tx.contentCreator.create({
        data: {
          fullName: fullName.trim(),
          email: normalizedEmail,
          passwordHash
        }
      });

      await tx.userRole.createMany({
        data: resolvedRoles.map((r) => ({
          userId: newCreator.id,
          roleId: r.id,
          userType: 'CONTENT_CREATOR'
        })),
        skipDuplicates: true
      });

      return newCreator;
    });

    return res.status(201).json({
      success: true,
      message: 'Staff account created successfully',
      creator: {
        id: creator.id,
        name: creator.fullName,
        fullName: creator.fullName,
        email: creator.email,
        isActive: creator.isActive,
        accountType: 'CONTENT_CREATOR',
        role: resolvedRoles[0]?.name || 'CONTENT_CREATOR',
        roles: resolvedRoles.map((r) => r.name),
        roleDetails: resolvedRoles.map((r) => ({
          id: r.id,
          name: r.name,
          displayName: r.displayName
        })),
        permissions,
        createdAt: creator.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * List Content Creator Staff with Roles (ADMIN / content_creators:view)
 * GET /api/admin/content-creators
 */
export const listContentCreators = async (req, res, next) => {
  try {
    const creators = await prisma.contentCreator.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        fullName: true,
        email: true,
        isActive: true,
        createdAt: true
      }
    });

    const creatorIds = creators.map((c) => c.id);
    const userRoles = await prisma.userRole.findMany({
      where: { userId: { in: creatorIds } },
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

    const rolesByUserId = new Map();
    for (const ur of userRoles) {
      if (!rolesByUserId.has(ur.userId)) {
        rolesByUserId.set(ur.userId, []);
      }
      if (ur.role) {
        rolesByUserId.get(ur.userId).push({
          id: ur.role.id,
          name: ur.role.name,
          displayName: ur.role.displayName,
          isActive: ur.role.isActive
        });
      }
    }

    const formattedCreators = creators.map((c) => {
      const userRolesList = rolesByUserId.get(c.id) || [];
      const roleNames = userRolesList.map((r) => r.name);
      return {
        ...c,
        name: c.fullName,
        role: roleNames[0] || 'CONTENT_CREATOR',
        roles: roleNames.length > 0 ? roleNames : ['CONTENT_CREATOR'],
        roleDetails: userRolesList
      };
    });

    return res.status(200).json({
      success: true,
      creators: formattedCreators
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get Staff Details & Permissions (content_creators:view)
 * GET /api/admin/content-creators/:id
 */
export const getContentCreatorDetails = async (req, res, next) => {
  try {
    const { id } = req.params;

    const creator = await prisma.contentCreator.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        email: true,
        isActive: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!creator) {
      return res.status(404).json({
        success: false,
        message: 'Staff account not found.'
      });
    }

    const userRoles = await prisma.userRole.findMany({
      where: { userId: creator.id },
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

    const activeRoles = userRoles
      .filter((ur) => ur.role && ur.role.isActive)
      .map((ur) => ur.role);

    let roles = [];
    let permissions = [];
    let effectiveDefaultRole = undefined;

    if (activeRoles.length > 0) {
      roles = activeRoles.map((r) => ({
        id: r.id,
        name: r.name,
        displayName: r.displayName,
        isActive: r.isActive
      }));

      const permSet = new Set();
      for (const r of activeRoles) {
        for (const rp of r.permissions) {
          if (rp.permission?.code) {
            permSet.add(rp.permission.code);
          }
        }
      }
      permissions = Array.from(permSet);
    } else {
      roles = [];
      effectiveDefaultRole = 'CONTENT_CREATOR';
      const defaultRole = await prisma.role.findUnique({
        where: { name: 'CONTENT_CREATOR' },
        include: {
          permissions: {
            include: {
              permission: true
            }
          }
        }
      });
      if (defaultRole && defaultRole.isActive) {
        permissions = defaultRole.permissions
          .map((rp) => rp.permission?.code)
          .filter(Boolean);
      }
    }

    const roleNames = activeRoles.map((r) => r.name);
    return res.status(200).json({
      success: true,
      creator: {
        id: creator.id,
        name: creator.fullName,
        fullName: creator.fullName,
        email: creator.email,
        isActive: creator.isActive,
        accountType: 'CONTENT_CREATOR',
        role: roleNames[0] || effectiveDefaultRole || 'CONTENT_CREATOR',
        roles: roleNames.length > 0 ? roleNames : ['CONTENT_CREATOR'],
        roleDetails: roles,
        ...(effectiveDefaultRole ? { effectiveDefaultRole } : {}),
        permissions,
        createdAt: creator.createdAt,
        updatedAt: creator.updatedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update Staff Roles (roles:manage)
 * PUT /api/admin/content-creators/:id/roles
 */
export const updateStaffRoles = async (req, res, next) => {
  try {
    const { id } = req.params;
    const validated = updateStaffRolesSchema.parse(req.body);

    const creator = await prisma.contentCreator.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        email: true,
        isActive: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!creator) {
      return res.status(404).json({
        success: false,
        message: 'Staff account not found.'
      });
    }

    const targetRoleIds = validated.roleIds || [];
    const targetRoleNames = validated.roleNames || [];

    const [rolesById, rolesByName] = await Promise.all([
      targetRoleIds.length > 0
        ? prisma.role.findMany({
            where: { id: { in: targetRoleIds } },
            include: {
              permissions: {
                include: { permission: true }
              }
            }
          })
        : [],
      targetRoleNames.length > 0
        ? prisma.role.findMany({
            where: { name: { in: targetRoleNames } },
            include: {
              permissions: {
                include: { permission: true }
              }
            }
          })
        : []
    ]);

    const invalidRoles = [];
    const rolesByIdMap = new Map(rolesById.map((r) => [r.id, r]));
    const rolesByNameMap = new Map(rolesByName.map((r) => [r.name, r]));

    for (const rid of targetRoleIds) {
      const r = rolesByIdMap.get(rid);
      if (!r || !r.isActive) {
        invalidRoles.push(rid);
      }
    }

    for (const rname of targetRoleNames) {
      const r = rolesByNameMap.get(rname);
      if (!r || !r.isActive) {
        invalidRoles.push(rname);
      }
    }

    if (invalidRoles.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'One or more roles are invalid or inactive.',
        invalidRoles: Array.from(new Set(invalidRoles))
      });
    }

    const roleMap = new Map();
    for (const r of rolesById) roleMap.set(r.id, r);
    for (const r of rolesByName) roleMap.set(r.id, r);
    const resolvedRoles = Array.from(roleMap.values());

    await prisma.$transaction([
      prisma.userRole.deleteMany({
        where: { userId: creator.id }
      }),
      prisma.userRole.createMany({
        data: resolvedRoles.map((r) => ({
          userId: creator.id,
          roleId: r.id,
          userType: 'CONTENT_CREATOR'
        })),
        skipDuplicates: true
      })
    ]);

    const permSet = new Set();
    for (const r of resolvedRoles) {
      for (const rp of r.permissions) {
        if (rp.permission?.code) {
          permSet.add(rp.permission.code);
        }
      }
    }
    const permissions = Array.from(permSet);

    return res.status(200).json({
      success: true,
      message: 'Staff roles updated successfully',
      creator: {
        id: creator.id,
        name: creator.fullName,
        fullName: creator.fullName,
        email: creator.email,
        isActive: creator.isActive,
        accountType: 'CONTENT_CREATOR',
        role: resolvedRoles[0]?.name || 'CONTENT_CREATOR',
        roles: resolvedRoles.map((r) => r.name),
        roleDetails: resolvedRoles.map((r) => ({
          id: r.id,
          name: r.name,
          displayName: r.displayName,
          isActive: r.isActive
        })),
        permissions,
        createdAt: creator.createdAt,
        updatedAt: creator.updatedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * List All Advocates for Admin Management
 * GET /api/admin/advocates
 */
export const listAdvocates = async (req, res, next) => {
  try {
    const advocates = await prisma.advocate.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { likes: true }
        }
      }
    });

    const safeAdvocates = advocates.map(adv => ({
      id: adv.id,
      name: adv.fullName,
      fullName: adv.fullName,
      email: adv.email,
      phone: adv.phone,
      status: adv.status,
      accountStatus: adv.status,
      approvalStatus: adv.approvalStatus,
      callAvailability: adv.callAvailability ?? false,
      rejectionReason: adv.rejectionReason || null,
      submittedForApprovalAt: adv.submittedForApprovalAt || null,
      approvedAt: adv.approvedAt || null,
      likeCount: adv._count?.likes ?? 0,
      lawType: adv.bestPracticeArea || (adv.practiceAreas && adv.practiceAreas.length > 0 ? adv.practiceAreas[0] : null),
      barCouncilId: adv.barCouncilId,
      state: adv.state,
      city: adv.city,
      pincode: adv.pincode,
      isOnline: computeEffectiveOnlineStatus(adv.isOnline, adv.lastSeenAt),
      lastSeenAt: adv.lastSeenAt,
      createdAt: adv.createdAt
    }));

    return res.status(200).json({
      success: true,
      advocates: safeAdvocates
    });
  } catch (error) {
    next(error);
  }
};

/**
 * List Pending Advocates for Admin Approval (ADMIN only)
 * GET /api/admin/advocates/pending
 */
export const listPendingAdvocates = async (req, res, next) => {
  try {
    const advocates = await prisma.advocate.findMany({
      where: { approvalStatus: 'PENDING' },
      orderBy: { submittedForApprovalAt: 'desc' }
    });

    const data = advocates.map(adv => ({
      id: adv.id,
      name: adv.fullName,
      fullName: adv.fullName,
      email: adv.email,
      phone: adv.phone,
      barId: adv.barCouncilId,
      barCouncilId: adv.barCouncilId,
      profileImage: adv.profilePhotoUrl,
      profilePhotoUrl: adv.profilePhotoUrl,
      lawType: adv.bestPracticeArea || (adv.practiceAreas && adv.practiceAreas.length > 0 ? adv.practiceAreas[0] : null),
      bestPracticeArea: adv.bestPracticeArea,
      experience: adv.experienceYears,
      experienceYears: adv.experienceYears,
      city: adv.city,
      state: adv.state,
      pincode: adv.pincode,
      profileCompleted: true,
      approvalStatus: adv.approvalStatus,
      callAvailability: adv.callAvailability ?? false,
      accountStatus: adv.status,
      submittedForApprovalAt: adv.submittedForApprovalAt,
      createdAt: adv.createdAt
    }));

    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Review Advocate Profile (ADMIN only)
 * GET /api/admin/advocates/:advocateId
 */
export const getAdvocateReviewProfile = async (req, res, next) => {
  try {
    const { advocateId } = req.params;

    const advocate = await prisma.advocate.findUnique({
      where: { id: advocateId },
      include: {
        _count: {
          select: { likes: true, reviews: true }
        }
      }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate not found'
      });
    }

    // Exclude passwordHash and sensitive authentication secrets
    const { passwordHash, aadhaarNumber, ...safeAdvocate } = advocate;

    const advocateData = {
      ...safeAdvocate,
      name: advocate.fullName,
      barId: advocate.barCouncilId,
      profileImage: advocate.profilePhotoUrl,
      lawType: advocate.bestPracticeArea || (advocate.practiceAreas && advocate.practiceAreas.length > 0 ? advocate.practiceAreas[0] : null),
      experience: advocate.experienceYears,
      accountStatus: advocate.status,
      callAvailability: advocate.callAvailability ?? false,
      likeCount: advocate._count?.likes ?? 0
    };

    return res.status(200).json({
      success: true,
      data: advocateData,
      advocate: advocateData
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Approve Advocate Profile (ADMIN only)
 * PATCH /api/admin/advocates/:advocateId/approve
 */
export const approveAdvocate = async (req, res, next) => {
  try {
    const { advocateId } = req.params;
    const validated = req.body && Object.keys(req.body).length > 0
      ? adminApproveAdvocateSchema.parse(req.body)
      : {};

    const advocate = await prisma.advocate.findUnique({
      where: { id: advocateId }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate not found'
      });
    }

    // On approval: approvalStatus = APPROVED, accountStatus = ACTIVE (unless intentionally blocked)
    const newStatus = advocate.status === 'BLOCKED' ? 'BLOCKED' : 'ACTIVE';
    const newCallAvailability = validated.callAvailability !== undefined
      ? validated.callAvailability
      : advocate.callAvailability;

    const updated = await prisma.advocate.update({
      where: { id: advocateId },
      data: {
        approvalStatus: 'APPROVED',
        status: newStatus,
        callAvailability: newCallAvailability,
        approvedAt: new Date(),
        approvedById: req.user?.id || null,
        rejectionReason: null
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Advocate profile approved successfully',
      data: {
        id: updated.id,
        approvalStatus: updated.approvalStatus,
        callAvailability: updated.callAvailability,
        status: updated.status,
        accountStatus: updated.status,
        approvedAt: updated.approvedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Reject Advocate Profile (ADMIN only)
 * PATCH /api/admin/advocates/:advocateId/reject
 */
export const rejectAdvocate = async (req, res, next) => {
  try {
    const { advocateId } = req.params;
    const { reason, rejectionReason } = req.body || {};
    const finalReason = reason || rejectionReason || 'Profile information requires correction';

    const advocate = await prisma.advocate.findUnique({
      where: { id: advocateId }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate not found'
      });
    }

    const updated = await prisma.advocate.update({
      where: { id: advocateId },
      data: {
        approvalStatus: 'REJECTED',
        callAvailability: false,
        rejectedAt: new Date(),
        rejectedById: req.user?.id || null,
        rejectionReason: finalReason
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Advocate profile rejected',
      data: {
        id: updated.id,
        approvalStatus: updated.approvalStatus,
        callAvailability: updated.callAvailability,
        status: updated.status,
        accountStatus: updated.status,
        rejectionReason: updated.rejectionReason,
        rejectedAt: updated.rejectedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Block / Activate Advocate / Update Status (ADMIN only)
 * PATCH /api/admin/advocates/:advocateId/status
 */
export const updateAdvocateStatus = async (req, res, next) => {
  try {
    const { advocateId } = req.params;
    const validated = adminUpdateAdvocateStatusSchema.parse(req.body);

    if (!validated.status && validated.callAvailability === undefined) {
      return res.status(400).json({
        success: false,
        message: "Please provide 'status' ('ACTIVE'/'BLOCKED') or 'callAvailability'."
      });
    }

    const advocate = await prisma.advocate.findUnique({
      where: { id: advocateId }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate not found'
      });
    }

    const updateData = {};
    if (validated.status) {
      updateData.status = validated.status;
    }
    if (validated.callAvailability !== undefined) {
      updateData.callAvailability = validated.callAvailability;
    }

    const updated = await prisma.advocate.update({
      where: { id: advocateId },
      data: updateData
    });

    return res.status(200).json({
      success: true,
      message: 'Advocate status updated successfully',
      data: {
        id: updated.id,
        status: updated.status,
        callAvailability: updated.callAvailability
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin Update Advocate Call Availability
 * PATCH /api/admin/advocates/:advocateId/call-availability
 */
export const updateAdvocateCallAvailability = async (req, res, next) => {
  try {
    const { advocateId } = req.params;
    const validated = adminUpdateAdvocateCallAvailabilitySchema.parse(req.body);

    const advocate = await prisma.advocate.findUnique({
      where: { id: advocateId }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate not found'
      });
    }

    const updated = await prisma.advocate.update({
      where: { id: advocateId },
      data: {
        callAvailability: validated.callAvailability
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Advocate call availability updated successfully',
      data: {
        id: updated.id,
        callAvailability: updated.callAvailability,
        approvalStatus: updated.approvalStatus,
        status: updated.status
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * List Pending Advocate Deletion Requests (ADMIN only)
 * GET /api/admin/advocates/deletion-requests
 */
export const listPendingAdvocateDeletionRequests = async (req, res, next) => {
  try {
    const advocates = await prisma.advocate.findMany({
      where: { deletionStatus: 'PENDING' },
      orderBy: { deletionRequestedAt: 'desc' }
    });

    const data = advocates.map(adv => ({
      id: adv.id,
      advocateId: adv.id,
      name: adv.fullName,
      fullName: adv.fullName,
      email: adv.email,
      phone: adv.phone,
      barId: adv.barCouncilId,
      barCouncilId: adv.barCouncilId,
      profileImage: adv.profilePhotoUrl,
      profilePhotoUrl: adv.profilePhotoUrl,
      approvalStatus: adv.approvalStatus,
      status: adv.status,
      accountStatus: adv.status,
      deletionStatus: adv.deletionStatus,
      deletionRequestedAt: adv.deletionRequestedAt,
      scheduledDeletionAt: adv.scheduledDeletionAt,
      createdAt: adv.createdAt
    }));

    return res.status(200).json({
      success: true,
      data,
      deletionRequests: data
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin Cancel Advocate Deletion Request
 * PATCH /api/admin/advocates/:advocateId/cancel-deletion
 */
export const cancelAdvocateDeletion = async (req, res, next) => {
  try {
    const { advocateId } = req.params;

    const advocate = await prisma.advocate.findUnique({
      where: { id: advocateId }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate not found'
      });
    }

    if (advocate.deletionStatus !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: 'Advocate account deletion request is not pending.'
      });
    }

    const updated = await prisma.advocate.update({
      where: { id: advocateId },
      data: {
        deletionStatus: 'NONE',
        deletionRequestedAt: null,
        scheduledDeletionAt: null
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Advocate account deletion has been cancelled successfully.',
      data: {
        id: updated.id,
        deletionStatus: updated.deletionStatus,
        status: updated.status,
        approvalStatus: updated.approvalStatus
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin Permanent Delete Advocate Account
 * DELETE /api/admin/advocates/:advocateId/permanent
 */
export const permanentDeleteAdvocate = async (req, res, next) => {
  try {
    const { advocateId } = req.params;

    const advocate = await prisma.advocate.findUnique({
      where: { id: advocateId }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate not found'
      });
    }

    if (advocate.deletionStatus !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: 'Advocate account deletion request is not pending.'
      });
    }

    await finalizeAdvocateDeletion(advocateId);

    return res.status(200).json({
      success: true,
      message: 'Advocate account permanently deleted.'
    });
  } catch (error) {
    next(error);
  }
};

