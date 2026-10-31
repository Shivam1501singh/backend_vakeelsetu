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
export const getModeDurationMinutes = (mode, advocate = null) => {
  if (mode === 'IN_PERSON') {
    if (advocate && advocate.officeVisitDurationMinutes) {
      return parseInt(advocate.officeVisitDurationMinutes, 10);
    }
    return parseInt(process.env.ADVOCATE_IN_PERSON_MINUTES || '60', 10);
  }
  return parseInt(process.env.ADVOCATE_BOOKING_SLOT_MINUTES || '15', 10);
};

const formatPriceLabelValue = (num) => {
  const n = Number(num);
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
};

/**
 * Computes the financial breakdown for a given advocate and booking mode.
 * Everything is calculated in integer paise to eliminate floating-point precision issues.
 */
export const calculatePricing = (advocate, mode) => {
  if (!advocate) return null;

  const gstPercent = parseInt(process.env.BOOKING_GST_PERCENT || '18', 10);
  const platformFeeRupees = parseInt(process.env.BOOKING_PLATFORM_FEE || '25', 10);
  const platformFeePaise = platformFeeRupees * 100;
  const slotMinutes = parseInt(process.env.ADVOCATE_BOOKING_SLOT_MINUTES || '15', 10);

  let durationMinutes = 0;
  let feePaise = 0;
  let priceLabel = '';

  if (mode === 'VOICE_CALL') {
    if (!advocate.voiceCallPricePer15Min || Number(advocate.voiceCallPricePer15Min) <= 0) {
      return null;
    }
    const pricePer15Min = Number(advocate.voiceCallPricePer15Min);
    durationMinutes = slotMinutes;
    // fee = pricePer15Min * (slotMinutes / 15)
    const fee = pricePer15Min * (slotMinutes / 15);
    feePaise = Math.round(fee * 100);
    priceLabel = `₹${formatPriceLabelValue(pricePer15Min)} / 15 min`;
  } else if (mode === 'VIDEO_CALL') {
    if (!advocate.videoCallPricePer15Min || Number(advocate.videoCallPricePer15Min) <= 0) {
      return null;
    }
    const pricePer15Min = Number(advocate.videoCallPricePer15Min);
    durationMinutes = slotMinutes;
    const fee = pricePer15Min * (slotMinutes / 15);
    feePaise = Math.round(fee * 100);
    priceLabel = `₹${formatPriceLabelValue(pricePer15Min)} / 15 min`;
  } else if (mode === 'IN_PERSON') {
    if (!advocate.offlineVisitingFee || Number(advocate.offlineVisitingFee) <= 0) {
      return null;
    }
    const flatFee = Number(advocate.offlineVisitingFee);
    durationMinutes = advocate.officeVisitDurationMinutes
      ? parseInt(advocate.officeVisitDurationMinutes, 10)
      : parseInt(process.env.ADVOCATE_IN_PERSON_MINUTES || '60', 10);

    if (!durationMinutes || durationMinutes <= 0) {
      return null;
    }

    feePaise = Math.round(flatFee * 100);
    priceLabel = `₹${formatPriceLabelValue(flatFee)} / ${durationMinutes} min`;
  } else {
    return null;
  }

  const gstPaise = Math.round((feePaise * gstPercent) / 100);
  const totalPaise = feePaise + gstPaise + platformFeePaise;

  return {
    mode,
    label: MODE_LABELS[mode] || mode,
    priceLabel,
    durationMinutes,
    ratePerMinute: null,
    ratePerMinutePaise: null,
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
 * Returns formatted pricing breakdown summary object for an advocate profile response.
 * Mode is null if not offered.
 */
export const formatPricingSummary = (advocate) => {
  if (!advocate) return null;
  const voice = calculatePricing(advocate, 'VOICE_CALL');
  const video = calculatePricing(advocate, 'VIDEO_CALL');
  const office = calculatePricing(advocate, 'IN_PERSON');

  return {
    voiceCall: voice ? { price: voice.fee, durationMinutes: voice.durationMinutes, label: voice.priceLabel } : null,
    videoCall: video ? { price: video.fee, durationMinutes: video.durationMinutes, label: video.priceLabel } : null,
    officeVisit: office ? { price: office.fee, durationMinutes: office.durationMinutes, label: office.priceLabel } : null
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
