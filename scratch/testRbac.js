import 'dotenv/config';
import prisma from '../src/lib/prisma.js';
import bcrypt from 'bcryptjs';
import { signToken } from '../src/utils/jwt.js';
import axios from 'axios';
import { seedRbac } from '../prisma/seedRbac.js';

const BASE_URL = 'http://localhost:5001';

async function startTestServer() {
  const { default: app } = await import('../src/server.js');
  return new Promise((resolve) => {
    const server = app.listen(5001, () => {
      console.log('Test server running on port 5001');
      resolve(server);
    });
  });
}

async function runTests() {
  console.log('=== STARTING RBAC TEST SUITE ===');

  // 1. Ensure seed is present
  await seedRbac(prisma);

  // 2. Setup Test Admin
  const adminEmail = 'test_admin_rbac@vakeelsetu.com';
  let admin = await prisma.admin.findUnique({ where: { email: adminEmail } });
  if (!admin) {
    const passwordHash = await bcrypt.hash('admin123', 10);
    admin = await prisma.admin.create({
      data: {
        email: adminEmail,
        fullName: 'Test RBAC Admin',
        passwordHash
      }
    });
  }
  const adminToken = signToken({ id: admin.id, type: 'admin' });

  // 3. Setup Test Content Creator
  const creatorEmail = 'test_creator_rbac@vakeelsetu.com';
  let creator = await prisma.contentCreator.findUnique({ where: { email: creatorEmail } });
  if (!creator) {
    const passwordHash = await bcrypt.hash('creator123', 10);
    creator = await prisma.contentCreator.create({
      data: {
        email: creatorEmail,
        fullName: 'Test Content Creator',
        passwordHash
      }
    });
  }
  const creatorToken = signToken({ id: creator.id, type: 'content_creator' });

  // 4. Setup Test Normal User (to be assigned LEAD_USER role)
  const leadUserEmail = 'test_lead_user_rbac@vakeelsetu.com';
  let leadUser = await prisma.user.findUnique({ where: { email: leadUserEmail } });
  if (!leadUser) {
    leadUser = await prisma.user.create({
      data: {
        email: leadUserEmail,
        fullName: 'Test Lead User',
        phone: '9999990001',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001'
      }
    });
  }
  const leadUserToken = signToken({ id: leadUser.id, type: 'user' });

  // 5. Setup Another Regular User without roles
  const regularUserEmail = 'test_regular_user_rbac@vakeelsetu.com';
  let regularUser = await prisma.user.findUnique({ where: { email: regularUserEmail } });
  if (!regularUser) {
    regularUser = await prisma.user.create({
      data: {
        email: regularUserEmail,
        fullName: 'Test Regular User',
        phone: '9999990002',
        city: 'Delhi',
        state: 'Delhi',
        pincode: '110001'
      }
    });
  }
  const regularUserToken = signToken({ id: regularUser.id, type: 'user' });

  // Start express server
  const server = await startTestServer();

  let testsPassed = 0;
  let testsFailed = 0;

  const assert = (condition, name) => {
    if (condition) {
      console.log(`  ✅ PASS: ${name}`);
      testsPassed++;
    } else {
      console.error(`  ❌ FAIL: ${name}`);
      testsFailed++;
    }
  };

  const client = (token) => axios.create({
    baseURL: BASE_URL,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  try {
    // --- TEST 1: Unauthenticated access returns 401 ---
    console.log('\n--- Test 1: Unauthenticated access ---');
    try {
      await client(null).get('/api/admin/roles');
      assert(false, 'Unauthenticated request should return 401');
    } catch (err) {
      assert(err.response && err.response.status === 401, 'Unauthenticated request returns 401');
    }

    // --- TEST 2: Regular user without roles cannot access admin role management (returns 403) ---
    console.log('\n--- Test 2: Regular user forbidden on role management ---');
    try {
      await client(regularUserToken).get('/api/admin/roles');
      assert(false, 'Regular user should get 403 on /api/admin/roles');
    } catch (err) {
      assert(err.response && err.response.status === 403, 'Regular user gets 403 Forbidden');
    }

    // --- TEST 3: Admin can list all roles ---
    console.log('\n--- Test 3: Admin list roles ---');
    const listRolesRes = await client(adminToken).get('/api/admin/roles');
    assert(listRolesRes.status === 200 && listRolesRes.data.success, 'Admin can list roles');
    assert(listRolesRes.data.roles.some(r => r.name === 'LEAD_USER'), 'Default LEAD_USER role exists in list');
    assert(listRolesRes.data.roles.some(r => r.name === 'CONTENT_CREATOR'), 'Default CONTENT_CREATOR role exists in list');

    // --- TEST 4: Admin can list permissions ---
    console.log('\n--- Test 4: Admin list permissions ---');
    const listPermsRes = await client(adminToken).get('/api/admin/permissions?grouped=true');
    assert(listPermsRes.status === 200 && listPermsRes.data.grouped === true, 'Admin can list permissions grouped by module');

    // --- TEST 5: Admin can create a new custom role ---
    console.log('\n--- Test 5: Admin create role ---');
    const customRoleName = `AUDITOR_${Date.now()}`;
    const createRoleRes = await client(adminToken).post('/api/admin/roles', {
      name: customRoleName,
      displayName: 'Compliance Auditor',
      description: 'Role for auditing compliance data',
      permissionCodes: ['users:view', 'feedback:view']
    });
    assert(createRoleRes.status === 201 && createRoleRes.data.role.name === customRoleName, 'Admin can create new custom role');
    const customRoleId = createRoleRes.data.role.id;
    assert(createRoleRes.data.role.permissionsCount === 2, 'Role has 2 initial permissions');

    // --- TEST 6: Duplicate role name prevention ---
    console.log('\n--- Test 6: Prevent duplicate role ---');
    try {
      await client(adminToken).post('/api/admin/roles', {
        name: customRoleName,
        displayName: 'Duplicate Auditor'
      });
      assert(false, 'Creating duplicate role should fail');
    } catch (err) {
      assert(err.response && err.response.status === 409, 'Duplicate role name returns 409 Conflict');
    }

    // --- TEST 7: Admin can update role ---
    console.log('\n--- Test 7: Admin update role ---');
    const updateRoleRes = await client(adminToken).put(`/api/admin/roles/${customRoleId}`, {
      displayName: 'Senior Compliance Auditor',
      description: 'Updated auditor description'
    });
    assert(updateRoleRes.status === 200 && updateRoleRes.data.role.displayName === 'Senior Compliance Auditor', 'Admin can update role details');

    // --- TEST 8: Admin can assign permissions to role ---
    console.log('\n--- Test 8: Assign permissions to role ---');
    const assignPermRes = await client(adminToken).post(`/api/admin/roles/${customRoleId}/permissions`, {
      permissionCodes: ['advocates:view']
    });
    assert(assignPermRes.status === 200 && assignPermRes.data.role.permissions.some(p => p.code === 'advocates:view'), 'Admin can assign new permission to role');

    // --- TEST 9: Admin can remove permissions from role ---
    console.log('\n--- Test 9: Remove permissions from role ---');
    const removePermRes = await client(adminToken).delete(`/api/admin/roles/${customRoleId}/permissions`, {
      data: { permissionCodes: ['advocates:view'] }
    });
    assert(removePermRes.status === 200 && !removePermRes.data.role.permissions.some(p => p.code === 'advocates:view'), 'Admin can remove permission from role');

    // --- TEST 10: Admin can assign role to user ---
    console.log('\n--- Test 10: Assign LEAD_USER role to user ---');
    const assignRoleRes = await client(adminToken).post(`/api/admin/users/${leadUser.id}/roles`, {
      roleName: 'LEAD_USER',
      userType: 'USER'
    });
    assert(assignRoleRes.status === 200 && assignRoleRes.data.success, 'Admin can assign LEAD_USER role to user');

    // Check user roles endpoint
    const getUserRolesRes = await client(adminToken).get(`/api/admin/users/${leadUser.id}/roles`);
    assert(getUserRolesRes.status === 200 && getUserRolesRes.data.roleNames.includes('LEAD_USER'), 'User roles reflect LEAD_USER');

    // --- TEST 11: Lead User has access to assigned features ---
    console.log('\n--- Test 11: Lead User authorized access ---');
    // Lead user has users:view -> GET /api/admin/users
    const leadListUsers = await client(leadUserToken).get('/api/admin/users');
    assert(leadListUsers.status === 200 && leadListUsers.data.success, 'Lead User can access /api/admin/users');

    // Lead user has advocates:view -> GET /api/admin/advocates
    const leadListAdvocates = await client(leadUserToken).get('/api/admin/advocates');
    assert(leadListAdvocates.status === 200 && leadListAdvocates.data.success, 'Lead User can access /api/admin/advocates');

    // Lead user has feedback:view -> GET /api/admin/feedback
    const leadListFeedback = await client(leadUserToken).get('/api/admin/feedback');
    assert(leadListFeedback.status === 200 && leadListFeedback.data.success, 'Lead User can access /api/admin/feedback');

    // --- TEST 12: Lead User CANNOT access unauthorized features (returns 403) ---
    console.log('\n--- Test 12: Lead User forbidden access on unassigned features ---');
    // Lead User does NOT have advocates:approve
    try {
      await client(leadUserToken).patch('/api/admin/advocates/non-existent-id/approve', {});
      assert(false, 'Lead user without advocates:approve should get 403');
    } catch (err) {
      assert(err.response && err.response.status === 403, 'Lead user gets 403 on advocates:approve');
    }

    // Lead User does NOT have roles:manage
    try {
      await client(leadUserToken).post('/api/admin/roles', { name: 'HACKED_ROLE', displayName: 'Hacked' });
      assert(false, 'Lead user cannot manage roles');
    } catch (err) {
      assert(err.response && err.response.status === 403, 'Lead user gets 403 on roles:manage');
    }

    // Lead User cannot assign roles to themselves or others
    try {
      await client(leadUserToken).post(`/api/admin/users/${leadUser.id}/roles`, { roleName: 'CONTENT_CREATOR' });
      assert(false, 'Lead user cannot assign roles');
    } catch (err) {
      assert(err.response && err.response.status === 403, 'Lead user gets 403 when trying to assign roles');
    }

    // --- TEST 13: Content Creator permissions and access ---
    console.log('\n--- Test 13: Content Creator access ---');
    // Content creator has acts:create / acts:update
    // Content creator does NOT have advocates:approve or feedback:view by default
    try {
      await client(creatorToken).get('/api/admin/advocates');
      assert(false, 'Content Creator without advocates:view should get 403 on /api/admin/advocates');
    } catch (err) {
      assert(err.response && err.response.status === 403, 'Content creator gets 403 on /api/admin/advocates');
    }

    // --- TEST 14: Admin has unrestricted access to everything ---
    console.log('\n--- Test 14: Admin unrestricted full access ---');
    const adminUsersRes = await client(adminToken).get('/api/admin/users');
    assert(adminUsersRes.status === 200, 'Admin can view users');
    const adminAdvocatesRes = await client(adminToken).get('/api/admin/advocates');
    assert(adminAdvocatesRes.status === 200, 'Admin can view advocates');
    const adminFeedbackRes = await client(adminToken).get('/api/admin/feedback');
    assert(adminFeedbackRes.status === 200, 'Admin can view feedback');

    // --- TEST 15: Deactivate role and verify permission revoked ---
    console.log('\n--- Test 15: Deactivate role behavior ---');
    // Assign custom role to regular user
    await client(adminToken).post(`/api/admin/users/${regularUser.id}/roles`, {
      roleId: customRoleId,
      userType: 'USER'
    });
    // With custom role active (having users:view), regular user can view users
    const regListUsersBefore = await client(regularUserToken).get('/api/admin/users');
    assert(regListUsersBefore.status === 200, 'User with active role can access permitted feature');

    // Deactivate custom role
    await client(adminToken).patch(`/api/admin/roles/${customRoleId}/status`, { isActive: false });

    // Now regular user should be denied access (403)
    try {
      await client(regularUserToken).get('/api/admin/users');
      assert(false, 'User with deactivated role should get 403');
    } catch (err) {
      assert(err.response && err.response.status === 403, 'User with deactivated role gets 403');
    }

    // --- TEST 16: Admin remove role from user ---
    console.log('\n--- Test 16: Remove role from user ---');
    const removeRoleRes = await client(adminToken).delete(`/api/admin/users/${regularUser.id}/roles/${customRoleId}`);
    assert(removeRoleRes.status === 200 && removeRoleRes.data.success, 'Admin can remove role from user');

    // --- TEST 17: Admin delete custom role ---
    console.log('\n--- Test 17: Admin delete role ---');
    const deleteRoleRes = await client(adminToken).delete(`/api/admin/roles/${customRoleId}`);
    assert(deleteRoleRes.status === 200 && deleteRoleRes.data.success, 'Admin can delete custom role');

    // System role deletion protection
    const leadRole = await prisma.role.findUnique({ where: { name: 'LEAD_USER' } });
    try {
      await client(adminToken).delete(`/api/admin/roles/${leadRole.id}`);
      assert(false, 'System role deletion should be blocked');
    } catch (err) {
      assert(err.response && err.response.status === 400, 'System role deletion is blocked with 400');
    }

  } catch (suiteError) {
    console.error('Unexpected error in test suite:', suiteError);
    testsFailed++;
  } finally {
    server.close();
    await prisma.$disconnect();
    console.log(`\n=== TEST SUITE FINISHED: ${testsPassed} PASSED, ${testsFailed} FAILED ===`);
    process.exit(testsFailed > 0 ? 1 : 0);
  }
}

runTests();
