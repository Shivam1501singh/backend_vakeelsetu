import { PrismaClient } from '@prisma/client';
import { calculateSectionOrder } from '../src/utils/sectionOrder.js';

const prisma = new PrismaClient();

async function main() {
  const isApply = process.argv.includes('--apply');

  console.log('=====================================================');
  console.log('   VakeelSetu: Backfill ActSection sectionOrder      ');
  console.log(`   Mode: ${isApply ? 'APPLY (DATABASE UPDATE)' : 'DRY RUN (READ ONLY)'}`);
  console.log('=====================================================\n');

  // Load all acts for heading lookup
  const acts = await prisma.act.findMany({
    select: { id: true, heading: true }
  });
  const actMap = new Map(acts.map((a) => [a.id, a.heading]));

  const BATCH_SIZE = 1000;
  let cursor = null;
  let totalChecked = 0;

  const mismatches = [];
  const fallbackSections = []; // expected === 999999
  const actSectionCountMap = new Map(); // actId -> Map(section -> count)

  while (true) {
    const rows = await prisma.actSection.findMany({
      take: BATCH_SIZE,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        actId: true,
        section: true,
        sectionOrder: true
      }
    });

    if (rows.length === 0) break;

    for (const row of rows) {
      totalChecked++;
      const expected = calculateSectionOrder(row.section);
      const isMismatch = Math.abs(row.sectionOrder - expected) > 1e-9;

      if (isMismatch) {
        mismatches.push({
          id: row.id,
          actId: row.actId,
          actHeading: actMap.get(row.actId) || 'Unknown Act',
          section: row.section,
          current: row.sectionOrder,
          expected
        });
      }

      if (expected === 999999) {
        fallbackSections.push({
          id: row.id,
          actId: row.actId,
          actHeading: actMap.get(row.actId) || 'Unknown Act',
          section: row.section,
          current: row.sectionOrder
        });
      }

      // Track duplicates
      if (!actSectionCountMap.has(row.actId)) {
        actSectionCountMap.set(row.actId, new Map());
      }
      const secMap = actSectionCountMap.get(row.actId);
      secMap.set(row.section, (secMap.get(row.section) || 0) + 1);
    }

    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH_SIZE) break;
  }

  // Summary counts
  console.log(`Total ActSection records checked: ${totalChecked}`);
  console.log(`Total mismatches detected: ${mismatches.length}`);

  // Breakdown of mismatches per Act
  const mismatchesByAct = new Map();
  for (const m of mismatches) {
    if (!mismatchesByAct.has(m.actId)) {
      mismatchesByAct.set(m.actId, { actHeading: m.actHeading, count: 0 });
    }
    mismatchesByAct.get(m.actId).count++;
  }

  if (mismatchesByAct.size > 0) {
    console.log('\nMismatches by Act:');
    for (const [actId, info] of mismatchesByAct.entries()) {
      console.log(`  - [${actId}] "${info.actHeading}": ${info.count} mismatched sections`);
    }

    console.log('\nFirst 20 mismatches:');
    mismatches.slice(0, 20).forEach((m, idx) => {
      console.log(`  ${idx + 1}. [${m.actId}] (${m.actHeading}) Section: "${m.section}" | Current: ${m.current} | Expected: ${m.expected}`);
    });
  } else {
    console.log('\nNo sectionOrder mismatches found.');
  }

  // Fallback 999999 sections
  console.log(`\nSections with expected sectionOrder = 999999 (no leading number, placed at end): ${fallbackSections.length}`);
  if (fallbackSections.length > 0) {
    fallbackSections.forEach((s, idx) => {
      console.log(`  ${idx + 1}. [${s.actId}] (${s.actHeading}) Section: "${s.section}" | Current: ${s.current}`);
    });
  }

  // Duplicate sections per act
  const duplicates = [];
  for (const [actId, secMap] of actSectionCountMap.entries()) {
    for (const [section, count] of secMap.entries()) {
      if (count > 1) {
        duplicates.push({
          actId,
          actHeading: actMap.get(actId) || 'Unknown Act',
          section,
          count
        });
      }
    }
  }

  if (duplicates.length > 0) {
    console.log(`\n[WARNING] Duplicate section identifiers detected per act (${duplicates.length} duplicate entries):`);
    duplicates.forEach((d, idx) => {
      console.log(`  ${idx + 1}. [${d.actId}] (${d.actHeading}) Section: "${d.section}" appears ${d.count} times`);
    });
  } else {
    console.log('\nNo duplicate section names found within any individual act.');
  }

  // Handle --apply
  if (isApply) {
    if (mismatches.length === 0) {
      console.log('\nNothing to apply. All sectionOrder values are up to date.');
      return;
    }

    console.log(`\nApplying updates for ${mismatches.length} records in chunks of 500...`);
    const CHUNK_SIZE = 500;
    let updatedCount = 0;

    for (let i = 0; i < mismatches.length; i += CHUNK_SIZE) {
      const chunk = mismatches.slice(i, i + CHUNK_SIZE);
      await prisma.$transaction(
        chunk.map((item) =>
          prisma.actSection.update({
            where: { id: item.id },
            data: { sectionOrder: item.expected }
          })
        )
      );
      updatedCount += chunk.length;
      console.log(`  Updated ${updatedCount}/${mismatches.length} records...`);
    }

    console.log(`\nSuccessfully backfilled ${updatedCount} ActSection records.`);
  } else {
    if (mismatches.length > 0) {
      console.log('\nDry run complete. Run with --apply to write these changes to the database.');
    } else {
      console.log('\nDry run complete. Database is already fully consistent.');
    }
  }
}

main()
  .catch((err) => {
    console.error('Error in backfill script:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
