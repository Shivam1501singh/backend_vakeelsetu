import prisma from '../lib/prisma.js';
import { getTeamMates } from './advocateTeam.service.js';
import { computeEffectiveOnlineStatus } from '../utils/advocateStatus.js';
import { isAdvocateBookable, getBookableModes, formatPricingSummary } from './advocateBooking/pricing.js';
import { getPincodeLocation, PINCODE_COORDINATES } from './geocoding.service.js';

const TIER_PRIORITY = {
  SAME_PINCODE: 1,
  WITHIN_5_KM: 2,
  WITHIN_10_KM: 3,
  WITHIN_25_KM: 4,
  WITHIN_50_KM: 5,
  WITHIN_100_KM: 6,
  BEYOND_100_KM: 7,
  UNKNOWN_DISTANCE: 8
};

const calculateHaversineDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Radius of the Earth in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
};

const getAdvocateDirectCoordinates = (advocate) => {
  if (advocate.officeLatitude !== null && advocate.officeLatitude !== undefined &&
      advocate.officeLongitude !== null && advocate.officeLongitude !== undefined) {
    return { latitude: advocate.officeLatitude, longitude: advocate.officeLongitude };
  }
  if (advocate.latitude !== null && advocate.latitude !== undefined &&
      advocate.longitude !== null && advocate.longitude !== undefined) {
    return { latitude: advocate.latitude, longitude: advocate.longitude };
  }
  return null;
};

/**
 * Resolves advocate coordinates in priority:
 * 1. officeLatitude / officeLongitude
 * 2. latitude / longitude
 * 3. pincode via cache-only batch lookup
 */
const resolveAdvocateCoordinatesBatch = async (advocates) => {
  const missingPincodes = new Set();
  for (const adv of advocates) {
    const direct = getAdvocateDirectCoordinates(adv);
    if (!direct && adv.pincode) {
      const cleanPin = String(adv.pincode).trim();
      if (/^[1-9]\d{5}$/.test(cleanPin)) {
        missingPincodes.add(cleanPin);
      }
    }
  }

  const cacheMap = new Map();
  if (missingPincodes.size > 0) {
    const rows = await prisma.pincodeLocation.findMany({
      where: {
        pincode: { in: Array.from(missingPincodes) },
        status: 'OK',
        latitude: { not: null },
        longitude: { not: null }
      },
      select: { pincode: true, latitude: true, longitude: true }
    });
    for (const r of rows) {
      cacheMap.set(r.pincode, { latitude: r.latitude, longitude: r.longitude });
    }
  }

  return advocates.map(adv => {
    const direct = getAdvocateDirectCoordinates(adv);
    if (direct) return direct;
    if (adv.pincode) {
      const cleanPin = String(adv.pincode).trim();
      if (cacheMap.has(cleanPin)) return cacheMap.get(cleanPin);
      if (PINCODE_COORDINATES[cleanPin]) return PINCODE_COORDINATES[cleanPin];
    }
    return null;
  });
};

const assignDistanceTier = (advPincode, searchPincode, distance) => {
  if (
    searchPincode &&
    advPincode &&
    String(advPincode).trim().toLowerCase() === String(searchPincode).trim().toLowerCase()
  ) {
    return { distanceTier: 'SAME_PINCODE', distanceLabel: 'Same pincode' };
  }

  if (distance !== null && distance !== undefined && !isNaN(distance)) {
    if (distance <= 5.0) return { distanceTier: 'WITHIN_5_KM', distanceLabel: 'Within 5 km' };
    if (distance <= 10.0) return { distanceTier: 'WITHIN_10_KM', distanceLabel: 'Within 10 km' };
    if (distance <= 25.0) return { distanceTier: 'WITHIN_25_KM', distanceLabel: 'Within 25 km' };
    if (distance <= 50.0) return { distanceTier: 'WITHIN_50_KM', distanceLabel: 'Within 50 km' };
    if (distance <= 100.0) return { distanceTier: 'WITHIN_100_KM', distanceLabel: 'Within 100 km' };
    return { distanceTier: 'BEYOND_100_KM', distanceLabel: 'More than 100 km away' };
  }

  return { distanceTier: 'UNKNOWN_DISTANCE', distanceLabel: 'Distance not available' };
};

/**
 * Lists active, completed advocates with pagination, search, sorting, and filters.
 */
export const listAdvocates = async ({
  page = 1,
  limit = 12,
  search,
  sort,
  practiceAreaId,
  topCourtPractisedId,
  practiceArea,
  topCourtPractised,
  bestPracticeArea,
  courtPractice,
  state,
  city,
  experienceYears,
  rating,
  pincode,
  currentUserId
}) => {
  const skip = (page - 1) * limit;
  const take = parseInt(limit, 10);

  const where = {
    isActive: true,
    phoneVerified: true,
    emailVerified: true,
    status: 'ACTIVE',
    approvalStatus: 'APPROVED',
    deletionStatus: { not: 'PENDING' }
  };

  // 1. Search (Matches Name, topCourtPractised, City, State case-insensitively, and practiceAreas exact match)
  if (search && search.trim()) {
    const cleanSearch = search.trim();
    where.OR = [
      { fullName: { contains: cleanSearch, mode: 'insensitive' } },
      { topCourtPractised: { contains: cleanSearch, mode: 'insensitive' } },
      { city: { contains: cleanSearch, mode: 'insensitive' } },
      { state: { contains: cleanSearch, mode: 'insensitive' } },
      { practiceAreas: { has: cleanSearch } }
    ];
  }

  // 2. Filters
  const filterArea = practiceArea || practiceAreaId;
  if (filterArea) {
    where.practiceAreas = { has: filterArea };
  }

  const filterCourt = topCourtPractised || topCourtPractisedId;
  if (filterCourt) {
    where.topCourtPractised = { equals: filterCourt, mode: 'insensitive' };
  }

  if (bestPracticeArea) {
    where.bestPracticeArea = bestPracticeArea;
  }
  if (courtPractice) {
    where.courtPractice = { has: courtPractice };
  }
  if (state) {
    where.state = { equals: state, mode: 'insensitive' };
  }
  if (city) {
    where.city = { equals: city, mode: 'insensitive' };
  }
  if (experienceYears) {
    where.experienceYears = { gte: parseInt(experienceYears, 10) };
  }
  if (rating) {
    where.averageRating = { gte: parseFloat(rating) };
  }

  // 3. Sorting
  let orderBy = { createdAt: 'desc' }; // Default sort
  const allowedSortKeys = {
    rating: { averageRating: 'desc' },
    experience: { experienceYears: 'desc' },
    casesHandled: { casesHandled: 'desc' }
  };

  if (sort && allowedSortKeys[sort]) {
    orderBy = allowedSortKeys[sort];
  }

  const selectFields = {
    id: true,
    fullName: true,
    profilePhotoUrl: true,
    experienceYears: true,
    casesHandled: true,
    practiceAreas: true,
    topCourtPractised: true,
    bestPracticeArea: true,
    courtPractice: true,
    languagesSpoken: true,
    state: true,
    city: true,
    voiceCallPricePer15Min: true,
    videoCallPricePer15Min: true,
    offlineVisitingFee: true,
    officeVisitDurationMinutes: true,
    averageRating: true,
    totalReviews: true,
    officeAddress: true,
    // TODO: remove fallback after backfill-office-address --apply
    completeAddress: true,
    pincode: true,
    latitude: true,
    longitude: true,
    officeLatitude: true,
    officeLongitude: true,
    isOnline: true,
    lastSeenAt: true,
    callAvailability: true,
    _count: {
      select: { likes: true }
    }
  };

  // Resolve user coords if logged in
  let userCoords = null;
  let savedLawyerIds = new Set();
  let likedAdvocateIds = new Set();
  if (currentUserId) {
    const [dbUser, saved, liked] = await prisma.$transaction([
      prisma.user.findUnique({
        where: { id: currentUserId },
        select: { latitude: true, longitude: true, pincode: true }
      }),
      prisma.savedLawyer.findMany({
        where: { userId: currentUserId },
        select: { advocateId: true }
      }),
      prisma.advocateLike.findMany({
        where: { userId: currentUserId },
        select: { advocateId: true }
      })
    ]);
    if (dbUser) {
      if (dbUser.latitude !== null && dbUser.longitude !== null) {
        userCoords = { latitude: dbUser.latitude, longitude: dbUser.longitude };
      } else if (dbUser.pincode) {
        try {
          const uloc = await getPincodeLocation(dbUser.pincode);
          if (uloc.found) {
            userCoords = { latitude: uloc.latitude, longitude: uloc.longitude };
          }
        } catch (err) {
          console.warn(`Could not resolve user coordinates for user pincode ${dbUser.pincode}:`, err);
        }
      }
    }
    if (saved) {
      savedLawyerIds = new Set(saved.map(s => s.advocateId));
    }
    if (liked) {
      likedAdvocateIds = new Set(liked.map(l => l.advocateId));
    }
  }

  // 4. Branch A: Search by Pincode with Expanding Radius
  if (pincode !== undefined && pincode !== null && pincode !== '') {
    const cleanSearchPincode = String(pincode).trim();
    const pinLoc = await getPincodeLocation(cleanSearchPincode);

    let refCoords = null;
    let locationResolved = false;
    let locationSource = null;

    if (!pinLoc.found) {
      if (pinLoc.reason === 'NOT_FOUND') {
        const error = new Error("We couldn't find this pincode. Please check and try again.");
        error.statusCode = 400;
        throw error;
      }
      // pinLoc.reason === 'UNAVAILABLE' and no fallback: graceful degradation
      locationResolved = false;
      locationSource = null;
      refCoords = null;
    } else {
      refCoords = { latitude: pinLoc.latitude, longitude: pinLoc.longitude };
      locationResolved = true;
      locationSource = pinLoc.source;
    }

    // Fetch all matching advocates to compute full-set areaSummary & stable tier ordering
    const allAdvocates = await prisma.advocate.findMany({
      where,
      select: selectFields
    });

    const advCoordsList = await resolveAdvocateCoordinatesBatch(allAdvocates);

    const advocatesWithDistance = allAdvocates.map((adv, idx) => {
      const coords = advCoordsList[idx];
      let distance = null;
      if (refCoords && coords) {
        const raw = calculateHaversineDistance(
          refCoords.latitude,
          refCoords.longitude,
          coords.latitude,
          coords.longitude
        );
        distance = parseFloat(raw.toFixed(2));
      }
      const { distanceTier, distanceLabel } = assignDistanceTier(adv.pincode, cleanSearchPincode, distance);
      return { ...adv, distance, distanceTier, distanceLabel };
    });

    // Full-set area summary
    const areaSummary = {
      SAME_PINCODE: 0,
      WITHIN_5_KM: 0,
      WITHIN_10_KM: 0,
      WITHIN_25_KM: 0,
      WITHIN_50_KM: 0,
      WITHIN_100_KM: 0,
      BEYOND_100_KM: 0,
      UNKNOWN_DISTANCE: 0
    };
    for (const adv of advocatesWithDistance) {
      if (areaSummary[adv.distanceTier] !== undefined) {
        areaSummary[adv.distanceTier]++;
      }
    }

    // Sort: Explicit sort overrides tier order, but distances and labels remain
    if (sort && allowedSortKeys[sort]) {
      if (sort === 'rating') {
        advocatesWithDistance.sort((a, b) => {
          const diff = (Number(b.averageRating) || 0) - (Number(a.averageRating) || 0);
          if (diff !== 0) return diff;
          return String(a.id).localeCompare(String(b.id));
        });
      } else if (sort === 'experience') {
        advocatesWithDistance.sort((a, b) => {
          const diff = (b.experienceYears || 0) - (a.experienceYears || 0);
          if (diff !== 0) return diff;
          return String(a.id).localeCompare(String(b.id));
        });
      } else if (sort === 'casesHandled') {
        advocatesWithDistance.sort((a, b) => {
          const diff = (b.casesHandled || 0) - (a.casesHandled || 0);
          if (diff !== 0) return diff;
          return String(a.id).localeCompare(String(b.id));
        });
      }
    } else {
      // Default: Tier ascending -> distance ascending -> rating desc -> id asc
      advocatesWithDistance.sort((a, b) => {
        const tierA = TIER_PRIORITY[a.distanceTier] || 99;
        const tierB = TIER_PRIORITY[b.distanceTier] || 99;
        if (tierA !== tierB) return tierA - tierB;

        const distA = a.distance !== null && a.distance !== undefined ? a.distance : Infinity;
        const distB = b.distance !== null && b.distance !== undefined ? b.distance : Infinity;
        if (distA !== distB) return distA - distB;

        const ratingA = Number(a.averageRating) || 0;
        const ratingB = Number(b.averageRating) || 0;
        if (ratingB !== ratingA) return ratingB - ratingA;

        return String(a.id).localeCompare(String(b.id));
      });
    }

    const total = advocatesWithDistance.length;
    const paginated = advocatesWithDistance.slice(skip, skip + take);

    const cleanAdvocates = paginated.map(adv => {
      const {
        pincode: _p,
        latitude: _lat,
        longitude: _lng,
        officeLatitude: _olat,
        officeLongitude: _olng,
        completeAddress: _ca,
        _count,
        ...cleanAdv
      } = adv;
      cleanAdv.officeAddress = adv.officeAddress || adv.completeAddress || null;
      cleanAdv.likeCount = _count?.likes ?? 0;
      cleanAdv.isSaved = savedLawyerIds.has(adv.id);
      cleanAdv.isLiked = likedAdvocateIds.has(adv.id);
      cleanAdv.isOnline = computeEffectiveOnlineStatus(adv.isOnline, adv.lastSeenAt);
      cleanAdv.lastSeenAt = adv.lastSeenAt;
      cleanAdv.callAvailability = adv.callAvailability ?? false;
      cleanAdv.voiceCallPricePer15Min = adv.voiceCallPricePer15Min !== null ? Number(adv.voiceCallPricePer15Min) : null;
      cleanAdv.videoCallPricePer15Min = adv.videoCallPricePer15Min !== null ? Number(adv.videoCallPricePer15Min) : null;
      cleanAdv.offlineVisitingFee = adv.offlineVisitingFee !== null ? Number(adv.offlineVisitingFee) : null;
      cleanAdv.officeVisitDurationMinutes = adv.officeVisitDurationMinutes !== null ? adv.officeVisitDurationMinutes : null;
      cleanAdv.pricing = formatPricingSummary(adv);
      cleanAdv.distance = adv.distance;
      cleanAdv.distanceTier = adv.distanceTier;
      cleanAdv.distanceLabel = adv.distanceLabel;
      return cleanAdv;
    });

    return {
      location: {
        pincode: cleanSearchPincode,
        resolved: locationResolved,
        source: locationSource
      },
      areaSummary,
      advocates: cleanAdvocates,
      pagination: {
        page: parseInt(page, 10),
        limit: take,
        total,
        totalPages: Math.ceil(total / take)
      }
    };
  }

  // 5. Branch B: Standard Flow without pincode query
  const refCoords = userCoords;
  const isSortingByDefault = !sort || sort === '';
  const sortByDistance = refCoords && isSortingByDefault;

  if (sortByDistance) {
    const allAdvocates = await prisma.advocate.findMany({
      where,
      select: selectFields
    });
    const advCoordsList = await resolveAdvocateCoordinatesBatch(allAdvocates);

    const advocatesWithDistance = allAdvocates.map((adv, idx) => {
      const coords = advCoordsList[idx];
      let distance = Infinity;
      if (coords) {
        distance = calculateHaversineDistance(
          refCoords.latitude,
          refCoords.longitude,
          coords.latitude,
          coords.longitude
        );
      }
      return { ...adv, distance };
    });

    advocatesWithDistance.sort((a, b) => a.distance - b.distance);

    const total = advocatesWithDistance.length;
    const paginated = advocatesWithDistance.slice(skip, skip + take);

    const cleanAdvocates = paginated.map(adv => {
      const {
        pincode: _p,
        latitude: _lat,
        longitude: _lng,
        officeLatitude: _olat,
        officeLongitude: _olng,
        completeAddress: _ca,
        _count,
        ...cleanAdv
      } = adv;
      cleanAdv.officeAddress = adv.officeAddress || adv.completeAddress || null;
      cleanAdv.distance = adv.distance !== Infinity ? parseFloat(adv.distance.toFixed(2)) : null;
      cleanAdv.likeCount = _count?.likes ?? 0;
      cleanAdv.isSaved = savedLawyerIds.has(adv.id);
      cleanAdv.isLiked = likedAdvocateIds.has(adv.id);
      cleanAdv.isOnline = computeEffectiveOnlineStatus(adv.isOnline, adv.lastSeenAt);
      cleanAdv.lastSeenAt = adv.lastSeenAt;
      cleanAdv.callAvailability = adv.callAvailability ?? false;
      cleanAdv.voiceCallPricePer15Min = adv.voiceCallPricePer15Min !== null ? Number(adv.voiceCallPricePer15Min) : null;
      cleanAdv.videoCallPricePer15Min = adv.videoCallPricePer15Min !== null ? Number(adv.videoCallPricePer15Min) : null;
      cleanAdv.offlineVisitingFee = adv.offlineVisitingFee !== null ? Number(adv.offlineVisitingFee) : null;
      cleanAdv.officeVisitDurationMinutes = adv.officeVisitDurationMinutes !== null ? adv.officeVisitDurationMinutes : null;
      cleanAdv.pricing = formatPricingSummary(adv);
      return cleanAdv;
    });

    return {
      advocates: cleanAdvocates,
      pagination: {
        page: parseInt(page, 10),
        limit: take,
        total,
        totalPages: Math.ceil(total / take)
      }
    };
  }

  // Database-level pagination/sorting
  const [total, advocates] = await prisma.$transaction([
    prisma.advocate.count({ where }),
    prisma.advocate.findMany({
      where,
      skip,
      take,
      orderBy,
      select: selectFields
    })
  ]);

  let advCoordsList = [];
  if (refCoords) {
    advCoordsList = await resolveAdvocateCoordinatesBatch(advocates);
  }

  const cleanAdvocates = advocates.map((adv, idx) => {
    const {
      pincode: _p,
      latitude: _lat,
      longitude: _lng,
      officeLatitude: _olat,
      officeLongitude: _olng,
      completeAddress: _ca,
      _count,
      ...cleanAdv
    } = adv;
    cleanAdv.officeAddress = adv.officeAddress || adv.completeAddress || null;
    if (refCoords) {
      const coords = advCoordsList[idx];
      if (coords) {
        const distance = calculateHaversineDistance(
          refCoords.latitude,
          refCoords.longitude,
          coords.latitude,
          coords.longitude
        );
        cleanAdv.distance = parseFloat(distance.toFixed(2));
      } else {
        cleanAdv.distance = null;
      }
    } else {
      cleanAdv.distance = null;
    }
    cleanAdv.likeCount = _count?.likes ?? 0;
    cleanAdv.isSaved = savedLawyerIds.has(adv.id);
    cleanAdv.isLiked = likedAdvocateIds.has(adv.id);
    cleanAdv.isOnline = computeEffectiveOnlineStatus(adv.isOnline, adv.lastSeenAt);
    cleanAdv.lastSeenAt = adv.lastSeenAt;
    cleanAdv.callAvailability = adv.callAvailability ?? false;
    cleanAdv.voiceCallPricePer15Min = adv.voiceCallPricePer15Min !== null ? Number(adv.voiceCallPricePer15Min) : null;
    cleanAdv.videoCallPricePer15Min = adv.videoCallPricePer15Min !== null ? Number(adv.videoCallPricePer15Min) : null;
    cleanAdv.offlineVisitingFee = adv.offlineVisitingFee !== null ? Number(adv.offlineVisitingFee) : null;
    cleanAdv.officeVisitDurationMinutes = adv.officeVisitDurationMinutes !== null ? adv.officeVisitDurationMinutes : null;
    cleanAdv.pricing = formatPricingSummary(adv);
    return cleanAdv;
  });

  return {
    advocates: cleanAdvocates,
    pagination: {
      page: parseInt(page, 10),
      limit: take,
      total,
      totalPages: Math.ceil(total / take)
    }
  };
};

/**
 * Gets the complete public details of an active advocate.
 */
export const getAdvocateDetailsPublic = async (id, currentUserId) => {
  const advocate = await prisma.advocate.findUnique({
    where: { id },
    include: {
      _count: {
        select: { likes: true }
      }
    }
  });

  if (!advocate || !advocate.isActive || advocate.status !== 'ACTIVE' || advocate.approvalStatus !== 'APPROVED' || advocate.deletionStatus === 'PENDING') {
    const error = new Error('Advocate not found.');
    error.statusCode = 404;
    throw error;
  }

  // Determine if saved/liked by current user
  let isSaved = false;
  let isLiked = false;
  if (currentUserId) {
    const [saved, liked] = await prisma.$transaction([
      prisma.savedLawyer.findFirst({
        where: { userId: currentUserId, advocateId: id }
      }),
      prisma.advocateLike.findFirst({
        where: { userId: currentUserId, advocateId: id }
      })
    ]);
    isSaved = !!saved;
    isLiked = !!liked;
  }

  // Fetch confirmed, ACTIVE team mates
  const rawTeam = await getTeamMates(id);
  const seenIds = new Set();
  const team = [];
  for (const member of rawTeam) {
    if (member && member.id && !seenIds.has(member.id)) {
      seenIds.add(member.id);
      team.push(member);
    }
  }

  // Exclude all sensitive details
  return {
    id: advocate.id,
    name: advocate.fullName,
    fullName: advocate.fullName,
    barId: advocate.barCouncilId,
    barCouncilId: advocate.barCouncilId,
    profileImage: advocate.profilePhotoUrl,
    profilePhotoUrl: advocate.profilePhotoUrl,
    gender: advocate.gender,
    experienceYears: advocate.experienceYears,
    experience: advocate.experienceYears,
    casesHandled: advocate.casesHandled,
    practiceAreas: advocate.practiceAreas,
    topCourtPractised: advocate.topCourtPractised,
    bestPracticeArea: advocate.bestPracticeArea,
    lawType: advocate.bestPracticeArea || (advocate.practiceAreas?.[0] || null),
    about: advocate.about,
    bio: advocate.about,
    courtPractice: advocate.courtPractice,
    languagesSpoken: advocate.languagesSpoken,
    state: advocate.state,
    city: advocate.city,
    pincode: advocate.pincode,
    voiceCallPricePer15Min: advocate.voiceCallPricePer15Min !== null ? Number(advocate.voiceCallPricePer15Min) : null,
    videoCallPricePer15Min: advocate.videoCallPricePer15Min !== null ? Number(advocate.videoCallPricePer15Min) : null,
    offlineVisitingFee: advocate.offlineVisitingFee !== null ? Number(advocate.offlineVisitingFee) : null,
    officeVisitDurationMinutes: advocate.officeVisitDurationMinutes !== null ? advocate.officeVisitDurationMinutes : null,
    pricing: formatPricingSummary(advocate),
    averageRating: advocate.averageRating,
    totalReviews: advocate.totalReviews,
    status: advocate.status,
    approvalStatus: advocate.approvalStatus,
    // TODO: remove fallback after backfill-office-address --apply
    officeAddress: advocate.officeAddress || advocate.completeAddress || null,
    officeLatitude: advocate.officeLatitude ?? null,
    officeLongitude: advocate.officeLongitude ?? null,
    officePhotoUrl: advocate.officePhotoUrl ?? null,
    office: {
      address: advocate.officeAddress || advocate.completeAddress || null,
      photoUrl: advocate.officePhotoUrl ?? null,
      latitude: advocate.officeLatitude ?? null,
      longitude: advocate.officeLongitude ?? null,
      updatedAt: advocate.officeLocationUpdatedAt ?? null
    },
    bookable: isAdvocateBookable(advocate),
    bookingModes: isAdvocateBookable(advocate) ? getBookableModes(advocate).map((m) => m.mode) : [],
    callAvailability: advocate.callAvailability ?? false,
    isOnline: computeEffectiveOnlineStatus(advocate.isOnline, advocate.lastSeenAt),
    lastSeenAt: advocate.lastSeenAt,
    likeCount: advocate._count?.likes ?? 0,
    isSaved,
    isLiked,
    team
  };
};
