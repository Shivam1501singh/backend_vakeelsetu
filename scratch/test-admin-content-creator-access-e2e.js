import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import app from '../src/server.js';
import prisma from '../src/lib/prisma.js';
import { signToken } from '../src/utils/jwt.js';

let server;
let baseUrl;

async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`Test server running at ${baseUrl}`);
      resolve();
    });
  });
}

async function stopServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = options.headers || {};
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body
  });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = text;
  }
  return { status: res.status, data };
}

async function runTests() {
  await startServer();
  console.log('\n=== Starting Admin Content Creator Access E2E Tests ===\n');

  try {
    // 1. Setup Admin Token
    const adminToken = signToken({ id: 'admin-e2e-id', type: 'admin', email: 'admin@vakeelsetu.com' });
    const adminHeaders = { Authorization: `Bearer ${adminToken}` };

    // 2. Setup Content Creator Account & Token
    let creator = await prisma.contentCreator.findFirst();
    if (!creator) {
      creator = await prisma.contentCreator.create({
        data: {
          fullName: 'Test Creator',
          email: `creator_${Date.now()}@test.com`,
          passwordHash: 'dummyhash'
        }
      });
    }
    const creatorToken = signToken({ id: creator.id, type: 'content_creator', email: creator.email });
    const creatorHeaders = { Authorization: `Bearer ${creatorToken}` };

    // 3. Setup Normal User Account & Token
    let user = await prisma.user.findFirst();
    if (!user) {
      user = await prisma.user.create({
        data: {
          fullName: 'Test User',
          email: `user_${Date.now()}@test.com`,
          phone: `99${Date.now().toString().slice(-8)}`,
          city: 'Delhi',
          state: 'Delhi',
          pincode: '110001'
        }
      });
    }
    const userToken = signToken({ id: user.id, type: 'user', email: user.email });
    const userHeaders = { Authorization: `Bearer ${userToken}` };

    console.log('✅ Tokens generated for Admin, Content Creator, and Normal User.');

    // ----------------------------------------------------
    // TEST 1: Bearer Acts (Single Write Handler) by Admin
    // ----------------------------------------------------
    console.log('\n--- Testing Bearer Acts Hierarchy write by Admin ---');
    const bActName = `Admin Test Bearer Act ${Date.now()}`;
    const createBActRes = await request('/api/content-creator/bearer-acts', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        type: 'BEARER_ACT',
        operation: 'CREATE',
        data: { name: bActName }
      }
    });
    console.log('Admin Create Bearer Act Status:', createBActRes.status);
    if (createBActRes.status !== 201) throw new Error(`Failed to create Bearer Act by Admin: ${JSON.stringify(createBActRes.data)}`);
    const createdBActId = createBActRes.data.data.id;

    // Admin Update Bearer Act
    const updateBActRes = await request('/api/content-creator/bearer-acts', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        type: 'BEARER_ACT',
        operation: 'UPDATE',
        data: { id: createdBActId, name: `${bActName} Updated` }
      }
    });
    console.log('Admin Update Bearer Act Status:', updateBActRes.status);
    if (updateBActRes.status !== 200) throw new Error(`Failed to update Bearer Act by Admin: ${JSON.stringify(updateBActRes.data)}`);

    // Admin Create Act
    const createActRes = await request('/api/content-creator/bearer-acts', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        type: 'ACT',
        operation: 'CREATE',
        data: {
          bearerActId: createdBActId,
          heading: 'Admin Heading',
          act: 'Admin Act Test',
          year: 2026
        }
      }
    });
    console.log('Admin Create Act Status:', createActRes.status);
    if (createActRes.status !== 201) throw new Error(`Failed to create Act by Admin: ${JSON.stringify(createActRes.data)}`);
    const createdActId = createActRes.data.data.id;

    // Admin Create Section
    const createSecRes = await request('/api/content-creator/bearer-acts', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        type: 'SECTION',
        operation: 'CREATE',
        data: {
          actId: createdActId,
          section: 'Section 1',
          chapterNo: 1,
          chapterName: 'Preliminary',
          title: 'Short Title Admin',
          description: 'Description written by Admin',
          metaData: 'Metadata by Admin'
        }
      }
    });
    console.log('Admin Create Section Status:', createSecRes.status);
    if (createSecRes.status !== 201) throw new Error(`Failed to create Section by Admin: ${JSON.stringify(createSecRes.data)}`);
    const createdSecId = createSecRes.data.data.id;

    // ----------------------------------------------------
    // TEST 2: Act PDFs operations by Admin
    // ----------------------------------------------------
    console.log('\n--- Testing Act PDFs operations by Admin ---');
    const testPdfPath = 'uploads/acts/test-admin.pdf';
    fs.mkdirSync('uploads/acts', { recursive: true });
    fs.writeFileSync(testPdfPath, '%PDF-1.4 dummy pdf content for admin testing');

    // Predefined PDF Attach
    const attachPdfRes = await request(`/api/content-creator/acts/${createdActId}/predefined-pdfs`, {
      method: 'POST',
      headers: adminHeaders,
      body: {
        displayName: 'Test Admin PDF',
        fileName: 'test-admin.pdf',
        filePath: 'uploads/acts/test-admin.pdf'
      }
    });
    console.log('Admin Attach Predefined PDF Status:', attachPdfRes.status);
    if (![200, 201].includes(attachPdfRes.status)) throw new Error(`Failed to attach predefined PDF by Admin: ${JSON.stringify(attachPdfRes.data)}`);
    const attachedPdfId = attachPdfRes.data.data.id;

    // Sync predefined PDFs by Admin
    const syncPdfsRes = await request('/api/content-creator/acts/predefined-pdfs/sync', {
      method: 'POST',
      headers: adminHeaders,
      body: { targetActId: createdActId }
    });
    console.log('Admin Sync Predefined PDFs Status:', syncPdfsRes.status);
    if (syncPdfsRes.status !== 200) throw new Error(`Failed to sync predefined PDFs by Admin: ${JSON.stringify(syncPdfsRes.data)}`);

    // Delete PDF attachment by Admin
    const deletePdfRes = await request(`/api/content-creator/acts/pdfs/${attachedPdfId}`, {
      method: 'DELETE',
      headers: adminHeaders
    });
    console.log('Admin Delete PDF Status:', deletePdfRes.status);
    if (deletePdfRes.status !== 200) throw new Error(`Failed to delete PDF by Admin: ${JSON.stringify(deletePdfRes.data)}`);

    // ----------------------------------------------------
    // TEST 3: Guides CRUD by Admin
    // ----------------------------------------------------
    console.log('\n--- Testing Guides CRUD by Admin ---');
    const createGuideRes = await request('/api/content-creator/guides', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        title: 'Admin Legal Guide Test',
        description: 'Comprehensive guide description created by Admin'
      }
    });
    console.log('Admin Create Guide Status:', createGuideRes.status);
    if (createGuideRes.status !== 201) throw new Error(`Failed to create Guide by Admin: ${JSON.stringify(createGuideRes.data)}`);
    const createdGuideId = createGuideRes.data.data.id;

    const updateGuideRes = await request(`/api/content-creator/guides/${createdGuideId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: {
        title: 'Admin Legal Guide Test (Updated)'
      }
    });
    console.log('Admin Update Guide Status:', updateGuideRes.status);
    if (updateGuideRes.status !== 200) throw new Error(`Failed to update Guide by Admin: ${JSON.stringify(updateGuideRes.data)}`);

    const deleteGuideRes = await request(`/api/content-creator/guides/${createdGuideId}`, {
      method: 'DELETE',
      headers: adminHeaders
    });
    console.log('Admin Delete Guide Status:', deleteGuideRes.status);
    if (deleteGuideRes.status !== 200) throw new Error(`Failed to delete Guide by Admin: ${JSON.stringify(deleteGuideRes.data)}`);

    // ----------------------------------------------------
    // TEST 4: Updates CRUD by Admin
    // ----------------------------------------------------
    console.log('\n--- Testing Updates CRUD by Admin ---');
    const createUpdateRes = await request('/api/content-creator/updates', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        title: 'Admin Platform Update Test',
        oldDescription: 'Old regulation format',
        newDescription: 'New regulation format updated by Admin'
      }
    });
    console.log('Admin Create Update Status:', createUpdateRes.status);
    if (createUpdateRes.status !== 201) throw new Error(`Failed to create Update by Admin: ${JSON.stringify(createUpdateRes.data)}`);
    const createdUpdateId = createUpdateRes.data.data.id;

    const updateUpdateRes = await request(`/api/content-creator/updates/${createdUpdateId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: {
        newDescription: 'Revised regulation format by Admin'
      }
    });
    console.log('Admin Update Update Status:', updateUpdateRes.status);
    if (updateUpdateRes.status !== 200) throw new Error(`Failed to update Update by Admin: ${JSON.stringify(updateUpdateRes.data)}`);

    const deleteUpdateRes = await request(`/api/content-creator/updates/${createdUpdateId}`, {
      method: 'DELETE',
      headers: adminHeaders
    });
    console.log('Admin Delete Update Status:', deleteUpdateRes.status);
    if (deleteUpdateRes.status !== 200) throw new Error(`Failed to delete Update by Admin: ${JSON.stringify(deleteUpdateRes.data)}`);

    // ----------------------------------------------------
    // TEST 5: IPC & BNS Sections by Admin
    // ----------------------------------------------------
    console.log('\n--- Testing IPC & BNS Sections by Admin ---');
    const ipcSectionNo = `Section TEST_${Date.now()}`;
    const createIpcRes = await request('/api/content-creator/ipc', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        sectionNo: ipcSectionNo,
        heading: 'Test IPC Section Admin',
        paragraph: 'Admin IPC paragraph test',
        explanation: 'Admin IPC explanation',
        content: 'Admin IPC full content'
      }
    });
    console.log('Admin Create IPC Status:', createIpcRes.status);
    if (createIpcRes.status !== 201) throw new Error(`Failed to create IPC section by Admin: ${JSON.stringify(createIpcRes.data)}`);
    const createdIpcId = createIpcRes.data.data.id;

    const editIpcRes = await request(`/api/content-creator/ipc/${createdIpcId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: {
        heading: 'Test IPC Section Admin (Updated)'
      }
    });
    console.log('Admin Edit IPC Status:', editIpcRes.status);
    if (editIpcRes.status !== 200) throw new Error(`Failed to edit IPC section by Admin: ${JSON.stringify(editIpcRes.data)}`);

    // Clean up IPC test record
    await prisma.iPCSection.delete({ where: { id: createdIpcId } });

    const bnsSectionNo = `Section TEST_${Date.now()}`;
    const createBnsRes = await request('/api/content-creator/bns', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        sectionNo: bnsSectionNo,
        heading: 'Test BNS Section Admin',
        paragraph: 'Admin BNS paragraph test',
        explanation: 'Admin BNS explanation',
        content: 'Admin BNS full content'
      }
    });
    console.log('Admin Create BNS Status:', createBnsRes.status);
    if (createBnsRes.status !== 201) throw new Error(`Failed to create BNS section by Admin: ${JSON.stringify(createBnsRes.data)}`);
    const createdBnsId = createBnsRes.data.data.id;

    const editBnsRes = await request(`/api/content-creator/bns/${createdBnsId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: {
        heading: 'Test BNS Section Admin (Updated)'
      }
    });
    console.log('Admin Edit BNS Status:', editBnsRes.status);
    if (editBnsRes.status !== 200) throw new Error(`Failed to edit BNS section by Admin: ${JSON.stringify(editBnsRes.data)}`);

    // Clean up BNS test record
    await prisma.bNSSection.delete({ where: { id: createdBnsId } });

    // ----------------------------------------------------
    // TEST 6: User Rights CRUD by Admin
    // ----------------------------------------------------
    console.log('\n--- Testing User Rights CRUD by Admin ---');
    const createUserRightRes = await request('/api/content-creator/user-rights', {
      method: 'POST',
      headers: adminHeaders,
      body: {
        title: 'Admin User Right Test',
        description: 'Citizen right description created by Admin'
      }
    });
    console.log('Admin Create User Right Status:', createUserRightRes.status);
    if (createUserRightRes.status !== 201) throw new Error(`Failed to create User Right by Admin: ${JSON.stringify(createUserRightRes.data)}`);
    const createdUserRightId = createUserRightRes.data.data.id;

    const updateUserRightRes = await request(`/api/content-creator/user-rights/${createdUserRightId}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: {
        title: 'Admin User Right Test (Updated)'
      }
    });
    console.log('Admin Update User Right Status:', updateUserRightRes.status);
    if (updateUserRightRes.status !== 200) throw new Error(`Failed to update User Right by Admin: ${JSON.stringify(updateUserRightRes.data)}`);

    const deleteUserRightRes = await request(`/api/content-creator/user-rights/${createdUserRightId}`, {
      method: 'DELETE',
      headers: adminHeaders
    });
    console.log('Admin Delete User Right Status:', deleteUserRightRes.status);
    if (deleteUserRightRes.status !== 200) throw new Error(`Failed to delete User Right by Admin: ${JSON.stringify(deleteUserRightRes.data)}`);

    // ----------------------------------------------------
    // TEST 7: Content Creator Regression Test
    // ----------------------------------------------------
    console.log('\n--- Testing Content Creator operations still work ---');
    const creatorGuideRes = await request('/api/content-creator/guides', {
      method: 'POST',
      headers: creatorHeaders,
      body: {
        title: 'Creator Guide Regression Test',
        description: 'Created by Content Creator role'
      }
    });
    console.log('Content Creator Create Guide Status:', creatorGuideRes.status);
    if (creatorGuideRes.status !== 201) throw new Error(`Failed Content Creator regression test: ${JSON.stringify(creatorGuideRes.data)}`);
    const creatorGuideId = creatorGuideRes.data.data.id;
    await prisma.guide.delete({ where: { id: creatorGuideId } });

    // ----------------------------------------------------
    // TEST 8: Security Role Boundary Tests (USER & ADVOCATE -> 403, Unauthenticated -> 401)
    // ----------------------------------------------------
    console.log('\n--- Testing Security Role Boundaries ---');
    // Normal User blocked
    const userBlockedRes = await request('/api/content-creator/guides', {
      method: 'POST',
      headers: userHeaders,
      body: {
        title: 'User Trying to create guide',
        description: 'Should be blocked'
      }
    });
    console.log('Normal User Access Status (expect 403):', userBlockedRes.status);
    if (userBlockedRes.status !== 403) throw new Error(`Expected 403 for Normal User, got ${userBlockedRes.status}`);

    const userBearerActBlocked = await request('/api/content-creator/bearer-acts', {
      method: 'POST',
      headers: userHeaders,
      body: {
        type: 'BEARER_ACT',
        operation: 'CREATE',
        data: { name: 'Unauthorized Bearer Act' }
      }
    });
    console.log('Normal User Bearer Act Status (expect 403):', userBearerActBlocked.status);
    if (userBearerActBlocked.status !== 403) throw new Error(`Expected 403 for Normal User, got ${userBearerActBlocked.status}`);

    // Unauthenticated blocked
    const unauthRes = await request('/api/content-creator/guides', {
      method: 'POST',
      body: {
        title: 'Unauthenticated Request',
        description: 'Should be 401'
      }
    });
    console.log('Unauthenticated Access Status (expect 401):', unauthRes.status);
    if (unauthRes.status !== 401) throw new Error(`Expected 401 for Unauthenticated, got ${unauthRes.status}`);

    // ----------------------------------------------------
    // TEST 9: Existing Admin Endpoints Verification
    // ----------------------------------------------------
    console.log('\n--- Testing Existing Admin Endpoints Intact ---');
    const listCreatorsRes = await request('/api/admin/content-creators', {
      method: 'GET',
      headers: adminHeaders
    });
    console.log('Admin List Content Creators Status:', listCreatorsRes.status);
    if (listCreatorsRes.status !== 200) throw new Error(`Admin List Content Creators failed: ${JSON.stringify(listCreatorsRes.data)}`);

    const listAdvocatesRes = await request('/api/admin/advocates', {
      method: 'GET',
      headers: adminHeaders
    });
    console.log('Admin List Advocates Status:', listAdvocatesRes.status);
    if (listAdvocatesRes.status !== 200) throw new Error(`Admin List Advocates failed: ${JSON.stringify(listAdvocatesRes.data)}`);

    // Clean up created test Bearer Act & Act & Section
    await prisma.actSection.deleteMany({ where: { actId: createdActId } });
    await prisma.act.deleteMany({ where: { id: createdActId } });
    await prisma.bearerAct.deleteMany({ where: { id: createdBActId } });

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉\n');
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    await stopServer();
    await prisma.$disconnect();
  }
}

runTests();
