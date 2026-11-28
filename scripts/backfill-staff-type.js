/**
 * scripts/backfill-staff-type.js
 * 
 * Backfills legacy 'CONTENT_CREATOR' enum values in AccountType columns to 'STAFF'.
 * 
 * Usage:
 *   node scripts/backfill-staff-type.js --dry-run
 *   node scripts/backfill-staff-type.js --apply
 */

import prisma from '../src/lib/prisma.js';

const isApply = process.argv.includes('--apply');
const isDryRun = process.argv.includes('--dry-run') || !isApply;

async function runBackfill() {
  const dbUrl = process.env.DATABASE_URL || '';
  let dbHost = 'unknown';
  try {
    const parsed = new URL(dbUrl);
    dbHost = parsed.host;
  } catch {
    dbHost = 'unparseable-url';
  }

  console.log('====================================================');
  console.log('   Vakeelsetu Backfill: CONTENT_CREATOR -> STAFF    ');
  console.log('====================================================');
  console.log(`Target Database Host: ${dbHost}`);
  console.log(`Execution Mode:       ${isApply ? 'APPLY (Live Changes)' : 'DRY RUN (Read-Only)'}`);
  console.log('====================================================\n');

  // 1. Check UserRole counts
  const userRoleLegacyCount = await prisma.userRole.count({
    where: { userType: 'CONTENT_CREATOR' }
  });
  const userRoleStaffCount = await prisma.userRole.count({
    where: { userType: 'STAFF' }
  });

  console.log(`[UserRole.userType]`);
  console.log(`  - Storing 'CONTENT_CREATOR': ${userRoleLegacyCount}`);
  console.log(`  - Storing 'STAFF':           ${userRoleStaffCount}`);

  // 2. Check RegistrationSession counts (safety check)
  let regSessionLegacyCount = 0;
  try {
    regSessionLegacyCount = await prisma.registrationSession.count({
      where: { accountType: 'CONTENT_CREATOR' }
    });
    console.log(`[RegistrationSession.accountType]`);
    console.log(`  - Storing 'CONTENT_CREATOR': ${regSessionLegacyCount}`);
  } catch (err) {
    console.log(`[RegistrationSession.accountType] check skipped (${err.message})`);
  }

  // 3. Check OtpVerification counts (safety check)
  let otpLegacyCount = 0;
  try {
    otpLegacyCount = await prisma.otpVerification.count({
      where: { accountType: 'CONTENT_CREATOR' }
    });
    console.log(`[OtpVerification.accountType]`);
    console.log(`  - Storing 'CONTENT_CREATOR': ${otpLegacyCount}`);
  } catch (err) {
    console.log(`[OtpVerification.accountType] check skipped (${err.message})`);
  }

  console.log('');

  const totalLegacyRows = userRoleLegacyCount + regSessionLegacyCount + otpLegacyCount;

  if (totalLegacyRows === 0) {
    console.log('No legacy records found. Database is already fully backfilled!');
    return;
  }

  if (isDryRun) {
    console.log(`[DRY RUN] ${totalLegacyRows} row(s) would be updated from 'CONTENT_CREATOR' to 'STAFF'.`);
    console.log('No changes were made to the database.');
    console.log('To apply these changes, re-run with: node scripts/backfill-staff-type.js --apply\n');
    return;
  }

  // Apply Changes
  console.log('Applying backfill updates...');

  if (userRoleLegacyCount > 0) {
    const updated = await prisma.$executeRawUnsafe(
      `UPDATE "UserRole" SET "userType" = 'STAFF'::"AccountType" WHERE "userType" = 'CONTENT_CREATOR'::"AccountType";`
    );
    console.log(`  ✔ Updated ${updated} row(s) in "UserRole" table.`);
  }

  if (regSessionLegacyCount > 0) {
    const updated = await prisma.$executeRawUnsafe(
      `UPDATE "RegistrationSession" SET "accountType" = 'STAFF'::"AccountType" WHERE "accountType" = 'CONTENT_CREATOR'::"AccountType";`
    );
    console.log(`  ✔ Updated ${updated} row(s) in "RegistrationSession" table.`);
  }

  if (otpLegacyCount > 0) {
    const updated = await prisma.$executeRawUnsafe(
      `UPDATE "OtpVerification" SET "accountType" = 'STAFF'::"AccountType" WHERE "accountType" = 'CONTENT_CREATOR'::"AccountType";`
    );
    console.log(`  ✔ Updated ${updated} row(s) in "OtpVerification" table.`);
  }

  // Verification after apply
  const postUserRoleLegacyCount = await prisma.userRole.count({
    where: { userType: 'CONTENT_CREATOR' }
  });
  const postUserRoleStaffCount = await prisma.userRole.count({
    where: { userType: 'STAFF' }
  });

  console.log('\n--- Verification After Apply ---');
  console.log(`[UserRole.userType]`);
  console.log(`  - Remaining 'CONTENT_CREATOR': ${postUserRoleLegacyCount}`);
  console.log(`  - Total 'STAFF':              ${postUserRoleStaffCount}`);
  console.log('\nBackfill completed successfully!\n');
}

runBackfill()
  .catch((err) => {
    console.error('Error executing backfill script:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
