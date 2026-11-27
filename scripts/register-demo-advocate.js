import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma.js';
import {
  generateSecureToken,
  hashToken,
  getTestConfig
} from '../src/services/advocateTest.service.js';
import { sendAdvocateTestLinkEmail, getAdvocateTestLink } from '../src/services/email.service.js';

async function main() {
  const email = 'trainee4@techvunex.in';
  const password = 'Shivam@singh.03';
  const fullName = 'Shivam Singh';
  const phone = '9876543290';
  const barCouncilId = 'D/9876/2023';

  console.log(`[Demo Advocate] Target email: ${email}`);

  // 1. Delete old record if it exists
  const existingAdvocate = await prisma.advocate.findUnique({
    where: { email },
    include: {
      testInvites: true
    }
  });

  if (existingAdvocate) {
    console.log(`[Demo Advocate] Found existing advocate (ID: ${existingAdvocate.id}). Deleting old records...`);

    // Clean up test attempts and test invites
    await prisma.advocateTestAttempt.deleteMany({
      where: { advocateId: existingAdvocate.id }
    });

    await prisma.advocateTestInvite.deleteMany({
      where: { advocateId: existingAdvocate.id }
    });

    // Delete advocate
    await prisma.advocate.delete({
      where: { id: existingAdvocate.id }
    });

    console.log(`[Demo Advocate] Old advocate record deleted successfully.`);
  }

  // Also clean up if any advocate has this phone or barCouncilId
  await prisma.advocate.deleteMany({
    where: {
      OR: [{ phone }, { barCouncilId }]
    }
  });

  // 2. Create fresh advocate
  console.log(`[Demo Advocate] Creating fresh advocate record...`);
  const passwordHash = await bcrypt.hash(password, 10);

  const advocate = await prisma.advocate.create({
    data: {
      email,
      passwordHash,
      fullName,
      phone,
      phoneVerified: true,
      emailVerified: true,
      barCouncilId,
      gender: 'Male',
      languagesSpoken: ['English', 'Hindi'],
      country: 'India',
      state: 'Delhi',
      city: 'New Delhi',
      pincode: '110001',
      profilePhotoUrl: 'https://images.unsplash.com/photo-1560250097-0b93528c311a',
      experienceYears: 5,
      casesHandled: 45,
      bestPracticeArea: 'Civil Litigation',
      practiceAreas: ['Civil Litigation', 'Corporate Law', 'Property Law'],
      courtPractice: ['Delhi High Court', 'Supreme Court of India'],
      about: 'Experienced advocate specializing in civil litigation and corporate disputes with over 5 years of courtroom experience.',
      completeAddress: 'Chamber 204, High Court Lawyers Block, New Delhi',
      approvalStatus: 'PENDING',
      submittedForApprovalAt: new Date(),
      status: 'ACTIVE',
      isActive: true
    }
  });

  console.log(`[Demo Advocate] Fresh advocate profile created! ID: ${advocate.id}`);

  // 3. Test link generation & invitation
  const now = new Date();
  const config = getTestConfig();
  const plainToken = generateSecureToken();
  const tokenHash = hashToken(plainToken);
  const expiresAt = new Date(now.getTime() + config.linkValidHours * 60 * 60 * 1000);

  console.log(`[Demo Advocate] Creating test invite...`);
  const newInvite = await prisma.advocateTestInvite.create({
    data: {
      advocateId: advocate.id,
      tokenHash,
      reason: 'INITIAL',
      status: 'SENT',
      sendAt: now,
      sentAt: now,
      expiresAt
    }
  });

  const testLink = getAdvocateTestLink(plainToken);
  console.log(`[Demo Advocate] Generated Test Link: ${testLink}`);

  console.log(`[Demo Advocate] Sending test link email to ${email}...`);
  try {
    const emailResult = await sendAdvocateTestLinkEmail({
      advocateId: advocate.id,
      token: plainToken,
      expiresAt,
      reason: 'INITIAL'
    });
    console.log(`[Demo Advocate] Email dispatch result:`, emailResult);
  } catch (emailErr) {
    console.error(`[Demo Advocate] Error during email send:`, emailErr.message);
  }

  console.log(`\n========================================`);
  console.log(`DEMO ADVOCATE RE-REGISTRATION COMPLETE`);
  console.log(`Email: ${email}`);
  console.log(`Password: ${password}`);
  console.log(`New Advocate ID: ${advocate.id}`);
  console.log(`Approval Status: PENDING (Submitted)`);
  console.log(`Test Link: ${testLink}`);
  console.log(`Expires At: ${expiresAt.toISOString()}`);
  console.log(`========================================\n`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[Demo Advocate] Error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
