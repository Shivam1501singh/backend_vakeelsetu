import prisma from '../lib/prisma.js';
import { createOtp, verifyOtp } from './otp.service.js';
import { sendEmailOtp } from './email.service.js';
import { sendOtpSms } from './sms.service.js';
import { finalizeUserDeletion } from './accountDeletion.service.js';
import { finalizeAdvocateDeletion } from './advocateDeletion.service.js';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from '../utils/crypto.js';
import { initiateAadhaarDigiLocker, fetchAadhaarDetails } from './idspay.service.js';
import * as aadhaarOtp from './aadhaarOtp/index.js';
import { uploadBufferToCloudinary, deleteFromCloudinary } from './cloudinary.service.js';

// Cooldown map for Aadhaar OTP generation (60 seconds per registration session)
const aadhaarOtpCooldowns = new Map();

// Helper to check duplicates in both tables
export const checkDuplicateEmail = async (email) => {
  const normalizedEmail = email.toLowerCase().trim();
  const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  const existingAdvocate = await prisma.advocate.findUnique({ where: { email: normalizedEmail } });

  if (existingUser) {
    throw new Error('An account with this email already exists as a User.');
  }
  if (existingAdvocate) {
    throw new Error('An account with this email already exists as an Advocate.');
  }
};

export const checkDuplicatePhone = async (phone) => {
  const cleanPhone = phone.trim();
  const existingUser = await prisma.user.findUnique({ where: { phone: cleanPhone } });
  const existingAdvocate = await prisma.advocate.findUnique({ where: { phone: cleanPhone } });

  if (existingUser) {
    throw new Error('An account with this phone number already exists as a User.');
  }
  if (existingAdvocate) {
    throw new Error('An account with this phone number already exists as an Advocate.');
  }
};

export const checkDuplicateBarCouncilId = async (barCouncilId) => {
  const cleanId = barCouncilId.trim();
  const existingAdvocate = await prisma.advocate.findUnique({ where: { barCouncilId: cleanId } });
  if (existingAdvocate) {
    throw new Error('An account with this Bar Council ID already exists.');
  }
};

export const checkDuplicateAadhaarNumber = async (aadhaarNumber) => {
  if (!aadhaarNumber) return;
  const cleanAadhaar = aadhaarNumber.replace(/\s/g, '');
  if (!cleanAadhaar) return;

  const existingAdv = await prisma.advocate.findFirst({
    where: { aadhaarNumber: cleanAadhaar }
  });
  if (existingAdv) {
    throw new Error('An account with this Aadhaar number already exists.');
  }

  // Handle legacy encrypted records
  const legacyRecords = await prisma.advocate.findMany({
    where: { aadhaarNumber: { contains: ':' } },
    select: { id: true, aadhaarNumber: true }
  });
  for (const rec of legacyRecords) {
    if (rec.aadhaarNumber && decrypt(rec.aadhaarNumber) === cleanAadhaar) {
      throw new Error('An account with this Aadhaar number already exists.');
    }
  }
};

// 1. Start Registration Session
export const startRegistration = async ({ fullName, email, emailVerified, accountType, profilePhotoUrl, profilePhotoPublicId, gender, registrationId }) => {
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
  const normalizedEmail = email ? email.toLowerCase().trim() : undefined;
  
  if (registrationId) {
    return await prisma.registrationSession.update({
      where: { id: registrationId },
      data: {
        fullName: fullName.trim(),
        email: normalizedEmail,
        emailVerified: emailVerified !== undefined ? emailVerified : undefined,
        profilePhotoUrl,
        profilePhotoPublicId,
        gender,
        expiresAt
      }
    });
  }

  return await prisma.registrationSession.create({
    data: {
      fullName: fullName.trim(),
      email: normalizedEmail,
      emailVerified: emailVerified !== undefined ? emailVerified : false,
      accountType,
      expiresAt,
      profilePhotoUrl,
      profilePhotoPublicId,
      gender
    }
  });
};

// Get Session Helper
const getValidSession = async (registrationId) => {
  const session = await prisma.registrationSession.findUnique({
    where: { id: registrationId }
  });

  if (!session) {
    throw new Error('Registration session not found. Please start again.');
  }

  if (new Date() > new Date(session.expiresAt)) {
    // Delete expired session
    await prisma.registrationSession.delete({ where: { id: registrationId } }).catch(() => {});
    throw new Error('Registration session has expired. Please start again.');
  }

  return session;
};

export const getCurrentRegistrationSession = async (registrationId) => {
  const session = await getValidSession(registrationId);
  return {
    id: session.id,
    fullName: session.fullName,
    email: session.email,
    emailVerified: session.emailVerified,
    phone: session.phone,
    phoneVerified: session.phoneVerified,
    profilePhotoUrl: session.profilePhotoUrl,
    profilePhotoPublicId: session.profilePhotoPublicId,
    gender: session.gender,
    accountType: session.accountType,
    aadhaarVerified: session.aadhaarVerified,
    aadhaarVerificationAttempts: session.aadhaarVerificationAttempts,
    aadhaarBlockedUntil: session.aadhaarBlockedUntil,
    aadhaarVerificationId: session.aadhaarVerificationId,
    aadhaarVerifiedAt: session.aadhaarVerifiedAt,
    aadhaarNumber: session.aadhaarNumber ? (session.aadhaarNumber.includes(':') ? (decrypt(session.aadhaarNumber) || session.aadhaarNumber) : session.aadhaarNumber) : null,
    city: session.city,
    state: session.state,
    pincode: session.pincode,
    officeAddress: session.officeAddress,
    officePhotoUrl: session.officePhotoUrl,
    officeLatitude: session.officeLatitude,
    officeLongitude: session.officeLongitude
  };
};

// 2. Send Email OTP
export const sendEmailOtpForRegistration = async ({ registrationId, email }) => {
  const session = await getValidSession(registrationId);
  const normalizedEmail = email.toLowerCase().trim();

  // Check email duplicates in both tables
  await checkDuplicateEmail(normalizedEmail);

  // Generate & save Email OTP
  const { plainOtp } = await createOtp({
    registrationId,
    accountType: session.accountType,
    purpose: 'EMAIL_VERIFICATION',
    target: normalizedEmail
  });

  // Update session email
  await prisma.registrationSession.update({
    where: { id: registrationId },
    data: { email: normalizedEmail }
  });

  // Send the OTP
  await sendEmailOtp(normalizedEmail, plainOtp);
  return true;
};

// 3. Verify Email OTP
export const verifyEmailOtpForRegistration = async ({ registrationId, otp }) => {
  const session = await getValidSession(registrationId);
  if (!session.email) {
    throw new Error('No email associated with this session.');
  }

  await verifyOtp({
    registrationId,
    target: session.email,
    purpose: 'EMAIL_VERIFICATION',
    otp
  });

  await prisma.registrationSession.update({
    where: { id: registrationId },
    data: { emailVerified: true }
  });

  return true;
};

// 4. Complete Profile Details (Used for USER flow)
export const completeProfileForRegistration = async ({ registrationId, city, state, pincode, latitude, longitude }) => {
  const session = await getValidSession(registrationId);

  if (!session.emailVerified) {
    throw new Error('Please verify your email address before completing your profile.');
  }

  if (!session.phoneVerified || !session.phone) {
    throw new Error('Please verify your phone number before adding your address.');
  }

  return await prisma.$transaction(async (tx) => {
    const normalizedEmail = session.email.toLowerCase().trim();
    const cleanPhone = session.phone.trim();

    const emailUser = await tx.user.findUnique({ where: { email: normalizedEmail } });
    const emailAdv = await tx.advocate.findUnique({ where: { email: normalizedEmail } });
    if (emailUser || emailAdv) {
      throw new Error('An account with this email was registered in another session.');
    }

    const phoneUser = await tx.user.findUnique({ where: { phone: cleanPhone } });
    const phoneAdv = await tx.advocate.findUnique({ where: { phone: cleanPhone } });
    if (phoneUser || phoneAdv) {
      throw new Error('An account with this phone number was registered in another session.');
    }

    const createdAccount = await tx.user.create({
      data: {
        fullName: session.fullName,
        email: normalizedEmail,
        phone: cleanPhone,
        city: city.trim(),
        state: state.trim(),
        pincode: pincode.trim(),
        emailVerified: true,
        phoneVerified: true,
        isActive: true,
        latitude: latitude !== undefined && latitude !== null ? parseFloat(latitude) : null,
        longitude: longitude !== undefined && longitude !== null ? parseFloat(longitude) : null
      }
    });

    // Delete registration session (cascade deletes OTP records associated with it)
    await tx.registrationSession.delete({
      where: { id: session.id }
    });

    return createdAccount;
  });
};

// 4b. Save Address and Office Details for Advocate Registration Session (Multipart)
export const saveAdvocateRegistrationOfficeDetails = async ({
  registrationId,
  pincode,
  city,
  state,
  officeAddress,
  officeLatitude,
  officeLongitude,
  file
}) => {
  const session = await getValidSession(registrationId);

  if (session.accountType !== 'ADVOCATE') {
    const err = new Error('Invalid account type for this operation.');
    err.statusCode = 400;
    throw err;
  }

  if (!session.emailVerified) {
    const err = new Error('Please verify your email address before saving address and office details.');
    err.statusCode = 400;
    throw err;
  }

  if (!session.phoneVerified) {
    const err = new Error('Please verify your phone number before saving address and office details.');
    err.statusCode = 400;
    throw err;
  }

  // Photo is required on first save; optional on subsequent update if session already has a photo
  if (!file && (!session.officePhotoUrl || !session.officePhotoUrl.trim())) {
    const err = new Error('Office photo is required.');
    err.statusCode = 400;
    throw err;
  }

  let photoUrl = session.officePhotoUrl;
  let photoPublicId = session.officePhotoPublicId;
  let oldPublicIdToDelete = null;

  if (file) {
    const uploaded = await uploadBufferToCloudinary(file.buffer);
    photoUrl = uploaded.url;
    if (session.officePhotoPublicId) {
      oldPublicIdToDelete = session.officePhotoPublicId;
    }
    photoPublicId = uploaded.publicId;
  }

  try {
    const lat = typeof officeLatitude === 'number' ? officeLatitude : parseFloat(officeLatitude);
    const lng = typeof officeLongitude === 'number' ? officeLongitude : parseFloat(officeLongitude);

    const updated = await prisma.registrationSession.update({
      where: { id: session.id },
      data: {
        officeAddress: officeAddress.trim(),
        officePhotoUrl: photoUrl,
        officePhotoPublicId: photoPublicId,
        officeLatitude: lat,
        officeLongitude: lng,
        latitude: lat,
        longitude: lng,
        city: city.trim(),
        state: state.trim(),
        pincode: pincode.trim()
      }
    });

    if (oldPublicIdToDelete) {
      await deleteFromCloudinary(oldPublicIdToDelete).catch(() => {});
    }

    return {
      officeAddress: updated.officeAddress,
      officePhotoUrl: updated.officePhotoUrl,
      officeLatitude: updated.officeLatitude,
      officeLongitude: updated.officeLongitude,
      city: updated.city,
      state: updated.state,
      pincode: updated.pincode
    };
  } catch (dbError) {
    if (file && photoPublicId) {
      await deleteFromCloudinary(photoPublicId).catch(() => {});
    }
    throw dbError;
  }
};

// 5. Send Phone OTP
export const sendPhoneOtpForRegistration = async ({ registrationId, phone }) => {
  const session = await getValidSession(registrationId);

  if (!session.emailVerified) {
    throw new Error('Email must be verified first.');
  }

  const cleanPhone = phone ? phone.trim() : session.phone;
  if (!cleanPhone) {
    throw new Error('Phone number is missing.');
  }

  await checkDuplicatePhone(cleanPhone);

  // If a phone is provided explicitly, update it in session
  if (phone) {
    await prisma.registrationSession.update({
      where: { id: registrationId },
      data: { phone: cleanPhone }
    });
  }

  const { plainOtp, expiryMinutes } = await createOtp({
    registrationId,
    accountType: session.accountType,
    purpose: 'PHONE_VERIFICATION',
    target: cleanPhone
  });

  await sendOtpSms({
    mobile: cleanPhone,
    otp: plainOtp,
    expiryMinutes
  });

  return true;
};

// 6. Verify Phone OTP
export const verifyPhoneOtpForRegistration = async ({ registrationId, otp }) => {
  const session = await getValidSession(registrationId);

  if (!session.emailVerified) {
    throw new Error('Email must be verified.');
  }
  if (!session.phone) {
    throw new Error('Phone number is missing.');
  }

  // Verify OTP
  await verifyOtp({
    registrationId,
    target: session.phone,
    purpose: 'PHONE_VERIFICATION',
    otp
  });

  // Mark phone as verified in registration session
  await prisma.registrationSession.update({
    where: { id: registrationId },
    data: { phoneVerified: true }
  });

  return true;
};

// 6b. Finalize Advocate Registration
export const completeAdvocateRegistration = async ({
  registrationId,
  barCouncilId,
  aadhaarNumber,
  password,
  languagesSpoken,
  state,
  city,
  pincode,
  latitude,
  longitude,
  about = null
}) => {
  const session = await getValidSession(registrationId);

  if (session.accountType !== 'ADVOCATE') {
    throw new Error('Invalid account type for this operation.');
  }

  if (!session.emailVerified) {
    throw new Error('Email must be verified.');
  }

  if (!session.phoneVerified) {
    throw new Error('Phone must be verified.');
  }

  if (!session.profilePhotoUrl) {
    throw new Error('Profile photo must be uploaded.');
  }

  if (!session.aadhaarVerified) {
    throw new Error('Aadhaar verification is required to complete profile.');
  }

  // Office details required from registration address step
  const missingOfficeFields = [];
  if (!session.officeAddress || !session.officeAddress.trim()) {
    missingOfficeFields.push('officeAddress');
  }
  if (!session.officePhotoUrl || !session.officePhotoUrl.trim()) {
    missingOfficeFields.push('officePhoto');
  }
  if (
    session.officeLatitude === null || session.officeLatitude === undefined ||
    session.officeLongitude === null || session.officeLongitude === undefined
  ) {
    missingOfficeFields.push('officeLocation');
  }
  if (missingOfficeFields.length > 0) {
    const err = new Error('Please complete your address and office details.');
    err.statusCode = 400;
    err.missingFields = missingOfficeFields;
    throw err;
  }

  const cleanBarCouncilId = barCouncilId.trim();
  const cleanAadhaar = aadhaarNumber.replace(/\s/g, ''); // Strip spaces

  // Check unique constraints
  await checkDuplicateBarCouncilId(cleanBarCouncilId);
  await checkDuplicateAadhaarNumber(cleanAadhaar);
  const normalizedEmail = session.email.toLowerCase().trim();
  const cleanPhone = session.phone.trim();
  await checkDuplicateEmail(normalizedEmail);
  await checkDuplicatePhone(cleanPhone);

  // Hash password
  const passwordHash = await bcrypt.hash(password, 10);

  // Create Advocate and delete session in transaction
  return await prisma.$transaction(async (tx) => {
    // Check duplicates again to prevent race conditions
    const emailUser = await tx.user.findUnique({ where: { email: normalizedEmail } });
    const emailAdv = await tx.advocate.findUnique({ where: { email: normalizedEmail } });
    if (emailUser || emailAdv) {
      throw new Error('An account with this email was registered in another session.');
    }

    const phoneUser = await tx.user.findUnique({ where: { phone: cleanPhone } });
    const phoneAdv = await tx.advocate.findUnique({ where: { phone: cleanPhone } });
    if (phoneUser || phoneAdv) {
      throw new Error('An account with this phone number was registered in another session.');
    }

    const barAdv = await tx.advocate.findUnique({ where: { barCouncilId: cleanBarCouncilId } });
    if (barAdv) {
      throw new Error('Bar Council ID already registered.');
    }

    const finalState = session.state || (state ? state.trim() : '');
    const finalCity = session.city || (city ? city.trim() : '');
    const finalPincode = session.pincode || (pincode ? pincode.trim() : null);

    const createdAdvocate = await tx.advocate.create({
      data: {
        fullName: session.fullName,
        email: normalizedEmail,
        phone: cleanPhone,
        profilePhotoUrl: session.profilePhotoUrl,
        profilePhotoPublicId: session.profilePhotoPublicId,
        gender: session.gender,
        barCouncilId: cleanBarCouncilId,
        aadhaarNumber: cleanAadhaar,
        passwordHash,
        languagesSpoken,
        state: finalState,
        city: finalCity,
        pincode: finalPincode,
        emailVerified: true,
        phoneVerified: true,
        isActive: true,
        latitude: session.officeLatitude,
        longitude: session.officeLongitude,
        officeAddress: session.officeAddress,
        officePhotoUrl: session.officePhotoUrl,
        officePhotoPublicId: session.officePhotoPublicId,
        officeLatitude: session.officeLatitude,
        officeLongitude: session.officeLongitude,
        officeLocationUpdatedAt: new Date(),
        about: about ? about.trim() : null,
        aadhaarVerified: session.aadhaarVerified,
        aadhaarVerificationId: session.aadhaarVerificationId,
        aadhaarVerifiedAt: session.aadhaarVerifiedAt,
        aadhaarVerificationAttempts: session.aadhaarVerificationAttempts,
        aadhaarBlockedUntil: session.aadhaarBlockedUntil,
        aadhaarVerificationMethod: session.aadhaarVerificationMethod
      }
    });

    // Delete registration session (does not delete Cloudinary office photo, which now belongs to the advocate)
    await tx.registrationSession.delete({
      where: { id: session.id }
    });

    return createdAdvocate;
  });
};


// 7. Login: Send Phone OTP
export const sendLoginOtpService = async ({ phone, accountType }) => {
  const cleanPhone = phone.trim();
  let account;

  if (accountType === 'USER') {
    account = await prisma.user.findUnique({ where: { phone: cleanPhone } });
  } else {
    account = await prisma.advocate.findUnique({ where: { phone: cleanPhone } });
  }

  if (!account) {
    throw new Error('Account not found. Please create an account first.');
  }

  if (!account.isActive) {
    throw new Error('Your account is deactivated. Please contact support.');
  }

  // Generate & save login OTP
  const { plainOtp, expiryMinutes } = await createOtp({
    registrationId: null,
    accountType,
    purpose: 'LOGIN',
    target: cleanPhone
  });

  await sendOtpSms({
    mobile: cleanPhone,
    otp: plainOtp,
    expiryMinutes
  });

  return true;
};

// 8. Login: Verify OTP
export const verifyLoginOtpService = async ({ phone, accountType, otp }) => {
  const cleanPhone = phone.trim();
  let account;

  if (accountType === 'USER') {
    account = await prisma.user.findUnique({ where: { phone: cleanPhone } });
  } else {
    account = await prisma.advocate.findUnique({ where: { phone: cleanPhone } });
  }

  if (!account) {
    throw new Error('Account not found.');
  }

  if (accountType === 'USER' && account.status === 'DELETION_PENDING') {
    if (account.scheduledDeletionAt && new Date(account.scheduledDeletionAt) <= new Date()) {
      await finalizeUserDeletion(account.id);
      const err = new Error('This account has been deleted.');
      err.statusCode = 400;
      throw err;
    }
  }

  if (accountType === 'ADVOCATE' && account.deletionStatus === 'PENDING') {
    if (account.scheduledDeletionAt && new Date(account.scheduledDeletionAt) <= new Date()) {
      await finalizeAdvocateDeletion(account.id);
      const err = new Error('This Advocate account has been deleted.');
      err.statusCode = 400;
      throw err;
    }
  }

  if (!account.isActive) {
    throw new Error('Account is deactivated.');
  }

  await verifyOtp({
    registrationId: null,
    target: cleanPhone,
    purpose: 'LOGIN',
    otp
  });

  if (accountType === 'USER' && account.status === 'DELETION_PENDING') {
    account = await prisma.user.update({
      where: { id: account.id },
      data: {
        status: 'ACTIVE',
        deletionRequestedAt: null,
        scheduledDeletionAt: null
      }
    });
    account.deletionCancelled = true;
  }

  if (accountType === 'ADVOCATE') {
    const updateData = {
      isOnline: true,
      lastSeenAt: new Date()
    };
    if (account.deletionStatus === 'PENDING') {
      updateData.deletionStatus = 'NONE';
      updateData.deletionRequestedAt = null;
      updateData.scheduledDeletionAt = null;
      account.deletionCancelled = true;
    }
    account = await prisma.advocate.update({
      where: { id: account.id },
      data: updateData
    });
  }

  return account;
};

// 8b. Login: Send Email OTP
export const sendLoginEmailOtpService = async ({ email, accountType }) => {
  const normalizedEmail = email.toLowerCase().trim();
  let account;

  if (accountType === 'USER') {
    account = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  } else {
    account = await prisma.advocate.findUnique({ where: { email: normalizedEmail } });
  }

  if (!account) {
    if (accountType === 'USER') {
      throw new Error('Account not found. Please create an account first.');
    } else {
      throw new Error('Account not found. Please create an advocate account first.');
    }
  }

  if (!account.isActive) {
    throw new Error('Account is not active. Please complete registration.');
  }

  // Generate & save login Email OTP
  const { plainOtp } = await createOtp({
    registrationId: null,
    accountType,
    purpose: 'LOGIN',
    target: normalizedEmail
  });

  await sendEmailOtp(normalizedEmail, plainOtp);
  return true;
};

// 8c. Login: Verify Email OTP
export const verifyLoginEmailOtpService = async ({ email, accountType, otp }) => {
  const normalizedEmail = email.toLowerCase().trim();
  let account;

  if (accountType === 'USER') {
    account = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  } else {
    account = await prisma.advocate.findUnique({ where: { email: normalizedEmail } });
  }

  if (!account) {
    throw new Error('Account not found.');
  }

  if (accountType === 'USER' && account.status === 'DELETION_PENDING') {
    if (account.scheduledDeletionAt && new Date(account.scheduledDeletionAt) <= new Date()) {
      await finalizeUserDeletion(account.id);
      const err = new Error('This account has been deleted.');
      err.statusCode = 400;
      throw err;
    }
  }

  if (accountType === 'ADVOCATE' && account.deletionStatus === 'PENDING') {
    if (account.scheduledDeletionAt && new Date(account.scheduledDeletionAt) <= new Date()) {
      await finalizeAdvocateDeletion(account.id);
      const err = new Error('This Advocate account has been deleted.');
      err.statusCode = 400;
      throw err;
    }
  }

  if (!account.isActive) {
    throw new Error('Account is deactivated.');
  }

  await verifyOtp({
    registrationId: null,
    target: normalizedEmail,
    purpose: 'LOGIN',
    otp
  });

  if (accountType === 'USER' && account.status === 'DELETION_PENDING') {
    account = await prisma.user.update({
      where: { id: account.id },
      data: {
        status: 'ACTIVE',
        deletionRequestedAt: null,
        scheduledDeletionAt: null
      }
    });
    account.deletionCancelled = true;
  }

  if (accountType === 'ADVOCATE') {
    const updateData = {
      isOnline: true,
      lastSeenAt: new Date()
    };
    if (account.deletionStatus === 'PENDING') {
      updateData.deletionStatus = 'NONE';
      updateData.deletionRequestedAt = null;
      updateData.scheduledDeletionAt = null;
      account.deletionCancelled = true;
    }
    account = await prisma.advocate.update({
      where: { id: account.id },
      data: updateData
    });
  }

  return account;
};

// 8d. Login: Verify Advocate Email & Password
export const verifyEmailPasswordLoginService = async ({ email, password }) => {
  const normalizedEmail = email.toLowerCase().trim();
  let advocate = await prisma.advocate.findUnique({
    where: { email: normalizedEmail }
  });

  if (!advocate) {
    throw new Error('Invalid email or password');
  }

  if (advocate.deletionStatus === 'PENDING') {
    if (advocate.scheduledDeletionAt && new Date(advocate.scheduledDeletionAt) <= new Date()) {
      await finalizeAdvocateDeletion(advocate.id);
      const err = new Error('This Advocate account has been deleted.');
      err.statusCode = 400;
      throw err;
    }
  }

  if (!advocate.isActive) {
    throw new Error('Invalid email or password');
  }

  const isMatch = await bcrypt.compare(password, advocate.passwordHash);
  if (!isMatch) {
    throw new Error('Invalid email or password');
  }

  const updateData = {
    isOnline: true,
    lastSeenAt: new Date()
  };
  if (advocate.deletionStatus === 'PENDING') {
    updateData.deletionStatus = 'NONE';
    updateData.deletionRequestedAt = null;
    updateData.scheduledDeletionAt = null;
    advocate.deletionCancelled = true;
  }
  advocate = await prisma.advocate.update({
    where: { id: advocate.id },
    data: updateData
  });

  return advocate;
};

// 9. Get Current User profile
export const getCurrentUserProfile = async (id, accountType) => {
  let profile = null;
  const normalizedType = (accountType || '').toLowerCase();

  if (normalizedType === 'admin') {
    return {
      id: id || 'admin',
      fullName: 'System Administrator',
      email: process.env.ADMIN_USER_EMAIL || 'admin@vakeelsetu.com',
      type: 'admin',
      role: 'ADMIN',
      roles: ['ADMIN'],
      permissions: ['*']
    };
  }

  if (normalizedType === 'user') {
    profile = await prisma.user.findUnique({ where: { id } });
  } else if (normalizedType === 'advocate') {
    profile = await prisma.advocate.findUnique({
      where: { id }
    });
  } else if (normalizedType === 'content_creator') {
    profile = await prisma.contentCreator.findUnique({
      where: { id }
    });
  }

  if (!profile || !profile.isActive) {
    return null;
  }

  if (normalizedType === 'user') {
    return {
      id: profile.id,
      fullName: profile.fullName,
      email: profile.email,
      phone: profile.phone,
      city: profile.city,
      state: profile.state,
      pincode: profile.pincode,
      status: profile.status,
      type: 'user',
      role: 'USER',
      roles: ['USER'],
      permissions: []
    };
  } else if (normalizedType === 'content_creator') {
    let assignedRoles = [];
    let assignedPermissions = [];

    try {
      const userRoles = await prisma.userRole.findMany({
        where: { userId: profile.id, role: { isActive: true } },
        include: {
          role: {
            include: {
              permissions: {
                include: {
                  permission: true
                }
              }
            }
          }
        }
      });

      assignedRoles = userRoles.map((ur) => ur.role.name);
      const permSet = new Set();
      userRoles.forEach((ur) => {
        ur.role.permissions.forEach((rp) => {
          if (rp.permission && !permSet.has(rp.permission.code)) {
            permSet.add(rp.permission.code);
            assignedPermissions.push(rp.permission.code);
          }
        });
      });
    } catch (err) {
      console.error('Error fetching RBAC permissions in getCurrentUserProfile:', err);
    }

    const creatorRoles = assignedRoles.length > 0 ? assignedRoles : ['CONTENT_CREATOR'];
    return {
      id: profile.id,
      fullName: profile.fullName,
      email: profile.email,
      type: 'content_creator',
      role: 'CONTENT_CREATOR',
      roles: creatorRoles,
      permissions: assignedPermissions
    };
  } else {
    return {
      id: profile.id,
      fullName: profile.fullName,
      email: profile.email,
      phone: profile.phone,
      profilePhotoUrl: profile.profilePhotoUrl,
      gender: profile.gender,
      barCouncilId: profile.barCouncilId,
      languagesSpoken: profile.languagesSpoken,
      state: profile.state,
      city: profile.city,
      pincode: profile.pincode,
      type: 'advocate',
      role: 'ADVOCATE',
      experienceYears: profile.experienceYears,
      casesHandled: profile.casesHandled,
      practiceAreas: profile.practiceAreas,
      topCourtPractised: profile.topCourtPractised,
      bestPracticeArea: profile.bestPracticeArea,
      about: profile.about,
      courtPractice: profile.courtPractice,
      // TODO: remove fallback after backfill-office-address --apply
      officeAddress: profile.officeAddress || profile.completeAddress || null,
      videoCallChargePerMinute: profile.videoCallChargePerMinute !== null ? Number(profile.videoCallChargePerMinute) : null,
      voiceCallChargePerMinute: profile.voiceCallChargePerMinute !== null ? Number(profile.voiceCallChargePerMinute) : null,
      offlineVisitingFee: profile.offlineVisitingFee !== null ? Number(profile.offlineVisitingFee) : null,
      status: profile.status,
      approvalStatus: profile.approvalStatus,
      callAvailability: profile.callAvailability ?? false,
      deletionStatus: profile.deletionStatus,
      deletionRequestedAt: profile.deletionRequestedAt,
      scheduledDeletionAt: profile.scheduledDeletionAt
    };
  }
};

// Aadhaar Initiate Verification service
export const initiateAadhaarVerificationService = async ({ registrationId, aadhaarNumber }) => {
  const session = await getValidSession(registrationId);

  if (session.accountType !== 'ADVOCATE') {
    const err = new Error('Invalid account type for this operation.');
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();

  // Check if currently blocked
  if (session.aadhaarBlockedUntil && now < new Date(session.aadhaarBlockedUntil)) {
    const err = new Error('Aadhaar verification is temporarily blocked. Please try again after 24 hours.');
    err.statusCode = 403;
    err.blocked = true;
    err.blockedUntil = session.aadhaarBlockedUntil;
    throw err;
  }

  // Lazy unblock if 24 hours have passed
  if (session.aadhaarBlockedUntil && now >= new Date(session.aadhaarBlockedUntil)) {
    await prisma.registrationSession.update({
      where: { id: registrationId },
      data: {
        aadhaarVerificationAttempts: 0,
        aadhaarBlockedUntil: null
      }
    });
    session.aadhaarVerificationAttempts = 0;
    session.aadhaarBlockedUntil = null;
  }

  // Check if already verified
  if (session.aadhaarVerified) {
    return {
      success: true,
      aadhaarVerified: true,
      message: 'Aadhaar already verified.'
    };
  }

  // Validate format
  const cleanAadhaar = aadhaarNumber.replace(/\s/g, '');
  if (!/^\d{12}$/.test(cleanAadhaar)) {
    // Malformed input: count it as a failed attempt to prevent bypass
    const newAttempts = session.aadhaarVerificationAttempts + 1;
    const isBlocked = newAttempts >= 3;
    const blockedUntil = isBlocked ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : null;

    await prisma.registrationSession.update({
      where: { id: registrationId },
      data: {
        aadhaarVerificationAttempts: newAttempts,
        aadhaarBlockedUntil: blockedUntil
      }
    });

    const err = new Error('Aadhaar number must be exactly 12 digits.');
    err.statusCode = 400;
    err.remainingAttempts = Math.max(0, 3 - newAttempts);
    err.blocked = isBlocked;
    err.blockedUntil = blockedUntil;
    throw err;
  }

  // Call IDSPay initiation
  const response = await initiateAadhaarDigiLocker(cleanAadhaar, registrationId);

  const statusType = response && typeof response.status === 'object' ? response.status?.type : response?.status;
  const isInitiateSuccess = response && 
                            (String(statusType || '').toLowerCase() === 'success' || response.status?.code === 200) && 
                            response.data && 
                            response.data.client_id;

  if (isInitiateSuccess) {
    // Save to session database
    await prisma.registrationSession.update({
      where: { id: registrationId },
      data: {
        aadhaarNumber: cleanAadhaar,
        aadhaarVerificationId: response.data.client_id,
        aadhaarVerificationMethod: 'DIGILOCKER'
      }
    });

    return {
      success: true,
      clientId: response.data.client_id,
      url: response.data.url
    };
  } else {
    // Technical failure - do NOT count as a failed attempt
    const errorMsg = (typeof response?.status === 'object' ? response?.status?.message : null) || response?.message || 'Failed to initiate DigiLocker verification with provider.';
    const err = new Error(errorMsg);
    err.statusCode = 502;
    throw err;
  }
};

// Aadhaar Verify Status service
export const verifyAadhaarStatusService = async ({ registrationId, clientId }) => {
  const session = await getValidSession(registrationId);

  if (session.accountType !== 'ADVOCATE') {
    const err = new Error('Invalid account type for this operation.');
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();

  // Check if currently blocked
  if (session.aadhaarBlockedUntil && now < new Date(session.aadhaarBlockedUntil)) {
    const err = new Error('Aadhaar verification is temporarily blocked. Please try again after 24 hours.');
    err.statusCode = 403;
    err.blocked = true;
    err.blockedUntil = session.aadhaarBlockedUntil;
    throw err;
  }

  // Call IDSPay status check
  const response = await fetchAadhaarDetails(clientId);

  const statusType = response && typeof response.status === 'object' ? response.status?.type : response?.status;
  const statusStr = String(statusType || '').toLowerCase();
  const statusCode = response?.status?.code;
  const dataStatus = response?.data ? String(response.data.status || response.data.verification_status || '').toLowerCase() : '';

  const isSuccess = (statusStr === 'success' || statusCode === 200) && 
                     (dataStatus === 'success' || dataStatus === 'success_verified' || dataStatus === 'verified' || dataStatus === 'completed' || dataStatus === 'success_kyc' || dataStatus === 'approved' || dataStatus === '');

  if (isSuccess) {
    await prisma.registrationSession.update({
      where: { id: registrationId },
      data: {
        aadhaarVerified: true,
        aadhaarVerificationId: clientId,
        aadhaarVerifiedAt: now,
        aadhaarVerificationAttempts: 0,
        aadhaarBlockedUntil: null
      }
    });

    return {
      success: true,
      aadhaarVerified: true,
      message: 'Aadhaar verified successfully.'
    };
  } else {
    // Update attempts
    const newAttempts = session.aadhaarVerificationAttempts + 1;
    const isBlocked = newAttempts >= 3;
    const blockedUntil = isBlocked ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : null;

    await prisma.registrationSession.update({
      where: { id: registrationId },
      data: {
        aadhaarVerified: false,
        aadhaarVerifiedAt: null,
        aadhaarVerificationAttempts: newAttempts,
        aadhaarBlockedUntil: blockedUntil
      }
    });

    const errorMsg = (typeof response?.status === 'object' ? response?.status?.message : null) || response?.message || 'Aadhaar verification failed.';
    const err = new Error(errorMsg);
    err.statusCode = 400;
    err.remainingAttempts = Math.max(0, 3 - newAttempts);
    err.blocked = isBlocked;
    err.blockedUntil = blockedUntil;
    throw err;
  }
};

// Aadhaar OTP Generate service
export const generateAadhaarOtpService = async ({ registrationId, aadhaarNumber }) => {
  const session = await getValidSession(registrationId);

  if (session.accountType !== 'ADVOCATE') {
    const err = new Error('Invalid account type for this operation.');
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();

  // Check if currently blocked
  if (session.aadhaarBlockedUntil && now < new Date(session.aadhaarBlockedUntil)) {
    const err = new Error('Aadhaar verification is temporarily blocked. Please try again after 24 hours.');
    err.statusCode = 403;
    err.blocked = true;
    err.blockedUntil = session.aadhaarBlockedUntil;
    throw err;
  }

  // Lazy unblock if 24 hours have passed
  if (session.aadhaarBlockedUntil && now >= new Date(session.aadhaarBlockedUntil)) {
    await prisma.registrationSession.update({
      where: { id: registrationId },
      data: {
        aadhaarVerificationAttempts: 0,
        aadhaarBlockedUntil: null
      }
    });
    session.aadhaarVerificationAttempts = 0;
    session.aadhaarBlockedUntil = null;
  }

  // Already verified?
  if (session.aadhaarVerified) {
    return {
      success: true,
      aadhaarVerified: true,
      message: 'Aadhaar already verified.'
    };
  }

  // 60-second resend cooldown per registration session
  const COOLDOWN_MS = 60 * 1000;
  const lastGeneratedAt = aadhaarOtpCooldowns.get(registrationId);
  if (lastGeneratedAt && (now.getTime() - lastGeneratedAt) < COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((COOLDOWN_MS - (now.getTime() - lastGeneratedAt)) / 1000);
    const err = new Error('Please wait before requesting another OTP.');
    err.statusCode = 429;
    err.retryAfterSeconds = remainingSeconds;
    throw err;
  }

  const cleanAadhaar = aadhaarNumber.replace(/\s/g, '');

  // Invoke configured Aadhaar OTP provider
  const result = await aadhaarOtp.generateOtp({ aadhaarNumber: cleanAadhaar });

  if (result.ok && result.referenceId) {
    // Record cooldown timestamp
    aadhaarOtpCooldowns.set(registrationId, now.getTime());

    // Save details to session (Aadhaar number stored full as today)
    await prisma.registrationSession.update({
      where: { id: registrationId },
      data: {
        aadhaarNumber: cleanAadhaar,
        aadhaarVerificationId: String(result.referenceId),
        aadhaarVerificationMethod: 'OTP'
      }
    });

    return {
      success: true,
      message: 'Aadhaar verification OTP sent successfully.',
      reference_id: String(result.referenceId)
    };
  } else {
    // Never log raw PII or expose provider internal payload to client
    console.warn(`[Aadhaar OTP Generate Failed] Reason: ${result.reason}`);

    if (result.isConfigMissing || result.statusCode === 503) {
      const err = new Error('Aadhaar verification is temporarily unavailable.');
      err.statusCode = 503;
      throw err;
    }

    if (result.reason === 'INVALID_AADHAAR') {
      const err = new Error('Invalid Aadhaar Number or Aadhaar not registered.');
      err.statusCode = 400;
      throw err;
    }

    if (result.reason === 'NO_MOBILE_LINKED') {
      const err = new Error('No mobile number is linked with this Aadhaar. Please use DigiLocker verification.');
      err.statusCode = 400;
      throw err;
    }

    if (result.reason === 'RATE_LIMITED') {
      const err = new Error('Too many OTP requests. Please try again later.');
      err.statusCode = 429;
      throw err;
    }

    // Default provider failure: do NOT increment failed attempts
    const err = new Error('Aadhaar verification service is temporarily unavailable. Please try again.');
    err.statusCode = 502;
    throw err;
  }
};

// Aadhaar OTP Verify service
export const verifyAadhaarOtpService = async ({ registrationId, reference_id, otp }) => {
  const session = await getValidSession(registrationId);

  if (session.accountType !== 'ADVOCATE') {
    const err = new Error('Invalid account type for this operation.');
    err.statusCode = 400;
    throw err;
  }

  const now = new Date();

  // Check if currently blocked
  if (session.aadhaarBlockedUntil && now < new Date(session.aadhaarBlockedUntil)) {
    const err = new Error('Aadhaar verification is temporarily blocked. Please try again after 24 hours.');
    err.statusCode = 403;
    err.blocked = true;
    err.blockedUntil = session.aadhaarBlockedUntil;
    throw err;
  }

  // Verify ID matches session's initiated verification ID
  if (!session.aadhaarVerificationId || session.aadhaarVerificationId !== reference_id) {
    const err = new Error('Invalid or expired OTP session. Please request a new OTP.');
    err.statusCode = 400;
    throw err;
  }

  // Invoke configured Aadhaar OTP provider
  const result = await aadhaarOtp.verifyOtp({ referenceId: reference_id, otp });

  if (result.ok) {
    // In-memory cross-check: verify last 4 digits of Aadhaar match the session
    if (result.kyc?.aadhaarLast4 && session.aadhaarNumber) {
      const sessionLast4 = session.aadhaarNumber.slice(-4);
      if (result.kyc.aadhaarLast4 !== sessionLast4) {
        console.warn(`[Aadhaar OTP Verify] Aadhaar last-4 mismatch for session ${registrationId}`);
        const err = new Error('Aadhaar verification failed. Identity mismatch.');
        err.statusCode = 400;
        throw err;
      }
    }

    // Save only what was saved today (no KYC fields stored)
    await prisma.registrationSession.update({
      where: { id: registrationId },
      data: {
        aadhaarVerified: true,
        aadhaarVerifiedAt: now,
        aadhaarVerificationAttempts: 0,
        aadhaarBlockedUntil: null,
        aadhaarVerificationMethod: 'OTP'
      }
    });

    // Clear cooldown for this session
    aadhaarOtpCooldowns.delete(registrationId);

    return {
      success: true,
      aadhaarVerified: true,
      message: 'Aadhaar verified successfully.'
    };
  } else {
    // Log provider message at warn level without PII
    console.warn(`[Aadhaar OTP Verify Failed] Reason: ${result.reason}`);

    if (result.isConfigMissing || result.statusCode === 503) {
      const err = new Error('Aadhaar verification is temporarily unavailable.');
      err.statusCode = 503;
      throw err;
    }

    if (result.reason === 'INVALID_OTP') {
      // Increment attempts only for invalid OTP
      const newAttempts = session.aadhaarVerificationAttempts + 1;
      const isBlocked = newAttempts >= 3;
      const blockedUntil = isBlocked ? new Date(now.getTime() + 24 * 60 * 60 * 1000) : null;

      await prisma.registrationSession.update({
        where: { id: registrationId },
        data: {
          aadhaarVerified: false,
          aadhaarVerifiedAt: null,
          aadhaarVerificationAttempts: newAttempts,
          aadhaarBlockedUntil: blockedUntil
        }
      });

      const err = new Error('Invalid OTP.');
      err.statusCode = isBlocked ? 403 : 400;
      err.remainingAttempts = Math.max(0, 3 - newAttempts);
      err.blocked = isBlocked;
      err.blockedUntil = blockedUntil;
      throw err;
    }

    if (result.reason === 'OTP_EXPIRED') {
      // Expired OTP does NOT count as a failed attempt
      const err = new Error('OTP expired. Please request a new OTP.');
      err.statusCode = 400;
      throw err;
    }

    // Provider error / network timeout does NOT count as a failed attempt
    const err = new Error('Aadhaar verification service is temporarily unavailable. Please try again.');
    err.statusCode = 502;
    throw err;
  }
};

