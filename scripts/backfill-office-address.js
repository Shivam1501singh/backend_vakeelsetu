import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const isApply = process.argv.includes('--apply');

  // Redact DB credentials and show host
  let dbHost = 'unknown';
  try {
    if (process.env.DATABASE_URL) {
      const url = new URL(process.env.DATABASE_URL);
      dbHost = url.host;
    }
  } catch (err) {
    dbHost = 'unparseable';
  }

  console.log('=====================================================');
  console.log('   VakeelSetu: Backfill Office Address from completeAddress');
  console.log(`   Database Host: ${dbHost}`);
  console.log(`   Mode: ${isApply ? 'APPLY (DATABASE UPDATE)' : 'DRY RUN (READ ONLY - PASS --apply TO WRITE)'}`);
  console.log('=====================================================\n');

  try {
    // 1. Gather pre-run aggregate counts across all advocates
    const allAdvocates = await prisma.advocate.findMany({
      select: {
        id: true,
        officeAddress: true,
        completeAddress: true,
        pendingProfileChange: true
      }
    });

    let completeOnlyCount = 0;
    let bothFilledCount = 0;
    let officeOnlyCount = 0;
    let neitherCount = 0;
    let pendingWithCompleteAddressCount = 0;

    for (const a of allAdvocates) {
      const hasComplete = Boolean(a.completeAddress && a.completeAddress.trim().length > 0);
      const hasOffice = Boolean(a.officeAddress && a.officeAddress.trim().length > 0);

      if (hasComplete && !hasOffice) completeOnlyCount++;
      else if (hasComplete && hasOffice) bothFilledCount++;
      else if (!hasComplete && hasOffice) officeOnlyCount++;
      else neitherCount++;

      if (a.pendingProfileChange && typeof a.pendingProfileChange === 'object' && 'completeAddress' in a.pendingProfileChange) {
        pendingWithCompleteAddressCount++;
      }
    }

    console.log('Pre-run Database Counts:');
    console.log(`  Total advocates:                               ${allAdvocates.length}`);
    console.log(`  completeAddress filled & officeAddress empty:  ${completeOnlyCount} (candidates to copy)`);
    console.log(`  Both filled:                                   ${bothFilledCount} (officeAddress preserved; untouched)`);
    console.log(`  Only officeAddress filled:                     ${officeOnlyCount}`);
    console.log(`  Neither filled:                                ${neitherCount}`);
    console.log(`  Pending profile changes with completeAddress:  ${pendingWithCompleteAddressCount}\n`);

    // 2. Fetch all candidates where officeAddress is missing and completeAddress exists
    const candidates = await prisma.advocate.findMany({
      where: {
        OR: [
          { officeAddress: null },
          { officeAddress: '' }
        ],
        completeAddress: { not: null }
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        completeAddress: true
      }
    });

    // Filter out whitespace-only strings
    const toMigrate = candidates.filter(c => c.completeAddress && c.completeAddress.trim().length > 0);

    console.log(`Found ${toMigrate.length} candidate record(s) to backfill into officeAddress.`);

    if (toMigrate.length === 0) {
      console.log('No records need backfilling. All advocates already have officeAddress populated.');
      return;
    }

    console.log('\nCandidate Advocate IDs to migrate (IDs only, no personal data):');
    for (const row of toMigrate) {
      console.log(`  - ${row.id}`);
    }
    console.log('');

    // Length check distribution
    let under10 = 0;
    let over255 = 0;
    let validRange = 0;
    for (const row of toMigrate) {
      const len = row.completeAddress.trim().length;
      if (len < 10) under10++;
      else if (len > 255) over255++;
      else validRange++;
    }
    console.log(`Length breakdown of source completeAddress:`);
    console.log(`  - 10 to 255 chars (valid): ${validRange}`);
    console.log(`  - < 10 chars (out of range): ${under10}`);
    console.log(`  - > 255 chars (out of range): ${over255}\n`);

    let processedCount = 0;

    if (isApply) {
      console.log('Applying backfill updates...');
      for (const row of toMigrate) {
        const trimmed = row.completeAddress.trim();
        await prisma.advocate.update({
          where: { id: row.id },
          data: {
            officeAddress: trimmed
          }
        });
        processedCount++;
      }
      console.log(`Successfully updated ${processedCount} advocate record(s).\n`);

      // 3. Post-run verification counts
      const postAdvocates = await prisma.advocate.findMany({
        select: {
          officeAddress: true,
          completeAddress: true
        }
      });
      let postCompleteOnly = 0;
      let postBothFilled = 0;
      let postOfficeOnly = 0;
      let postNeither = 0;
      for (const a of postAdvocates) {
        const hasComplete = Boolean(a.completeAddress && a.completeAddress.trim().length > 0);
        const hasOffice = Boolean(a.officeAddress && a.officeAddress.trim().length > 0);
        if (hasComplete && !hasOffice) postCompleteOnly++;
        else if (hasComplete && hasOffice) postBothFilled++;
        else if (!hasComplete && hasOffice) postOfficeOnly++;
        else postNeither++;
      }

      console.log('Post-run Database Counts:');
      console.log(`  Total advocates:                               ${postAdvocates.length}`);
      console.log(`  completeAddress filled & officeAddress empty:  ${postCompleteOnly}`);
      console.log(`  Both filled:                                   ${postBothFilled}`);
      console.log(`  Only officeAddress filled:                     ${postOfficeOnly}`);
      console.log(`  Neither filled:                                ${postNeither}\n`);
    } else {
      console.log(`[DRY RUN COMPLETE] ${toMigrate.length} record(s) would be updated with trimmed completeAddress.`);
      console.log('No database modifications were made. Run with --apply to execute.');
    }

    console.log('=====================================================');
    console.log(`Backfill Status:`);
    console.log(`Total scanned:   ${toMigrate.length}`);
    console.log(`Total processed: ${isApply ? processedCount : 0}`);
    console.log(`Mode:            ${isApply ? 'APPLIED TO DATABASE' : 'DRY RUN (Read Only)'}`);
    console.log('=====================================================');
  } catch (error) {
    console.error('Backfill failed with error:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
