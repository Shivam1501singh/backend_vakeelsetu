import { PrismaClient } from '@prisma/client';
import { generateBookingId } from '../src/utils/idFormat.js';

const prisma = new PrismaClient();

async function main() {
  const isApply = process.argv.includes('--apply');

  console.log('=====================================================');
  console.log('   VakeelSetu: Backfill Booking IDs (Consultancy)    ');
  console.log(`   Mode: ${isApply ? 'APPLY (DATABASE UPDATE)' : 'DRY RUN (READ ONLY)'}`);
  console.log('=====================================================\n');

  try {
    // 1. Collect all currently assigned booking IDs to avoid any collisions
    const existingRecords = await prisma.consultancyRequest.findMany({
      where: { bookingId: { not: null } },
      select: { bookingId: true }
    });
    const usedBookingIds = new Set(existingRecords.map((r) => r.bookingId).filter(Boolean));
    console.log(`Found ${usedBookingIds.size} already assigned bookingId(s).`);

    // 2. Fetch all consultancy requests missing a bookingId
    const pendingRecords = await prisma.consultancyRequest.findMany({
      where: {
        OR: [
          { bookingId: null },
          { bookingId: '' }
        ]
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        createdAt: true,
        phoneNumber: true,
        email: true
      }
    });

    console.log(`Found ${pendingRecords.length} record(s) without bookingId.\n`);

    if (pendingRecords.length === 0) {
      console.log('No records need backfilling. All consultancy requests have a bookingId.');
      return;
    }

    let successCount = 0;

    for (const record of pendingRecords) {
      // Generate a collision-free bookingId based on record's own createdAt (IST)
      let newBookingId = generateBookingId(record.createdAt);
      let collisionRetries = 0;
      while (usedBookingIds.has(newBookingId) && collisionRetries < 20) {
        newBookingId = generateBookingId(record.createdAt);
        collisionRetries++;
      }

      usedBookingIds.add(newBookingId);

      if (isApply) {
        await prisma.consultancyRequest.update({
          where: { id: record.id },
          data: { bookingId: newBookingId }
        });
        console.log(`[APPLIED] Record ${record.id} (created ${record.createdAt.toISOString()}) -> ${newBookingId}`);
      } else {
        console.log(`[DRY RUN] Would assign ${record.id} (created ${record.createdAt.toISOString()}) -> ${newBookingId}`);
      }

      successCount++;
    }

    console.log('\n=====================================================');
    console.log(`Backfill Summary:`);
    console.log(`Total scanned:   ${pendingRecords.length}`);
    console.log(`Total processed: ${successCount}`);
    console.log(`Mode:            ${isApply ? 'APPLIED TO DATABASE' : 'DRY RUN (Pass --apply to write)'}`);
    console.log('=====================================================');
  } catch (error) {
    console.error('Backfill failed with error:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
