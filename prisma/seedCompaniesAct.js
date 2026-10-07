import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateSectionOrder } from '../src/utils/sectionOrder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

async function seedCompaniesAct() {
  console.log('🚀 Starting seed for THE COMPANIES ACT, 2013...');

  const dataFilePath = path.join(__dirname, 'companiesActBearerActData.json');
  if (!fs.existsSync(dataFilePath)) {
    throw new Error(`Data file not found at: ${dataFilePath}`);
  }

  const rawData = fs.readFileSync(dataFilePath, 'utf8');
  const sectionsData = JSON.parse(rawData);

  console.log(`Found ${sectionsData.length} sections in JSON file.`);

  // 1. Ensure BearerAct "Commercial and Business" exists
  let bearerAct = await prisma.bearerAct.findFirst({
    where: {
      OR: [
        { name: { equals: 'Commercial and Business', mode: 'insensitive' } },
        { name: { equals: 'Commercial & Business', mode: 'insensitive' } }
      ]
    }
  });

  if (!bearerAct) {
    bearerAct = await prisma.bearerAct.create({
      data: {
        name: 'Commercial and Business'
      }
    });
    console.log(`Created BearerAct: ${bearerAct.name} (${bearerAct.id})`);
  } else {
    console.log(`Using existing BearerAct: ${bearerAct.name} (${bearerAct.id})`);
  }

  // 2. Ensure Act "THE COMPANIES ACT, 2013" exists
  let act = await prisma.act.findFirst({
    where: {
      bearerActId: bearerAct.id,
      act: { contains: 'Companies', mode: 'insensitive' }
    }
  });

  if (!act) {
    act = await prisma.act.create({
      data: {
        bearerActId: bearerAct.id,
        heading: 'THE COMPANIES ACT, 2013',
        act: 'THE COMPANIES ACT, 2013',
        year: 2013
      }
    });
    console.log(`Created Act: ${act.act} (${act.id})`);
  } else {
    console.log(`Using existing Act: ${act.act} (${act.id})`);
  }

  // 3. Clear existing sections for this act (if any) to prevent duplicates
  const deletedCount = await prisma.actSection.deleteMany({
    where: { actId: act.id }
  });
  console.log(`Cleaned up ${deletedCount.count} existing sections for this Act.`);

  // 4. Map data to ActSection records
  const actSections = sectionsData.map((item) => {
    const rawSectionNo = item.sectionNo || item.section || '';
    const sectionOrder = calculateSectionOrder(rawSectionNo);

    return {
      actId: act.id,
      section: item.section || `Section ${rawSectionNo}`,
      sectionOrder: sectionOrder,
      chapterNo: Number(item.chapterNo) || 1,
      chapterName: item.chapterName || '',
      title: item.title || '',
      description: item.description || '',
      metaData: item.metaData || 'THE COMPANIES ACT, 2013',
      metaDescription: item.metaDescription || `THE COMPANIES ACT, 2013 ${item.section || ''} - ${item.title || ''}`,
      metaTitle: item.metaTitle || `${item.section || ''} - THE COMPANIES ACT, 2013`
    };
  });

  // 5. Insert in batches using createMany
  const batchSize = 100;
  let inserted = 0;
  for (let i = 0; i < actSections.length; i += batchSize) {
    const batch = actSections.slice(i, i + batchSize);
    await prisma.actSection.createMany({
      data: batch
    });
    inserted += batch.length;
    console.log(`Inserted ${inserted}/${actSections.length} sections...`);
  }

  // 6. Verify total in DB
  const totalInDb = await prisma.actSection.count({
    where: { actId: act.id }
  });

  console.log(`\n Successfully seeded ${totalInDb} sections for "${act.act}"!`);
}

seedCompaniesAct()
  .catch((e) => {
    console.error('❌ Error seeding Companies Act:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
