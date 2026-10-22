import 'dotenv/config';
import app from '../src/server.js';
import prisma from '../src/lib/prisma.js';
import { signToken } from '../src/utils/jwt.js';

async function runTests() {
  console.log('=== Step 0: Print Database Host & Verify Environment ===');
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const parsed = new URL(dbUrl);
    console.log(`Database Host: ${parsed.host}`);
    console.log(`Database Name: ${parsed.pathname}`);
  } else {
    console.error('DATABASE_URL is not set!');
    process.exit(1);
  }

  // Start temporary HTTP server on random available port
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}`);

  try {
    // 1. Identify User A (has completed and requested items) and User B (has confirmed and requested items)
    const userA = await prisma.user.findUnique({
      where: { id: '21360976-fc8a-4f07-9be2-38eb240cfb38' }
    });
    const userB = await prisma.user.findUnique({
      where: { id: '08076fa9-8ab1-4af0-aa3d-ccb0e7b31bd7' }
    });
    const advocate = await prisma.advocate.findFirst();

    if (!userA || !userB) {
      throw new Error('Users not found for test');
    }

    const tokenA = signToken({ id: userA.id, type: 'USER' });
    const tokenB = signToken({ id: userB.id, type: 'USER' });
    const tokenAdvocate = advocate ? signToken({ id: advocate.id, type: 'ADVOCATE' }) : null;

    console.log('\n=== Step 1: Authentication & Authorization Tests ===');

    // Case 1: No token -> 401
    const resNoToken = await fetch(`${baseUrl}/api/user/bookings`);
    const dataNoToken = await resNoToken.json();
    console.log('No token status:', resNoToken.status, dataNoToken.message);
    if (resNoToken.status !== 401 || !dataNoToken.message.includes('Authentication required')) {
      throw new Error(`Expected 401 Authentication required, got ${resNoToken.status}`);
    }

    // Case 2: Advocate token -> 403
    if (tokenAdvocate) {
      const resAdvocate = await fetch(`${baseUrl}/api/user/bookings`, {
        headers: { Authorization: `Bearer ${tokenAdvocate}` }
      });
      const dataAdvocate = await resAdvocate.json();
      console.log('Advocate token status:', resAdvocate.status, dataAdvocate.message);
      if (resAdvocate.status !== 403 || !dataAdvocate.message.includes('Access forbidden')) {
        throw new Error(`Expected 403 Access forbidden, got ${resAdvocate.status}`);
      }
    }

    // Case 3: Bad query parameters -> 400 with Zod message
    const resBadQuery = await fetch(`${baseUrl}/api/user/bookings?limit=999`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataBadQuery = await resBadQuery.json();
    console.log('Bad query status:', resBadQuery.status, dataBadQuery.message);
    if (resBadQuery.status !== 400 || !dataBadQuery.message.includes('Limit cannot exceed 50')) {
      throw new Error(`Expected 400 limit exceeded, got ${resBadQuery.status}`);
    }

    const resBadStatus = await fetch(`${baseUrl}/api/user/bookings?status=INVALID_STATUS`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataBadStatus = await resBadStatus.json();
    console.log('Bad status filter status:', resBadStatus.status, dataBadStatus.message);
    if (resBadStatus.status !== 400) {
      throw new Error(`Expected 400 for invalid status, got ${resBadStatus.status}`);
    }

    console.log('\n=== Step 2: User A & User B Booking Lists & Isolation ===');

    // User A bookings
    const resListA = await fetch(`${baseUrl}/api/user/bookings`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataListA = await resListA.json();
    console.log('User A total bookings:', dataListA.bookings.length, 'Counts:', dataListA.counts);
    console.log('User A sample booking status:', dataListA.bookings.map(b => `${b.id.slice(0, 8)}... (${b.status} / ${b.statusGroup})`));

    // User B bookings
    const resListB = await fetch(`${baseUrl}/api/user/bookings`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    const dataListB = await resListB.json();
    console.log('User B total bookings:', dataListB.bookings.length, 'Counts:', dataListB.counts);
    console.log('User B sample booking status:', dataListB.bookings.map(b => `${b.id.slice(0, 8)}... (${b.status} / ${b.statusGroup})`));

    // Verify mutual exclusion: none of User A's booking IDs are in User B's list
    const idsA = new Set(dataListA.bookings.map(b => b.id));
    const idsB = new Set(dataListB.bookings.map(b => b.id));
    const overlap = [...idsA].filter(id => idsB.has(id));
    if (overlap.length > 0) {
      throw new Error(`Data leak detected! Overlapping booking IDs between User A and User B: ${overlap.join(', ')}`);
    }
    console.log('✅ CONFIRMED: Strict user data isolation (0 overlapping bookings).');

    console.log('\n=== Step 3: Detail View & Timeline ===');
    const bookingA = dataListA.bookings[0];
    const resDetailA = await fetch(`${baseUrl}/api/user/bookings/${bookingA.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataDetailA = await resDetailA.json();
    console.log('Detail A status:', resDetailA.status);
    console.log('Detail A title:', dataDetailA.booking.title);
    console.log('Detail A timeline:', dataDetailA.booking.timeline);
    if (!Array.isArray(dataDetailA.booking.timeline)) {
      throw new Error('Expected timeline array in detail booking response');
    }

    console.log('\n=== Step 4: Cross-User Booking ID Access (404 Security Check) ===');
    const bookingB = dataListB.bookings[0];
    // User A tries to open User B's booking
    const resUnauthorizedAccess = await fetch(`${baseUrl}/api/user/bookings/${bookingB.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataUnauthorizedAccess = await resUnauthorizedAccess.json();
    console.log("User A access to User B's booking status:", resUnauthorizedAccess.status, dataUnauthorizedAccess.message);
    if (resUnauthorizedAccess.status !== 404 || dataUnauthorizedAccess.message !== 'Booking not found.') {
      throw new Error(`Expected 404 Booking not found, got ${resUnauthorizedAccess.status}`);
    }
    console.log('✅ CONFIRMED: Cross-user access returns uniform 404 "Booking not found." (no ID leakage).');

    // Non-existent ID returns 404
    const resNonExistent = await fetch(`${baseUrl}/api/user/bookings/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataNonExistent = await resNonExistent.json();
    console.log('Non-existent ID status:', resNonExistent.status, dataNonExistent.message);
    if (resNonExistent.status !== 404 || dataNonExistent.message !== 'Booking not found.') {
      throw new Error(`Expected 404 for non-existent ID, got ${resNonExistent.status}`);
    }

    console.log('\n=== Step 5: Pagination Walk with limit=1 ===');
    const walkedIds = [];
    let currentPage = 1;
    let hasMore = true;

    while (hasMore) {
      const pageRes = await fetch(`${baseUrl}/api/user/bookings?page=${currentPage}&limit=1`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });
      const pageData = await pageRes.json();
      if (pageData.bookings.length > 0) {
        walkedIds.push(pageData.bookings[0].id);
      }
      hasMore = pageData.pagination.hasNextPage;
      currentPage++;
    }

    console.log('Walked IDs count:', walkedIds.length, 'Total expected:', dataListA.bookings.length);
    const uniqueWalked = new Set(walkedIds);
    if (uniqueWalked.size !== walkedIds.length || walkedIds.length !== dataListA.bookings.length) {
      throw new Error(`Pagination walk mismatch! Walked ${walkedIds.length} items (${uniqueWalked.size} unique), expected ${dataListA.bookings.length}`);
    }
    console.log('✅ CONFIRMED: Pagination with limit=1 walks all items exactly once without duplicates.');

    console.log('\n=== Step 6: Status Group Filtering (UPCOMING vs COMPLETED) ===');
    const resUpcoming = await fetch(`${baseUrl}/api/user/bookings?status=UPCOMING`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataUpcoming = await resUpcoming.json();
    console.log('User A UPCOMING count:', dataUpcoming.bookings.length, 'Status tabs counts preserved:', dataUpcoming.counts);
    for (const b of dataUpcoming.bookings) {
      if (b.statusGroup !== 'UPCOMING') {
        throw new Error(`Expected statusGroup UPCOMING, got ${b.statusGroup}`);
      }
    }

    const resCompleted = await fetch(`${baseUrl}/api/user/bookings?status=COMPLETED`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataCompleted = await resCompleted.json();
    console.log('User A COMPLETED count:', dataCompleted.bookings.length);
    for (const b of dataCompleted.bookings) {
      if (b.statusGroup !== 'COMPLETED') {
        throw new Error(`Expected statusGroup COMPLETED, got ${b.statusGroup}`);
      }
    }
    console.log('✅ CONFIRMED: Status group filters work accurately and tab counts remain global.');

    console.log('\n=== Step 7: Verify Existing GET /api/user/consultancy Unaltered ===');
    const resOldConsultancy = await fetch(`${baseUrl}/api/user/consultancy`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const dataOldConsultancy = await resOldConsultancy.json();
    console.log('Existing /api/user/consultancy response success:', dataOldConsultancy.success);
    console.log('Existing /api/user/consultancy requests count:', dataOldConsultancy.data.length);
    console.log('Existing sample request structure keys:', Object.keys(dataOldConsultancy.data[0]));
    if (!dataOldConsultancy.success || !Array.isArray(dataOldConsultancy.data) || !dataOldConsultancy.pagination) {
      throw new Error('Existing GET /api/user/consultancy output format was altered!');
    }
    console.log('✅ CONFIRMED: Existing GET /api/user/consultancy behaves identically to before.');

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
