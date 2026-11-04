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
export const calculatePricing = (advocate, mode, customDurationMinutes = null, startAt = null) => {
  if (!advocate) return null;

  const gstPercent = parseInt(process.env.BOOKING_GST_PERCENT || '18', 10);
  const platformFeeRupees = parseInt(process.env.BOOKING_PLATFORM_FEE || '25', 10);
  const platformFeePaise = platformFeeRupees * 100;
  const slotMinutes = parseInt(process.env.ADVOCATE_BOOKING_SLOT_MINUTES || '15', 10);

  let durationMinutes = 0;
  let feePaise = 0;
  let priceLabel = '';
  let extendable = false;
  let stepMinutes = null;
  let minDurationMinutes = null;
  let pricePerStep = null;

  if (mode === 'VOICE_CALL') {
    if (!advocate.voiceCallPricePer15Min || Number(advocate.voiceCallPricePer15Min) <= 0) {
      return null;
    }
    const pricePer15Min = Number(advocate.voiceCallPricePer15Min);
    durationMinutes = customDurationMinutes ? parseInt(customDurationMinutes, 10) : slotMinutes;
    const steps = durationMinutes / slotMinutes;
    const fee = pricePer15Min * steps;
    feePaise = Math.round(fee * 100);
    priceLabel = `₹${formatPriceLabelValue(pricePer15Min)} / 15 min`;
    extendable = true;
    stepMinutes = slotMinutes;
    minDurationMinutes = slotMinutes;
    pricePerStep = parseFloat(pricePer15Min.toFixed(2));
  } else if (mode === 'VIDEO_CALL') {
    if (!advocate.videoCallPricePer15Min || Number(advocate.videoCallPricePer15Min) <= 0) {
      return null;
    }
    const pricePer15Min = Number(advocate.videoCallPricePer15Min);
    durationMinutes = customDurationMinutes ? parseInt(customDurationMinutes, 10) : slotMinutes;
    const steps = durationMinutes / slotMinutes;
    const fee = pricePer15Min * steps;
    feePaise = Math.round(fee * 100);
    priceLabel = `₹${formatPriceLabelValue(pricePer15Min)} / 15 min`;
    extendable = true;
    stepMinutes = slotMinutes;
    minDurationMinutes = slotMinutes;
    pricePerStep = parseFloat(pricePer15Min.toFixed(2));
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
    extendable = false;
    stepMinutes = null;
    minDurationMinutes = durationMinutes;
    pricePerStep = null;
  } else {
    return null;
  }

  const gstPaise = Math.round((feePaise * gstPercent) / 100);
  const totalPaise = feePaise + gstPaise + platformFeePaise;

  const maxPaymentRupees = parseInt(process.env.RAZORPAY_MAX_PAYMENT_AMOUNT_RUPEES || '500000', 10);
  const maxPaymentPaise = maxPaymentRupees * 100;
  if (totalPaise > maxPaymentPaise) {
    const error = new Error('This booking is too long to pay in one payment. Please choose a shorter duration.');
    error.statusCode = 400;
    error.code = 'AMOUNT_TOO_HIGH';
    throw error;
  }

  let endAt = null;
  if (startAt) {
    const sDate = new Date(startAt);
    if (!isNaN(sDate.getTime())) {
      endAt = new Date(sDate.getTime() + durationMinutes * 60 * 1000).toISOString();
    }
  }

  return {
    mode,
    label: MODE_LABELS[mode] || mode,
    priceLabel,
    durationMinutes,
    extendable,
    stepMinutes,
    minDurationMinutes,
    pricePerStep,
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
    totalPaise,
    ...(endAt ? { endAt } : {})
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
export const quote = (advocate, mode, durationMinutes = null, startAt = null) => {
  assertAdvocateBookable(advocate);

  const pricing = calculatePricing(advocate, mode, durationMinutes, startAt);
  if (!pricing) {
    const error = new Error(`The selected mode (${mode}) is not offered by this advocate.`);
    error.statusCode = 400;
    error.code = 'MODE_NOT_AVAILABLE';
    throw error;
  }

  return pricing;
};
