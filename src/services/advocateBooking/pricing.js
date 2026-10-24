export const ADVOCATE_BOOKING_SUBJECTS = [
  'Criminal Defence',
  'Corporate',
  'Family',
  'Personal Injury',
  'Employment',
  'IP Rights',
  'Real Estate',
  'Tax',
  'Immigration',
  'Civil Litigation',
  'Other'
];

export const MODE_LABELS = {
  VOICE_CALL: 'Voice Call',
  VIDEO_CALL: 'Video Call',
  IN_PERSON: 'In-Person Meeting'
};

/**
 * Checks whether an advocate meets the requirements to accept bookings.
 * Note: callAvailability is specifically excluded as it is reserved for instant on-demand calls.
 */
export const isAdvocateBookable = (advocate) => {
  if (!advocate) return false;
  return (
    advocate.isActive === true &&
    advocate.status === 'ACTIVE' &&
    advocate.approvalStatus === 'APPROVED' &&
    advocate.deletionStatus !== 'PENDING'
  );
};

/**
 * Asserts that an advocate is bookable, throwing a 400 ADVOCATE_NOT_BOOKABLE error if not.
 */
export const assertAdvocateBookable = (advocate) => {
  if (!isAdvocateBookable(advocate)) {
    const error = new Error('Advocate is currently not available for bookings.');
    error.statusCode = 400;
    error.code = 'ADVOCATE_NOT_BOOKABLE';
    throw error;
  }
};

/**
 * Returns the duration in minutes for a given mode.
 */
export const getModeDurationMinutes = (mode) => {
  if (mode === 'IN_PERSON') {
    return parseInt(process.env.ADVOCATE_IN_PERSON_MINUTES || '60', 10);
  }
  return parseInt(process.env.ADVOCATE_BOOKING_SLOT_MINUTES || '15', 10);
};

/**
 * Computes the financial breakdown for a given advocate and booking mode.
 * Everything is calculated in integer paise to eliminate floating-point precision issues.
 */
export const calculatePricing = (advocate, mode) => {
  const gstPercent = parseInt(process.env.BOOKING_GST_PERCENT || '18', 10);
  const platformFeeRupees = parseInt(process.env.BOOKING_PLATFORM_FEE || '25', 10);
  const platformFeePaise = platformFeeRupees * 100;
  const durationMinutes = getModeDurationMinutes(mode);

  let ratePerMinute = null;
  let ratePerMinutePaise = null;
  let feePaise = 0;

  if (mode === 'VOICE_CALL') {
    if (!advocate.voiceCallChargePerMinute || Number(advocate.voiceCallChargePerMinute) <= 0) {
      return null;
    }
    ratePerMinute = Number(advocate.voiceCallChargePerMinute);
    ratePerMinutePaise = Math.round(ratePerMinute * 100);
    feePaise = ratePerMinutePaise * durationMinutes;
  } else if (mode === 'VIDEO_CALL') {
    if (!advocate.videoCallChargePerMinute || Number(advocate.videoCallChargePerMinute) <= 0) {
      return null;
    }
    ratePerMinute = Number(advocate.videoCallChargePerMinute);
    ratePerMinutePaise = Math.round(ratePerMinute * 100);
    feePaise = ratePerMinutePaise * durationMinutes;
  } else if (mode === 'IN_PERSON') {
    if (!advocate.offlineVisitingFee || Number(advocate.offlineVisitingFee) <= 0) {
      return null;
    }
    const flatFee = Number(advocate.offlineVisitingFee);
    feePaise = Math.round(flatFee * 100);
  } else {
    return null;
  }

  const gstPaise = Math.round((feePaise * gstPercent) / 100);
  const totalPaise = feePaise + gstPaise + platformFeePaise;

  return {
    mode,
    label: MODE_LABELS[mode] || mode,
    durationMinutes,
    ratePerMinute,
    ratePerMinutePaise,
    fee: parseFloat((feePaise / 100).toFixed(2)),
    feePaise,
    gst: parseFloat((gstPaise / 100).toFixed(2)),
    gstPercent,
    gstPaise,
    platformFee: platformFeeRupees,
    platformFeePaise,
    total: parseFloat((totalPaise / 100).toFixed(2)),
    totalPaise
  };
};

/**
 * Returns all active bookable modes for an advocate.
 */
export const getBookableModes = (advocate) => {
  const modes = ['VOICE_CALL', 'VIDEO_CALL', 'IN_PERSON'];
  const available = [];

  for (const m of modes) {
    const pricing = calculatePricing(advocate, m);
    if (pricing) {
      available.push(pricing);
    }
  }

  return available;
};

/**
 * Returns the exact quote breakdown for an advocate and mode, or throws 400 MODE_NOT_AVAILABLE.
 */
export const quote = (advocate, mode) => {
  assertAdvocateBookable(advocate);

  const pricing = calculatePricing(advocate, mode);
  if (!pricing) {
    const error = new Error(`The selected mode (${mode}) is not offered by this advocate.`);
    error.statusCode = 400;
    error.code = 'MODE_NOT_AVAILABLE';
    throw error;
  }

  return pricing;
};
