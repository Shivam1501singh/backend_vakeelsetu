import { z } from 'zod';
import { otpSchema, phoneSchema } from './otp.validator.js';

// Indian States and Union Territories
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  // Union Territories
  'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry'
];

export const pincodeSchema = z.string()
  .trim()
  .regex(/^[0-9]{6}$/, { message: 'Pincode must be exactly 6 digits (e.g. 201301).' });

// Base validations
export const passwordSchema = z.string()
  .min(8, { message: 'Password must be at least 8 characters long.' });

export const aadhaarSchema = z.string()
  .trim()
  .regex(/^\d{12}$/, { message: 'Aadhaar number must be exactly 12 digits.' });

export const barCouncilIdSchema = z.string()
  .trim()
  .min(3, { message: 'Bar Council ID must be at least 3 characters.' })
  .max(50, { message: 'Bar Council ID cannot exceed 50 characters.' });

export const languagesSpokenSchema = z.array(z.string().min(1))
  .min(1, { message: 'Please select at least one language.' });

export const genderSchema = z.enum(['Male', 'Female', 'Other', 'Prefer not to say'], {
  errorMap: () => ({ message: 'Please select a valid gender.' })
});

// Registration flow schemas
export const startAdvocateRegistrationSchema = z.object({
  fullName: z.string({ required_error: 'Full Name is required.' })
    .trim()
    .min(2, { message: 'Full Name must be at least 2 characters.' })
    .max(100, { message: 'Full Name cannot exceed 100 characters.' }),
  email: z.string({ required_error: 'Email is required.' })
    .trim()
    .email({ message: 'Please enter a valid email address.' })
    .toLowerCase(),
  profilePhotoUrl: z.string().url({ message: 'Valid profile photo URL is required.' }).optional().nullable(),
  profilePhotoPublicId: z.string().min(1, { message: 'Profile photo public ID is required.' }).optional().nullable(),
  gender: genderSchema.optional().nullable(),
  registrationId: z.string().uuid().optional()
});

export const sendAdvocateEmailOtpSchema = z.object({
  registrationId: z.string().uuid({ message: 'Invalid registration session ID.' }),
  email: z.string({ required_error: 'Email is required.' })
    .trim()
    .email({ message: 'Please enter a valid email address.' })
    .toLowerCase()
});

export const verifyAdvocateEmailOtpSchema = z.object({
  registrationId: z.string().uuid({ message: 'Invalid registration session ID.' }),
  otp: otpSchema
});

export const sendAdvocatePhoneOtpSchema = z.object({
  registrationId: z.string().uuid({ message: 'Invalid registration session ID.' }),
  phone: phoneSchema
});

export const verifyAdvocatePhoneSchema = z.object({
  registrationId: z.string().uuid({ message: 'Invalid registration session ID.' }),
  otp: otpSchema
});

export const validateBioWords = (val, ctx) => {
  if (val === undefined || val === null || val === '') {
    return;
  }
  const trimmed = typeof val === 'string' ? val.trim() : '';
  if (!trimmed) {
    return;
  }
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount < 50) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Bio must contain at least 50 words.'
    });
  } else if (wordCount > 500) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Bio must not exceed 500 words.'
    });
  }
};

export const bioSchema = z.string().trim().optional().nullable().superRefine(validateBioWords);

export const completeAdvocateRegistrationSchema = z.object({
  registrationId: z.string().uuid({ message: 'Invalid registration session ID.' }),
  barCouncilId: barCouncilIdSchema,
  aadhaarNumber: aadhaarSchema,
  password: passwordSchema,
  languagesSpoken: languagesSpokenSchema,
  state: z.string().trim().min(2, { message: 'State must be at least 2 characters.' }).max(100),
  city: z.string().trim().min(2, { message: 'City must be at least 2 characters.' }).max(100),
  pincode: pincodeSchema,
  latitude: z.union([z.number(), z.string().transform(v => parseFloat(v))]).optional().nullable(),
  longitude: z.union([z.number(), z.string().transform(v => parseFloat(v))]).optional().nullable(),
  about: bioSchema,
  bio: bioSchema
});

// Login schemas
export const advocateLoginSendOtpSchema = z.object({
  phone: phoneSchema
});

export const advocateLoginVerifyOtpSchema = z.object({
  phone: phoneSchema,
  otp: otpSchema
});

export const advocateLoginEmailPasswordSchema = z.object({
  email: z.string({ required_error: 'Email is required.' })
    .trim()
    .email({ message: 'Please enter a valid email address.' })
    .toLowerCase(),
  password: z.string({ required_error: 'Password is required.' })
    .min(8, { message: 'Password must be at least 8 characters long.' })
}).strict();

// Coordinate validation helper (handles numbers and valid numeric strings; rejects empty string, NaN, Infinity)
export const parseCoordinate = (min, max, fieldName) => z.preprocess((val) => {
  if (val === undefined || val === null) return val;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return NaN;
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return NaN;
    return Number(trimmed);
  }
  return NaN;
}, z.number({ invalid_type_error: `${fieldName} must be a valid number.` })
  .refine((n) => !Number.isNaN(n) && Number.isFinite(n), { message: `${fieldName} must be a valid finite number.` })
  .refine((n) => n >= min && n <= max, { message: `${fieldName} must be between ${min} and ${max}.` })
  .nullable()
  .optional()
);

export const officeLatitudeSchema = parseCoordinate(-90, 90, 'officeLatitude');
export const officeLongitudeSchema = parseCoordinate(-180, 180, 'officeLongitude');

// Both or neither refinement rule for office coordinates
export const validateOfficeCoordinates = (data, ctx) => {
  const hasLat = data.officeLatitude !== undefined;
  const hasLng = data.officeLongitude !== undefined;
  if (!hasLat && !hasLng) return;
  if (hasLat !== hasLng) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'officeLatitude and officeLongitude must be sent together.',
      path: ['officeLatitude']
    });
    return;
  }
  const latIsNull = data.officeLatitude === null;
  const lngIsNull = data.officeLongitude === null;
  if (latIsNull !== lngIsNull) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'officeLatitude and officeLongitude must be sent together.',
      path: ['officeLatitude']
    });
  }
};

// Helper to parse integers that may arrive as strings in multipart/form-data
export const parseOptionalInt = (min, max, label) => z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return val === '' ? null : val;
  if (typeof val === 'number') return Math.floor(val);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return null;
    if (!/^-?\d+$/.test(trimmed)) return NaN;
    return parseInt(trimmed, 10);
  }
  return NaN;
}, z.number({ invalid_type_error: `${label} must be a valid integer.` })
  .int({ message: `${label} must be an integer.` })
  .min(min, { message: `${label} must be a non-negative number.` })
  .max(max, { message: `${label} cannot exceed ${max}.` })
  .optional()
  .nullable()
);

// Helper to parse numbers/floats that may arrive as strings in multipart/form-data
export const parseOptionalFloat = (min, max, label) => z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return val === '' ? null : val;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return null;
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return NaN;
    return parseFloat(trimmed);
  }
  return NaN;
}, z.number({ invalid_type_error: `${label} must be a valid number.` })
  .min(min, { message: `${label} must be a non-negative number.` })
  .max(max, { message: `${label} cannot exceed ${max}.` })
  .refine((n) => !Number.isNaN(n) && Number.isFinite(n), { message: `${label} must be a valid finite number.` })
  .optional()
  .nullable()
);

export const parsePriceField = (label) => z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return val === '' ? null : val;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return NaN;
    return parseFloat(trimmed);
  }
  return NaN;
}, z.number({ invalid_type_error: `${label} must be a valid number.` })
  .refine((n) => !Number.isNaN(n) && Number.isFinite(n), { message: `${label} must be a valid finite number.` })
  .refine((n) => n > 0, { message: `${label} must be a positive number.` })
  .refine((n) => {
    const parts = n.toString().split('.');
    return parts.length < 2 || parts[1].length <= 2;
  }, { message: `${label} can have at most 2 decimal places.` })
  .refine((n) => {
    const maxPayment = parseInt(process.env.RAZORPAY_MAX_PAYMENT_AMOUNT_RUPEES || '500000', 10);
    const feePaise = Math.round(n * 100);
    const gstPaise = Math.round((feePaise * 18) / 100);
    const totalPaise = feePaise + gstPaise + 2500;
    return totalPaise <= maxPayment * 100;
  }, { message: `Total booking amount for ${label} exceeds the maximum allowed payment limit.` })
  .optional()
  .nullable()
);

export const parseDurationField = (label) => z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return val === '' ? null : val;
  if (typeof val === 'number') return Number.isInteger(val) ? val : NaN;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
    if (!/^\d+$/.test(trimmed)) return NaN;
    return parseInt(trimmed, 10);
  }
  return NaN;
}, z.number({ invalid_type_error: `${label} must be a positive whole number.` })
  .refine((n) => !Number.isNaN(n) && Number.isInteger(n), { message: `${label} must be a whole number.` })
  .refine((n) => n >= 1 && n <= 1440, { message: `${label} must be between 1 and 1440 minutes.` })
  .optional()
  .nullable()
);

// Helper to parse arrays that may arrive as JSON strings in multipart/form-data
export const parseOptionalArray = (itemSchema, maxItems) => z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return val === '' ? null : val;
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return null;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return [trimmed];
      }
    }
    return [trimmed];
  }
  return val;
}, maxItems
  ? z.array(itemSchema).max(maxItems, { message: `Maximum of ${maxItems} items allowed.` }).optional().nullable()
  : z.array(itemSchema).optional().nullable()
);

export const officeAddressSchema = z.string({ required_error: 'Office address is required.' })
  .trim()
  .min(10, { message: 'Office address must be at least 10 characters.' })
  .max(500, { message: 'Office address cannot exceed 500 characters.' });

// Profile update validation schema (Base object before refinement)
export const advocateProfileUpdateBaseSchema = z.object({
  fullName: z.string().trim().min(2, { message: 'Full Name must be at least 2 characters.' }).max(100).optional(),
  gender: genderSchema.optional().nullable(),
  barCouncilId: barCouncilIdSchema.optional(),
  aadhaarNumber: aadhaarSchema.optional().nullable(),
  email: z.string().trim().email().toLowerCase().optional(),

  experienceYears: parseOptionalInt(0, 80, 'Experience'),
  casesHandled: parseOptionalInt(0, 100000, 'Cases handled'),
  practiceAreaIds: parseOptionalArray(z.string().min(1)),
  bestPracticeArea: z.string().trim().max(100, { message: 'Best Practice Area cannot exceed 100 characters.' }).optional().nullable(),
  about: bioSchema,
  bio: bioSchema,
  courtPractice: parseOptionalArray(z.string().trim().min(1)),
  // Retired completeAddress field to intercept and reject with 400
  completeAddress: z.any().optional(),

  // Pricing & duration fields
  voiceCallPricePer15Min: parsePriceField('voiceCallPricePer15Min'),
  videoCallPricePer15Min: parsePriceField('videoCallPricePer15Min'),
  offlineVisitingFee: parsePriceField('offlineVisitingFee'),
  officeVisitDurationMinutes: parseDurationField('officeVisitDurationMinutes'),

  // Retired legacy per-minute fields to intercept and reject with 400
  videoCallChargePerMinute: z.any().optional(),
  voiceCallChargePerMinute: z.any().optional(),
  videoChargePerMinute: z.any().optional(),
  voiceChargePerMinute: z.any().optional(),

  officeAddress: officeAddressSchema.optional().nullable(),
  state: z.string().trim().min(2, { message: 'State must be at least 2 characters.' }).max(100).optional().nullable(),
  city: z.string().trim().min(2, { message: 'City must be at least 2 characters.' }).max(100).optional().nullable(),
  pincode: pincodeSchema.optional().nullable(),

  // Direct professional fields
  practiceAreas: parseOptionalArray(z.string().trim().min(1, { message: 'Practice Area cannot be empty.' }), 20),
  topCourtPractised: z.string().trim().max(100, { message: 'Top Court Practised name cannot exceed 100 characters.' }).optional().nullable(),

  // Aliases (Section 10 request payload support)
  experience: parseOptionalInt(0, 80, 'Experience'),
  languages: parseOptionalArray(z.string().trim().min(1)),
  languagesSpoken: parseOptionalArray(z.string().trim().min(1)),

  // Office location coordinates collected at profile completion
  officeLatitude: officeLatitudeSchema,
  officeLongitude: officeLongitudeSchema,

  // Legacy lat/lng fields to intercept and reject with 400
  latitude: z.any().optional(),
  longitude: z.any().optional()
});

export const requiredOfficeLatitudeSchema = z.preprocess((val) => {
  if (val === undefined || val === null) return val;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return NaN;
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return NaN;
    return Number(trimmed);
  }
  return NaN;
}, z.number({ required_error: 'officeLatitude is required.', invalid_type_error: 'officeLatitude must be a valid number.' })
  .refine((n) => !Number.isNaN(n) && Number.isFinite(n), { message: 'officeLatitude must be a valid finite number.' })
  .refine((n) => n >= -90 && n <= 90, { message: 'officeLatitude must be between -90 and 90.' })
);

export const requiredOfficeLongitudeSchema = z.preprocess((val) => {
  if (val === undefined || val === null) return val;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return NaN;
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return NaN;
    return Number(trimmed);
  }
  return NaN;
}, z.number({ required_error: 'officeLongitude is required.', invalid_type_error: 'officeLongitude must be a valid number.' })
  .refine((n) => !Number.isNaN(n) && Number.isFinite(n), { message: 'officeLongitude must be a valid finite number.' })
  .refine((n) => n >= -180 && n <= 180, { message: 'officeLongitude must be between -180 and 180.' })
);

export const advocateRegistrationAddressSchema = z.object({
  registrationId: z.string({ required_error: 'registrationId is required.' }).uuid({ message: 'Invalid registration session ID.' }),
  pincode: pincodeSchema,
  city: z.string({ required_error: 'City is required.' }).trim().min(2, { message: 'City must be at least 2 characters.' }).max(100),
  state: z.string({ required_error: 'State is required.' }).trim().min(2, { message: 'State must be at least 2 characters.' }).max(100),
  officeAddress: officeAddressSchema,
  officeLatitude: requiredOfficeLatitudeSchema,
  officeLongitude: requiredOfficeLongitudeSchema
});

// Location and coordinate pairs refinement
export const validateLocationPairs = (data, ctx) => {
  // 0. completeAddress retired: reject with 400 "completeAddress is no longer supported. Use officeAddress."
  if (data.completeAddress !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'completeAddress is no longer supported. Use officeAddress.',
      path: ['completeAddress']
    });
  }

  // 0.1 Legacy per-minute fee fields retired: reject with 400
  if (data.voiceCallChargePerMinute !== undefined || data.voiceChargePerMinute !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'voiceCallChargePerMinute is no longer supported. Use voiceCallPricePer15Min.',
      path: [data.voiceCallChargePerMinute !== undefined ? 'voiceCallChargePerMinute' : 'voiceChargePerMinute']
    });
  }

  if (data.videoCallChargePerMinute !== undefined || data.videoChargePerMinute !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'videoCallChargePerMinute is no longer supported. Use videoCallPricePer15Min.',
      path: [data.videoCallChargePerMinute !== undefined ? 'videoCallChargePerMinute' : 'videoChargePerMinute']
    });
  }

  // 0.2 Office visit fee and duration pair rule when both sent in payload
  if (data.offlineVisitingFee !== undefined && data.officeVisitDurationMinutes !== undefined) {
    const hasFee = data.offlineVisitingFee !== null;
    const hasDuration = data.officeVisitDurationMinutes !== null;
    if (hasFee !== hasDuration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'offlineVisitingFee and officeVisitDurationMinutes must both be provided or both be null.',
        path: [!hasFee ? 'offlineVisitingFee' : 'officeVisitDurationMinutes']
      });
    }
  }

  // 1. Old latitude / longitude in the body: reject with 400 "Use officeLatitude/officeLongitude."
  if (data.latitude !== undefined || data.longitude !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Use officeLatitude/officeLongitude.',
      path: [data.latitude !== undefined ? 'latitude' : 'longitude']
    });
  }

  // 2. officeLatitude + officeLongitude must come together
  const hasLat = data.officeLatitude !== undefined;
  const hasLng = data.officeLongitude !== undefined;
  if (hasLat !== hasLng) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'officeLatitude and officeLongitude must be sent together.',
      path: ['officeLatitude']
    });
  } else if (hasLat && hasLng) {
    const latIsNull = data.officeLatitude === null;
    const lngIsNull = data.officeLongitude === null;
    if (latIsNull !== lngIsNull) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'officeLatitude and officeLongitude must be sent together.',
        path: ['officeLatitude']
      });
    }
  }

  // 3. pincode + city + state must come together
  const hasPincode = data.pincode !== undefined && data.pincode !== null && data.pincode !== '';
  const hasCity = data.city !== undefined && data.city !== null && data.city !== '';
  const hasState = data.state !== undefined && data.state !== null && data.state !== '';
  const anyLocation = hasPincode || hasCity || hasState;
  const allLocation = hasPincode && hasCity && hasState;
  if (anyLocation && !allLocation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'pincode, city, and state must be sent together.',
      path: [!hasPincode ? 'pincode' : !hasCity ? 'city' : 'state']
    });
  }
};

export const advocateProfileUpdateSchema = advocateProfileUpdateBaseSchema.strict()
  .superRefine(validateLocationPairs);

export const initiateAadhaarSchema = z.object({
  registrationId: z.string().uuid({ message: 'Invalid registration session ID.' }),
  aadhaarNumber: z.string().trim()
});

export const verifyAadhaarSchema = z.object({
  registrationId: z.string().uuid({ message: 'Invalid registration session ID.' }),
  clientId: z.string({ required_error: 'Client ID is required.' }).min(1)
});

export const generateAadhaarOtpSchema = z.object({
  registrationId: z.string().uuid({ message: 'Invalid registration session ID.' }),
  aadhaar_number: z.string({ required_error: 'Aadhaar number is required.' })
    .trim()
    .regex(/^\d{12}$/, { message: 'Aadhaar number must be exactly 12 digits without spaces or special characters.' })
});

export const verifyAadhaarOtpSchema = z.object({
  registrationId: z.string().uuid({ message: 'Invalid registration session ID.' }),
  reference_id: z.string({ required_error: 'Reference ID is required.' }).min(1),
  otp: z.string({ required_error: 'OTP is required.' })
    .trim()
    .regex(/^\d{6}$/, { message: 'OTP must be exactly 6 numeric digits.' })
});

export const updateAdvocateOnlineStatusSchema = z.object({
  isOnline: z.boolean({
    required_error: 'isOnline is required.',
    invalid_type_error: 'isOnline must be a boolean.'
  })
}).strict();


