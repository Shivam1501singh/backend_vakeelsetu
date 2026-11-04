import dotenv from 'dotenv';
dotenv.config();

import prisma from '../src/lib/prisma.js';
import { getPincodeLocation } from '../src/services/geocoding.service.js';

async function main() {
  const isApply = process.argv.includes('--apply');
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) || 500 : 500;

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
  console.log('   VakeelSetu: Warm Pincode Location Cache');
  console.log(`   Database Host: ${dbHost}`);
  console.log(`   Mode: ${isApply ? 'APPLY (WARMING CACHE)' : 'DRY RUN (READ ONLY - PASS --apply TO RUN)'}`);
  console.log(`   Limit: ${limit}`);
  console.log('=====================================================\n');

  try {
    const baseWhere = {
      isActive: true,
      phoneVerified: true,
      emailVerified: true,
      status: 'ACTIVE',
      approvalStatus: 'APPROVED',
      deletionStatus: { not: 'PENDING' }
    };

    const totalAdvocates = await prisma.advocate.count({ where: baseWhere });

    // Distinct advocate pincodes
    const distinctPincodeRows = await prisma.advocate.findMany({
      where: {
        ...baseWhere,
        pincode: { not: null }
      },
      select: { pincode: true },
      distinct: ['pincode']
    });

    const distinctPincodes = distinctPincodeRows
      .map(r => r.pincode?.trim())
      .filter(p => p && /^[1-9]\d{5}$/.test(p));

    // Check existing fresh cache
    const ttlDays = Math.min(parseInt(process.env.PINCODE_CACHE_TTL_DAYS || '30', 10) || 30, 30);
    const freshCutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

    const freshCachedRows = await prisma.pincodeLocation.findMany({
      where: {
        pincode: { in: distinctPincodes },
        status: 'OK',
        fetchedAt: { gte: freshCutoff }
      },
      select: { pincode: true }
    });

    const freshCachedSet = new Set(freshCachedRows.map(r => r.pincode));
    const needingWarm = distinctPincodes.filter(p => !freshCachedSet.has(p));

    console.log('Database Overview:');
    console.log(`  Total Active & Approved Advocates: ${totalAdvocates}`);
    console.log(`  Distinct Valid Advocate Pincodes:  ${distinctPincodes.length}`);
    console.log(`  Already Fresh in Cache:            ${freshCachedSet.size}`);
    console.log(`  Needing Warm / Refresh:            ${needingWarm.length}\n`);

    if (needingWarm.length > 0) {
      console.log('Pincodes needing cache warm:');
      console.log(`  ${needingWarm.join(', ')}\n`);
    }

    if (!isApply) {
      console.log('DRY RUN complete. No external Google Geocoding API calls were made.');
      console.log('To execute geocoding for pending pincodes, run: node scripts/warm-pincode-cache.js --apply\n');
      return;
    }

    // Apply Mode
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      console.error('ERROR: GOOGLE_MAPS_API_KEY is not configured in .env. Cannot warm cache with Google Geocoding.');
      process.exit(1);
    }

    const batch = needingWarm.slice(0, limit);
    console.log(`Starting geocoding for ${batch.length} pincodes (with 100ms rate limit delay)...\n`);

    let successCount = 0;
    let notFoundCount = 0;
    let failedCount = 0;

    for (let i = 0; i < batch.length; i++) {
      const pin = batch[i];
      try {
        const res = await getPincodeLocation(pin);
        if (res.found) {
          successCount++;
          console.log(`[${i + 1}/${batch.length}] Pincode ${pin}: RESOLVED via ${res.source} (lat: ${res.latitude.toFixed(4)}, lng: ${res.longitude.toFixed(4)})`);
        } else if (res.reason === 'NOT_FOUND') {
          notFoundCount++;
          console.log(`[${i + 1}/${batch.length}] Pincode ${pin}: NOT_FOUND`);
        } else {
          failedCount++;
          console.log(`[${i + 1}/${batch.length}] Pincode ${pin}: UNAVAILABLE`);
        }
      } catch (err) {
        failedCount++;
        console.error(`[${i + 1}/${batch.length}] Pincode ${pin}: ERROR - ${err.message}`);
      }

      // Small rate-limiting delay (100ms)
      if (i < batch.length - 1) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    console.log('\nWarming Summary:');
    console.log(`  Processed:  ${batch.length}`);
    console.log(`  Resolved:   ${successCount}`);
    console.log(`  Not Found:  ${notFoundCount}`);
    console.log(`  Failed:     ${failedCount}\n`);
  } catch (err) {
    console.error('Error during warm-pincode-cache execution:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

