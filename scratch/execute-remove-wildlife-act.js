import fs from 'fs';
import path from 'path';
import prisma from '../src/lib/prisma.js';

const TARGET_ACT_ID = '5107fc84-db93-4a5f-8a28-686d7317ec21';
const EXPECTED_BEARER_ACT_ID = 'cd654b8f-2414-4979-b29f-47780086217f';
const EXPECTED_HEADING = 'THE WILD LIFE (PROTECTION) ACT, 1972';

async function executeDeletion() {
  console.log('====================================================');
  console.log(' EXECUTING DELETION OF WILDLIFE (PROTECTION) ACT, 1972');
  console.log('====================================================\n');

  // Step 1: Pre-deletion verification
  const targetAct = await prisma.act.findUnique({
    where: { id: TARGET_ACT_ID },
    include: {
      bearerAct: true,
      sections: true,
      pdfs: true
    }
  });

  if (!targetAct) {
    throw new Error(`Target Act with ID ${TARGET_ACT_ID} not found in database!`);
  }

  if (targetAct.bearerActId !== EXPECTED_BEARER_ACT_ID) {
    throw new Error(`Target Act bearerActId mismatch: expected ${EXPECTED_BEARER_ACT_ID}, got ${targetAct.bearerActId}`);
  }

  if (targetAct.heading !== EXPECTED_HEADING) {
    throw new Error(`Target Act heading mismatch: expected "${EXPECTED_HEADING}", got "${targetAct.heading}"`);
  }

  console.log(`Verified Target Act:`);
  console.log(`  ID: ${targetAct.id}`);
  console.log(`  Heading: "${targetAct.heading}"`);
  console.log(`  BearerAct Category: "${targetAct.bearerAct.name}" (${targetAct.bearerAct.id})`);
  console.log(`  Sections Count: ${targetAct.sections.length}`);
  console.log(`  PDFs Count: ${targetAct.pdfs.length}\n`);

  // Step 2: Verify PDF attachment and file exclusivity
  const pdfRecords = targetAct.pdfs;
  const filesToDelete = [];

  for (const pdf of pdfRecords) {
    console.log(`Checking PDF record: ${pdf.displayName} (${pdf.id}) -> ${pdf.filePath}`);
    const otherReferences = await prisma.actPdf.findMany({
      where: {
        id: { not: pdf.id },
        OR: [
          { fileName: pdf.fileName },
          { filePath: pdf.filePath }
        ]
      }
    });

    if (otherReferences.length > 0) {
      console.warn(`[WARNING] PDF file is referenced by other records! Skipping file deletion for safety.`);
    } else {
      const fullPath = path.resolve(process.cwd(), pdf.filePath);
      filesToDelete.push(fullPath);
      console.log(`PDF file is exclusive to this Act. Marked for file deletion: ${fullPath}`);
    }
  }

  // Step 3: Perform database deletion
  console.log('\nExecuting Prisma Act deletion...');
  const deletedAct = await prisma.act.delete({
    where: { id: TARGET_ACT_ID }
  });
  console.log(`Successfully deleted Act: "${deletedAct.heading}" (ID: ${deletedAct.id})`);

  // Step 4: Remove physical files
  for (const filePath of filesToDelete) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Successfully deleted exclusive PDF file from disk: ${filePath}`);
    } else {
      console.log(`PDF file does not exist on disk: ${filePath}`);
    }
  }

  // Step 5: Post-deletion verification
  console.log('\n--- Post-Deletion Verifications ---');

  const checkAct = await prisma.act.findUnique({
    where: { id: TARGET_ACT_ID }
  });
  console.log(`Act still exists: ${checkAct !== null}`);

  const checkSections = await prisma.actSection.count({
    where: { actId: TARGET_ACT_ID }
  });
  console.log(`Orphan sections remaining for this Act: ${checkSections}`);

  const checkPdfs = await prisma.actPdf.count({
    where: { actId: TARGET_ACT_ID }
  });
  console.log(`Orphan PDFs remaining for this Act: ${checkPdfs}`);

  const bearerAct = await prisma.bearerAct.findUnique({
    where: { id: EXPECTED_BEARER_ACT_ID },
    include: {
      acts: {
        select: {
          id: true,
          heading: true,
          year: true,
          _count: {
            select: { sections: true, pdfs: true }
          }
        }
      }
    }
  });

  console.log(`\nBearerAct "${bearerAct.name}" remaining Acts count: ${bearerAct.acts.length}`);
  bearerAct.acts.forEach((act, idx) => {
    console.log(`  ${idx + 1}. [${act.id}] "${act.heading}" (${act.year}) - ${act._count.sections} sections, ${act._count.pdfs} PDFs`);
  });

  const totalCategories = await prisma.bearerAct.count();
  console.log(`\nTotal BearerAct categories intact: ${totalCategories}`);

  console.log('\n====================================================');
  console.log(' EXECUTION COMPLETED SUCCESSFULLY');
  console.log('====================================================');
}

executeDeletion()
  .catch((err) => {
    console.error('Deletion error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
