import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const isApply = process.argv.includes('--apply');

  // Print DB host first for safety verification
  const dbUrl = process.env.DATABASE_URL;
  let dbHost = 'unknown';
  if (dbUrl) {
    try {
      dbHost = new URL(dbUrl).hostname;
    } catch (_) {}
  }

  console.log('=====================================================');
  console.log('   VakeelSetu: Backfill Advocate Earnings & Reversals ');
  console.log(`   Database Host: ${dbHost}`);
  console.log(`   Mode: ${isApply ? 'APPLY (DATABASE MUTATION)' : 'DRY RUN (READ ONLY - Pass --apply to execute)'}`);
  console.log('=====================================================\n');

  try {
    // 1. Fetch all bookings that reached COMPLETED status
    // (Note: in edge cases, a completed booking may now be REFUNDED or REFUND_PENDING, but completedAt is set)
    const completedBookings = await prisma.advocateBooking.findMany({
      where: {
        OR: [
          { status: 'COMPLETED' },
          { completedAt: { not: null } }
        ]
      },
      select: {
        id: true,
        bookingId: true,
        advocateId: true,
        feePaise: true,
        status: true,
        completedAt: true,
        refundedAt: true,
        createdAt: true
      },
      orderBy: { createdAt: 'asc' }
    });

    console.log(`Found ${completedBookings.length} completed booking candidate(s).\n`);

    // 2. Fetch existing ledger records to ensure strict idempotency
    const existingLedgerRecords = await prisma.advocateEarningLedger.findMany({
      where: {
        advocateBookingId: { in: completedBookings.map((b) => b.id) }
      },
      select: {
        type: true,
        advocateBookingId: true
      }
    });

    const existingEarningsSet = new Set(
      existingLedgerRecords
        .filter((r) => r.type === 'BOOKING_EARNING')
        .map((r) => r.advocateBookingId)
    );

    const existingReversalsSet = new Set(
      existingLedgerRecords
        .filter((r) => r.type === 'REFUND_REVERSAL')
        .map((r) => r.advocateBookingId)
    );

    let earningsToCreate = 0;
    let reversalsToCreate = 0;
    let totalEarningPaise = 0;
    let totalReversalPaise = 0;

    for (const booking of completedBookings) {
      const bIdentifier = booking.bookingId || booking.id;

      // Check missing BOOKING_EARNING
      if (!existingEarningsSet.has(booking.id)) {
        earningsToCreate++;
        totalEarningPaise += booking.feePaise;

        if (isApply) {
          await prisma.advocateEarningLedger.create({
            data: {
              advocateId: booking.advocateId,
              type: 'BOOKING_EARNING',
              amountPaise: booking.feePaise,
              advocateBookingId: booking.id,
              note: `Backfill: Earning for completed booking ${bIdentifier}`,
              createdBy: 'system',
              createdAt: booking.completedAt || booking.createdAt
            }
          });
          console.log(`[APPLIED EARNING] Booking ${bIdentifier} -> +${(booking.feePaise / 100).toFixed(2)} INR (${booking.feePaise} paise)`);
        } else {
          console.log(`[DRY RUN EARNING] Would create BOOKING_EARNING for Booking ${bIdentifier} -> +${(booking.feePaise / 100).toFixed(2)} INR`);
        }
      }

      // Check missing REFUND_REVERSAL (if completed booking was subsequently refunded)
      if (
        (booking.status === 'REFUNDED' || booking.refundedAt !== null) &&
        !existingReversalsSet.has(booking.id)
      ) {
        reversalsToCreate++;
        totalReversalPaise += booking.feePaise;

        if (isApply) {
          await prisma.advocateEarningLedger.create({
            data: {
              advocateId: booking.advocateId,
              type: 'REFUND_REVERSAL',
              amountPaise: -booking.feePaise,
              advocateBookingId: booking.id,
              note: `Backfill: Reversal for refunded completed booking ${bIdentifier}`,
              createdBy: 'system',
              createdAt: booking.refundedAt || new Date()
            }
          });
          console.log(`[APPLIED REVERSAL] Booking ${bIdentifier} -> -${(booking.feePaise / 100).toFixed(2)} INR`);
        } else {
          console.log(`[DRY RUN REVERSAL] Would create REFUND_REVERSAL for Booking ${bIdentifier} -> -${(booking.feePaise / 100).toFixed(2)} INR`);
        }
      }
    }

    console.log('\n=====================================================');
    console.log('Backfill Execution Summary:');
    console.log(`Database Host:         ${dbHost}`);
    console.log(`Total Candidates:      ${completedBookings.length}`);
    console.log(`BOOKING_EARNING:       ${earningsToCreate} (Total: ₹${(totalEarningPaise / 100).toFixed(2)})`);
    console.log(`REFUND_REVERSAL:       ${reversalsToCreate} (Total: ₹${(totalReversalPaise / 100).toFixed(2)})`);
    console.log(`Execution Mode:        ${isApply ? 'APPLIED TO DATABASE' : 'DRY RUN ONLY'}`);
    console.log('=====================================================');
  } catch (error) {
    console.error('Backfill script error:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
