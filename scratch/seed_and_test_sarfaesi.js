import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateSectionOrder } from '../src/utils/sectionOrder.js';
import {
  getSingleBearerAct,
  getActsByBearerAct,
  getSingleAct,
  getSectionsByAct,
  getSingleSection,
  searchGlobalBearerActs
} from '../src/controllers/bearerAct.controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

const jsonPath = path.join(__dirname, '../prisma/securitisation_and_reconstruction_of_financial_assets_and_enforcement_of_security_interest_act__2002.json');

const ACT_CONFIG = {
  heading: 'THE SECURITISATION AND RECONSTRUCTION OF FINANCIAL ASSETS AND ENFORCEMENT OF SECURITY INTEREST ACT, 2002',
  act: 'THE SECURITISATION AND RECONSTRUCTION OF FINANCIAL ASSETS AND ENFORCEMENT OF SECURITY INTEREST ACT, 2002',
  year: 2002,
  expectedSections: 61,
  expectedChapters: 7,
  searchTerms: ['SECURITISATION', 'SARFAESI', 'SECURITY INTEREST']
};

const getSectionKey = (item) => item.section.trim().toLowerCase();

export async function seedAndTestSarfaesi() {
  console.log('================================================================');
  console.log(' SEEDING & TESTING: SARFAESI ACT, 2002');
  console.log('================================================================\n');

  // Step 1: Validate JSON File
  console.log('--- Step 1: Validating SARFAESI JSON File ---');
  const rawData = fs.readFileSync(jsonPath, 'utf8');
  const sections = JSON.parse(rawData);
  console.log(`Loaded ${sections.length} sections from JSON file.`);

  if (sections.length !== ACT_CONFIG.expectedSections) {
    throw new Error(`Section count mismatch: expected ${ACT_CONFIG.expectedSections}, got ${sections.length}`);
  }

  const seenSections = new Set();
  const chaptersMap = new Map();
  let prevOrder = -1;

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!s.section || !s.sectionNo || s.chapterNo === undefined || !s.chapterName || !s.title || s.description === undefined) {
      throw new Error(`Invalid section object at index ${i}: ${JSON.stringify(s)}`);
    }

    const key = getSectionKey(s);
    if (seenSections.has(key)) {
      throw new Error(`Duplicate section found: ${s.section}`);
    }
    seenSections.add(key);

    const chKey = `${s.chapterNo} - ${s.chapterName}`;
    chaptersMap.set(chKey, (chaptersMap.get(chKey) || 0) + 1);

    const order = calculateSectionOrder(s.sectionNo);
    if (order < prevOrder) {
      console.warn(`Warning: section order not strictly ascending at ${s.section} (${order} < ${prevOrder})`);
    }
    prevOrder = order;
  }

  console.log(`Unique chapters found: ${chaptersMap.size} (Expected: ${ACT_CONFIG.expectedChapters})`);
  for (const [ch, cnt] of chaptersMap) {
    console.log(`  Chapter ${ch}: ${cnt} sections`);
  }

  if (chaptersMap.size !== ACT_CONFIG.expectedChapters) {
    throw new Error(`Chapter count mismatch: expected ${ACT_CONFIG.expectedChapters}, got ${chaptersMap.size}`);
  }

  // Step 2: Target Category Verification
  console.log('\n--- Step 2: Finding Category "Insolvency, Banking, & Debt Recovery" ---');
  const bearerAct = await prisma.bearerAct.findFirst({
    where: {
      OR: [
        { id: '8f12e880-7a6f-46a1-883d-cda11c938e64' },
        { name: { contains: 'Insolvency', mode: 'insensitive' } }
      ]
    }
  });

  if (!bearerAct) {
    throw new Error('BearerAct category for "Insolvency, Banking, & Debt Recovery" not found!');
  }
  console.log(`Found BearerAct Category: "${bearerAct.name}" (ID: ${bearerAct.id})`);

  // Step 3: Seed Function
  const seedAct = async () => {
    let act = await prisma.act.findFirst({
      where: {
        bearerActId: bearerAct.id,
        heading: { contains: 'SECURITISATION', mode: 'insensitive' }
      }
    });

    if (!act) {
      act = await prisma.act.create({
        data: {
          bearerActId: bearerAct.id,
          heading: ACT_CONFIG.heading,
          act: ACT_CONFIG.act,
          year: ACT_CONFIG.year
        }
      });
      console.log(`Act created: "${act.heading}" (ID: ${act.id})`);
    } else {
      act = await prisma.act.update({
        where: { id: act.id },
        data: {
          heading: ACT_CONFIG.heading,
          act: ACT_CONFIG.act,
          year: ACT_CONFIG.year
        }
      });
      console.log(`Act synchronized: "${act.heading}" (ID: ${act.id})`);
    }

    const existingSections = await prisma.actSection.findMany({
      where: { actId: act.id }
    });
    const sectionMap = new Map(existingSections.map(s => [getSectionKey(s), s]));

    const toCreate = [];
    const toUpdate = [];
    const baseTime = Date.now();

    for (let i = 0; i < sections.length; i++) {
      const item = sections[i];
      const key = getSectionKey(item);
      const existing = sectionMap.get(key);
      const sectionOrder = calculateSectionOrder(item.sectionNo || item.section);
      const chapterNoInt = typeof item.chapterNo === 'number' ? Math.trunc(item.chapterNo) : parseInt(item.chapterNo, 10);

      if (!existing) {
        toCreate.push({
          actId: act.id,
          section: item.section,
          sectionOrder: sectionOrder,
          chapterNo: chapterNoInt,
          chapterName: item.chapterName,
          title: item.title,
          description: item.description,
          metaData: item.metaData || null,
          metaDescription: item.metaDescription || null,
          metaTitle: item.metaTitle || null,
          createdAt: new Date(baseTime + i * 10)
        });
      } else {
        toUpdate.push({
          id: existing.id,
          data: {
            section: item.section,
            sectionOrder: sectionOrder,
            chapterNo: chapterNoInt,
            chapterName: item.chapterName,
            title: item.title,
            description: item.description,
            metaData: item.metaData || null,
            metaDescription: item.metaDescription || null,
            metaTitle: item.metaTitle || null
          }
        });
      }
    }

    if (toCreate.length > 0) {
      const chunkSize = 50;
      for (let i = 0; i < toCreate.length; i += chunkSize) {
        await prisma.actSection.createMany({
          data: toCreate.slice(i, i + chunkSize)
        });
      }
    }

    if (toUpdate.length > 0) {
      const updateChunkSize = 25;
      for (let i = 0; i < toUpdate.length; i += updateChunkSize) {
        const chunk = toUpdate.slice(i, i + updateChunkSize);
        await Promise.all(
          chunk.map(u =>
            prisma.actSection.update({
              where: { id: u.id },
              data: u.data
            })
          )
        );
      }
    }

    return { act, createdCount: toCreate.length, updatedCount: toUpdate.length };
  };

  // Step 4: First Seed Run
  console.log('\n--- Step 4: Executing First Seed Run ---');
  const run1 = await seedAct();
  console.log(`Run 1 Result: ${run1.createdCount} sections created, ${run1.updatedCount} sections updated.`);

  // Step 5: Second Seed Run (Idempotency)
  console.log('\n--- Step 5: Executing Second Seed Run (Idempotency Check) ---');
  const run2 = await seedAct();
  console.log(`Run 2 Result: ${run2.createdCount} sections created, ${run2.updatedCount} sections updated.`);
  if (run2.createdCount !== 0) {
    throw new Error(`Duplicate check FAILED: ${run2.createdCount} sections created on rerun!`);
  }
  console.log('✅ Duplicate check PASSED: 0 duplicate sections created on rerun.');

  // Step 6: Verify Database Records
  console.log('\n--- Step 6: Verifying DB Sections & Chapters ---');
  const dbSections = await prisma.actSection.findMany({
    where: { actId: run1.act.id },
    orderBy: [
      { chapterNo: 'asc' },
      { sectionOrder: 'asc' },
      { createdAt: 'asc' }
    ]
  });

  console.log(`Expected sections in DB: ${sections.length}`);
  console.log(`Actual sections in DB: ${dbSections.length}`);
  if (dbSections.length !== sections.length) {
    throw new Error(`Section count mismatch in DB: expected ${sections.length}, got ${dbSections.length}`);
  }

  const dbChapters = new Set(dbSections.map(s => s.chapterName));
  console.log(`Unique chapters in DB: ${dbChapters.size} (Expected: ${ACT_CONFIG.expectedChapters})`);
  if (dbChapters.size !== ACT_CONFIG.expectedChapters) {
    throw new Error(`Chapter count mismatch in DB: expected ${ACT_CONFIG.expectedChapters}, got ${dbChapters.size}`);
  }

  console.log('✅ All 61 sections and 7 chapters verified in DB!');

  // Step 7: Testing Controller Endpoints
  console.log('\n--- Step 7: Testing Controller API Endpoints ---');
  const mockNext = (err) => {
    if (err) throw err;
  };

  // 7.1 getSingleAct
  let singleActResp = null;
  await getSingleAct(
    { params: { id: run1.act.id } },
    {
      status: (code) => ({
        json: (data) => {
          singleActResp = { code, data };
          return data;
        }
      })
    },
    mockNext
  );

  console.log(`1. getSingleAct: Status ${singleActResp?.code}, Sections: ${singleActResp?.data?.data?.sections?.length}`);
  if (singleActResp?.code !== 200 || !singleActResp?.data?.success || singleActResp.data.data.sections.length !== 61) {
    throw new Error('getSingleAct API test failed!');
  }

  // 7.2 getSectionsByAct
  let sectionsPaginatedResp = null;
  await getSectionsByAct(
    {
      params: { id: run1.act.id },
      query: { page: '1', limit: '100' }
    },
    {
      status: (code) => ({
        json: (data) => {
          sectionsPaginatedResp = { code, data };
          return data;
        }
      })
    },
    mockNext
  );

  console.log(`2. getSectionsByAct: Status ${sectionsPaginatedResp?.code}, Total: ${sectionsPaginatedResp?.data?.pagination?.total}`);
  if (sectionsPaginatedResp?.code !== 200 || !sectionsPaginatedResp?.data?.success || sectionsPaginatedResp.data.pagination.total !== 61) {
    throw new Error('getSectionsByAct API test failed!');
  }

  // 7.3 getSingleSection (test first, middle, last)
  const actData = singleActResp.data.data;
  const firstSec = actData.sections[0];
  const midSec = actData.sections[Math.floor(actData.sections.length / 2)];
  const lastSec = actData.sections[actData.sections.length - 1];

  for (const targetSec of [firstSec, midSec, lastSec]) {
    let singleSectionResp = null;
    await getSingleSection(
      { params: { id: targetSec.id } },
      {
        status: (code) => ({
          json: (data) => {
            singleSectionResp = { code, data };
            return data;
          }
        })
      },
      mockNext
    );

    if (singleSectionResp?.code !== 200 || !singleSectionResp?.data?.success) {
      throw new Error(`getSingleSection API failed for ${targetSec.section}`);
    }
    console.log(`3. getSingleSection: Verified "${singleSectionResp.data.data.section}" - "${singleSectionResp.data.data.title}"`);
  }

  // 7.4 searchGlobalBearerActs
  let searchResp = null;
  await searchGlobalBearerActs(
    { query: { q: 'Securitisation', page: '1', limit: '5' } },
    {
      status: (code) => ({
        json: (data) => {
          searchResp = { code, data };
          return data;
        }
      })
    },
    mockNext
  );

  console.log(`4. searchGlobalBearerActs ("Securitisation"): Status ${searchResp?.code}, Total Matches: ${searchResp?.data?.pagination?.total}`);
  if (searchResp?.code !== 200 || !searchResp?.data?.success || searchResp.data.pagination.total === 0) {
    throw new Error('searchGlobalBearerActs failed!');
  }

  console.log('\n================================================================');
  console.log(' ALL SARFAESI ACT SEEDING, IDEMPOTENCY, AND API TESTS PASSED!');
  console.log('================================================================\n');

  await prisma.$disconnect();
}

seedAndTestSarfaesi().catch(async (e) => {
  console.error('Execution FAILED with error:', e);
  await prisma.$disconnect();
  process.exit(1);
});
