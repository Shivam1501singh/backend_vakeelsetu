import axios from 'axios';
import prisma from '../lib/prisma.js';

export const PINCODE_COORDINATES = {
  '110001': { latitude: 28.6304, longitude: 77.2177 }, // New Delhi (Connaught Place)
  '110002': { latitude: 28.6438, longitude: 77.2415 }, // Daryaganj
  '400001': { latitude: 18.9696, longitude: 72.8230 }, // Mumbai (Fort)
  '400021': { latitude: 18.9256, longitude: 72.8242 }, // Nariman Point
  '411001': { latitude: 18.5284, longitude: 73.8739 }, // Pune
  '560001': { latitude: 12.9716, longitude: 77.5946 }, // Bengaluru
  '560025': { latitude: 12.9619, longitude: 77.6015 }, // Richmond Town
  '600001': { latitude: 13.0827, longitude: 80.2707 }, // Chennai
  '700001': { latitude: 22.5726, longitude: 88.3639 }, // Kolkata
  '201301': { latitude: 28.5800, longitude: 77.3300 }, // Noida
  '226001': { latitude: 26.8467, longitude: 80.9462 }, // Lucknow
  '380001': { latitude: 23.0225, longitude: 72.5714 }, // Ahmedabad
  '302001': { latitude: 26.9124, longitude: 75.7873 }, // Jaipur
  '500001': { latitude: 17.3850, longitude: 78.4867 }, // Hyderabad
  '682001': { latitude: 9.9816, longitude: 76.2999 },  // Kochi
  '682011': { latitude: 9.9700, longitude: 76.2800 }   // Kochi Ernakulam
};

const inFlightRequests = new Map();
let hasLoggedKeyWarning = false;

const getTtlDays = () => {
  const configured = parseInt(process.env.PINCODE_CACHE_TTL_DAYS || '30', 10);
  if (isNaN(configured) || configured <= 0) return 30;
  return Math.min(configured, 30); // Google terms: max 30 days
};

/**
 * Validates Indian postal PIN code format: 6 digits, first digit 1-9.
 */
export const isValidPincode = (pincode) => {
  if (typeof pincode !== 'string') return false;
  return /^[1-9]\d{5}$/.test(pincode.trim());
};

/**
 * Execute fallbacks in strict order:
 * 1. Stale cache row with status OK
 * 2. Hardcoded PINCODE_COORDINATES
 */
const resolveFallbacks = async (cleanPincode, staleCacheRow) => {
  // 1. Stale cache row
  if (staleCacheRow && staleCacheRow.status === 'OK' && staleCacheRow.latitude !== null && staleCacheRow.longitude !== null) {
    return {
      found: true,
      latitude: staleCacheRow.latitude,
      longitude: staleCacheRow.longitude,
      source: 'STALE_CACHE'
    };
  }

  // 2. Static hardcoded map
  if (PINCODE_COORDINATES[cleanPincode]) {
    const coords = PINCODE_COORDINATES[cleanPincode];
    return {
      found: true,
      latitude: coords.latitude,
      longitude: coords.longitude,
      source: 'FALLBACK'
    };
  }

  return { found: false, reason: 'UNAVAILABLE' };
};

const resolveNominatim = async (cleanPincode) => {
  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { postalcode: cleanPincode, country: 'India', format: 'json' },
      headers: { 'User-Agent': 'VakeelsetuBackend/1.0' },
      timeout: 5000
    });
    if (Array.isArray(res.data) && res.data.length > 0) {
      const item = res.data[0];
      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lon);
      if (!isNaN(lat) && !isNaN(lon)) {
        try {
          await prisma.pincodeLocation.upsert({
            where: { pincode: cleanPincode },
            update: {
              latitude: lat,
              longitude: lon,
              formattedAddress: item.display_name || null,
              source: 'NOMINATIM',
              status: 'OK',
              fetchedAt: new Date()
            },
            create: {
              pincode: cleanPincode,
              latitude: lat,
              longitude: lon,
              formattedAddress: item.display_name || null,
              source: 'NOMINATIM',
              status: 'OK',
              fetchedAt: new Date()
            }
          });
        } catch (dbErr) {
          console.warn(`[Geocoding] Could not cache NOMINATIM location for ${cleanPincode}:`, dbErr.message);
        }
        return {
          found: true,
          latitude: lat,
          longitude: lon,
          source: 'NOMINATIM'
        };
      }
    }
  } catch (err) {
    console.warn(`[Geocoding] Nominatim lookup failed for pincode ${cleanPincode}:`, err.message);
  }
  return null;
};

const _resolvePincodeLocation = async (cleanPincode) => {
  const startTime = Date.now();
  const ttlDays = getTtlDays();
  const okTtlMs = ttlDays * 24 * 60 * 60 * 1000;
  const notFoundTtlMs = 7 * 24 * 60 * 60 * 1000; // 7 days negative cache

  // 1. Check Database Cache
  let cached = null;
  try {
    cached = await prisma.pincodeLocation.findUnique({
      where: { pincode: cleanPincode }
    });
  } catch (dbErr) {
    console.warn(`[Geocoding] DB read error for pincode ${cleanPincode}:`, dbErr.message);
  }

  const now = Date.now();
  if (cached) {
    const ageMs = now - new Date(cached.fetchedAt).getTime();
    if (cached.status === 'OK' && ageMs <= okTtlMs && cached.latitude !== null && cached.longitude !== null) {
      const duration = Date.now() - startTime;
      console.log(`[Geocoding] pincode=${cleanPincode} source=CACHE status=OK duration=${duration}ms`);
      return {
        found: true,
        latitude: cached.latitude,
        longitude: cached.longitude,
        source: 'CACHE'
      };
    }

    if (cached.status === 'NOT_FOUND' && ageMs <= notFoundTtlMs) {
      const duration = Date.now() - startTime;
      console.log(`[Geocoding] pincode=${cleanPincode} source=CACHE status=NOT_FOUND duration=${duration}ms`);
      return {
        found: false,
        reason: 'NOT_FOUND'
      };
    }
  }

  // 2. Google Geocoding API Call
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    if (!hasLoggedKeyWarning) {
      hasLoggedKeyWarning = true;
      console.warn('[Geocoding] GOOGLE_MAPS_API_KEY is missing. Trying Nominatim, then fallbacks.');
    }
    const nominatimRes = await resolveNominatim(cleanPincode);
    if (nominatimRes) {
      const duration = Date.now() - startTime;
      console.log(`[Geocoding] pincode=${cleanPincode} source=NOMINATIM status=OK duration=${duration}ms`);
      return nominatimRes;
    }
    const fallbackRes = await resolveFallbacks(cleanPincode, cached);
    const duration = Date.now() - startTime;
    console.log(`[Geocoding] pincode=${cleanPincode} source=${fallbackRes.source || 'NONE'} status=KEY_MISSING duration=${duration}ms`);
    return fallbackRes;
  }

  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        components: `postal_code:${cleanPincode}|country:IN`,
        key: apiKey
      },
      timeout: 5000
    });

    const googleStatus = response.data?.status;

    if (googleStatus === 'OK') {
      const result = response.data.results?.[0];
      const location = result?.geometry?.location;

      // Validate result is in India and contains/matches postal code
      const isIndia = result?.address_components?.some(
        c => c.types?.includes('country') && (c.short_name === 'IN' || c.long_name === 'India')
      );
      const isPostalCode = result?.types?.includes('postal_code') ||
        result?.address_components?.some(c => c.types?.includes('postal_code') && c.short_name?.includes(cleanPincode));

      if (location && typeof location.lat === 'number' && typeof location.lng === 'number' && (isIndia !== false || isPostalCode)) {
        const formattedAddress = result.formatted_address || null;
        try {
          await prisma.pincodeLocation.upsert({
            where: { pincode: cleanPincode },
            update: {
              latitude: location.lat,
              longitude: location.lng,
              formattedAddress,
              source: 'GOOGLE',
              status: 'OK',
              fetchedAt: new Date()
            },
            create: {
              pincode: cleanPincode,
              latitude: location.lat,
              longitude: location.lng,
              formattedAddress,
              source: 'GOOGLE',
              status: 'OK',
              fetchedAt: new Date()
            }
          });
        } catch (saveErr) {
          console.warn(`[Geocoding] Could not cache OK location for ${cleanPincode}:`, saveErr.message);
        }

        const duration = Date.now() - startTime;
        console.log(`[Geocoding] pincode=${cleanPincode} source=GOOGLE status=OK duration=${duration}ms`);
        return {
          found: true,
          latitude: location.lat,
          longitude: location.lng,
          source: 'GOOGLE'
        };
      }
    }

    if (googleStatus === 'ZERO_RESULTS') {
      try {
        await prisma.pincodeLocation.upsert({
          where: { pincode: cleanPincode },
          update: {
            latitude: null,
            longitude: null,
            formattedAddress: null,
            source: 'GOOGLE',
            status: 'NOT_FOUND',
            fetchedAt: new Date()
          },
          create: {
            pincode: cleanPincode,
            latitude: null,
            longitude: null,
            formattedAddress: null,
            source: 'GOOGLE',
            status: 'NOT_FOUND',
            fetchedAt: new Date()
          }
        });
      } catch (saveErr) {
        console.warn(`[Geocoding] Could not cache NOT_FOUND for ${cleanPincode}:`, saveErr.message);
      }

      const duration = Date.now() - startTime;
      console.log(`[Geocoding] pincode=${cleanPincode} source=GOOGLE status=ZERO_RESULTS duration=${duration}ms`);
      return {
        found: false,
        reason: 'NOT_FOUND'
      };
    }

    // Non-fatal Google statuses (OVER_QUERY_LIMIT, REQUEST_DENIED, INVALID_REQUEST, UNKNOWN_ERROR):
    // Do NOT cache. Log status without logging key, and fall through.
    console.warn(`[Geocoding] Google Geocoding returned non-success status: ${googleStatus} for pincode ${cleanPincode}`);
  } catch (netErr) {
    const errorStatus = netErr.response?.data?.status || netErr.code || netErr.message;
    console.warn(`[Geocoding] Google Geocoding call failed for pincode ${cleanPincode} (${errorStatus})`);
  }

  // 3. Fallbacks: Try Nominatim, then static fallbacks
  const nominatimRes = await resolveNominatim(cleanPincode);
  if (nominatimRes) {
    const duration = Date.now() - startTime;
    console.log(`[Geocoding] pincode=${cleanPincode} source=NOMINATIM status=OK duration=${duration}ms`);
    return nominatimRes;
  }

  const fallbackRes = await resolveFallbacks(cleanPincode, cached);
  const duration = Date.now() - startTime;
  console.log(`[Geocoding] pincode=${cleanPincode} source=${fallbackRes.source || 'NONE'} duration=${duration}ms`);
  return fallbackRes;
};

/**
 * Resolves coordinates for a pincode with in-flight deduplication and caching.
 *
 * @param {string} pincode
 * @returns {Promise<{ found: boolean, latitude?: number, longitude?: number, source?: string, reason?: string }>}
 */
export const getPincodeLocation = async (pincode) => {
  if (!pincode) {
    return { found: false, reason: 'NOT_FOUND' };
  }

  const cleanPincode = String(pincode).trim();
  if (!isValidPincode(cleanPincode)) {
    return { found: false, reason: 'NOT_FOUND' };
  }

  if (inFlightRequests.has(cleanPincode)) {
    return inFlightRequests.get(cleanPincode);
  }

  const promise = _resolvePincodeLocation(cleanPincode);
  inFlightRequests.set(cleanPincode, promise);

  try {
    return await promise;
  } finally {
    inFlightRequests.delete(cleanPincode);
  }
};

