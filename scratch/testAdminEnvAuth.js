import 'dotenv/config';
import prisma from '../src/lib/prisma.js';
import axios from 'axios';
import { signToken } from '../src/utils/jwt.js';

const BASE_URL = 'http://localhost:5002';

async function startTestServer() {
  const { default: app } = await import('../src/server.js');
  return new Promise((resolve) => {
    const server = app.listen(5002, () => {
      console.log('Test server running on port 5002');
      resolve(server);
    });
  });
}

async function runTests() {
  console.log('=== STARTING ADMIN ENV AUTH TEST SUITE ===');

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

  const correctEmail = process.env.ADMIN_USER_EMAIL;
  const correctPassword = process.env.ADMIN_USER_PASSWORD;

  try {
    // --- TEST 1: Correct email + correct password -> Successful Admin login ---
    console.log('\n--- Test 1: Valid credentials ---');
    const validLoginRes = await client(null).post('/api/admin/login', {
      email: correctEmail,
      password: correctPassword
    });
    assert(validLoginRes.status === 200, 'Returns 200 OK');
    assert(validLoginRes.data.success === true, 'Response success is true');
    assert(typeof validLoginRes.data.token === 'string' && validLoginRes.data.token.length > 0, 'JWT token is returned');
    assert(validLoginRes.data.admin && validLoginRes.data.admin.email === correctEmail, 'Admin object returned in response');
    const adminToken = validLoginRes.data.token;

    // --- TEST 2: Correct email + incorrect password -> 401 Unauthorized ---
    console.log('\n--- Test 2: Correct email + wrong password ---');
    try {
      await client(null).post('/api/admin/login', {
        email: correctEmail,
        password: 'wrongpassword'
      });
      assert(false, 'Should have failed with 401');
    } catch (err) {
      assert(err.response && err.response.status === 401, 'Returns 401 Unauthorized');
      assert(err.response.data.message === 'Invalid email or password.', 'Returns standard generic error message');
    }

    // --- TEST 3: Incorrect email + correct password -> 401 Unauthorized ---
    console.log('\n--- Test 3: Wrong email + correct password ---');
    try {
      await client(null).post('/api/admin/login', {
        email: 'wrong.admin@example.com',
        password: correctPassword
      });
      assert(false, 'Should have failed with 401');
    } catch (err) {
      assert(err.response && err.response.status === 401, 'Returns 401 Unauthorized');
      assert(err.response.data.message === 'Invalid email or password.', 'Returns standard generic error message');
    }

    // --- TEST 4: Incorrect email + incorrect password -> 401 Unauthorized ---
    console.log('\n--- Test 4: Wrong email + wrong password ---');
    try {
      await client(null).post('/api/admin/login', {
        email: 'wrong.admin@example.com',
        password: 'wrongpassword'
      });
      assert(false, 'Should have failed with 401');
    } catch (err) {
      assert(err.response && err.response.status === 401, 'Returns 401 Unauthorized');
    }

    // --- TEST 5: Missing ADMIN_USER_EMAIL configuration -> 500 Internal Server Error ---
    console.log('\n--- Test 5: Missing ADMIN_USER_EMAIL in env ---');
    const origEmail = process.env.ADMIN_USER_EMAIL;
    delete process.env.ADMIN_USER_EMAIL;
    try {
      await client(null).post('/api/admin/login', {
        email: correctEmail,
        password: correctPassword
      });
      assert(false, 'Should have failed with 500');
    } catch (err) {
      assert(err.response && err.response.status === 500, 'Returns 500 when ADMIN_USER_EMAIL is missing');
    } finally {
      process.env.ADMIN_USER_EMAIL = origEmail;
    }

    // --- TEST 6: Missing ADMIN_USER_PASSWORD configuration -> 500 Internal Server Error ---
    console.log('\n--- Test 6: Missing ADMIN_USER_PASSWORD in env ---');
    const origPassword = process.env.ADMIN_USER_PASSWORD;
    delete process.env.ADMIN_USER_PASSWORD;
    try {
      await client(null).post('/api/admin/login', {
        email: correctEmail,
        password: correctPassword
      });
      assert(false, 'Should have failed with 500');
    } catch (err) {
      assert(err.response && err.response.status === 500, 'Returns 500 when ADMIN_USER_PASSWORD is missing');
    } finally {
      process.env.ADMIN_USER_PASSWORD = origPassword;
    }

    // --- TEST 7: Case-insensitivity and whitespace trimming for Email ---
    console.log('\n--- Test 7: Email case-insensitivity & whitespace trimming ---');
    const trimmedCaseRes = await client(null).post('/api/admin/login', {
      email: `  ${correctEmail.toUpperCase()}  `,
      password: correctPassword
    });
    assert(trimmedCaseRes.status === 200, 'Admin login succeeds with mixed-case and whitespace-padded email');

    // --- TEST 8: Verify that Admin login does not depend on database record ---
    console.log('\n--- Test 8: Non-database verification ---');
    // Query database to ensure no Admin record exists with a dummy non-existent email
    const nonExistentDbEmail = 'pure_env_admin@vakeelsetu.com';
    const dbAdmin = await prisma.admin.findUnique({ where: { email: nonExistentDbEmail } });
    assert(!dbAdmin, 'Confirmed nonExistentDbEmail is not in database');
    // Set env to this non-existent DB email
    process.env.ADMIN_USER_EMAIL = nonExistentDbEmail;
    process.env.ADMIN_USER_PASSWORD = 'envPassword123';
    const envOnlyRes = await client(null).post('/api/admin/login', {
      email: nonExistentDbEmail,
      password: 'envPassword123'
    });
    assert(envOnlyRes.status === 200, 'Login succeeds purely from .env without database Admin record');
    const envOnlyToken = envOnlyRes.data.token;
    // Restore env
    process.env.ADMIN_USER_EMAIL = origEmail;
    process.env.ADMIN_USER_PASSWORD = origPassword;

    // --- TEST 9: Authenticated Admin retains full access to admin APIs ---
    console.log('\n--- Test 9: Admin retains full access across endpoints ---');
    const adminRolesRes = await client(adminToken).get('/api/admin/roles');
    assert(adminRolesRes.status === 200 && adminRolesRes.data.success, 'Admin can access /api/admin/roles');

    const adminAdvocatesRes = await client(adminToken).get('/api/admin/advocates');
    assert(adminAdvocatesRes.status === 200 && adminAdvocatesRes.data.success, 'Admin can access /api/admin/advocates');

    const adminFeedbackRes = await client(adminToken).get('/api/admin/feedback');
    assert(adminFeedbackRes.status === 200 && adminFeedbackRes.data.success, 'Admin can access /api/admin/feedback');

    const adminMeRes = await client(adminToken).get('/api/auth/me');
    assert(adminMeRes.status === 200 && adminMeRes.data.user.type === 'admin', '/api/auth/me resolves admin profile correctly');

    // --- TEST 10: Non-Admin authentication (Content Creator / User) remains unaffected ---
    console.log('\n--- Test 10: Non-Admin authentication regression check ---');
    const creator = await prisma.contentCreator.findFirst({ where: { email: 'trainee6@techvunex.in' } });
    if (creator) {
      const creatorLoginRes = await client(null).post('/api/content-creator/login', {
        email: 'trainee6@techvunex.in',
        password: '1234'
      });
      assert(creatorLoginRes.status === 200 && creatorLoginRes.data.success, 'Content Creator login still works via database');
      const creatorToken = creatorLoginRes.data.token;
      const creatorMeRes = await client(creatorToken).get('/api/auth/me');
      assert(creatorMeRes.status === 200 && creatorMeRes.data.user.type === 'content_creator', 'Content Creator session profile resolves');
    } else {
      console.log('  ⚠️ Skipping Content Creator login test (no seeded creator found)');
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
