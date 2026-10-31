import prisma from '../lib/prisma.js';
import { advocateProfileUpdateSchema } from '../validators/advocate.validator.js';
import { uploadBufferToCloudinary, deleteFromCloudinary } from '../services/cloudinary.service.js';
import { computeEffectiveOnlineStatus } from '../utils/advocateStatus.js';
import { formatPricingSummary } from '../services/advocateBooking/pricing.js';

/**
 * Approval-required fields for APPROVED advocates.
 */
export const APPROVAL_FIELDS = [
  'experienceYears',
  'about',
  'voiceCallPricePer15Min',
  'videoCallPricePer15Min',
  'offlineVisitingFee',
  'officeVisitDurationMinutes',
  'profilePhoto',
  'officeAddress',
  'pincode',
  'city',
  'state',
  'officeLatitude',
  'officeLongitude',
  'officePhoto'
];

/**
 * Human-readable labels for approval fields.
 */
export const FIELD_LABELS = {
  experienceYears: 'Experience (years)',
  about: 'About',
  voiceCallPricePer15Min: 'Voice call price (15 min)',
  videoCallPricePer15Min: 'Video call price (15 min)',
  offlineVisitingFee: 'Office visit price',
  officeVisitDurationMinutes: 'Office visit duration (min)',
  profilePhoto: 'Profile photo',
  officeAddress: 'Office address',
  pincode: 'Pincode',
  city: 'City',
  state: 'State',
  officeLatitude: 'Office latitude',
  officeLongitude: 'Office longitude',
  officePhoto: 'Office photo'
};

/**
 * Shared validator for uploaded image files (profile photo, office photo).
 */
export const validateUploadedPhoto = (file) => {
  if (!file) {
    return { valid: false, status: 400, message: 'No photo file provided.' };
  }
  const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return { valid: false, status: 400, message: 'Invalid file format. Only JPEG, JPG, PNG, and WEBP images are allowed.' };
  }
  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    return { valid: false, status: 400, message: 'File size exceeds the 5MB limit.' };
  }
  return { valid: true };
};

/**
 * Shared formatter for advocate office details.
 * Ensures officePhotoPublicId is NEVER exposed.
 */
export const formatOfficeDetails = (advocate) => {
  const photoUrl = advocate.officePhotoUrl ?? null;
  const latitude = advocate.officeLatitude ?? null;
  const longitude = advocate.officeLongitude ?? null;
  const updatedAt = advocate.officeLocationUpdatedAt ?? null;
  // TODO: remove fallback after backfill-office-address --apply
  const address = advocate.officeAddress || advocate.completeAddress || null;

  return {
    office: {
      address,
      photoUrl,
      latitude,
      longitude,
      updatedAt
    },
    officeAddress: address,
    officePhotoUrl: photoUrl,
    officeLatitude: latitude,
    officeLongitude: longitude,
    officeLocationUpdatedAt: updatedAt,
    officeDetailsComplete: Boolean(photoUrl && latitude !== null && longitude !== null)
  };
};

/**
 * Formats the pending profile change block for API responses.
 * Never exposes Cloudinary publicIds.
 */
export const formatProfileChange = (advocate) => {
  if (!advocate || advocate.approvalStatus !== 'APPROVED' || !advocate.profileChangeStatus) {
    return null;
  }
  const pending = advocate.pendingProfileChange || {};
  const changes = [];

  for (const [key, reqVal] of Object.entries(pending)) {
    if (!APPROVAL_FIELDS.includes(key)) continue;
    const label = FIELD_LABELS[key] || key;
    let current = null;
    let requested = reqVal;

    if (key === 'profilePhoto') {
      current = advocate.profilePhotoUrl ?? null;
      requested = reqVal?.url ?? reqVal;
    } else if (key === 'officePhoto') {
      current = advocate.officePhotoUrl ?? null;
      requested = reqVal?.url ?? reqVal;
    } else if (key === 'officeAddress') {
      // TODO: remove fallback after backfill-office-address --apply
      current = advocate.officeAddress || advocate.completeAddress || null;
      requested = reqVal;
    } else {
      current = advocate[key] !== undefined && advocate[key] !== null
        ? (typeof advocate[key] === 'object' && 'toNumber' in advocate[key] ? advocate[key].toNumber() : advocate[key])
        : null;
      if (typeof reqVal === 'object' && reqVal !== null && 'toNumber' in reqVal) {
        requested = reqVal.toNumber();
      }
    }

    changes.push({
      field: key,
      label,
      current,
      requested
    });
  }

  return {
    status: advocate.profileChangeStatus,
    updatedAt: advocate.profileChangeUpdatedAt,
    submittedAt: advocate.profileChangeSubmittedAt,
    reviewedAt: advocate.profileChangeReviewedAt,
    rejectionReason: advocate.profileChangeRejectionReason,
    changes,
    approvalFields: APPROVAL_FIELDS
  };
};

/**
 * Helper to check if a requested value is equal to the live advocate value.
 */
const isEqualValue = (field, liveVal, reqVal) => {
  if (reqVal === undefined) return true;
  if (liveVal === null || liveVal === undefined) {
    return reqVal === null || reqVal === undefined || reqVal === '';
  }
  if (['experienceYears', 'voiceCallPricePer15Min', 'videoCallPricePer15Min', 'offlineVisitingFee', 'officeVisitDurationMinutes', 'officeLatitude', 'officeLongitude'].includes(field)) {
    const liveNum = typeof liveVal === 'object' && liveVal !== null && 'toNumber' in liveVal ? liveVal.toNumber() : Number(liveVal);
    const reqNum = Number(reqVal);
    return Math.abs(liveNum - reqNum) < 0.000001;
  }
  return String(liveVal).trim() === String(reqVal).trim();
};

/**
 * Get the currently authenticated advocate's profile.
 */
export const getProfile = async (req, res, next) => {
  try {
    if (!req.user || req.user.type !== 'advocate') {
      return res.status(403).json({
        success: false,
        message: 'Access forbidden. Advocate role required.'
      });
    }

    const advocate = await prisma.advocate.findUnique({
      where: { id: req.user.id }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate profile not found.'
      });
    }

    // Exclude passwordHash, aadhaarNumber, officePhotoPublicId, and legacy fee columns
    const {
      passwordHash,
      aadhaarNumber,
      officePhotoPublicId,
      pendingOfficeChange,
      pendingProfileChange,
      ...safeAdvocate
    } = advocate;
    const officeDetails = formatOfficeDetails(advocate);
    const profileChange = formatProfileChange(advocate);
    const pricing = formatPricingSummary(advocate);

    return res.status(200).json({
      success: true,
      advocate: {
        ...safeAdvocate,
        voiceCallPricePer15Min: advocate.voiceCallPricePer15Min !== null ? Number(advocate.voiceCallPricePer15Min) : null,
        videoCallPricePer15Min: advocate.videoCallPricePer15Min !== null ? Number(advocate.videoCallPricePer15Min) : null,
        offlineVisitingFee: advocate.offlineVisitingFee !== null ? Number(advocate.offlineVisitingFee) : null,
        officeVisitDurationMinutes: advocate.officeVisitDurationMinutes !== null ? advocate.officeVisitDurationMinutes : null,
        pricing,
        ...officeDetails,
        profileChange,
        isOnline: computeEffectiveOnlineStatus(advocate.isOnline, advocate.lastSeenAt),
        lastSeenAt: advocate.lastSeenAt,
        callAvailability: advocate.callAvailability ?? false,
        bio: advocate.about,
        accountStatus: advocate.status,
        approvalStatus: advocate.approvalStatus,
        rejectionReason: advocate.rejectionReason,
        type: 'advocate'
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Helper to validate advocate profile completeness.
 */
export const checkIsProfileComplete = (advocate) => {
  const hasName = !!(advocate.fullName && advocate.fullName.trim());
  const hasPhone = !!(advocate.phone && advocate.phone.trim());
  const hasBarId = !!(advocate.barCouncilId && advocate.barCouncilId.trim());
  const hasPhoto = !!(advocate.profilePhotoUrl && advocate.profilePhotoUrl.trim());
  const hasLawType = !!(advocate.bestPracticeArea || (advocate.practiceAreas && advocate.practiceAreas.length > 0));
  const hasExp = advocate.experienceYears !== null && advocate.experienceYears !== undefined;
  const hasAbout = !!(advocate.about && advocate.about.trim());
  const hasCity = !!(advocate.city && advocate.city.trim());
  const hasState = !!(advocate.state && advocate.state.trim());
  const hasPincode = !!(advocate.pincode && advocate.pincode.trim());

  return hasName && hasPhone && hasBarId && hasPhoto && hasLawType && hasExp && hasAbout && hasCity && hasState && hasPincode;
};

/**
 * Submit Advocate Profile for Admin Approval.
 * POST /api/advocate/profile/submit-for-approval
 */
export const submitForApproval = async (req, res, next) => {
  try {
    if (!req.user || (req.user.type !== 'advocate' && req.user.role !== 'ADVOCATE')) {
      return res.status(403).json({
        success: false,
        message: 'Access forbidden. Advocate role required.'
      });
    }

    const advocateId = req.user.id;

    const advocate = await prisma.advocate.findUnique({
      where: { id: advocateId }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate profile not found.'
      });
    }

    // Check account status
    if (advocate.status === 'BLOCKED') {
      return res.status(400).json({
        success: false,
        message: 'Your account is blocked. Cannot submit profile for approval.'
      });
    }

    // Advocate APPROVED -> Submit profile changes workflow
    if (advocate.approvalStatus === 'APPROVED') {
      const draft = advocate.pendingProfileChange;
      if (
        advocate.profileChangeStatus !== 'DRAFT' ||
        !draft ||
        typeof draft !== 'object' ||
        Object.keys(draft).length === 0
      ) {
        return res.status(400).json({
          success: false,
          message: 'No changes to submit.'
        });
      }

      await prisma.advocate.update({
        where: { id: advocateId },
        data: {
          profileChangeStatus: 'SUBMITTED',
          profileChangeSubmittedAt: new Date()
        }
      });

      return res.status(200).json({
        success: true,
        message: 'Changes sent for admin approval.'
      });
    }

    // Advocate NOT approved -> Standard initial profile verification submission
    if (!checkIsProfileComplete(advocate)) {
      return res.status(400).json({
        success: false,
        message: 'Please complete your Advocate profile before submitting it for approval'
      });
    }

    await prisma.advocate.update({
      where: { id: advocateId },
      data: {
        approvalStatus: 'PENDING',
        submittedForApprovalAt: new Date(),
        rejectionReason: null
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Your profile has been submitted for admin approval'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Withdraw submitted profile changes (SUBMITTED -> DRAFT).
 * POST /api/advocate/profile/changes/withdraw
 */
export const withdrawProfileChanges = async (req, res, next) => {
  try {
    if (!req.user || req.user.type !== 'advocate') {
      return res.status(403).json({
        success: false,
        message: 'Access forbidden. Advocate role required.'
      });
    }

    const advocate = await prisma.advocate.findUnique({
      where: { id: req.user.id }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate profile not found.'
      });
    }

    if (advocate.profileChangeStatus !== 'SUBMITTED') {
      return res.status(409).json({
        success: false,
        message: 'No submitted changes to withdraw.'
      });
    }

    await prisma.advocate.update({
      where: { id: req.user.id },
      data: {
        profileChangeStatus: 'DRAFT'
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Profile change request withdrawn. You can now edit your draft.'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Discard draft profile changes (DRAFT / REJECTED -> cleared).
 * DELETE /api/advocate/profile/changes
 */
export const discardProfileChanges = async (req, res, next) => {
  try {
    if (!req.user || req.user.type !== 'advocate') {
      return res.status(403).json({
        success: false,
        message: 'Access forbidden. Advocate role required.'
      });
    }

    const advocate = await prisma.advocate.findUnique({
      where: { id: req.user.id }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate profile not found.'
      });
    }

    if (advocate.profileChangeStatus === 'SUBMITTED') {
      return res.status(409).json({
        success: false,
        message: 'Withdraw first.'
      });
    }

    if (!advocate.pendingProfileChange && !advocate.profileChangeStatus) {
      return res.status(400).json({
        success: false,
        message: 'No changes to discard.'
      });
    }

    const draft = advocate.pendingProfileChange || {};
    const draftProfilePublicId = draft.profilePhoto?.publicId;
    const draftOfficePublicId = draft.officePhoto?.publicId;

    await prisma.advocate.update({
      where: { id: req.user.id },
      data: {
        pendingProfileChange: null,
        profileChangeStatus: null,
        profileChangeUpdatedAt: null,
        profileChangeSubmittedAt: null,
        profileChangeReviewedAt: null,
        profileChangeRejectionReason: null,
        profileChangeReviewedBy: null
      }
    });

    // Clean up draft photos from Cloudinary
    if (draftProfilePublicId) {
      await deleteFromCloudinary(draftProfilePublicId).catch(() => {});
    }
    if (draftOfficePublicId) {
      await deleteFromCloudinary(draftOfficePublicId).catch(() => {});
    }

    return res.status(200).json({
      success: true,
      message: 'Profile changes discarded.'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update the currently authenticated advocate's profile.
 * PATCH /api/advocate/profile
 * Accepts JSON or multipart/form-data.
 */
export const updateProfile = async (req, res, next) => {
  try {
    if (!req.user || req.user.type !== 'advocate') {
      return res.status(403).json({
        success: false,
        message: 'Access forbidden. Advocate role required.'
      });
    }

    const validated = advocateProfileUpdateSchema.parse(req.body);

    const advocate = await prisma.advocate.findUnique({
      where: { id: req.user.id }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate profile not found.'
      });
    }

    // Extract uploaded files
    const profilePhotoFile = req.files?.profilePhoto?.[0] || (req.file?.fieldname === 'profilePhoto' ? req.file : null);
    const officePhotoFile = req.files?.officePhoto?.[0] || (req.file?.fieldname === 'officePhoto' ? req.file : null);

    if (profilePhotoFile) {
      const v = validateUploadedPhoto(profilePhotoFile);
      if (!v.valid) return res.status(v.status).json({ success: false, message: v.message });
    }
    if (officePhotoFile) {
      const v = validateUploadedPhoto(officePhotoFile);
      if (!v.valid) return res.status(v.status).json({ success: false, message: v.message });
    }

    // Normalize payload with aliases
    const normalized = { ...validated };
    if (normalized.bio !== undefined) normalized.about = normalized.bio;
    if (normalized.experience !== undefined) normalized.experienceYears = normalized.experience;
    if (normalized.languages !== undefined) normalized.languagesSpoken = normalized.languages;

    // Validate merged office visit pair (fee + duration) only when at least one is being updated
    if (normalized.offlineVisitingFee !== undefined || normalized.officeVisitDurationMinutes !== undefined) {
      const liveFee = advocate.offlineVisitingFee != null ? Number(advocate.offlineVisitingFee) : null;
      const liveDuration = advocate.officeVisitDurationMinutes != null ? advocate.officeVisitDurationMinutes : null;

      const effectiveOfflineFee = normalized.offlineVisitingFee !== undefined
        ? normalized.offlineVisitingFee
        : liveFee;
      const effectiveOfficeDuration = normalized.officeVisitDurationMinutes !== undefined
        ? normalized.officeVisitDurationMinutes
        : liveDuration;

      const hasMergedFee = effectiveOfflineFee !== null && effectiveOfflineFee !== undefined && !Number.isNaN(effectiveOfflineFee);
      const hasMergedDuration = effectiveOfficeDuration !== null && effectiveOfficeDuration !== undefined;

      if (hasMergedFee !== hasMergedDuration) {
        return res.status(400).json({
          success: false,
          message: 'offlineVisitingFee and officeVisitDurationMinutes must both be set, or both be null.'
        });
      }
    }

    const directFieldKeys = [
      'fullName', 'gender', 'casesHandled', 'practiceAreas', 'practiceAreaIds',
      'bestPracticeArea', 'topCourtPractised', 'courtPractice', 'languagesSpoken'
    ];
    const approvalScalarKeys = [
      'experienceYears', 'about', 'voiceCallPricePer15Min', 'videoCallPricePer15Min',
      'offlineVisitingFee', 'officeVisitDurationMinutes', 'officeAddress', 'pincode', 'city', 'state',
      'officeLatitude', 'officeLongitude'
    ];

    // ==========================================
    // CASE A: Advocate is NOT APPROVED
    // ==========================================
    if (advocate.approvalStatus !== 'APPROVED') {
      const updateData = {};
      const oldLivePhotosToDelete = [];

      // Direct fields
      for (const field of directFieldKeys) {
        if (normalized[field] !== undefined) {
          if (field === 'practiceAreaIds') {
            updateData.practiceAreas = normalized[field];
          } else {
            updateData[field] = normalized[field];
          }
        }
      }

      // Approval scalar fields (apply directly to live record)
      for (const field of approvalScalarKeys) {
        if (normalized[field] !== undefined) {
          updateData[field] = normalized[field];
        }
      }

      // Office coordinates mapping to live latitude/longitude
      if (normalized.officeLatitude !== undefined && normalized.officeLongitude !== undefined) {
        updateData.latitude = normalized.officeLatitude;
        updateData.longitude = normalized.officeLongitude;
        updateData.officeLocationUpdatedAt = new Date();
      }

      // Upload profile photo directly if provided
      if (profilePhotoFile) {
        const { url, publicId } = await uploadBufferToCloudinary(profilePhotoFile.buffer);
        updateData.profilePhotoUrl = url;
        updateData.profilePhotoPublicId = publicId;
        if (advocate.profilePhotoPublicId) {
          oldLivePhotosToDelete.push(advocate.profilePhotoPublicId);
        }
      }

      // Upload office photo directly if provided
      if (officePhotoFile) {
        const { url, publicId } = await uploadBufferToCloudinary(officePhotoFile.buffer);
        updateData.officePhotoUrl = url;
        updateData.officePhotoPublicId = publicId;
        if (advocate.officePhotoPublicId) {
          oldLivePhotosToDelete.push(advocate.officePhotoPublicId);
        }
      }

      const updatedAdvocate = await prisma.advocate.update({
        where: { id: req.user.id },
        data: updateData
      });

      // Cleanup replaced live photos
      for (const pId of oldLivePhotosToDelete) {
        await deleteFromCloudinary(pId).catch(() => {});
      }

      const {
        passwordHash,
        aadhaarNumber,
        officePhotoPublicId: _opId,
        pendingOfficeChange: _poc,
        pendingProfileChange: _ppc,
        ...safeAdvocate
      } = updatedAdvocate;
      const officeDetails = formatOfficeDetails(updatedAdvocate);
      const pricing = formatPricingSummary(updatedAdvocate);

      return res.status(200).json({
        success: true,
        message: 'Profile updated successfully',
        advocate: {
          ...safeAdvocate,
          voiceCallPricePer15Min: updatedAdvocate.voiceCallPricePer15Min !== null ? Number(updatedAdvocate.voiceCallPricePer15Min) : null,
          videoCallPricePer15Min: updatedAdvocate.videoCallPricePer15Min !== null ? Number(updatedAdvocate.videoCallPricePer15Min) : null,
          offlineVisitingFee: updatedAdvocate.offlineVisitingFee !== null ? Number(updatedAdvocate.offlineVisitingFee) : null,
          officeVisitDurationMinutes: updatedAdvocate.officeVisitDurationMinutes !== null ? updatedAdvocate.officeVisitDurationMinutes : null,
          pricing,
          ...officeDetails,
          profileChange: null,
          type: 'advocate'
        }
      });
    }

    // ==========================================
    // CASE B: Advocate IS APPROVED
    // ==========================================
    if (advocate.profileChangeStatus === 'SUBMITTED') {
      return res.status(409).json({
        success: false,
        message: 'Your profile changes are waiting for admin approval. Withdraw the request to edit again.'
      });
    }

    // Start with existing draft (or rejected values if restarting after rejection)
    const draft = { ...(advocate.pendingProfileChange || {}) };
    const draftPhotosToDelete = [];
    let touchedApprovalFields = false;

    // Process photo uploads into draft
    if (profilePhotoFile) {
      touchedApprovalFields = true;
      const { url, publicId } = await uploadBufferToCloudinary(profilePhotoFile.buffer);
      if (draft.profilePhoto?.publicId) {
        draftPhotosToDelete.push(draft.profilePhoto.publicId);
      }
      draft.profilePhoto = { url, publicId };
    }

    if (officePhotoFile) {
      touchedApprovalFields = true;
      const { url, publicId } = await uploadBufferToCloudinary(officePhotoFile.buffer);
      if (draft.officePhoto?.publicId) {
        draftPhotosToDelete.push(draft.officePhoto.publicId);
      }
      draft.officePhoto = { url, publicId };
    }

    // Process approval scalar fields
    for (const key of approvalScalarKeys) {
      if (normalized[key] !== undefined) {
        touchedApprovalFields = true;
        const reqVal = normalized[key];
        const isSame = isEqualValue(key, advocate[key], reqVal);
        if (isSame) {
          // If value equals live value, drop from draft
          delete draft[key];
        } else {
          draft[key] = reqVal;
        }
      }
    }

    // Direct fields (applied directly to live fields)
    const liveUpdateData = {};
    let touchedDirectFields = false;
    for (const field of directFieldKeys) {
      if (normalized[field] !== undefined) {
        touchedDirectFields = true;
        if (field === 'practiceAreaIds') {
          liveUpdateData.practiceAreas = normalized[field];
        } else {
          liveUpdateData[field] = normalized[field];
        }
      }
    }

    const hasDraftChanges = Object.keys(draft).length > 0;
    const dbUpdateData = { ...liveUpdateData };

    if (hasDraftChanges) {
      dbUpdateData.pendingProfileChange = draft;
      dbUpdateData.profileChangeStatus = 'DRAFT';
      dbUpdateData.profileChangeUpdatedAt = new Date();
      dbUpdateData.profileChangeRejectionReason = null;
    } else {
      // Draft has become completely empty
      if (advocate.pendingProfileChange || advocate.profileChangeStatus) {
        dbUpdateData.pendingProfileChange = null;
        dbUpdateData.profileChangeStatus = null;
        dbUpdateData.profileChangeUpdatedAt = null;
        dbUpdateData.profileChangeRejectionReason = null;
      }
    }

    const updatedAdvocate = await prisma.advocate.update({
      where: { id: req.user.id },
      data: dbUpdateData
    });

    // Delete superseded draft photos
    for (const pId of draftPhotosToDelete) {
      await deleteFromCloudinary(pId).catch(() => {});
    }

    const {
      passwordHash,
      aadhaarNumber,
      officePhotoPublicId: _opId,
      pendingOfficeChange: _poc,
      pendingProfileChange: _ppc,
      ...safeAdvocate
    } = updatedAdvocate;
    const officeDetails = formatOfficeDetails(updatedAdvocate);
    const profileChange = formatProfileChange(updatedAdvocate);
    const pricing = formatPricingSummary(updatedAdvocate);

    let message = 'Profile updated.';
    if (touchedApprovalFields && hasDraftChanges) {
      message = 'Changes saved as draft. Submit for approval to publish them.';
    }

    return res.status(200).json({
      success: true,
      message,
      advocate: {
        ...safeAdvocate,
        voiceCallPricePer15Min: updatedAdvocate.voiceCallPricePer15Min !== null ? Number(updatedAdvocate.voiceCallPricePer15Min) : null,
        videoCallPricePer15Min: updatedAdvocate.videoCallPricePer15Min !== null ? Number(updatedAdvocate.videoCallPricePer15Min) : null,
        offlineVisitingFee: updatedAdvocate.offlineVisitingFee !== null ? Number(updatedAdvocate.offlineVisitingFee) : null,
        officeVisitDurationMinutes: updatedAdvocate.officeVisitDurationMinutes !== null ? updatedAdvocate.officeVisitDurationMinutes : null,
        pricing,
        ...officeDetails,
        profileChange,
        type: 'advocate'
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Upload profile photo for advocate (POST /api/advocate/profile/photo).
 * Compatible alias of PATCH /api/advocate/profile with profilePhoto.
 */
export const uploadProfilePhoto = async (req, res, next) => {
  try {
    if (!req.user || req.user.type !== 'advocate') {
      return res.status(403).json({
        success: false,
        message: 'Access forbidden. Advocate role required.'
      });
    }

    const validation = validateUploadedPhoto(req.file);
    if (!validation.valid) {
      return res.status(validation.status).json({
        success: false,
        message: validation.message
      });
    }

    const advocate = await prisma.advocate.findUnique({
      where: { id: req.user.id }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate profile not found.'
      });
    }

    // Approved advocate: save photo to draft pendingProfileChange
    if (advocate.approvalStatus === 'APPROVED') {
      if (advocate.profileChangeStatus === 'SUBMITTED') {
        return res.status(409).json({
          success: false,
          message: 'Your profile changes are waiting for admin approval. Withdraw the request to edit again.'
        });
      }

      const { url, publicId } = await uploadBufferToCloudinary(req.file.buffer);
      const draft = { ...(advocate.pendingProfileChange || {}) };
      const oldDraftPublicId = draft.profilePhoto?.publicId;

      draft.profilePhoto = { url, publicId };

      const updatedAdvocate = await prisma.advocate.update({
        where: { id: req.user.id },
        data: {
          pendingProfileChange: draft,
          profileChangeStatus: 'DRAFT',
          profileChangeUpdatedAt: new Date(),
          profileChangeRejectionReason: null
        }
      });

      if (oldDraftPublicId) {
        await deleteFromCloudinary(oldDraftPublicId).catch(() => {});
      }

      const {
        passwordHash,
        aadhaarNumber,
        officePhotoPublicId: _opId,
        pendingOfficeChange: _poc,
        pendingProfileChange: _ppc,
        ...safeAdvocate
      } = updatedAdvocate;
      const officeDetails = formatOfficeDetails(updatedAdvocate);
      const pricing = formatPricingSummary(updatedAdvocate);

      return res.status(200).json({
        success: true,
        message: 'Changes saved as draft. Submit for approval to publish them.',
        profilePhotoUrl: url,
        advocate: {
          ...safeAdvocate,
          voiceCallPricePer15Min: updatedAdvocate.voiceCallPricePer15Min !== null ? Number(updatedAdvocate.voiceCallPricePer15Min) : null,
          videoCallPricePer15Min: updatedAdvocate.videoCallPricePer15Min !== null ? Number(updatedAdvocate.videoCallPricePer15Min) : null,
          offlineVisitingFee: updatedAdvocate.offlineVisitingFee !== null ? Number(updatedAdvocate.offlineVisitingFee) : null,
          officeVisitDurationMinutes: updatedAdvocate.officeVisitDurationMinutes !== null ? updatedAdvocate.officeVisitDurationMinutes : null,
          pricing,
          ...officeDetails,
          profileChange: formatProfileChange(updatedAdvocate),
          type: 'advocate'
        }
      });
    }

    // Non-approved advocate: direct live update
    const oldPublicId = advocate.profilePhotoPublicId;
    const { url, publicId } = await uploadBufferToCloudinary(req.file.buffer);

    try {
      const updatedAdvocate = await prisma.advocate.update({
        where: { id: req.user.id },
        data: {
          profilePhotoUrl: url,
          profilePhotoPublicId: publicId
        }
      });

      if (oldPublicId) {
        await deleteFromCloudinary(oldPublicId).catch(() => {});
      }

      const {
        passwordHash,
        aadhaarNumber,
        officePhotoPublicId: _opId,
        pendingOfficeChange: _poc,
        pendingProfileChange: _ppc,
        ...safeAdvocate
      } = updatedAdvocate;
      const officeDetails = formatOfficeDetails(updatedAdvocate);
      const pricing = formatPricingSummary(updatedAdvocate);

      return res.status(200).json({
        success: true,
        message: 'Photo updated successfully',
        profilePhotoUrl: url,
        advocate: {
          ...safeAdvocate,
          voiceCallPricePer15Min: updatedAdvocate.voiceCallPricePer15Min !== null ? Number(updatedAdvocate.voiceCallPricePer15Min) : null,
          videoCallPricePer15Min: updatedAdvocate.videoCallPricePer15Min !== null ? Number(updatedAdvocate.videoCallPricePer15Min) : null,
          offlineVisitingFee: updatedAdvocate.offlineVisitingFee !== null ? Number(updatedAdvocate.offlineVisitingFee) : null,
          officeVisitDurationMinutes: updatedAdvocate.officeVisitDurationMinutes !== null ? updatedAdvocate.officeVisitDurationMinutes : null,
          pricing,
          ...officeDetails,
          profileChange: null,
          type: 'advocate'
        }
      });
    } catch (dbError) {
      await deleteFromCloudinary(publicId).catch(() => {});
      throw dbError;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Get Advocate Profile Verification Status.
 * GET /api/advocate/profile/verification-status
 */
export const getVerificationStatus = async (req, res, next) => {
  try {
    if (!req.user || (req.user.type !== 'advocate' && req.user.role !== 'ADVOCATE')) {
      return res.status(403).json({
        success: false,
        message: 'Access forbidden. Advocate role required.'
      });
    }

    const advocate = await prisma.advocate.findUnique({
      where: { id: req.user.id }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate profile not found.'
      });
    }

    // 1. APPROVED State
    if (advocate.approvalStatus === 'APPROVED') {
      const officeDetails = formatOfficeDetails(advocate);
      const profilePreview = {
        id: advocate.id,
        fullName: advocate.fullName,
        name: advocate.fullName,
        email: advocate.email,
        phone: advocate.phone,
        gender: advocate.gender,
        barCouncilId: advocate.barCouncilId,
        barId: advocate.barCouncilId,
        profilePhotoUrl: advocate.profilePhotoUrl,
        profileImage: advocate.profilePhotoUrl,
        experienceYears: advocate.experienceYears,
        experience: advocate.experienceYears,
        casesHandled: advocate.casesHandled,
        practiceAreas: advocate.practiceAreas || [],
        bestPracticeArea: advocate.bestPracticeArea,
        lawType: advocate.bestPracticeArea || (advocate.practiceAreas && advocate.practiceAreas.length > 0 ? advocate.practiceAreas[0] : null),
        topCourtPractised: advocate.topCourtPractised,
        courtPractice: advocate.courtPractice || [],
        languagesSpoken: advocate.languagesSpoken || [],
        state: advocate.state,
        city: advocate.city,
        pincode: advocate.pincode,
        about: advocate.about,
        bio: advocate.about,
        voiceCallPricePer15Min: advocate.voiceCallPricePer15Min !== null ? Number(advocate.voiceCallPricePer15Min) : null,
        videoCallPricePer15Min: advocate.videoCallPricePer15Min !== null ? Number(advocate.videoCallPricePer15Min) : null,
        offlineVisitingFee: advocate.offlineVisitingFee !== null ? Number(advocate.offlineVisitingFee) : null,
        officeVisitDurationMinutes: advocate.officeVisitDurationMinutes !== null ? advocate.officeVisitDurationMinutes : null,
        pricing: formatPricingSummary(advocate),
        averageRating: advocate.averageRating,
        totalReviews: advocate.totalReviews,
        status: advocate.status,
        accountStatus: advocate.status,
        approvalStatus: advocate.approvalStatus,
        ...officeDetails
      };

      return res.status(200).json({
        success: true,
        status: 'APPROVED',
        message: 'Your profile has been approved.',
        profile: profilePreview
      });
    }

    // 2. REJECTED State
    if (advocate.approvalStatus === 'REJECTED') {
      const response = {
        success: true,
        status: 'REJECTED',
        message: 'Your profile has been rejected.'
      };
      if (advocate.rejectionReason) {
        response.rejectionReason = advocate.rejectionReason;
      }
      return res.status(200).json(response);
    }

    // 3. PENDING State vs NOT_SUBMITTED State
    if (!advocate.submittedForApprovalAt) {
      return res.status(200).json({
        success: true,
        status: 'NOT_SUBMITTED',
        message: 'Your profile has not been submitted for admin approval.'
      });
    }

    const pendingResponse = {
      success: true,
      status: 'PENDING',
      message: 'Your profile is pending admin approval.'
    };
    if (advocate.submittedForApprovalAt) {
      pendingResponse.submittedAt = advocate.submittedForApprovalAt;
    }

    return res.status(200).json(pendingResponse);
  } catch (error) {
    next(error);
  }
};
