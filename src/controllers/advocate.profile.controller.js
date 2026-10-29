import prisma from '../lib/prisma.js';
import { advocateProfileUpdateSchema, advocateOfficeChangeSchema } from '../validators/advocate.validator.js';
import { uploadBufferToCloudinary, deleteFromCloudinary } from '../services/cloudinary.service.js';
import { computeEffectiveOnlineStatus } from '../utils/advocateStatus.js';

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
  const address = advocate.officeAddress ?? null;

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
    const { passwordHash, aadhaarNumber, officePhotoPublicId, pendingOfficeChange, ...safeAdvocate } = advocate;
    const officeDetails = formatOfficeDetails(advocate);

    const officeChange = advocate.officeChangeStatus ? {
      status: advocate.officeChangeStatus,
      requestedAt: advocate.officeChangeRequestedAt,
      reviewedAt: advocate.officeChangeReviewedAt,
      rejectionReason: advocate.officeChangeRejectionReason,
      requested: advocate.pendingOfficeChange ? (() => {
        const { officePhotoPublicId: _oppId, ...safePending } = advocate.pendingOfficeChange;
        return safePending;
      })() : null
    } : null;

    return res.status(200).json({
      success: true,
      advocate: {
        ...safeAdvocate,
        ...officeDetails,
        officeChange,
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
      'completeAddress', 'offlineVisitingFee', 'casesHandled',
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
/**
 * Request office details change for advocate (PUT /api/advocate/profile/office).
 * - Non-approved advocate: applied directly to live fields.
 * - Approved advocate: sent for admin approval via pendingOfficeChange.
 */
export const requestOfficeChange = async (req, res, next) => {
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

    const validated = advocateOfficeChangeSchema.parse(req.body);

    const advocate = await prisma.advocate.findUnique({
      where: { id: req.user.id }
    });

    if (!advocate) {
      return res.status(404).json({
        success: false,
        message: 'Advocate profile not found.'
      });
    }

    // Upload new live office photo to Cloudinary
    const { url, publicId } = await uploadBufferToCloudinary(req.file.buffer);

    try {
      if (advocate.approvalStatus !== 'APPROVED') {
        // Non-approved advocate (draft / PENDING / REJECTED): apply directly to live fields
        const oldPublicId = advocate.officePhotoPublicId;

        const updatedAdvocate = await prisma.advocate.update({
          where: { id: req.user.id },
          data: {
            officeAddress: validated.officeAddress,
            officePhotoUrl: url,
            officePhotoPublicId: publicId,
            officeLatitude: validated.officeLatitude,
            officeLongitude: validated.officeLongitude,
            latitude: validated.officeLatitude,
            longitude: validated.officeLongitude,
            city: validated.city,
            state: validated.state,
            pincode: validated.pincode,
            officeLocationUpdatedAt: new Date()
          }
        });

        // Delete old live photo after DB commit
        if (oldPublicId) {
          await deleteFromCloudinary(oldPublicId).catch(() => {});
        }

        const { passwordHash, aadhaarNumber, officePhotoPublicId: _opId, pendingOfficeChange: _poc, ...safeAdvocate } = updatedAdvocate;
        const officeDetails = formatOfficeDetails(updatedAdvocate);

        return res.status(200).json({
          success: true,
          message: 'Office details updated.',
          office: officeDetails.office,
          advocate: {
            ...safeAdvocate,
            ...officeDetails,
            type: 'advocate'
          }
        });
      } else {
        // Approved advocate: save to pendingOfficeChange for admin approval
        const oldPendingPublicId = advocate.pendingOfficeChange?.officePhotoPublicId;

        const requestedAt = new Date();
        const pendingData = {
          officeAddress: validated.officeAddress,
          pincode: validated.pincode,
          city: validated.city,
          state: validated.state,
          officeLatitude: validated.officeLatitude,
          officeLongitude: validated.officeLongitude,
          officePhotoUrl: url,
          officePhotoPublicId: publicId
        };

        await prisma.advocate.update({
          where: { id: req.user.id },
          data: {
            pendingOfficeChange: pendingData,
            officeChangeStatus: 'PENDING',
            officeChangeRequestedAt: requestedAt,
            officeChangeRejectionReason: null
          }
        });

        // Delete previous pending photo if one existed
        if (oldPendingPublicId) {
          await deleteFromCloudinary(oldPendingPublicId).catch(() => {});
        }

        const { officePhotoPublicId: _pId, ...safeRequested } = pendingData;

        return res.status(200).json({
          success: true,
          message: 'Office change sent for admin approval.',
          officeChange: {
            status: 'PENDING',
            requestedAt: requestedAt.toISOString(),
            requested: safeRequested
          }
        });
      }
    } catch (dbError) {
      // Clean up newly uploaded image from Cloudinary if DB update failed
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

