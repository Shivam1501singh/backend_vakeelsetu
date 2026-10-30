import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../src/lib/prisma.js';
import * as advocateProfileController from '../src/controllers/advocate.profile.controller.js';
import * as adminController from '../src/controllers/admin.controller.js';
import { advocateProfileUpdateSchema } from '../src/validators/advocate.validator.js';
import { adminAdvocateProfileUpdateSchema } from '../src/validators/admin.validator.js';
import { quote } from '../src/services/advocateBooking/pricing.js';

describe('Advocate Profile Change Approval Workflow (Stubbed Prisma & Cloudinary)', () => {
  let originalPrismaAdvocate;
  let originalPrismaTransaction;
  let originalUploadStream;
  let originalDestroy;

  beforeEach(() => {
    originalPrismaAdvocate = { ...prisma.advocate };
    originalPrismaTransaction = prisma.$transaction;
    originalUploadStream = cloudinary.uploader.upload_stream;
    originalDestroy = cloudinary.uploader.destroy;
  });

  afterEach(() => {
    prisma.advocate = originalPrismaAdvocate;
    prisma.$transaction = originalPrismaTransaction;
    cloudinary.uploader.upload_stream = originalUploadStream;
    cloudinary.uploader.destroy = originalDestroy;
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

  it('1. Pairs validation: officeLatitude + officeLongitude must come together', () => {
    assert.throws(() => {
      advocateProfileUpdateSchema.parse({ officeLatitude: 28.5 });
    }, (err) => {
      return err.errors.some(e => e.message === 'officeLatitude and officeLongitude must be sent together.');
    });

    assert.throws(() => {
      advocateProfileUpdateSchema.parse({ officeLongitude: 77.3 });
    }, (err) => {
      return err.errors.some(e => e.message === 'officeLatitude and officeLongitude must be sent together.');
    });

    const valid = advocateProfileUpdateSchema.parse({ officeLatitude: 28.5, officeLongitude: 77.3 });
    assert.equal(valid.officeLatitude, 28.5);
    assert.equal(valid.officeLongitude, 77.3);
  });

  it('2. Pairs validation: pincode + city + state must come together', () => {
    assert.throws(() => {
      advocateProfileUpdateSchema.parse({ pincode: '201301', city: 'Noida' });
    }, (err) => {
      return err.errors.some(e => e.message === 'pincode, city, and state must be sent together.');
    });

    const valid = advocateProfileUpdateSchema.parse({ pincode: '201301', city: 'Noida', state: 'Uttar Pradesh' });
    assert.equal(valid.pincode, '201301');
    assert.equal(valid.city, 'Noida');
    assert.equal(valid.state, 'Uttar Pradesh');
  });

  it('3. Old latitude / longitude in body is rejected with 400 "Use officeLatitude/officeLongitude."', () => {
    assert.throws(() => {
      advocateProfileUpdateSchema.parse({ latitude: 28.5 });
    }, (err) => {
      return err.errors.some(e => e.message === 'Use officeLatitude/officeLongitude.');
    });

    assert.throws(() => {
      advocateProfileUpdateSchema.parse({ longitude: 77.3 });
    }, (err) => {
      return err.errors.some(e => e.message === 'Use officeLatitude/officeLongitude.');
    });
  });

  it('4. Not-approved advocate: PATCH saves all fields directly (live fields, office coordinates and photos)', async () => {
    let updatedPayload = null;
    const deletedPhotos = [];

    cloudinary.uploader.upload_stream = (options, cb) => ({
      end: () => {
        cb(null, {
          secure_url: 'https://cloudinary.com/new-photo.jpg',
          public_id: 'advocate/new-profile-photo'
        });
      }
    });
    cloudinary.uploader.destroy = async (pid) => {
      deletedPhotos.push(pid);
      return { result: 'ok' };
    };

    prisma.advocate.findUnique = async () => ({
      id: 'adv-not-approved',
      approvalStatus: 'PENDING',
      profilePhotoPublicId: 'old-live-photo-id',
      experienceYears: 3,
      languagesSpoken: ['English']
    });

    prisma.advocate.update = async ({ data }) => {
      updatedPayload = data;
      return {
        id: 'adv-not-approved',
        approvalStatus: 'PENDING',
        ...data
      };
    };

    const req = {
      user: { id: 'adv-not-approved', type: 'advocate' },
      body: {
        experienceYears: 5,
        languages: ['English', 'Hindi'],
        officeAddress: '101 Judicial Enclave, Sector 12',
        officeLatitude: 28.55,
        officeLongitude: 77.35
      },
      files: {
        profilePhoto: [{ buffer: Buffer.from('img'), mimetype: 'image/jpeg', size: 1000 }]
      }
    };
    const res = mockRes();
    await advocateProfileController.updateProfile(req, res, (err) => { if (err) throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonData.success, true);
    assert.equal(res.jsonData.message, 'Profile updated successfully');
    assert.equal(updatedPayload.experienceYears, 5);
    assert.deepEqual(updatedPayload.languagesSpoken, ['English', 'Hindi']);
    assert.equal(updatedPayload.latitude, 28.55);
    assert.equal(updatedPayload.longitude, 77.35);
    assert.equal(updatedPayload.profilePhotoPublicId, 'advocate/new-profile-photo');
    assert.deepEqual(deletedPhotos, ['old-live-photo-id']);
  });

  it('5. Approved advocate: Split of direct vs approval fields, equal-to-live values dropped, draft created', async () => {
    let updatedPayload = null;

    prisma.advocate.findUnique = async () => ({
      id: 'adv-approved',
      approvalStatus: 'APPROVED',
      profileChangeStatus: null,
      pendingProfileChange: null,
      experienceYears: 10,
      about: 'Original about text',
      videoCallChargePerMinute: 30,
      languagesSpoken: ['English']
    });

    prisma.advocate.update = async ({ data }) => {
      updatedPayload = data;
      return {
        id: 'adv-approved',
        approvalStatus: 'APPROVED',
        experienceYears: 10,
        about: 'Original about text',
        ...data
      };
    };

    const req = {
      user: { id: 'adv-approved', type: 'advocate' },
      body: {
        languages: ['English', 'Hindi', 'Punjabi'],
        experienceYears: 10, // equal to live (dropped from draft)
        videoCallChargePerMinute: 45 // differs from live (saved in draft)
      }
    };
    const res = mockRes();
    await advocateProfileController.updateProfile(req, res, (err) => { if (err) throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonData.success, true);
    assert.equal(res.jsonData.message, 'Changes saved as draft. Submit for approval to publish them.');
    assert.deepEqual(updatedPayload.languagesSpoken, ['English', 'Hindi', 'Punjabi']);
    assert.equal(updatedPayload.profileChangeStatus, 'DRAFT');
    assert.deepEqual(updatedPayload.pendingProfileChange, {
      videoCallChargePerMinute: 45
    });
    assert.equal(updatedPayload.pendingProfileChange.experienceYears, undefined);
  });

  it('6. Approved advocate: Draft merge and photo replacement deletes previous draft photo', async () => {
    let updatedPayload = null;
    const deletedCloudinaryIds = [];

    cloudinary.uploader.upload_stream = (options, cb) => ({
      end: () => {
        cb(null, {
          secure_url: 'https://cloudinary.com/new-draft-photo.jpg',
          public_id: 'advocate/draft-photo-2'
        });
      }
    });
    cloudinary.uploader.destroy = async (pid) => {
      deletedCloudinaryIds.push(pid);
      return { result: 'ok' };
    };

    prisma.advocate.findUnique = async () => ({
      id: 'adv-approved',
      approvalStatus: 'APPROVED',
      profileChangeStatus: 'DRAFT',
      pendingProfileChange: {
        about: 'Existing draft about',
        profilePhoto: { url: 'https://cloudinary.com/old-draft-photo.jpg', publicId: 'advocate/draft-photo-1' }
      },
      about: 'Live about',
      profilePhotoUrl: 'https://cloudinary.com/live.jpg',
      profilePhotoPublicId: 'advocate/live-photo-id'
    });

    prisma.advocate.update = async ({ data }) => {
      updatedPayload = data;
      return {
        id: 'adv-approved',
        approvalStatus: 'APPROVED',
        about: 'Live about',
        ...data
      };
    };

    const req = {
      user: { id: 'adv-approved', type: 'advocate' },
      body: {
        videoCallChargePerMinute: 50
      },
      files: {
        profilePhoto: [{ buffer: Buffer.from('img'), mimetype: 'image/jpeg', size: 1000 }]
      }
    };
    const res = mockRes();
    await advocateProfileController.updateProfile(req, res, (err) => { if (err) throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(updatedPayload.profileChangeStatus, 'DRAFT');
    assert.equal(updatedPayload.pendingProfileChange.about, 'Existing draft about');
    assert.equal(updatedPayload.pendingProfileChange.videoCallChargePerMinute, 50);
    assert.equal(updatedPayload.pendingProfileChange.profilePhoto.publicId, 'advocate/draft-photo-2');
    assert.deepEqual(deletedCloudinaryIds, ['advocate/draft-photo-1']);
  });

  it('7. SUBMITTED lock: Attempt to edit returns 409', async () => {
    prisma.advocate.findUnique = async () => ({
      id: 'adv-approved',
      approvalStatus: 'APPROVED',
      profileChangeStatus: 'SUBMITTED',
      pendingProfileChange: { videoCallChargePerMinute: 45 }
    });

    const req = {
      user: { id: 'adv-approved', type: 'advocate' },
      body: { languages: ['English', 'Marathi'] }
    };
    const res = mockRes();
    await advocateProfileController.updateProfile(req, res, (err) => { if (err) throw err; });

    assert.equal(res.statusCode, 409);
    assert.equal(res.jsonData.success, false);
    assert.equal(res.jsonData.message, 'Your profile changes are waiting for admin approval. Withdraw the request to edit again.');
  });

  it('8. Submit for approval: Empty draft returns 400', async () => {
    prisma.advocate.findUnique = async () => ({
      id: 'adv-approved',
      approvalStatus: 'APPROVED',
      profileChangeStatus: null,
      pendingProfileChange: null
    });

    const req = { user: { id: 'adv-approved', type: 'advocate' } };
    const res = mockRes();
    await advocateProfileController.submitForApproval(req, res, (err) => { if (err) throw err; });

    assert.equal(res.statusCode, 400);
    assert.equal(res.jsonData.success, false);
    assert.equal(res.jsonData.message, 'No changes to submit.');
  });

  it('9. Submit for approval: Transitions DRAFT to SUBMITTED', async () => {
    let updatedPayload = null;
    prisma.advocate.findUnique = async () => ({
      id: 'adv-approved',
      approvalStatus: 'APPROVED',
      profileChangeStatus: 'DRAFT',
      pendingProfileChange: { videoCallChargePerMinute: 45 }
    });
    prisma.advocate.update = async ({ data }) => {
      updatedPayload = data;
      return { id: 'adv-approved', ...data };
    };

    const req = { user: { id: 'adv-approved', type: 'advocate' } };
    const res = mockRes();
    await advocateProfileController.submitForApproval(req, res, (err) => { if (err) throw err; });

    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonData.success, true);
    assert.equal(res.jsonData.message, 'Changes sent for admin approval.');
    assert.equal(updatedPayload.profileChangeStatus, 'SUBMITTED');
    assert.ok(updatedPayload.profileChangeSubmittedAt instanceof Date);
  });

  it('10. Withdraw: SUBMITTED transitions to DRAFT; other status returns 409', async () => {
    // Non-SUBMITTED returns 409
    prisma.advocate.findUnique = async () => ({
      id: 'adv-approved',
      profileChangeStatus: 'DRAFT'
    });
    let res = mockRes();
    await advocateProfileController.withdrawProfileChanges({ user: { id: 'adv-approved', type: 'advocate' } }, res, () => {});
    assert.equal(res.statusCode, 409);

    // SUBMITTED transitions to DRAFT
    let updatedPayload = null;
    prisma.advocate.findUnique = async () => ({
      id: 'adv-approved',
      profileChangeStatus: 'SUBMITTED'
    });
    prisma.advocate.update = async ({ data }) => {
      updatedPayload = data;
      return { id: 'adv-approved', ...data };
    };

    res = mockRes();
    await advocateProfileController.withdrawProfileChanges({ user: { id: 'adv-approved', type: 'advocate' } }, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonData.message, 'Profile change request withdrawn. You can now edit your draft.');
    assert.equal(updatedPayload.profileChangeStatus, 'DRAFT');
  });

  it('11. Discard: SUBMITTED returns 409; DRAFT cleans up draft photos and clears draft', async () => {
    // SUBMITTED returns 409
    prisma.advocate.findUnique = async () => ({
      id: 'adv-approved',
      profileChangeStatus: 'SUBMITTED'
    });
    let res = mockRes();
    await advocateProfileController.discardProfileChanges({ user: { id: 'adv-approved', type: 'advocate' } }, res, () => {});
    assert.equal(res.statusCode, 409);
    assert.equal(res.jsonData.message, 'Withdraw first.');

    // DRAFT discards photos and clears draft in DB
    const deletedPhotos = [];
    cloudinary.uploader.destroy = async (pid) => {
      deletedPhotos.push(pid);
      return { result: 'ok' };
    };

    let updatedPayload = null;
    prisma.advocate.findUnique = async () => ({
      id: 'adv-approved',
      profileChangeStatus: 'DRAFT',
      pendingProfileChange: {
        profilePhoto: { url: 'https://...', publicId: 'draft-prof-id' },
        officePhoto: { url: 'https://...', publicId: 'draft-off-id' }
      }
    });
    prisma.advocate.update = async ({ data }) => {
      updatedPayload = data;
      return { id: 'adv-approved', ...data };
    };

    res = mockRes();
    await advocateProfileController.discardProfileChanges({ user: { id: 'adv-approved', type: 'advocate' } }, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonData.message, 'Profile changes discarded.');
    assert.equal(updatedPayload.pendingProfileChange, null);
    assert.equal(updatedPayload.profileChangeStatus, null);
    assert.deepEqual(deletedPhotos.sort(), ['draft-off-id', 'draft-prof-id']);
  });

  it('12. Admin Approve: Copies requested values, updates latitude/longitude, and deletes old live photos', async () => {
    const deletedPhotos = [];
    cloudinary.uploader.destroy = async (pid) => {
      deletedPhotos.push(pid);
      return { result: 'ok' };
    };

    prisma.advocate.findUnique = async () => ({
      id: 'adv-123',
      profileChangeStatus: 'SUBMITTED',
      profilePhotoPublicId: 'old-live-profile-id',
      officePhotoPublicId: 'old-live-office-id',
      officeLatitude: 28.50,
      officeLongitude: 77.30,
      pendingProfileChange: {
        about: 'Approved new about text',
        videoCallChargePerMinute: 60,
        officeLatitude: 28.60,
        officeLongitude: 77.40,
        profilePhoto: { url: 'https://.../new-p.jpg', publicId: 'new-live-profile-id' },
        officePhoto: { url: 'https://.../new-o.jpg', publicId: 'new-live-office-id' }
      }
    });

    let txUpdateData = null;
    prisma.$transaction = async (fn) => {
      const tx = {
        advocate: {
          update: async ({ data }) => {
            txUpdateData = data;
            return { id: 'adv-123', ...data };
          }
        }
      };
      return fn(tx);
    };

    const req = {
      params: { advocateId: 'adv-123' },
      user: { id: 'admin-user-id' }
    };
    const res = mockRes();
    await adminController.approveAdvocateProfileChange(req, res, () => {});

    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonData.message, 'Profile changes approved successfully.');
    assert.equal(txUpdateData.about, 'Approved new about text');
    assert.equal(txUpdateData.videoCallChargePerMinute, 60);
    assert.equal(txUpdateData.latitude, 28.60);
    assert.equal(txUpdateData.longitude, 77.40);
    assert.equal(txUpdateData.profilePhotoPublicId, 'new-live-profile-id');
    assert.equal(txUpdateData.officePhotoPublicId, 'new-live-office-id');
    assert.equal(txUpdateData.profileChangeStatus, 'APPROVED');
    assert.equal(txUpdateData.pendingProfileChange, null);
    assert.deepEqual(deletedPhotos.sort(), ['old-live-office-id', 'old-live-profile-id']);
  });

  it('13. Admin Reject: Keeps pendingProfileChange intact and records reason', async () => {
    let updatedPayload = null;
    prisma.advocate.findUnique = async () => ({
      id: 'adv-123',
      profileChangeStatus: 'SUBMITTED',
      pendingProfileChange: {
        about: 'Draft about text',
        videoCallChargePerMinute: 60
      }
    });
    prisma.advocate.update = async ({ data }) => {
      updatedPayload = data;
      return { id: 'adv-123', ...data };
    };

    const req = {
      params: { advocateId: 'adv-123' },
      user: { id: 'admin-user-id' },
      body: { reason: 'The fee increase does not align with your years of experience.' }
    };
    const res = mockRes();
    await adminController.rejectAdvocateProfileChange(req, res, () => {});

    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonData.message, 'Profile changes rejected.');
    assert.equal(updatedPayload.profileChangeStatus, 'REJECTED');
    assert.equal(updatedPayload.profileChangeRejectionReason, 'The fee increase does not align with your years of experience.');
    assert.equal(updatedPayload.pendingProfileChange, undefined);
  });

  it('14. Booking pricing and quote read live fees, NEVER draft fees', () => {
    const advocate = {
      isActive: true,
      status: 'ACTIVE',
      approvalStatus: 'APPROVED',
      deletionStatus: 'NONE',
      voiceCallChargePerMinute: 20,
      videoCallChargePerMinute: 30,
      offlineVisitingFee: 500,
      // Pending draft with new higher fees
      pendingProfileChange: {
        voiceCallChargePerMinute: 50,
        videoCallChargePerMinute: 100,
        offlineVisitingFee: 1500
      }
    };

    const voiceQuote = quote(advocate, 'VOICE_CALL');
    assert.equal(voiceQuote.ratePerMinute, 20); // live rate (not 50)
    assert.equal(voiceQuote.fee, 300); // 15 mins * 20 = 300

    const videoQuote = quote(advocate, 'VIDEO_CALL');
    assert.equal(videoQuote.ratePerMinute, 30); // live rate (not 100)
    assert.equal(videoQuote.fee, 450); // 15 mins * 30 = 450

    const inPersonQuote = quote(advocate, 'IN_PERSON');
    assert.equal(inPersonQuote.fee, 500); // live fee (not 1500)
  });

  it('15. Advocate Profile Update Schema: completeAddress is rejected with 400', () => {
    const result = advocateProfileUpdateSchema.safeParse({
      completeAddress: 'Some residential address'
    });
    assert.equal(result.success, false);
    const errorMsg = result.error.errors[0]?.message;
    assert.equal(errorMsg, 'completeAddress is no longer supported. Use officeAddress.');
  });

  it('16. Admin Advocate Profile Update Schema: completeAddress is rejected with 400', () => {
    const result = adminAdvocateProfileUpdateSchema.safeParse({
      completeAddress: 'Some admin updated address'
    });
    assert.equal(result.success, false);
    const errorMsg = result.error.errors[0]?.message;
    assert.equal(errorMsg, 'completeAddress is no longer supported. Use officeAddress.');
  });

  it('17. Response formatOfficeDetails fallback: completeAddress only, both, neither', () => {
    // 17.1 Only completeAddress present -> officeAddress fallback
    const advOnlyComplete = {
      officeAddress: null,
      completeAddress: 'Chamber 101, High Court',
      officePhotoUrl: null,
      officeLatitude: null,
      officeLongitude: null,
      officeLocationUpdatedAt: null
    };
    const details1 = advocateProfileController.formatOfficeDetails(advOnlyComplete);
    assert.equal(details1.officeAddress, 'Chamber 101, High Court');
    assert.equal(details1.office.address, 'Chamber 101, High Court');

    // 17.2 Both present -> officeAddress wins
    const advBoth = {
      officeAddress: 'Chamber 202, New Wing',
      completeAddress: 'Old residential address',
      officePhotoUrl: null,
      officeLatitude: null,
      officeLongitude: null,
      officeLocationUpdatedAt: null
    };
    const details2 = advocateProfileController.formatOfficeDetails(advBoth);
    assert.equal(details2.officeAddress, 'Chamber 202, New Wing');
    assert.equal(details2.office.address, 'Chamber 202, New Wing');

    // 17.3 Neither present -> null
    const advNeither = {
      officeAddress: null,
      completeAddress: null,
      officePhotoUrl: null,
      officeLatitude: null,
      officeLongitude: null,
      officeLocationUpdatedAt: null
    };
    const details3 = advocateProfileController.formatOfficeDetails(advNeither);
    assert.equal(details3.officeAddress, null);
    assert.equal(details3.office.address, null);
  });

  it('18. Backfill selection logic: overwrites nothing, skips whitespace, idempotent', () => {
    const mockDb = [
      { id: 'adv-1', officeAddress: null, completeAddress: 'Chamber 101, Delhi High Court' },
      { id: 'adv-2', officeAddress: 'Chamber 202, Supreme Court', completeAddress: 'Old Address' },
      { id: 'adv-3', officeAddress: '', completeAddress: '   ' }, // whitespace-only -> skip
      { id: 'adv-4', officeAddress: null, completeAddress: null }
    ];

    // Filter criteria identical to backfill script
    const toMigrate = mockDb.filter(row => {
      const isMissingOffice = !row.officeAddress || row.officeAddress.trim() === '';
      const hasComplete = row.completeAddress && row.completeAddress.trim().length > 0;
      return isMissingOffice && hasComplete;
    });

    assert.equal(toMigrate.length, 1);
    assert.equal(toMigrate[0].id, 'adv-1');

    // Apply backfill
    toMigrate.forEach(row => {
      row.officeAddress = row.completeAddress.trim();
    });

    // Idempotent: re-running filter yields 0 candidates
    const secondRun = mockDb.filter(row => {
      const isMissingOffice = !row.officeAddress || row.officeAddress.trim() === '';
      const hasComplete = row.completeAddress && row.completeAddress.trim().length > 0;
      return isMissingOffice && hasComplete;
    });

    assert.equal(secondRun.length, 0);
    // adv-2 was never touched
    assert.equal(mockDb[1].officeAddress, 'Chamber 202, Supreme Court');
  });
});

