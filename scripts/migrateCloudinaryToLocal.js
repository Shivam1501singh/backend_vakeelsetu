import 'dotenv/config';
import axios from 'axios';
import prisma from '../src/lib/prisma.js';
import { processAndSaveImage } from '../src/services/imageStorage.service.js';

const isDryRun = process.argv.includes('--dry-run');

/**
 * Downloads image buffer from remote Cloudinary URL with timeout and headers.
 */
async function fetchImageBuffer(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: {
      'User-Agent': 'VakeelSetu-Migration-Agent/1.0'
    }
  });
  return Buffer.from(response.data);
}

/**
 * Checks if a URL points to an external remote image that should be migrated to local VPS storage.
 * Skips already migrated local /uploads/ images and non-existent example.com placeholders.
 */
function shouldMigrateUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.includes('/uploads/images/')) return false;
  if (url.includes('example.com')) return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

async function migrateAdvocates(stats) {
  console.log('\n--- Checking Advocates ---');
  const advocates = await prisma.advocate.findMany({
    where: {
      OR: [
        { profilePhotoUrl: { not: null } },
        { officePhotoUrl: { not: null } }
      ]
    }
  });

  console.log(`Scanning ${advocates.length} advocates with non-null photos.`);

  for (const adv of advocates) {
    const updates = {};

    // 1. Profile photo
    if (shouldMigrateUrl(adv.profilePhotoUrl)) {
      try {
        stats.totalAttempted++;
        console.log(`Downloading advocate avatar: ${adv.id} (${adv.fullName || adv.email})`);
        const buffer = await fetchImageBuffer(adv.profilePhotoUrl);
        const saved = await processAndSaveImage({ buffer, category: 'AVATAR' });
        updates.profilePhotoUrl = saved.url;
        updates.profilePhotoPublicId = saved.publicId;
        stats.successful++;
        console.log(`  -> Migrated avatar: ${saved.url}`);
      } catch (err) {
        stats.failed++;
        console.error(`  x Failed avatar for advocate ${adv.id}: ${err.message}`);
      }
    }

    // 2. Office photo
    if (shouldMigrateUrl(adv.officePhotoUrl)) {
      try {
        stats.totalAttempted++;
        console.log(`Downloading advocate office photo: ${adv.id}`);
        const buffer = await fetchImageBuffer(adv.officePhotoUrl);
        const saved = await processAndSaveImage({ buffer, category: 'OFFICE' });
        updates.officePhotoUrl = saved.url;
        updates.officePhotoPublicId = saved.publicId;
        stats.successful++;
        console.log(`  -> Migrated office photo: ${saved.url}`);
      } catch (err) {
        stats.failed++;
        console.error(`  x Failed office photo for advocate ${adv.id}: ${err.message}`);
      }
    }

    // Apply DB update
    if (Object.keys(updates).length > 0 && !isDryRun) {
      await prisma.advocate.update({
        where: { id: adv.id },
        data: updates
      });
    }
  }
}

async function migrateBlogs(stats) {
  console.log('\n--- Checking Blogs ---');
  const blogs = await prisma.blog.findMany({
    where: {
      image: { not: null }
    }
  });

  console.log(`Found ${blogs.length} blogs to inspect.`);

  for (const blog of blogs) {
    if (shouldMigrateUrl(blog.image)) {
      try {
        stats.totalAttempted++;
        console.log(`Downloading blog image: ${blog.id} ("${blog.title}")`);
        const buffer = await fetchImageBuffer(blog.image);
        const saved = await processAndSaveImage({ buffer, category: 'CONTENT' });

        if (!isDryRun) {
          await prisma.blog.update({
            where: { id: blog.id },
            data: {
              image: saved.url,
              imagePublicId: saved.publicId
            }
          });
        }
        stats.successful++;
        console.log(`  -> Migrated blog image: ${saved.url}`);
      } catch (err) {
        stats.failed++;
        console.error(`  x Failed blog image for ${blog.id}: ${err.message}`);
      }
    }
  }
}

async function migrateUserRights(stats) {
  console.log('\n--- Checking User Rights ---');
  const userRights = await prisma.userRight.findMany({
    where: {
      photo: { not: null }
    }
  });

  console.log(`Found ${userRights.length} user rights to inspect.`);

  for (const item of userRights) {
    if (shouldMigrateUrl(item.photo)) {
      try {
        stats.totalAttempted++;
        console.log(`Downloading user right image: ${item.id} ("${item.title}")`);
        const buffer = await fetchImageBuffer(item.photo);
        const saved = await processAndSaveImage({ buffer, category: 'CONTENT' });

        if (!isDryRun) {
          await prisma.userRight.update({
            where: { id: item.id },
            data: {
              photo: saved.url,
              photoPublicId: saved.publicId
            }
          });
        }
        stats.successful++;
        console.log(`  -> Migrated user right: ${saved.url}`);
      } catch (err) {
        stats.failed++;
        console.error(`  x Failed user right ${item.id}: ${err.message}`);
      }
    }
  }
}

async function run() {
  console.log('====================================================');
  console.log(`STARTING CLOUDINARY -> LOCAL VPS AVIF MIGRATION`);
  if (isDryRun) {
    console.log(`[DRY-RUN MODE] No database records will be modified.`);
  }
  console.log('====================================================');

  const stats = {
    totalAttempted: 0,
    successful: 0,
    failed: 0
  };

  try {
    await migrateAdvocates(stats);
    await migrateBlogs(stats);
    await migrateUserRights(stats);

    console.log('\n====================================================');
    console.log('MIGRATION SUMMARY');
    console.log('====================================================');
    console.log(`Total images attempted : ${stats.totalAttempted}`);
    console.log(`Successfully converted : ${stats.successful}`);
    console.log(`Failed / skipped       : ${stats.failed}`);
    console.log('====================================================\n');
  } catch (error) {
    console.error('Fatal error during migration:', error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
