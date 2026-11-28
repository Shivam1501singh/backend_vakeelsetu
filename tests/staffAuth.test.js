/**
 * tests/staffAuth.test.js
 * 
 * Unit tests verifying:
 * 1. POST /api/admin/login returns accountType: 'staff' and preserves existing roles/permissions.
 * 2. Token generation with type: 'staff' and backward-compatible acceptance of legacy 'content_creator' tokens.
 * 3. UserRole reading accepts both 'STAFF' and 'CONTENT_CREATOR' userType before and after backfill.
 * 4. Deprecated /api/admin/content-creators route returns legacy keys and Deprecation headers.
 */

import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import prisma from '../src/lib/prisma.js';
import { verifyToken, signToken } from '../src/utils/jwt.js';
import * as adminController from '../src/controllers/admin.controller.js';
import { getCurrentUserProfile } from '../src/services/auth.service.js';
import { requireRole } from '../src/middleware/auth.middleware.js';

describe('Staff Authentication & Transition Unit Tests', () => {
  let originalPrismaStaff;
  let originalPrismaUserRole;
  let originalPrismaRole;
  let originalBcryptCompare;

  beforeEach(() => {
    originalPrismaStaff = { ...prisma.staff };
    originalPrismaUserRole = { ...prisma.userRole };
    originalPrismaRole = { ...prisma.role };
    originalBcryptCompare = bcrypt.compare;
  });

  afterEach(() => {
    prisma.staff = originalPrismaStaff;
    prisma.userRole = originalPrismaUserRole;
    prisma.role = originalPrismaRole;
    bcrypt.compare = originalBcryptCompare;
  });

  const mockRes = () => {
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
      cookie() {
        return this;
      },
      set(key, value) {
        this.headers[key] = value;
        return this;
      }
    };
    return res;
  };

  it('1. POST /api/admin/login: returns accountType "staff" with intact roles and permissions', async () => {
    const staffId = 'staff-uuid-101';
    const fakePasswordHash = await bcrypt.hash('secretPass123', 10);

    // Mock Staff record
    prisma.staff.findUnique = async ({ where }) => {
      if (where.email === 'staff@vakeelsetu.com' || where.id === staffId) {
        return {
          id: staffId,
          fullName: 'Legal Staff Member',
          email: 'staff@vakeelsetu.com',
          passwordHash: fakePasswordHash,
          isActive: true
        };
      }
      return null;
    };

    // Mock UserRole before backfill (userType = 'CONTENT_CREATOR')
    prisma.userRole.findMany = async ({ where }) => {
      assert.deepEqual(where.userType, { in: ['STAFF', 'CONTENT_CREATOR'] });
      return [
        {
          id: 'ur-1',
          userId: staffId,
          userType: 'CONTENT_CREATOR',
          role: {
            id: 'role-1',
            name: 'CONTENT_CREATOR',
            displayName: 'Content Creator',
            isActive: true,
            permissions: [
              { permission: { code: 'blogs:create' } },
              { permission: { code: 'content_creators:view' } }
            ]
          }
        }
      ];
    };

    const req = {
      body: {
        email: 'staff@vakeelsetu.com',
        password: 'secretPass123'
      }
    };
    const res = mockRes();
    let nextError = null;

    await adminController.loginAdmin(req, res, (err) => {
      nextError = err;
    });

    assert.equal(nextError, null, 'loginAdmin threw an unexpected error');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.admin.accountType, 'staff', 'admin.accountType must be "staff"');
    assert.equal(res.body.admin.fullName, 'Legal Staff Member');
    assert.deepEqual(res.body.admin.roles, ['CONTENT_CREATOR'], 'admin.roles must match assigned roles');
    assert.ok(res.body.admin.permissions.includes('blogs:create'), 'permissions must include blogs:create');
    assert.ok(res.body.admin.permissions.includes('content_creators:view'), 'permissions must include content_creators:view');

    // Verify JWT payload
    const decoded = verifyToken(res.body.token);
    assert.equal(decoded.id, staffId);
    assert.equal(decoded.type, 'staff', 'Token type must be "staff"');
  });

  it('2. getCurrentUserProfile: accepts both type "staff" and legacy "content_creator"', async () => {
    const staffId = 'staff-uuid-202';
    prisma.staff.findUnique = async ({ where }) => {
      if (where.id === staffId) {
        return {
          id: staffId,
          fullName: 'Dual Token Staff',
          email: 'dual@vakeelsetu.com',
          isActive: true
        };
      }
      return null;
    };

    prisma.userRole.findMany = async ({ where }) => {
      assert.deepEqual(where.userType, { in: ['STAFF', 'CONTENT_CREATOR'] });
      return [
        {
          id: 'ur-2',
          userId: staffId,
          userType: 'CONTENT_CREATOR',
          role: {
            id: 'role-2',
            name: 'CONTENT_CREATOR',
            permissions: [{ permission: { code: 'acts:create' } }]
          }
        }
      ];
    };

    // Call with new 'staff' type
    const staffProfile = await getCurrentUserProfile(staffId, 'staff');
    assert.ok(staffProfile);
    assert.equal(staffProfile.type, 'staff');
    assert.deepEqual(staffProfile.roles, ['CONTENT_CREATOR']);
    assert.deepEqual(staffProfile.permissions, ['acts:create']);

    // Call with legacy 'content_creator' type
    const legacyProfile = await getCurrentUserProfile(staffId, 'content_creator');
    assert.ok(legacyProfile);
    assert.equal(legacyProfile.type, 'staff');
    assert.deepEqual(legacyProfile.roles, ['CONTENT_CREATOR']);
    assert.deepEqual(legacyProfile.permissions, ['acts:create']);
  });

  it('3. UserRole userType: reads both "CONTENT_CREATOR" and "STAFF" rows identically', async () => {
    const staffId = 'staff-uuid-303';
    prisma.staff.findUnique = async () => ({
      id: staffId,
      fullName: 'Backfill Test Staff',
      email: 'backfill@vakeelsetu.com',
      isActive: true
    });

    // Simulated state 1: Before backfill (UserRole.userType = 'CONTENT_CREATOR')
    prisma.userRole.findMany = async ({ where }) => {
      assert.deepEqual(where.userType, { in: ['STAFF', 'CONTENT_CREATOR'] });
      return [
        {
          id: 'ur-before',
          userId: staffId,
          userType: 'CONTENT_CREATOR',
          role: {
            name: 'CONTENT_CREATOR',
            permissions: [{ permission: { code: 'acts:view' } }]
          }
        }
      ];
    };
    const profileBefore = await getCurrentUserProfile(staffId, 'staff');
    assert.deepEqual(profileBefore.roles, ['CONTENT_CREATOR']);
    assert.deepEqual(profileBefore.permissions, ['acts:view']);

    // Simulated state 2: After backfill (UserRole.userType = 'STAFF')
    prisma.userRole.findMany = async ({ where }) => {
      assert.deepEqual(where.userType, { in: ['STAFF', 'CONTENT_CREATOR'] });
      return [
        {
          id: 'ur-after',
          userId: staffId,
          userType: 'STAFF',
          role: {
            name: 'CONTENT_CREATOR',
            permissions: [{ permission: { code: 'acts:view' } }]
          }
        }
      ];
    };
    const profileAfter = await getCurrentUserProfile(staffId, 'staff');
    assert.deepEqual(profileAfter.roles, ['CONTENT_CREATOR']);
    assert.deepEqual(profileAfter.permissions, ['acts:view']);
  });

  it('4. requireRole: allows both STAFF and CONTENT_CREATOR roles interchangeably', async () => {
    const middleware = requireRole('CONTENT_CREATOR');

    // Case A: User object with role 'CONTENT_CREATOR'
    let nextCalledA = false;
    await middleware({ user: { role: 'CONTENT_CREATOR', type: 'staff' } }, {}, () => {
      nextCalledA = true;
    });
    assert.equal(nextCalledA, true, 'User with role CONTENT_CREATOR should pass');

    // Case B: User object with type 'staff' and role 'STAFF'
    let nextCalledB = false;
    await middleware({ user: { role: 'STAFF', type: 'staff' } }, {}, () => {
      nextCalledB = true;
    });
    assert.equal(nextCalledB, true, 'User with role STAFF should pass');
  });

  it('5. GET /api/admin/content-creators vs /api/admin/staff headers and response keys', async () => {
    prisma.staff.findMany = async () => [
      {
        id: 's-1',
        fullName: 'Test Staff',
        email: 'test@staff.com',
        isActive: true,
        createdAt: new Date()
      }
    ];
    prisma.userRole.findMany = async () => [];

    // New Route /api/admin/staff
    const reqNew = { originalUrl: '/api/admin/staff', baseUrl: '/api/admin' };
    const resNew = mockRes();
    await adminController.listStaffAccounts(reqNew, resNew, () => {});
    assert.equal(resNew.statusCode, 200);
    assert.ok(Array.isArray(resNew.body.staff), 'New route returns key "staff"');
    assert.equal(resNew.headers['Deprecation'], undefined, 'New route must not have Deprecation header');

    // Legacy Route /api/admin/content-creators
    const reqOld = { originalUrl: '/api/admin/content-creators', baseUrl: '/api/admin/content-creators' };
    const resOld = mockRes();
    await adminController.listContentCreators(reqOld, resOld, () => {});
    assert.equal(resOld.statusCode, 200);
    assert.ok(Array.isArray(resOld.body.creators), 'Legacy route returns key "creators"');
    assert.equal(resOld.headers['Deprecation'], 'true', 'Legacy route must set Deprecation header');
    assert.equal(resOld.headers['Link'], '</api/admin/staff>; rel="successor-version"');
  });
});
