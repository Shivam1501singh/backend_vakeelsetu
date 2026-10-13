import assert from 'assert';
import fs from 'fs';
import path from 'path';
import prisma from '../src/lib/prisma.js';
import {
  getSingleBearerAct,
  getActsByBearerAct,
  getSingleAct,
  getSectionsByAct,
  searchGlobalBearerActs
} from '../src/controllers/bearerAct.controller.js';

const TARGET_ACT_ID = '5107fc84-db93-4a5f-8a28-686d7317ec21';
const CATEGORY_ID = 'cd654b8f-2414-4979-b29f-47780086217f';
const DELETED_FILE_PATH = path.resolve('uploads/acts/wildlife protection act sechdules -compressed.pdf');

// Mock express req/res
function createMockReqRes(params = {}, query = {}, body = {}) {
  const req = { params, query, body };
  let statusCode = 200;
  let jsonResponse = null;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      jsonResponse = data;
      return res;
    }
  };

  const getResult = () => ({ status: statusCode, body: jsonResponse });
  return { req, res, getResult };
}

async function runVerifications() {
  console.log('====================================================');
  console.log(' PHASE 3: VERIFICATION OF WILDLIFE ACT REMOVAL');
  console.log('====================================================\n');

  // Verification 1: Wildlife Act record in DB
  console.log('Test 1: Verify Wildlife Act record is completely deleted from DB...');
  const actRecord = await prisma.act.findUnique({
    where: { id: TARGET_ACT_ID }
  });
  assert.strictEqual(actRecord, null, 'Act record must be null');
  console.log('✅ Act record is null.');

  // Verification 2: Sections in DB
  console.log('\nTest 2: Verify zero orphan ActSection records exist for this Act...');
  const sectionCount = await prisma.actSection.count({
    where: { actId: TARGET_ACT_ID }
  });
  assert.strictEqual(sectionCount, 0, 'No sections must exist for deleted actId');
  console.log('✅ Section count is 0.');

  // Verification 3: ActPdf in DB
  console.log('\nTest 3: Verify zero orphan ActPdf records exist for this Act...');
  const pdfCount = await prisma.actPdf.count({
    where: { actId: TARGET_ACT_ID }
  });
  assert.strictEqual(pdfCount, 0, 'No PDF records must exist for deleted actId');
  console.log('✅ ActPdf count is 0.');

  // Verification 4: Physical file deleted
  console.log('\nTest 4: Verify physical PDF file is removed from disk...');
  const fileExists = fs.existsSync(DELETED_FILE_PATH);
  assert.strictEqual(fileExists, false, 'Physical PDF file must not exist');
  console.log('✅ Physical PDF file does not exist on disk.');

  // Verification 5: API: GET /api/bearer-acts/:id/acts
  console.log('\nTest 5: Verify getActsByBearerAct controller for Environment and Land...');
  const { req: actsReq, res: actsRes, getResult: getActsResult } = createMockReqRes({ id: CATEGORY_ID }, { page: '1', limit: '20' });
  await getActsByBearerAct(actsReq, actsRes, (err) => { if (err) throw err; });
  const actsResult = getActsResult();
  assert.strictEqual(actsResult.status, 200);
  assert.strictEqual(actsResult.body.success, true);
  assert.strictEqual(actsResult.body.data.length, 6, 'Category must contain exactly 6 acts');

  const wildlifeInActs = actsResult.body.data.some(a =>
    a.id === TARGET_ACT_ID || a.heading.toLowerCase().includes('wild life') || a.act.toLowerCase().includes('wild life')
  );
  assert.strictEqual(wildlifeInActs, false, 'Wildlife Act must not be in acts array');
  console.log('✅ Public API getActsByBearerAct returns exactly 6 acts; Wildlife is absent.');

  // Verification 6: API: GET /api/acts/:id
  console.log('\nTest 6: Verify getSingleAct controller returns 404 for deleted Act...');
  const { req: singleReq, res: singleRes, getResult: getSingleResult } = createMockReqRes({ id: TARGET_ACT_ID });
  await getSingleAct(singleReq, singleRes, (err) => { if (err) throw err; });
  const singleResult = getSingleResult();
  assert.strictEqual(singleResult.status, 404, 'Must return 404');
  console.log('✅ Public API getSingleAct correctly returns 404 Not Found.');

  // Verification 7: API: Global search for wildlife
  console.log('\nTest 7: Verify searchGlobalBearerActs does not find Wildlife Act...');
  const { req: searchReq, res: searchRes, getResult: getSearchResult } = createMockReqRes({}, { q: 'Wild Life', page: '1', limit: '20' });
  await searchGlobalBearerActs(searchReq, searchRes, (err) => { if (err) throw err; });
  const searchResult = getSearchResult();
  assert.strictEqual(searchResult.status, 200);
  const matchingActs = searchResult.body.data.filter(item => item.id === TARGET_ACT_ID || (item.actId && item.actId === TARGET_ACT_ID));
  assert.strictEqual(matchingActs.length, 0, 'Must have 0 matching Wildlife acts or sections');
  console.log('✅ searchGlobalBearerActs returns 0 matches for deleted Wildlife Act.');

  // Verification 8: Remaining 6 Acts under Environment and Land
  console.log('\nTest 8: Verify the remaining 6 Acts in Environment and Land are intact with their sections/PDFs...');
  const expectedRemainingActs = [
    { heading: 'THE AIR (PREVENTION AND CONTROL OF POLLUTION) ACT, 1981', expectedSections: 62, expectedPdfs: 0 },
    { heading: 'THE NATIONAL GREEN TRIBUNAL ACT, 2010', expectedSections: 39, expectedPdfs: 1 },
    { heading: 'THE ENVIRONMENT (PROTECTION) ACT, 1986', expectedSections: 36, expectedPdfs: 0 },
    { heading: 'THE INDIAN FOREST ACT, 1927', expectedSections: 88, expectedPdfs: 0 },
    { heading: 'THE WATER (PREVENTION AND CONTROL OF POLLUTION) ACT, 1974', expectedSections: 75, expectedPdfs: 0 },
    { heading: 'THE BIOLOGICAL DIVERSITY ACT, 2002', expectedSections: 72, expectedPdfs: 0 }
  ];

  const dbCategory = await prisma.bearerAct.findUnique({
    where: { id: CATEGORY_ID },
    include: {
      acts: {
        include: {
          _count: {
            select: { sections: true, pdfs: true }
          }
        }
      }
    }
  });

  assert.strictEqual(dbCategory.acts.length, 6);
  for (const expected of expectedRemainingActs) {
    const matched = dbCategory.acts.find(a => a.heading === expected.heading);
    assert(matched, `Expected act "${expected.heading}" must exist`);
    assert.strictEqual(matched._count.sections, expected.expectedSections, `Sections count mismatch for ${expected.heading}`);
    assert.strictEqual(matched._count.pdfs, expected.expectedPdfs, `PDFs count mismatch for ${expected.heading}`);
    console.log(`  ✓ "${expected.heading}" intact (${matched._count.sections} sections, ${matched._count.pdfs} PDFs)`);
  }

  // Verification 9: Total categories intact
  console.log('\nTest 9: Verify all 13 BearerAct categories exist...');
  const totalCategories = await prisma.bearerAct.count();
  assert.strictEqual(totalCategories, 13, 'Must have exactly 13 BearerAct categories');
  console.log('✅ Exactly 13 BearerAct categories exist.');

  console.log('\n====================================================');
  console.log(' ALL VERIFICATIONS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runVerifications()
  .catch((err) => {
    console.error('Verification failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
