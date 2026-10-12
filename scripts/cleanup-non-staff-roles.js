import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const isApply = process.argv.includes('--apply');

  console.log('=====================================================');
  console.log('   VakeelSetu RBAC: Cleanup Non-Staff User Roles     ');
  console.log(`   Mode: ${isApply ? 'APPLY (DESTRUCTIVE)' : 'DRY RUN (READ ONLY)'}`);
  console.log('=====================================================\n');

  // 1. Fetch all UserRole rows with role details
  const allUserRoles = await prisma.userRole.findMany({
    include: {
      role: {
        select: {
          id: true,
          name: true,
          displayName: true
        }
      }
    }
  });

  if (allUserRoles.length === 0) {
    console.log('No UserRole records found in the database.\n');
    return;
  }

  // 2. Identify all unique user IDs
  const userIds = Array.from(new Set(allUserRoles.map((ur) => ur.userId)));

  // 3. Batch lookup across ContentCreator, User, and Advocate
  const [staffAccounts, clientAccounts, advocateAccounts] = await Promise.all([
    prisma.contentCreator.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true }
    }),
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true }
    }),
    prisma.advocate.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true }
    })
  ]);

  const staffIdSet = new Set(staffAccounts.map((s) => s.id));
  const clientIdSet = new Set(clientAccounts.map((c) => c.id));
  const advocateIdSet = new Set(advocateAccounts.map((a) => a.id));

  // 4. Find non-staff roles
  const nonStaffRoles = [];

  for (const ur of allUserRoles) {
    if (!staffIdSet.has(ur.userId)) {
      let accountKind = 'NONE';
      if (clientIdSet.has(ur.userId)) {
        accountKind = 'USER';
      } else if (advocateIdSet.has(ur.userId)) {
        accountKind = 'ADVOCATE';
      }

      nonStaffRoles.push({
        userRoleId: ur.id,
        userId: ur.userId,
        accountKind,
        roleName: ur.role?.name || 'UNKNOWN'
      });
    }
  }

  if (nonStaffRoles.length === 0) {
    console.log('All UserRole records belong to valid staff (ContentCreator) accounts.');
    console.log('No non-staff role assignments found. Database is clean!\n');
    return;
  }

  console.log(`Found ${nonStaffRoles.length} non-staff UserRole assignment(s):\n`);
  console.table(nonStaffRoles);

  if (!isApply) {
    console.log('\n[DRY RUN COMPLETE] No rows were deleted.');
    console.log("To delete these invalid rows, re-run with: npm run cleanup:non-staff-roles -- --apply\n");
  } else {
    const idsToDelete = nonStaffRoles.map((r) => r.userRoleId);
    const deleteResult = await prisma.userRole.deleteMany({
      where: { id: { in: idsToDelete } }
    });

    console.log(`\n[SUCCESS] Deleted ${deleteResult.count} non-staff UserRole record(s).\n`);
  }
}

main()
  .catch((err) => {
    console.error('Error during non-staff roles cleanup:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
