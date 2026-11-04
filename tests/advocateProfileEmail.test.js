import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/lib/prisma.js';
import {
  profileUnderReviewTemplate,
  maskAdvocatePhone,
  formatSubmittedDateIst,
  formatSubmittedTimeIst
} from '../src/templates/advocateAccountEmail.template.js';
import {
  sendProfileUnderReviewEmail,
  setTransporter
} from '../src/services/email.service.js';
import * as advocateProfileController from '../src/controllers/advocate.profile.controller.js';

describe('Advocate Profile Under Review Email & Trigger Tests', () => {
  let originalPrismaAdvocate;

  beforeEach(() => {
    originalPrismaAdvocate = { ...prisma.advocate };
  });

  afterEach(() => {
    prisma.advocate = originalPrismaAdvocate;
    setTransporter(null);
  });

  const mockRes = () => {
    const res = {
      statusCode: 200,
      jsonData: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.jsonData = data;
        return this;
      }
    };
    return res;
  };

  describe('TASK 1: Template Rendering & Helpers', () => {
    it('1.1 maskAdvocatePhone correctly masks 10-digit Indian numbers and variants', () => {
      assert.equal(maskAdvocatePhone('+919876543221'), '+91 98XXXXXX21');
      assert.equal(maskAdvocatePhone('+91 9876543221'), '+91 98XXXXXX21');
      assert.equal(maskAdvocatePhone('9876543221'), '+91 98XXXXXX21');
      assert.equal(maskAdvocatePhone(''), '');
      assert.equal(maskAdvocatePhone(null), '');
      assert.equal(maskAdvocatePhone(undefined), '');
    });

    it('1.2 formatSubmittedDateIst and formatSubmittedTimeIst output expected IST formats', () => {
      // 2026-11-04 11:10:00 UTC = 2026-11-04 16:40:00 IST (4:40 PM IST)
      const date = new Date('2026-11-04T11:10:00.000Z');
      assert.equal(formatSubmittedDateIst(date), '4 Nov 2026');
      assert.equal(formatSubmittedTimeIst(date), '4:40 PM IST');
    });

    it('1.3 profileUnderReviewTemplate contains exact required copy, escaping, and no buttons/notes', () => {
      const advocate = {
        fullName: '<Adv. Priya & Associates>',
        barCouncilId: 'D/1234/2018',
        email: 'priya@example.com',
        phone: '9876543221'
      };
      const submittedAt = new Date('2026-11-04T11:10:00.000Z');

      const result = profileUnderReviewTemplate({ advocate, submittedAt });

      assert.equal(result.subject, 'Your VakeelSetu profile is under review');
      assert.ok(result.html.includes('We&#39;ve received your profile. Our team is verifying your details.'));
      assert.ok(result.html.includes('Advocate Partner'));
      assert.ok(result.html.includes('&#9203;&nbsp; Under review'));
      assert.ok(result.html.includes('Your profile is under review'));

      // Escaped greeting
      assert.ok(result.html.includes('&lt;Adv. Priya &amp; Associates&gt;'));
      assert.ok(result.html.includes('Thank you for completing your profile on VakeelSetu. We have received it and our verification team is now reviewing your details and documents.'));

      // Status box
      assert.ok(result.html.includes('Submitted for verification'));
      assert.ok(result.html.includes('4 Nov 2026<br/>4:40 PM IST'));

      // Detail table with monospace bar council ID and masked phone
      assert.ok(result.html.includes('D/1234/2018'));
      assert.ok(result.html.includes("'Courier New',monospace"));
      assert.ok(result.html.includes('priya@example.com'));
      assert.ok(result.html.includes('+91 98XXXXXX21'));
      assert.ok(result.html.includes('Profile status'));
      assert.ok(result.html.includes('Under review'));

      // Closing paragraph
      assert.ok(result.html.includes('We will email you as soon as your profile is approved. Until then, your profile will not be visible to clients. If we need any more information, our team will contact you.'));

      // MUST NOT contain button or note callout box
      assert.ok(!result.html.includes('<!-- button -->'));
      assert.ok(!result.html.includes('<!-- footnote -->'));
      assert.ok(!result.html.includes('border-left:3px solid'));

      // Plain-text alternative checks
      assert.ok(result.text.includes('Your VakeelSetu profile is under review'));
      assert.ok(result.text.includes('Dear <Adv. Priya & Associates>,'));
      assert.ok(result.text.includes('Status: Submitted for verification'));
      assert.ok(result.text.includes('Submitted on: 4 Nov 2026 / 4:40 PM IST'));
      assert.ok(result.text.includes('Registered phone: +91 98XXXXXX21'));
    });

    it('1.4 Greeting handles missing/empty advocate name cleanly', () => {
      const advocate = {
        fullName: '',
        barCouncilId: 'D/1234/2018',
        email: 'lawyer@example.com',
        phone: '9876543221'
      };
      const result = profileUnderReviewTemplate({ advocate });
      assert.ok(!result.html.includes('Dear'));
      assert.ok(result.html.includes('<p style="margin:10px 0 0;font-family:\'Segoe UI\',Arial,sans-serif;font-size:14px;line-height:22px;color:#3d4b5c;">Thank you for completing your profile on VakeelSetu.'));
      assert.ok(!result.text.includes('Dear'));
      assert.ok(result.text.includes('Thank you for completing your profile on VakeelSetu.'));
    });

    it('1.5 Empty fields are omitted from the detail table', () => {
      const advocate = {
        fullName: 'Adv. Test',
        barCouncilId: '',
        email: '',
        phone: ''
      };
      const result = profileUnderReviewTemplate({ advocate });
      assert.ok(result.html.includes('Adv. Test'));
      assert.ok(!result.html.includes('Bar Council ID'));
      assert.ok(!result.html.includes('Registered email'));
      assert.ok(!result.html.includes('Registered phone'));
      assert.ok(result.html.includes('Profile status'));
    });
  });

  describe('TASK 2: sendProfileUnderReviewEmail Function', () => {
    it('2.1 Sends branded mail to registered advocate email with stubbed transporter', async () => {
      const sentMails = [];
      setTransporter({
        sendMail: async (options) => {
          sentMails.push(options);
          return { messageId: 'msg-profile-review-123' };
        }
      });

      prisma.advocate.findUnique = async () => ({
        id: 'adv-uuid-1',
        fullName: 'Adv. Priya Sharma',
        barCouncilId: 'D/1234/2018',
        email: 'advocate@example.com',
        phone: '+919876543221',
        submittedForApprovalAt: new Date('2026-11-04T11:10:00.000Z')
      });

      const res = await sendProfileUnderReviewEmail('adv-uuid-1');
      assert.equal(res.success, true);
      assert.equal(sentMails.length, 1);
      assert.equal(sentMails[0].to, 'advocate@example.com');
      assert.equal(sentMails[0].subject, 'Your VakeelSetu profile is under review');
      assert.ok(sentMails[0].html.includes('Adv. Priya Sharma'));
    });

    it('2.2 Missing advocate or missing email skips send gracefully without throwing', async () => {
      let sentCount = 0;
      setTransporter({
        sendMail: async () => {
          sentCount++;
          return { messageId: 'msg-1' };
        }
      });

      // Case A: advocate not found
      prisma.advocate.findUnique = async () => null;
      const res1 = await sendProfileUnderReviewEmail('non-existent');
      assert.equal(res1.success, false);
      assert.equal(res1.message, 'Advocate not found');
      assert.equal(sentCount, 0);

      // Case B: advocate has no email
      prisma.advocate.findUnique = async () => ({
        id: 'adv-no-email',
        fullName: 'Adv. No Email',
        email: null
      });
      const res2 = await sendProfileUnderReviewEmail('adv-no-email');
      assert.equal(res2.success, true);
      assert.equal(res2.message, 'No email on record');
      assert.equal(sentCount, 0);
    });

    it('2.3 Transporter failure is caught and logged, never throws', async () => {
      setTransporter({
        sendMail: async () => {
          throw new Error('SMTP connection refused');
        }
      });

      prisma.advocate.findUnique = async () => ({
        id: 'adv-uuid-fail',
        fullName: 'Adv. Fail',
        email: 'fail@example.com'
      });

      const res = await sendProfileUnderReviewEmail('adv-uuid-fail');
      assert.equal(res.success, false);
      assert.ok(res.message.includes('Email sending failed') || res.message.includes('SMTP connection refused'));
    });
  });

  describe('TASK 3: Trigger in submitForApproval', () => {
    const completeAdvocate = {
      id: 'adv-complete-1',
      fullName: 'Adv. Priya Sharma',
      phone: '9876543221',
      barCouncilId: 'D/1234/2018',
      profilePhotoUrl: 'https://cloudinary.com/photo.jpg',
      bestPracticeArea: 'Criminal Law',
      experienceYears: 7,
      about: 'Experienced advocate in Delhi High Court',
      city: 'New Delhi',
      state: 'Delhi',
      pincode: '110001',
      email: 'priya@example.com',
      status: 'ACTIVE',
      approvalStatus: 'PENDING',
      submittedForApprovalAt: null
    };

    it('3.1 First submission triggers email send after DB update', async () => {
      let updatedData = null;
      let emailSentTo = null;

      prisma.advocate.findUnique = async () => ({ ...completeAdvocate });
      prisma.advocate.update = async ({ data }) => {
        updatedData = data;
        return { ...completeAdvocate, ...data };
      };

      setTransporter({
        sendMail: async (options) => {
          emailSentTo = options.to;
          return { messageId: 'msg-first-submit' };
        }
      });

      const req = { user: { id: 'adv-complete-1', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.success, true);
      assert.equal(res.jsonData.message, 'Your profile has been submitted for admin approval');
      assert.equal(updatedData.approvalStatus, 'PENDING');
      assert.ok(updatedData.submittedForApprovalAt instanceof Date);
      assert.equal(emailSentTo, 'priya@example.com');
    });

    it('3.2 Resubmission after REJECTED triggers email send after DB update', async () => {
      let updatedData = null;
      let emailSentTo = null;

      const rejectedAdvocate = {
        ...completeAdvocate,
        approvalStatus: 'REJECTED',
        rejectionReason: 'Please upload clearer bar council certificate',
        submittedForApprovalAt: new Date('2026-10-01T00:00:00Z')
      };

      prisma.advocate.findUnique = async () => ({ ...rejectedAdvocate });
      prisma.advocate.update = async ({ data }) => {
        updatedData = data;
        return { ...rejectedAdvocate, ...data };
      };

      setTransporter({
        sendMail: async (options) => {
          emailSentTo = options.to;
          return { messageId: 'msg-resubmit' };
        }
      });

      const req = { user: { id: 'adv-complete-1', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.success, true);
      assert.equal(res.jsonData.message, 'Your profile has been submitted for admin approval');
      assert.equal(updatedData.approvalStatus, 'PENDING');
      assert.equal(updatedData.rejectionReason, null);
      assert.equal(emailSentTo, 'priya@example.com');
    });

    it('3.3 Duplicate submit (already PENDING with submittedForApprovalAt) returns 400 and does NOT send email', async () => {
      let emailSentCount = 0;
      setTransporter({
        sendMail: async () => {
          emailSentCount++;
          return { messageId: 'msg-dup' };
        }
      });

      const alreadyPendingAdvocate = {
        ...completeAdvocate,
        approvalStatus: 'PENDING',
        submittedForApprovalAt: new Date('2026-11-04T10:00:00Z')
      };

      prisma.advocate.findUnique = async () => ({ ...alreadyPendingAdvocate });

      const req = { user: { id: 'adv-complete-1', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 400);
      assert.equal(res.jsonData.success, false);
      assert.equal(res.jsonData.message, 'Your profile has already been submitted and is currently under review.');
      assert.equal(emailSentCount, 0);
    });

    it('3.4 Profile changes for APPROVED advocate routes to draft change workflow and does NOT send profile review email', async () => {
      let emailSentCount = 0;
      setTransporter({
        sendMail: async () => {
          emailSentCount++;
          return { messageId: 'msg-approved' };
        }
      });

      const approvedAdvocate = {
        id: 'adv-approved-1',
        approvalStatus: 'APPROVED',
        status: 'ACTIVE',
        profileChangeStatus: 'DRAFT',
        pendingProfileChange: { videoCallPricePer15Min: 650 }
      };

      prisma.advocate.findUnique = async () => ({ ...approvedAdvocate });
      prisma.advocate.update = async ({ data }) => ({ ...approvedAdvocate, ...data });

      const req = { user: { id: 'adv-approved-1', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.success, true);
      assert.equal(res.jsonData.message, 'Changes sent for admin approval.');
      assert.equal(emailSentCount, 0);
    });

    it('3.5 Incomplete profile returns 400 and does NOT send email', async () => {
      let emailSentCount = 0;
      setTransporter({
        sendMail: async () => {
          emailSentCount++;
          return { messageId: 'msg-incomplete' };
        }
      });

      const incompleteAdvocate = {
        ...completeAdvocate,
        fullName: '' // missing name
      };

      prisma.advocate.findUnique = async () => ({ ...incompleteAdvocate });

      const req = { user: { id: 'adv-complete-1', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 400);
      assert.equal(res.jsonData.success, false);
      assert.equal(res.jsonData.message, 'Please complete your Advocate profile before submitting it for approval');
      assert.equal(emailSentCount, 0);
    });

    it('3.6 Blocked account returns 400 and does NOT send email', async () => {
      let emailSentCount = 0;
      setTransporter({
        sendMail: async () => {
          emailSentCount++;
          return { messageId: 'msg-blocked' };
        }
      });

      const blockedAdvocate = {
        ...completeAdvocate,
        status: 'BLOCKED'
      };

      prisma.advocate.findUnique = async () => ({ ...blockedAdvocate });

      const req = { user: { id: 'adv-complete-1', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 400);
      assert.equal(res.jsonData.success, false);
      assert.equal(res.jsonData.message, 'Your account is blocked. Cannot submit profile for approval.');
      assert.equal(emailSentCount, 0);
    });

    it('3.7 Even if email sending fails or throws, submitForApproval response still succeeds with 200', async () => {
      setTransporter({
        sendMail: async () => {
          throw new Error('SMTP connection timed out');
        }
      });

      prisma.advocate.findUnique = async () => ({ ...completeAdvocate });
      prisma.advocate.update = async ({ data }) => ({ ...completeAdvocate, ...data });

      const req = { user: { id: 'adv-complete-1', type: 'advocate' } };
      const res = mockRes();

      await advocateProfileController.submitForApproval(req, res, () => {});

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.success, true);
      assert.equal(res.jsonData.message, 'Your profile has been submitted for admin approval');
    });
  });
});

