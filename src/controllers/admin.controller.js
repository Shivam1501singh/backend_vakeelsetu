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
  updateStaffRolesSchema,
  adminAdvocateProfileUpdateSchema,
  rejectOfficeChangeSchema,
  rejectProfileChangeSchema
} from '../validators/admin.validator.js';
import { APPROVAL_FIELDS, FIELD_LABELS } from './advocate.profile.controller.js';
import * as blogValidator from '../validators/blog.validator.js';
import { getCurrentUserProfile } from '../services/auth.service.js';
import { checkUserPermission } from '../services/rbac.service.js';
import { deleteFromCloudinary } from '../services/cloudinary.service.js';
import { formatPricingSummary } from '../services/advocateBooking/pricing.js';

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
    const { approvalStatus } = req.query;
    const where = {};

    if (approvalStatus !== undefined) {
      const normalizedStatus = String(approvalStatus).trim().toUpperCase();
      if (!['PENDING', 'APPROVED', 'REJECTED'].includes(normalizedStatus)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid approvalStatus. Allowed: PENDING, APPROVED, REJECTED'
        });
      }
      where.approvalStatus = normalizedStatus;
    }

    const advocates = await prisma.advocate.findMany({
      where,
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
      rejectedAt: adv.rejectedAt || null,
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
      // TODO: remove fallback after backfill-office-address --apply
      officeAddress: adv.officeAddress || adv.completeAddress || null,
      officePhotoUrl: adv.officePhotoUrl ?? null,
      officeLatitude: adv.officeLatitude ?? null,
      officeLongitude: adv.officeLongitude ?? null,
      officeLocationUpdatedAt: adv.officeLocationUpdatedAt ?? null,
      office: {
        address: adv.officeAddress || adv.completeAddress || null,
        photoUrl: adv.officePhotoUrl ?? null,
        latitude: adv.officeLatitude ?? null,
        longitude: adv.officeLongitude ?? null,
        updatedAt: adv.officeLocationUpdatedAt ?? null
      },
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
 * Shared formatter for advocate review / detail responses
 * Ensures passwordHash, aadhaarNumber, and officePhotoPublicId are never leaked
 */
export const formatAdvocateReviewData = (advocate) => {
  if (!advocate) return null;
  const {
    passwordHash,
    aadhaarNumber,
    completeAddress,
    officePhotoPublicId,
    pendingOfficeChange,
    pendingProfileChange,
    ...safeAdvocate
  } = advocate;

  const officeLatitude = advocate.officeLatitude ?? null;
  const officeLongitude = advocate.officeLongitude ?? null;
  const officePhotoUrl = advocate.officePhotoUrl ?? null;
  const officeLocationUpdatedAt = advocate.officeLocationUpdatedAt ?? null;
  // TODO: remove fallback after backfill-office-address --apply
  const officeAddress = advocate.officeAddress || advocate.completeAddress || null;
  const officeMapUrl = (officeLatitude !== null && officeLongitude !== null)
    ? `https://www.google.com/maps?q=${officeLatitude},${officeLongitude}`
    : null;

  const profileChange = advocate.profileChangeStatus ? {
    status: advocate.profileChangeStatus,
    submittedAt: advocate.profileChangeSubmittedAt,
    changedFields: advocate.pendingProfileChange ? Object.keys(advocate.pendingProfileChange) : []
  } : null;

  const pricing = formatPricingSummary(advocate);

  return {
    ...safeAdvocate,
    voiceCallPricePer15Min: advocate.voiceCallPricePer15Min !== null ? Number(advocate.voiceCallPricePer15Min) : null,
    videoCallPricePer15Min: advocate.videoCallPricePer15Min !== null ? Number(advocate.videoCallPricePer15Min) : null,
    offlineVisitingFee: advocate.offlineVisitingFee !== null ? Number(advocate.offlineVisitingFee) : null,
    officeVisitDurationMinutes: advocate.officeVisitDurationMinutes !== null ? advocate.officeVisitDurationMinutes : null,
    pricing,
    name: advocate.fullName,
    barId: advocate.barCouncilId,
    profileImage: advocate.profilePhotoUrl,
    lawType: advocate.bestPracticeArea || (advocate.practiceAreas && advocate.practiceAreas.length > 0 ? advocate.practiceAreas[0] : null),
    experience: advocate.experienceYears,
    accountStatus: advocate.status,
    callAvailability: advocate.callAvailability ?? false,
    likeCount: advocate._count?.likes ?? 0,
    officeAddress,
    officeLatitude,
    officeLongitude,
    officePhotoUrl,
    officeLocationUpdatedAt,
    officeMapUrl,
    office: {
      address: officeAddress,
      photoUrl: officePhotoUrl,
      latitude: officeLatitude,
      longitude: officeLongitude,
      updatedAt: officeLocationUpdatedAt
    },
    profileChange
  };
};

/**
 * List Rejected Advocates for Admin Management (ADMIN / advocates:view)
 * GET /api/admin/advocates/rejected
 */
export const listRejectedAdvocates = async (req, res, next) => {
  try {
    const { search } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const where = { approvalStatus: 'REJECTED' };

    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { barCouncilId: { contains: q, mode: 'insensitive' } }
      ];
    }

    const [total, advocates] = await Promise.all([
      prisma.advocate.count({ where }),
      prisma.advocate.findMany({
        where,
        orderBy: { rejectedAt: 'desc' },
        skip,
        take: limit
      })
    ]);

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
      // TODO: remove fallback after backfill-office-address --apply
      officeAddress: adv.officeAddress || adv.completeAddress || null,
      officePhotoUrl: adv.officePhotoUrl ?? null,
      officeLatitude: adv.officeLatitude ?? null,
      officeLongitude: adv.officeLongitude ?? null,
      officeLocationUpdatedAt: adv.officeLocationUpdatedAt ?? null,
      office: {
        address: adv.officeAddress || adv.completeAddress || null,
        photoUrl: adv.officePhotoUrl ?? null,
        latitude: adv.officeLatitude ?? null,
        longitude: adv.officeLongitude ?? null,
        updatedAt: adv.officeLocationUpdatedAt ?? null
      },
      approvalStatus: adv.approvalStatus,
      rejectionReason: adv.rejectionReason,
      rejectedAt: adv.rejectedAt,
      rejectedById: adv.rejectedById,
      submittedForApprovalAt: adv.submittedForApprovalAt,
      accountStatus: adv.status,
      callAvailability: adv.callAvailability ?? false,
      createdAt: adv.createdAt
    }));

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1
      }
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

    const advocateData = formatAdvocateReviewData(advocate);

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
 * Update Advocate Profile by Admin (ADMIN / advocates:edit)
 * PATCH /api/admin/advocates/:advocateId/profile
 */
export const updateAdvocateProfileByAdmin = async (req, res, next) => {
  try {
    const { advocateId } = req.params;
    const validated = adminAdvocateProfileUpdateSchema.parse(req.body);

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

    // Check Bar Council ID uniqueness if provided and differs from current
    if (validated.barCouncilId !== undefined && validated.barCouncilId !== advocate.barCouncilId) {
      const duplicate = await prisma.advocate.findFirst({
        where: {
          barCouncilId: validated.barCouncilId,
          NOT: { id: advocateId }
        }
      });
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: 'Bar Council ID is already registered to another advocate.'
        });
      }
    }

    // Build updateData using alias mapping
    const updateData = {};

    // Admin-editable identity fields
    if (validated.fullName !== undefined) updateData.fullName = validated.fullName;
    if (validated.gender !== undefined) updateData.gender = validated.gender;
    if (validated.barCouncilId !== undefined) updateData.barCouncilId = validated.barCouncilId;

    // Direct professional fields
    if (validated.casesHandled !== undefined) updateData.casesHandled = validated.casesHandled;
    if (validated.practiceAreas !== undefined) updateData.practiceAreas = validated.practiceAreas;
    if (validated.bestPracticeArea !== undefined) updateData.bestPracticeArea = validated.bestPracticeArea;
    if (validated.topCourtPractised !== undefined) updateData.topCourtPractised = validated.topCourtPractised;
    if (validated.courtPractice !== undefined) updateData.courtPractice = validated.courtPractice;
    if (validated.voiceCallPricePer15Min !== undefined) updateData.voiceCallPricePer15Min = validated.voiceCallPricePer15Min;
    if (validated.videoCallPricePer15Min !== undefined) updateData.videoCallPricePer15Min = validated.videoCallPricePer15Min;
    if (validated.offlineVisitingFee !== undefined) updateData.offlineVisitingFee = validated.offlineVisitingFee;
    if (validated.officeVisitDurationMinutes !== undefined) updateData.officeVisitDurationMinutes = validated.officeVisitDurationMinutes;
    if (validated.state !== undefined) updateData.state = validated.state;
    if (validated.city !== undefined) updateData.city = validated.city;
    if (validated.pincode !== undefined) updateData.pincode = validated.pincode;
    if (validated.officeAddress !== undefined) updateData.officeAddress = validated.officeAddress;

    // Validate merged office visit pair (fee + duration) only when at least one is being updated
    if (validated.offlineVisitingFee !== undefined || validated.officeVisitDurationMinutes !== undefined) {
      const liveFee = advocate.offlineVisitingFee != null ? Number(advocate.offlineVisitingFee) : null;
      const liveDuration = advocate.officeVisitDurationMinutes != null ? advocate.officeVisitDurationMinutes : null;

      const effectiveOfflineFee = validated.offlineVisitingFee !== undefined
        ? validated.offlineVisitingFee
        : liveFee;
      const effectiveOfficeDuration = validated.officeVisitDurationMinutes !== undefined
        ? validated.officeVisitDurationMinutes
        : liveDuration;

      const hasMergedFee = effectiveOfflineFee !== null && effectiveOfflineFee !== undefined && !Number.isNaN(effectiveOfflineFee);
      const hasMergedDuration = effectiveOfficeDuration !== null && effectiveOfficeDuration !== undefined;

      if (hasMergedFee !== hasMergedDuration) {
        return res.status(400).json({
          success: false,
          message: 'offlineVisitingFee and officeVisitDurationMinutes must both be set, or both be null.'
        });
      }
    }

    // Aliases
    if (validated.bio !== undefined) {
      updateData.about = validated.bio;
    } else if (validated.about !== undefined) {
      updateData.about = validated.about;
    }

    if (validated.experience !== undefined) {
      updateData.experienceYears = validated.experience;
    } else if (validated.experienceYears !== undefined) {
      updateData.experienceYears = validated.experienceYears;
    }

    if (validated.languages !== undefined) {
      updateData.languagesSpoken = validated.languages;
    } else if (validated.languagesSpoken !== undefined) {
      updateData.languagesSpoken = validated.languagesSpoken;
    }

    // Office location update by admin
    if (validated.officeLatitude !== undefined && validated.officeLongitude !== undefined) {
      updateData.officeLatitude = validated.officeLatitude;
      updateData.officeLongitude = validated.officeLongitude;
      updateData.officeLocationUpdatedAt = (validated.officeLatitude !== null && validated.officeLongitude !== null) ? new Date() : null;
    }

    // Compute changedFields
    const changedFields = [];
    const decimalFields = ['voiceCallPricePer15Min', 'videoCallPricePer15Min', 'offlineVisitingFee', 'officeLatitude', 'officeLongitude'];
    const arrayFields = ['languagesSpoken', 'courtPractice', 'practiceAreas'];

    for (const key of Object.keys(updateData)) {
      if (key === 'officeLocationUpdatedAt') continue;
      if (decimalFields.includes(key)) {
        const oldNum = advocate[key] !== null && advocate[key] !== undefined ? Number(advocate[key]) : null;
        const newNum = updateData[key] !== null && updateData[key] !== undefined ? Number(updateData[key]) : null;
        if (oldNum !== newNum) {
          changedFields.push({ field: key, oldValue: oldNum, newValue: newNum });
        }
      } else if (arrayFields.includes(key)) {
        const oldArr = advocate[key] || [];
        const newArr = updateData[key] || [];
        if (JSON.stringify(oldArr) !== JSON.stringify(newArr)) {
          changedFields.push({ field: key, oldValue: oldArr, newValue: newArr });
        }
      } else {
        const oldVal = advocate[key];
        const newVal = updateData[key];
        if (oldVal !== newVal) {
          changedFields.push({ field: key, oldValue: oldVal ?? null, newValue: newVal ?? null });
        }
      }
    }

    // If nothing changed, do not write to DB
    if (changedFields.length === 0) {
      const advocateData = formatAdvocateReviewData(advocate);
      return res.status(200).json({
        success: true,
        message: 'No changes detected.',
        data: advocateData,
        advocate: advocateData,
        changedFields: []
      });
    }

    // Execute update while strictly preserving all approval/status fields
    const updatedAdvocate = await prisma.advocate.update({
      where: { id: advocateId },
      data: updateData,
      include: {
        _count: {
          select: { likes: true, reviews: true }
        }
      }
    });

    console.log('[ADMIN ADVOCATE EDIT]', {
      advocateId,
      editedBy: req.user?.id,
      editorType: req.user?.type,
      fields: changedFields.map(c => c.field)
    });

    const advocateData = formatAdvocateReviewData(updatedAdvocate);

    return res.status(200).json({
      success: true,
      message: 'Advocate profile updated successfully by admin',
      data: advocateData,
      advocate: advocateData,
      changedFields
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

/**
 * List Profile Change Requests (ADMIN / advocates:edit)
 * GET /api/admin/advocates/profile-changes?status=SUBMITTED|APPROVED|REJECTED|ALL&page&limit&search
 */
export const listProfileChangeRequests = async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const requestedStatus = status ? status.toUpperCase() : 'SUBMITTED';
    const where = {};

    if (requestedStatus !== 'ALL') {
      where.profileChangeStatus = requestedStatus;
    } else {
      where.profileChangeStatus = { not: null };
    }

    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { barCouncilId: { contains: q, mode: 'insensitive' } }
      ];
    }

    const [total, advocates, submittedCount, approvedCount, rejectedCount] = await Promise.all([
      prisma.advocate.count({ where }),
      prisma.advocate.findMany({
        where,
        orderBy: { profileChangeSubmittedAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          barCouncilId: true,
          profilePhotoUrl: true,
          pendingProfileChange: true,
          profileChangeStatus: true,
          profileChangeSubmittedAt: true,
          profileChangeReviewedAt: true,
          profileChangeRejectionReason: true
        }
      }),
      prisma.advocate.count({ where: { profileChangeStatus: 'SUBMITTED' } }),
      prisma.advocate.count({ where: { profileChangeStatus: 'APPROVED' } }),
      prisma.advocate.count({ where: { profileChangeStatus: 'REJECTED' } })
    ]);

    const data = advocates.map((adv) => ({
      advocate: {
        id: adv.id,
        name: adv.fullName,
        fullName: adv.fullName,
        email: adv.email,
        phone: adv.phone,
        barCouncilId: adv.barCouncilId,
        barId: adv.barCouncilId,
        profileImage: adv.profilePhotoUrl
      },
      changedFields: adv.pendingProfileChange ? Object.keys(adv.pendingProfileChange) : [],
      submittedAt: adv.profileChangeSubmittedAt,
      reviewedAt: adv.profileChangeReviewedAt,
      status: adv.profileChangeStatus,
      rejectionReason: adv.profileChangeRejectionReason
    }));

    return res.status(200).json({
      success: true,
      data,
      counts: {
        SUBMITTED: submittedCount,
        APPROVED: approvedCount,
        REJECTED: rejectedCount,
        total: submittedCount + approvedCount + rejectedCount
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get Advocate Profile Change Details (ADMIN / advocates:edit)
 * GET /api/admin/advocates/:advocateId/profile-change
 */
export const getAdvocateProfileChangeDetails = async (req, res, next) => {
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

    const pending = advocate.pendingProfileChange || {};
    const changes = [];

    for (const [field, reqVal] of Object.entries(pending)) {
      const label = FIELD_LABELS[field] || field;
      let current = null;
      let requested = reqVal;

      if (field === 'profilePhoto') {
        current = advocate.profilePhotoUrl ?? null;
        requested = reqVal?.url ?? reqVal;
      } else if (field === 'officePhoto') {
        current = advocate.officePhotoUrl ?? null;
        requested = reqVal?.url ?? reqVal;
      } else if (field === 'officeAddress') {
        // TODO: remove fallback after backfill-office-address --apply
        current = advocate.officeAddress || advocate.completeAddress || null;
        requested = reqVal;
      } else {
        current = advocate[field] !== undefined && advocate[field] !== null
          ? (typeof advocate[field] === 'object' && 'toNumber' in advocate[field] ? advocate[field].toNumber() : advocate[field])
          : null;
        if (typeof reqVal === 'object' && reqVal !== null && 'toNumber' in reqVal) {
          requested = reqVal.toNumber();
        }
      }

      changes.push({
        field,
        label,
        current,
        requested
      });
    }

    // Map URLs
    const currentLat = advocate.officeLatitude ?? null;
    const currentLng = advocate.officeLongitude ?? null;
    const requestedLat = pending.officeLatitude !== undefined ? pending.officeLatitude : currentLat;
    const requestedLng = pending.officeLongitude !== undefined ? pending.officeLongitude : currentLng;

    const currentMapUrl = (currentLat !== null && currentLng !== null)
      ? `https://www.google.com/maps?q=${currentLat},${currentLng}`
      : null;
    const requestedMapUrl = (requestedLat !== null && requestedLng !== null)
      ? `https://www.google.com/maps?q=${requestedLat},${requestedLng}`
      : null;

    return res.status(200).json({
      success: true,
      status: advocate.profileChangeStatus,
      submittedAt: advocate.profileChangeSubmittedAt,
      reviewedAt: advocate.profileChangeReviewedAt,
      rejectionReason: advocate.profileChangeRejectionReason,
      reviewedBy: advocate.profileChangeReviewedBy,
      changes,
      officeMapUrls: (currentMapUrl || requestedMapUrl) ? {
        current: currentMapUrl,
        requested: requestedMapUrl
      } : null
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Approve Advocate Profile Change (ADMIN / advocates:edit)
 * POST /api/admin/advocates/:advocateId/profile-change/approve
 */
export const approveAdvocateProfileChange = async (req, res, next) => {
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

    if (advocate.profileChangeStatus !== 'SUBMITTED' || !advocate.pendingProfileChange) {
      return res.status(409).json({
        success: false,
        message: 'No submitted profile changes.'
      });
    }

    const requested = advocate.pendingProfileChange;
    const oldLiveProfilePhotoPublicId = advocate.profilePhotoPublicId;
    const oldLiveOfficePhotoPublicId = advocate.officePhotoPublicId;
    const now = new Date();

    const updateData = {};

    const scalarFields = [
      'experienceYears', 'about', 'voiceCallPricePer15Min', 'videoCallPricePer15Min',
      'offlineVisitingFee', 'officeVisitDurationMinutes', 'officeAddress', 'pincode', 'city', 'state'
    ];
    for (const f of scalarFields) {
      if (requested[f] !== undefined) {
        updateData[f] = requested[f];
      }
    }

    const hasLat = requested.officeLatitude !== undefined;
    const hasLng = requested.officeLongitude !== undefined;
    if (hasLat || hasLng) {
      const lat = hasLat ? (typeof requested.officeLatitude === 'number' ? requested.officeLatitude : parseFloat(requested.officeLatitude)) : advocate.officeLatitude;
      const lng = hasLng ? (typeof requested.officeLongitude === 'number' ? requested.officeLongitude : parseFloat(requested.officeLongitude)) : advocate.officeLongitude;
      updateData.officeLatitude = lat;
      updateData.officeLongitude = lng;
      updateData.latitude = lat;
      updateData.longitude = lng;
      updateData.officeLocationUpdatedAt = now;
    }

    let replacedProfilePhoto = false;
    if (requested.profilePhoto) {
      updateData.profilePhotoUrl = requested.profilePhoto.url;
      updateData.profilePhotoPublicId = requested.profilePhoto.publicId;
      replacedProfilePhoto = true;
    }

    let replacedOfficePhoto = false;
    if (requested.officePhoto) {
      updateData.officePhotoUrl = requested.officePhoto.url;
      updateData.officePhotoPublicId = requested.officePhoto.publicId;
      replacedOfficePhoto = true;
    }

    const reviewer = req.user?.id || req.user?.email || 'env-admin';
    updateData.profileChangeStatus = 'APPROVED';
    updateData.profileChangeReviewedAt = now;
    updateData.profileChangeReviewedBy = reviewer;
    updateData.pendingProfileChange = null;
    updateData.profileChangeRejectionReason = null;

    await prisma.$transaction(async (tx) => {
      await tx.advocate.update({
        where: { id: advocateId },
        data: updateData
      });
    });

    if (replacedProfilePhoto && oldLiveProfilePhotoPublicId && oldLiveProfilePhotoPublicId !== requested.profilePhoto?.publicId) {
      await deleteFromCloudinary(oldLiveProfilePhotoPublicId).catch(() => {});
    }
    if (replacedOfficePhoto && oldLiveOfficePhotoPublicId && oldLiveOfficePhotoPublicId !== requested.officePhoto?.publicId) {
      await deleteFromCloudinary(oldLiveOfficePhotoPublicId).catch(() => {});
    }

    return res.status(200).json({
      success: true,
      message: 'Profile changes approved successfully.'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Reject Advocate Profile Change (ADMIN / advocates:edit)
 * POST /api/admin/advocates/:advocateId/profile-change/reject
 */
export const rejectAdvocateProfileChange = async (req, res, next) => {
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

    if (advocate.profileChangeStatus !== 'SUBMITTED' || !advocate.pendingProfileChange) {
      return res.status(409).json({
        success: false,
        message: 'No submitted profile changes.'
      });
    }

    const validated = rejectProfileChangeSchema.parse(req.body);
    const now = new Date();
    const reviewer = req.user?.id || req.user?.email || 'env-admin';

    await prisma.advocate.update({
      where: { id: advocateId },
      data: {
        profileChangeStatus: 'REJECTED',
        profileChangeRejectionReason: validated.reason,
        profileChangeReviewedAt: now,
        profileChangeReviewedBy: reviewer
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Profile changes rejected.'
    });
  } catch (error) {
    next(error);
  }
};


