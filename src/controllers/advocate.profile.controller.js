import prisma from '../lib/prisma.js';
import { advocateProfileUpdateSchema } from '../validators/advocate.validator.js';
import { uploadBufferToCloudinary, deleteFromCloudinary } from '../services/cloudinary.service.js';
import { computeEffectiveOnlineStatus } from '../utils/advocateStatus.js';

/**
 * Shared validator for uploaded image files (profile photo, office photo).
 */
const validateUploadedPhoto = (file) => {
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

  return {
    office: {
      photoUrl,
      latitude,
      longitude,
      updatedAt
    },
    officePhotoUrl: photoUrl,
    officeLatitude: latitude,
    officeLongitude: longitude,
    officeLocationUpdatedAt: updatedAt,
    officeDetailsComplete: Boolean(photoUrl && latitude !== null && longitude !== null)
  };
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

    // Exclude passwordHash, aadhaarNumber, and officePhotoPublicId
    const { passwordHash, aadhaarNumber, officePhotoPublicId, ...safeAdvocate } = advocate;
    const officeDetails = formatOfficeDetails(advocate);

    return res.status(200).json({
      success: true,
      advocate: {
        ...safeAdvocate,
        ...officeDetails,
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
 * POST /api/advocates/profile/submit-for-approval
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

    // Check if already approved
    if (advocate.approvalStatus === 'APPROVED') {
      return res.status(400).json({
        success: false,
        message: 'Profile is already approved.'
      });
    }

    // Check profile completion (base details)
    if (!checkIsProfileComplete(advocate)) {
      return res.status(400).json({
        success: false,
        message: 'Please complete your Advocate profile before submitting it for approval'
      });
    }

    // Check office details (office photo and office location required for submission)
    const missingFields = [];
    if (!advocate.officePhotoUrl || !advocate.officePhotoUrl.trim()) {
      missingFields.push('officePhoto');
    }
    if (
      advocate.officeLatitude === null || advocate.officeLatitude === undefined ||
      advocate.officeLongitude === null || advocate.officeLongitude === undefined
    ) {
      missingFields.push('officeLocation');
    }
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Please complete your office photo and office location before submitting for approval.',
        missingFields
      });
    }

    // Submit / Resubmit for approval -> PENDING
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
 * Update the currently authenticated advocate's profile.
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

    const updateData = {};

    const allowedScalars = [
      'fullName', 'gender', 'barCouncilId', 'aadhaarNumber', 'email', 'about',
      'completeAddress', 'offlineVisitingFee', 'state', 'city', 'pincode', 'casesHandled',
      'bestPracticeArea', 'topCourtPractised', 'practiceAreas'
    ];

    for (const field of allowedScalars) {
      if (validated[field] !== undefined) {
        updateData[field] = validated[field];
      }
    }

    // Map aliases
    if (validated.bio !== undefined) {
      updateData.about = validated.bio;
    } else if (validated.about !== undefined) {
      updateData.about = validated.about;
    }

    if (validated.experience !== undefined) {
      updateData.experienceYears = validated.experience;
    } else if (validated.experienceYears !== undefined) {
      updateData.experienceYears = validated.experienceYears;
    }

    if (validated.videoChargePerMinute !== undefined) {
      updateData.videoCallChargePerMinute = validated.videoChargePerMinute;
    } else if (validated.videoCallChargePerMinute !== undefined) {
      updateData.videoCallChargePerMinute = validated.videoCallChargePerMinute;
    }

    if (validated.voiceChargePerMinute !== undefined) {
      updateData.voiceCallChargePerMinute = validated.voiceChargePerMinute;
    } else if (validated.voiceCallChargePerMinute !== undefined) {
      updateData.voiceCallChargePerMinute = validated.voiceCallChargePerMinute;
    }

    if (validated.languages !== undefined) {
      updateData.languagesSpoken = validated.languages;
    } else if (validated.languagesSpoken !== undefined) {
      updateData.languagesSpoken = validated.languagesSpoken;
    }

    if (validated.courtPractice !== undefined) {
      updateData.courtPractice = validated.courtPractice;
    }

    // Office location update (both sent together or both null to clear)
    if (validated.officeLatitude !== undefined && validated.officeLongitude !== undefined) {
      if (validated.officeLatitude === null && validated.officeLongitude === null) {
        // Disallow clearing office location if already APPROVED
        const currentAdvocate = await prisma.advocate.findUnique({
          where: { id: req.user.id },
          select: { approvalStatus: true }
        });
        if (currentAdvocate && currentAdvocate.approvalStatus === 'APPROVED') {
          return res.status(400).json({
            success: false,
            message: 'Office location cannot be cleared once your profile is approved.'
          });
        }
        updateData.officeLatitude = null;
        updateData.officeLongitude = null;
        updateData.officeLocationUpdatedAt = null;
      } else {
        updateData.officeLatitude = validated.officeLatitude;
        updateData.officeLongitude = validated.officeLongitude;
        updateData.officeLocationUpdatedAt = new Date();
      }
    }

    const updatedAdvocate = await prisma.advocate.update({
      where: { id: req.user.id },
      data: updateData
    });

    // Exclude passwordHash, aadhaarNumber, and officePhotoPublicId
    const { passwordHash, aadhaarNumber, officePhotoPublicId, ...safeAdvocate } = updatedAdvocate;
    const officeDetails = formatOfficeDetails(updatedAdvocate);

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      advocate: {
        ...safeAdvocate,
        ...officeDetails,
        type: 'advocate'
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Upload profile photo for advocate and cleanup old Cloudinary image.
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

    const oldPublicId = advocate.profilePhotoPublicId;

    // Upload new image to Cloudinary
    const { url, publicId } = await uploadBufferToCloudinary(req.file.buffer);

    try {
      // Update DB with new photo
      const updatedAdvocate = await prisma.advocate.update({
        where: { id: req.user.id },
        data: {
          profilePhotoUrl: url,
          profilePhotoPublicId: publicId
        }
      });

      // DB update succeeded, delete old Cloudinary image if it exists
      if (oldPublicId) {
        await deleteFromCloudinary(oldPublicId);
      }

      const { passwordHash, aadhaarNumber, officePhotoPublicId, ...safeAdvocate } = updatedAdvocate;
      const officeDetails = formatOfficeDetails(updatedAdvocate);

      return res.status(200).json({
        success: true,
        message: 'Photo updated successfully',
        profilePhotoUrl: url,
        advocate: {
          ...safeAdvocate,
          ...officeDetails,
          type: 'advocate'
        }
      });
    } catch (dbError) {
      // Clean up orphaned new image from Cloudinary
      await deleteFromCloudinary(publicId);
      throw dbError;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * Upload office photo for advocate and cleanup old Cloudinary office image.
 * POST /api/advocate/profile/office-photo
 */
export const uploadOfficePhoto = async (req, res, next) => {
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

    const oldPublicId = advocate.officePhotoPublicId;

    // Upload new office photo to Cloudinary
    const { url, publicId } = await uploadBufferToCloudinary(req.file.buffer);

    try {
      // Update DB with new office photo
      const updatedAdvocate = await prisma.advocate.update({
        where: { id: req.user.id },
        data: {
          officePhotoUrl: url,
          officePhotoPublicId: publicId
        }
      });

      // DB update succeeded, delete old Cloudinary office image if it exists
      if (oldPublicId) {
        await deleteFromCloudinary(oldPublicId);
      }

      const { passwordHash, aadhaarNumber, officePhotoPublicId: _opId, ...safeAdvocate } = updatedAdvocate;
      const officeDetails = formatOfficeDetails(updatedAdvocate);

      return res.status(200).json({
        success: true,
        message: 'Office photo updated successfully',
        officePhotoUrl: url,
        advocate: {
          ...safeAdvocate,
          ...officeDetails,
          type: 'advocate'
        }
      });
    } catch (dbError) {
      // Clean up orphaned new image from Cloudinary
      await deleteFromCloudinary(publicId);
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
        completeAddress: advocate.completeAddress,
        about: advocate.about,
        bio: advocate.about,
        videoCallChargePerMinute: advocate.videoCallChargePerMinute,
        voiceCallChargePerMinute: advocate.voiceCallChargePerMinute,
        offlineVisitingFee: advocate.offlineVisitingFee,
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
    // If profile has never been submitted for approval (submittedForApprovalAt is null), return NOT_SUBMITTED
    if (!advocate.submittedForApprovalAt) {
      return res.status(200).json({
        success: true,
        status: 'NOT_SUBMITTED',
        message: 'Your profile has not been submitted for admin approval.'
      });
    }

    // Otherwise, profile is submitted and currently under admin review
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

