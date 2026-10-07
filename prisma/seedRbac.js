import { PrismaClient } from '@prisma/client';

export const DEFAULT_PERMISSIONS = [
  // Blogs
  { code: 'blogs:read', name: 'View Blogs', module: 'BLOGS', description: 'Permission to view and read blogs' },
  { code: 'blogs:create', name: 'Create Blog', module: 'BLOGS', description: 'Permission to create new blogs' },
  { code: 'blogs:update', name: 'Update Blog', module: 'BLOGS', description: 'Permission to edit blogs' },
  { code: 'blogs:delete', name: 'Delete Blog', module: 'BLOGS', description: 'Permission to delete blogs' },

  // Bearer Acts, Acts & Sections
  { code: 'acts:read', name: 'View Acts and Sections', module: 'ACTS', description: 'Permission to view bearer acts and sections' },
  { code: 'acts:create', name: 'Create Acts and Sections', module: 'ACTS', description: 'Permission to create bearer acts, acts, and sections' },
  { code: 'acts:update', name: 'Update Acts and Sections', module: 'ACTS', description: 'Permission to update bearer acts, acts, and sections' },
  { code: 'acts:delete', name: 'Delete Acts and Sections', module: 'ACTS', description: 'Permission to delete acts and sections' },

  // Act PDFs
  { code: 'act_pdfs:upload', name: 'Upload Act PDF', module: 'ACT_PDFS', description: 'Permission to upload and attach act PDFs' },
  { code: 'act_pdfs:delete', name: 'Delete Act PDF', module: 'ACT_PDFS', description: 'Permission to delete act PDFs' },
  { code: 'act_pdfs:sync', name: 'Sync Predefined Act PDFs', module: 'ACT_PDFS', description: 'Permission to sync predefined act PDFs' },

  // IPC Sections
  { code: 'ipc:create', name: 'Create IPC Section', module: 'IPC', description: 'Permission to add IPC sections' },
  { code: 'ipc:update', name: 'Update IPC Section', module: 'IPC', description: 'Permission to modify IPC sections' },

  // BNS Sections
  { code: 'bns:create', name: 'Create BNS Section', module: 'BNS', description: 'Permission to add BNS sections' },
  { code: 'bns:update', name: 'Update BNS Section', module: 'BNS', description: 'Permission to modify BNS sections' },

  // Legal Guides
  { code: 'guides:create', name: 'Create Legal Guide', module: 'GUIDES', description: 'Permission to create legal guides' },
  { code: 'guides:update', name: 'Update Legal Guide', module: 'GUIDES', description: 'Permission to edit legal guides' },
  { code: 'guides:delete', name: 'Delete Legal Guide', module: 'GUIDES', description: 'Permission to delete legal guides' },

  // Legal Updates
  { code: 'updates:create', name: 'Create Legal Update', module: 'UPDATES', description: 'Permission to create legal updates' },
  { code: 'updates:update', name: 'Update Legal Update', module: 'UPDATES', description: 'Permission to edit legal updates' },
  { code: 'updates:delete', name: 'Delete Legal Update', module: 'UPDATES', description: 'Permission to delete legal updates' },

  // User Rights
  { code: 'user_rights:create', name: 'Create User Right', module: 'USER_RIGHTS', description: 'Permission to create user rights' },
  { code: 'user_rights:update', name: 'Update User Right', module: 'USER_RIGHTS', description: 'Permission to edit user rights' },
  { code: 'user_rights:delete', name: 'Delete User Right', module: 'USER_RIGHTS', description: 'Permission to delete user rights' },

  // Users Management
  { code: 'users:view', name: 'View Users', module: 'USERS', description: 'Permission to view registered normal users list and details' },

  // Advocates Management
  { code: 'advocates:view', name: 'View Advocates', module: 'ADVOCATES', description: 'Permission to view advocates list and pending approvals' },
  { code: 'advocates:approve', name: 'Approve Advocate Profiles', module: 'ADVOCATES', description: 'Permission to approve pending advocate profiles' },
  { code: 'advocates:reject', name: 'Reject Advocate Profiles', module: 'ADVOCATES', description: 'Permission to reject advocate profiles' },
  { code: 'advocates:update_status', name: 'Update Advocate Status', module: 'ADVOCATES', description: 'Permission to block/activate advocates and toggle call availability' },
  { code: 'advocates:delete', name: 'Manage Advocate Deletion', module: 'ADVOCATES', description: 'Permission to cancel or execute permanent advocate deletions' },

  // Feedback Management
  { code: 'feedback:view', name: 'View Feedback', module: 'FEEDBACK', description: 'Permission to view submitted user feedback' },
  { code: 'feedback:delete', name: 'Delete Feedback', module: 'FEEDBACK', description: 'Permission to delete feedback items' },

  // Consultancy Requests
  { code: 'consultancy:view', name: 'View Consultancy Requests', module: 'CONSULTANCY', description: 'Permission to view consultancy requests' },
  { code: 'consultancy:update', name: 'Update Consultancy Request', module: 'CONSULTANCY', description: 'Permission to mark consultancy requests completed' },

  // Content Creator Staff Management
  { code: 'content_creators:view', name: 'View Content Creators', module: 'CONTENT_CREATORS', description: 'Permission to list content creator staff accounts' },
  { code: 'content_creators:create', name: 'Create Content Creator', module: 'CONTENT_CREATORS', description: 'Permission to create new content creator staff accounts' },

  // Roles & RBAC Management
  { code: 'roles:manage', name: 'Manage Roles and Permissions', module: 'ROLES', description: 'Permission to manage RBAC roles, permissions, and user assignments' }
];

export const CONTENT_CREATOR_PERMISSIONS = [
  'blogs:read',
  'blogs:create',
  'blogs:update',
  'blogs:delete',
  'acts:read',
  'acts:create',
  'acts:update',
  'acts:delete',
  'act_pdfs:upload',
  'act_pdfs:delete',
  'act_pdfs:sync',
  'ipc:create',
  'ipc:update',
  'bns:create',
  'bns:update',
  'guides:create',
  'guides:update',
  'guides:delete',
  'updates:create',
  'updates:update',
  'updates:delete',
  'user_rights:create',
  'user_rights:update',
  'user_rights:delete'
];

export const LEAD_USER_PERMISSIONS = [
  'users:view',
  'advocates:view',
  'feedback:view',
  'consultancy:view'
];

/**
 * Idempotent Seed for RBAC System
 */
export async function seedRbac(prismaClient = null) {
  const prisma = prismaClient || new PrismaClient();
  console.log('--- Seeding RBAC System (Idempotent) ---');

  // 1. Seed Permissions
  console.log(`Seeding ${DEFAULT_PERMISSIONS.length} default permissions...`);
  const permissionMap = {};

  for (const perm of DEFAULT_PERMISSIONS) {
    let p = await prisma.permission.findUnique({
      where: { code: perm.code }
    });

    if (!p) {
      p = await prisma.permission.create({
        data: {
          code: perm.code,
          name: perm.name,
          module: perm.module,
          description: perm.description
        }
      });
      console.log(`  [+] Created permission: ${perm.code}`);
    } else {
      // Update name/module/description if needed
      p = await prisma.permission.update({
        where: { id: p.id },
        data: {
          name: perm.name,
          module: perm.module,
          description: perm.description
        }
      });
    }
    permissionMap[perm.code] = p.id;
  }

  // 2. Seed CONTENT_CREATOR Role
  let contentCreatorRole = await prisma.role.findUnique({
    where: { name: 'CONTENT_CREATOR' }
  });

  if (!contentCreatorRole) {
    contentCreatorRole = await prisma.role.create({
      data: {
        name: 'CONTENT_CREATOR',
        displayName: 'Content Creator',
        description: 'Can create and manage legal content including blogs, acts, sections, guides, updates, and user rights.',
        isActive: true,
        isSystem: true
      }
    });
    console.log('  [+] Created role: CONTENT_CREATOR');
  } else {
    console.log('  [*] Role CONTENT_CREATOR already exists.');
  }

  // Assign permissions to CONTENT_CREATOR role idempotently
  for (const code of CONTENT_CREATOR_PERMISSIONS) {
    const permissionId = permissionMap[code];
    if (permissionId) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: contentCreatorRole.id,
            permissionId
          }
        },
        update: {},
        create: {
          roleId: contentCreatorRole.id,
          permissionId
        }
      });
    }
  }
  console.log('  [*] CONTENT_CREATOR role permissions verified.');

  // 3. Seed LEAD_USER Role
  let leadUserRole = await prisma.role.findUnique({
    where: { name: 'LEAD_USER' }
  });

  if (!leadUserRole) {
    leadUserRole = await prisma.role.create({
      data: {
        name: 'LEAD_USER',
        displayName: 'Lead User',
        description: 'Can view operational and platform data such as users, advocates, feedback, and consultancy requests.',
        isActive: true,
        isSystem: true
      }
    });
    console.log('  [+] Created role: LEAD_USER');
  } else {
    console.log('  [*] Role LEAD_USER already exists.');
  }

  // Assign permissions to LEAD_USER role idempotently
  for (const code of LEAD_USER_PERMISSIONS) {
    const permissionId = permissionMap[code];
    if (permissionId) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: leadUserRole.id,
            permissionId
          }
        },
        update: {},
        create: {
          roleId: leadUserRole.id,
          permissionId
        }
      });
    }
  }
  console.log('  [*] LEAD_USER role permissions verified.');

  // 4. Link seeded ContentCreator account with CONTENT_CREATOR role if exists
  const defaultCreator = await prisma.contentCreator.findFirst({
    where: { email: 'trainee6@techvunex.in' }
  });

  if (defaultCreator) {
    await prisma.userRole.upsert({
      where: {
        userId_roleId: {
          userId: defaultCreator.id,
          roleId: contentCreatorRole.id
        }
      },
      update: {
        userType: 'CONTENT_CREATOR'
      },
      create: {
        userId: defaultCreator.id,
        roleId: contentCreatorRole.id,
        userType: 'CONTENT_CREATOR'
      }
    });
    console.log('  [*] Assigned CONTENT_CREATOR role to seeded trainee6@techvunex.in.');
  }

  console.log('--- RBAC Seeding Completed Successfully ---');
}

// Standalone execution support
const isMain = process.argv[1] && process.argv[1].endsWith('seedRbac.js');
if (isMain) {
  const prisma = new PrismaClient();
  seedRbac(prisma)
    .catch((e) => {
      console.error('RBAC Seeding error:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
