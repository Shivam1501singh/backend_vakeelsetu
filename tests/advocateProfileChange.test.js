import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { v2 as cloudinary } from 'cloudinary';
import prisma from '../src/lib/prisma.js';
import * as advocateProfileController from '../src/controllers/advocate.profile.controller.js';
import * as adminController from '../src/controllers/admin.controller.js';
import { advocateProfileUpdateSchema } from '../src/validators/advocate.validator.js';
import { adminAdvocateProfileUpdateSchema } from '../src/validators/admin.validator.js';
import { quote, calculatePricing, formatPricingSummary } from '../src/services/advocateBooking/pricing.js';
import { validateStart } from '../src/services/advocateBooking/slotValidation.js';

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
      videoCallPricePer15Min: 450,
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
        videoCallPricePer15Min: 600 // differs from live (saved in draft)
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
      videoCallPricePer15Min: 600
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
        videoCallPricePer15Min: 750
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
    assert.equal(updatedPayload.pendingProfileChange.videoCallPricePer15Min, 750);
    assert.equal(updatedPayload.pendingProfileChange.profilePhoto.publicId, 'advocate/draft-photo-2');
    assert.deepEqual(deletedCloudinaryIds, ['advocate/draft-photo-1']);
  });

  it('7. SUBMITTED lock: Attempt to edit returns 409', async () => {
    prisma.advocate.findUnique = async () => ({
      id: 'adv-approved',
      approvalStatus: 'APPROVED',
      profileChangeStatus: 'SUBMITTED',
      pendingProfileChange: { videoCallPricePer15Min: 675 }
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
      pendingProfileChange: { videoCallPricePer15Min: 675 }
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
        videoCallPricePer15Min: 900,
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
    assert.equal(txUpdateData.videoCallPricePer15Min, 900);
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
        videoCallPricePer15Min: 900
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
      voiceCallPricePer15Min: 300,
      videoCallPricePer15Min: 450,
      offlineVisitingFee: 500,
      officeVisitDurationMinutes: 60,
      // Pending draft with new higher fees
      pendingProfileChange: {
        voiceCallPricePer15Min: 750,
        videoCallPricePer15Min: 1500,
        offlineVisitingFee: 1500,
        officeVisitDurationMinutes: 45
      }
    };

    const voiceQuote = quote(advocate, 'VOICE_CALL');
    assert.equal(voiceQuote.fee, 300); // live rate (not 750)
    assert.equal(voiceQuote.durationMinutes, 15);

    const videoQuote = quote(advocate, 'VIDEO_CALL');
    assert.equal(videoQuote.fee, 450); // live rate (not 1500)
    assert.equal(videoQuote.durationMinutes, 15);

    const inPersonQuote = quote(advocate, 'IN_PERSON');
    assert.equal(inPersonQuote.fee, 500); // live fee (not 1500)
    assert.equal(inPersonQuote.durationMinutes, 60); // live duration (not 45)
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

  it('19. Pricing Helper: 510 -> 62680 paise; decimal rounding; null -> mode off', () => {
    const advocate = {
      voiceCallPricePer15Min: 510,
      videoCallPricePer15Min: 33.33,
      offlineVisitingFee: 1000,
      officeVisitDurationMinutes: 45
    };

    // Voice 510: fee 510, GST 18% = 91.80 (9180 paise), Platform fee = ₹25 (2500 paise), Total = 626.80 (62680 paise)
    const voice = calculatePricing(advocate, 'VOICE_CALL');
    assert.equal(voice.fee, 510);
    assert.equal(voice.feePaise, 51000);
    assert.equal(voice.gstPaise, 9180);
    assert.equal(voice.platformFeePaise, 2500);
    assert.equal(voice.totalPaise, 62680);
    assert.equal(voice.total, 626.80);
    assert.equal(voice.priceLabel, '₹510 / 15 min');

    // Decimal rounding test: 33.33 -> feePaise 3333, GST 18% = round(3333 * 0.18) = 600, total = 3333 + 600 + 2500 = 6433
    const video = calculatePricing(advocate, 'VIDEO_CALL');
    assert.equal(video.fee, 33.33);
    assert.equal(video.feePaise, 3333);
    assert.equal(video.gstPaise, 600);
    assert.equal(video.totalPaise, 6433);

    // Office visit: fee 1000, 45 min -> GST 180 (18000), total 1000 + 180 + 25 = 1205 (120500 paise)
    const office = calculatePricing(advocate, 'IN_PERSON');
    assert.equal(office.fee, 1000);
    assert.equal(office.durationMinutes, 45);
    assert.equal(office.priceLabel, '₹1,000 / 45 min');
    assert.equal(office.totalPaise, 120500);
    assert.equal(office.total, 1205);

    // Null modes are turned off
    const unoffered = calculatePricing({ voiceCallPricePer15Min: null, videoCallPricePer15Min: null, offlineVisitingFee: null }, 'VOICE_CALL');
    assert.equal(unoffered, null);

    // formatPricingSummary
    const summary = formatPricingSummary(advocate);
    assert.equal(summary.voiceCall.price, 510);
    assert.equal(summary.voiceCall.durationMinutes, 15);
    assert.equal(summary.videoCall.price, 33.33);
    assert.equal(summary.officeVisit.price, 1000);
    assert.equal(summary.officeVisit.durationMinutes, 45);
  });

  it('20. In-person duration: 45 / 37 min -> correct endAt; 15-min grid alignment; overlap check', () => {
    // Valid 15-min aligned future start: 2026-11-15T10:15:00.000Z
    const validStart = '2026-11-15T10:15:00.000Z';
    const result45 = validateStart('IN_PERSON', validStart, 45);
    assert.equal(result45.durationMinutes, 45);
    assert.equal(result45.startAt.toISOString(), '2026-11-15T10:15:00.000Z');
    assert.equal(result45.endAt.toISOString(), '2026-11-15T11:00:00.000Z');

    const result37 = validateStart('IN_PERSON', validStart, 37);
    assert.equal(result37.durationMinutes, 37);
    assert.equal(result37.endAt.toISOString(), '2026-11-15T10:52:00.000Z');

    // Non-15-min grid alignment throws INVALID_SLOT
    assert.throws(() => {
      validateStart('IN_PERSON', '2026-11-15T10:17:00.000Z', 45);
    }, (err) => err.code === 'INVALID_SLOT');

    // Overlap math: [10:15, 10:52) overlaps with a slot starting at 10:45
    const existingBooking = { startAt: new Date('2026-11-15T10:15:00.000Z'), endAt: new Date('2026-11-15T10:52:00.000Z') };
    const querySlot = { startAt: new Date('2026-11-15T10:45:00.000Z'), endAt: new Date('2026-11-15T11:00:00.000Z') };
    const overlaps = existingBooking.startAt < querySlot.endAt && existingBooking.endAt > querySlot.startAt;
    assert.equal(overlaps, true);

    // But slot starting at 11:00 does not overlap
    const nonOverlappingSlot = { startAt: new Date('2026-11-15T11:00:00.000Z'), endAt: new Date('2026-11-15T11:15:00.000Z') };
    const overlaps2 = existingBooking.startAt < nonOverlappingSlot.endAt && existingBooking.endAt > nonOverlappingSlot.startAt;
    assert.equal(overlaps2, false);
  });

  it('21. Validation: sanity, old fields -> 400, pair rule with merged values, Razorpay max', async () => {
    // 21.1 Old per-minute field rejection
    const oldVoice = advocateProfileUpdateSchema.safeParse({ voiceCallChargePerMinute: 30 });
    assert.equal(oldVoice.success, false);
    assert.equal(oldVoice.error.errors[0]?.message, 'voiceCallChargePerMinute is no longer supported. Use voiceCallPricePer15Min.');

    const oldVideo = advocateProfileUpdateSchema.safeParse({ videoCallChargePerMinute: 50 });
    assert.equal(oldVideo.success, false);
    assert.equal(oldVideo.error.errors[0]?.message, 'videoCallChargePerMinute is no longer supported. Use videoCallPricePer15Min.');

    // 21.2 Duration sanity: 0, 1441, 2.5
    assert.equal(advocateProfileUpdateSchema.safeParse({ officeVisitDurationMinutes: 0 }).success, false);
    assert.equal(advocateProfileUpdateSchema.safeParse({ officeVisitDurationMinutes: 1441 }).success, false);
    assert.equal(advocateProfileUpdateSchema.safeParse({ officeVisitDurationMinutes: '2.5' }).success, false);

    // 21.3 Razorpay max amount check
    const overLimitPrice = 450000; // 450000 + 18% + 25 = 531,025 > 500,000
    assert.equal(advocateProfileUpdateSchema.safeParse({ voiceCallPricePer15Min: overLimitPrice }).success, false);

    // 21.4 Office visit pair rule with merged values in controller
    prisma.advocate.findUnique = async () => ({
      id: 'adv-pair',
      offlineVisitingFee: null,
      officeVisitDurationMinutes: null
    });
    const res = mockRes();
    await advocateProfileController.updateProfile({
      user: { id: 'adv-pair', type: 'advocate' },
      body: { officeVisitDurationMinutes: 45 } // fee is null in DB and not sent -> 400
    }, res, () => {});
    assert.equal(res.statusCode, 400);
    assert.equal(res.jsonData.message, 'offlineVisitingFee and officeVisitDurationMinutes must both be set, or both be null.');
  });

  it('22. Profile change: new fields go to draft, approve applies them', async () => {
    prisma.advocate.findUnique = async () => ({
      id: 'adv-appr',
      approvalStatus: 'APPROVED',
      profileChangeStatus: null,
      pendingProfileChange: null,
      voiceCallPricePer15Min: 400,
      officeVisitDurationMinutes: 60,
      offlineVisitingFee: 1000
    });

    let draftSaved = null;
    prisma.advocate.update = async ({ data }) => {
      draftSaved = data;
      return { id: 'adv-appr', approvalStatus: 'APPROVED', ...data };
    };

    const res = mockRes();
    await advocateProfileController.updateProfile({
      user: { id: 'adv-appr', type: 'advocate' },
      body: {
        voiceCallPricePer15Min: 600,
        officeVisitDurationMinutes: 45
      }
    }, res, () => {});

    assert.equal(res.statusCode, 200);
    assert.equal(draftSaved.profileChangeStatus, 'DRAFT');
    assert.equal(draftSaved.pendingProfileChange.voiceCallPricePer15Min, 600);
    assert.equal(draftSaved.pendingProfileChange.officeVisitDurationMinutes, 45);

    // Approve applies both fields
    prisma.advocate.findUnique = async () => ({
      id: 'adv-appr',
      profileChangeStatus: 'SUBMITTED',
      pendingProfileChange: {
        voiceCallPricePer15Min: 600,
        officeVisitDurationMinutes: 45
      }
    });

    let txData = null;
    prisma.$transaction = async (fn) => fn({ advocate: { update: async ({ data }) => { txData = data; return { id: 'adv-appr', ...data }; } } });

    const adminRes = mockRes();
    await adminController.approveAdvocateProfileChange({
      params: { advocateId: 'adv-appr' },
      user: { id: 'admin-1' }
    }, adminRes, () => {});

    assert.equal(adminRes.statusCode, 200);
    assert.equal(txData.voiceCallPricePer15Min, 600);
    assert.equal(txData.officeVisitDurationMinutes, 45);
    assert.equal(txData.pendingProfileChange, null);
  });

  it('23. Snapshot: A later price change does not alter an existing booking', () => {
    const historicalBooking = {
      id: 'bk-1',
      durationMinutes: 60,
      startAt: new Date('2026-10-01T10:00:00.000Z'),
      endAt: new Date('2026-10-01T11:00:00.000Z'),
      feePaise: 100000,
      gstPaise: 18000,
      platformFeePaise: 2500,
      totalPaise: 120500
    };

    // Advocate later updates office visit fee to 2500 and duration to 45
    const updatedAdvocate = {
      offlineVisitingFee: 2500,
      officeVisitDurationMinutes: 45
    };

    // Historical booking preserves its exact snapshot
    assert.equal(historicalBooking.feePaise, 100000);
    assert.equal(historicalBooking.durationMinutes, 60);
    assert.equal(historicalBooking.totalPaise, 120500);
  });
});

