# Implementation Plan: Pincode Search with Google Geocoding & Expanding-Radius Sorting

## Database Host & Environment Verification
- **PostgreSQL Host:** `ep-weathered-hat-b47xszyr-pooler.c-6.us-east-2.aws.neon.tech`
- **Database Name:** `neondb` (Production shared Neon instance — **strictly read-only baseline; NO test records, NO manual mutations**)
- **Read-Only Baseline Aggregates (Active + Approved Advocates):**
  - **Total Active & Approved Advocates:** `57`
  - **Advocates with office coordinates (`officeLatitude` & `officeLongitude`):** `3`
  - **Advocates with only `latitude` & `longitude` (office coords null):** `50`
  - **Advocates with neither coords, but have a `pincode`:** `4`
  - **Distinct pincodes among those 4 advocates:** `1` (`110001` — New Delhi)
  - **Advocates with neither coordinates nor pincode:** `0`
  - **Total distinct pincodes across all 57 active advocates:** `19`
    - `201301`, `110001`, `201009`, `201008`, `411001`, `400021`, `500001`, `600001`, `560001`, `110002`, `560025`, `302001`, `682011`, `682001`, `226001`, `700001`, `380001`, `400001`, `244001`

---

## 1. Current Behaviour Analysis

### 1.1 Route & Query Parameters
- **Route:** `GET /api/advocates` (mounted at `app.use('/api/advocates', advocateRoutes)` in `src/server.js:115`)
- **Query Parameters Handled Today:**
  - `page`: default `1`
  - `limit`: default `12`
  - `search`: string matching name, top court, city, state, practiceAreas
  - `sort`: allowed values `rating`, `experience`, `casesHandled`
  - `practiceArea` / `practiceAreaId`
  - `topCourtPractised` / `topCourtPractisedId`
  - `bestPracticeArea`
  - `courtPractice`
  - `state`
  - `city`
  - `experienceYears`
  - `rating`
  - `pincode`: validated today with `pincodeSchema.parse(pincode)` in `src/controllers/advocate.controller.js` (`z.string().trim().regex(/^\d{6}$/)`)

### 1.2 Coordinate Resolution (`resolvePincodeCoordinates`)
- Located in `src/services/advocate.service.js:26-60`:
  1. Checks static `PINCODE_COORDINATES` map (contains 16 hardcoded Indian metro pincodes).
  2. Falls back to database lookups:
     - `prisma.advocate.findFirst({ where: { pincode, latitude: { not: null }, longitude: { not: null } } })`
     - `prisma.user.findFirst({ where: { pincode, latitude: { not: null }, longitude: { not: null } } })`
  3. If not found in static map or database, it **throws an uncaught Error**:
     `throw new Error('Invalid pincode. Location not found for pincode: ${pincode}');`
  4. This error is caught by `error.middleware.js` (matching `isControlledError` keywords `'not found'` / `'invalid'`) and returned as `400 Bad Request`.
  5. Any valid Indian pincode outside the 16 hardcoded pincodes and existing user records currently fails with "Location not found".

### 1.3 Haversine & Distance Sorting Today
- `calculateHaversineDistance(lat1, lon1, lat2, lon2)` calculates earth distance in kilometers using $R = 6371$ km.
- Reference coordinates (`refCoords`):
  - Resolved from `pincode` query param if provided.
  - Or resolved from logged-in user (`dbUser.latitude/longitude` or `dbUser.pincode`).
- Advocate coordinates (`getAdvocateCoordinates(adv)`):
  - Currently only inspects `adv.latitude`/`adv.longitude` or `PINCODE_COORDINATES[adv.pincode]`.
  - **Does NOT check `officeLatitude` / `officeLongitude` today.**
- Distance Sorting Logic:
  - Triggered only when `refCoords` exists **AND** `isSortingByDefault` (`!sort || sort === ''`).
  - Fetches **all** matching advocates (`prisma.advocate.findMany({ where, select: selectFields })`).
  - Computes Haversine distance in memory.
  - Sorts in memory: `advocatesWithDistance.sort((a, b) => a.distance - b.distance)`.
  - In-memory pagination: `slice(skip, skip + take)`.
- Explicit Sort (`sort=rating|experience|casesHandled`):
  - Distance sorting is bypassed.
  - Prisma handles sorting and pagination directly in the database query.
  - For the returned 12 advocates, `distance` is computed against `refCoords` if available, but the list ordering is strictly governed by the sort key (e.g. rating).

### 1.4 Field Stripping & Privacy
- In both code paths (distance-sorted and DB-sorted), the following fields are stripped from the response:
  - `pincode`, `latitude`, `longitude`, `completeAddress`, `_count`.
- `officeLatitude` and `officeLongitude` are not exposed to the client.

### 1.5 Outbound HTTP Clients
- `axios` is already installed (`^1.7.4`) and widely used across `src/services/` (e.g., `sms.service.js`, `idspay.service.js`, `sandboxAuth.service.js`, `legalAi.routes.js`).
- Native Node 18+ `fetch` is also available.

---

## 2. Target Design Adapted to Real Codebase

### 2.1 Cache Table: `PincodeLocation`
We will add `PincodeLocation` to `prisma/schema.prisma`:
```prisma
model PincodeLocation {
  pincode          String   @id           // 6 digits
  latitude         Float?
  longitude        Float?
  formattedAddress String?                // e.g. "Noida, Uttar Pradesh 201301, India" (for debugging/admin)
  source           String                 // "GOOGLE"
  status           String                 // "OK" | "NOT_FOUND"
  fetchedAt        DateTime
  @@index([fetchedAt])
}
```

### 2.2 Geocoding Service (`src/services/geocoding.service.js`)
Standalone service module with function `getPincodeLocation(pincode)`:
1. **Validation:**
   - Must be a 6-digit string with first digit 1–9: `/^[1-9]\d{5}$/`.
   - If invalid format, return `{ found: false, reason: "NOT_FOUND" }`.
2. **In-Flight Deduplication:**
   - In-memory `Map<string, Promise>` (`inFlightRequests`).
   - If a request for pincode `X` is already pending, concurrent requests share the same promise, preventing redundant Google API calls.
3. **Database Cache Check:**
   - Reads `prisma.pincodeLocation.findUnique({ where: { pincode } })`.
   - Configurable TTL: `PINCODE_CACHE_TTL_DAYS` (default `30`, capped at `30` per Google Maps terms).
   - `status === "OK"`:
     - If `now - fetchedAt < TTL_MS`: returns `{ found: true, latitude, longitude, source: "CACHE" }`.
   - `status === "NOT_FOUND"` (negative cache):
     - Negative cache TTL is **7 days**.
     - If `now - fetchedAt < 7_DAYS_MS`: returns `{ found: false, reason: "NOT_FOUND" }`.
4. **Google Geocoding API Call (when cache missed or expired):**
   - Check `process.env.GOOGLE_MAPS_API_KEY`:
     - If key is missing: log a warning once (`[Geocoding] GOOGLE_MAPS_API_KEY is not configured; skipping external geocoding`) and proceed directly to fallbacks.
   - If key exists:
     - URL: `https://maps.googleapis.com/maps/api/geocode/json`
     - Query parameters:
       - `components=postal_code:${pincode}|country:IN`
       - `key=${GOOGLE_MAPS_API_KEY}`
     - Request timeout: `5000` ms (5 seconds), using `axios`.
     - **Security & Privacy:** The API key is **never logged**, never returned in error messages, and never embedded in log URLs.
     - Response status inspection:
       - `status === "OK"`:
         - Validate `results[0]` is in India and contains `postal_code` matching the input.
         - Extract `results[0].geometry.location` (`lat`, `lng`) and `formatted_address`.
         - Upsert into `PincodeLocation` with `status: "OK"`, `source: "GOOGLE"`, `fetchedAt: new Date()`.
         - Return `{ found: true, latitude: lat, longitude: lng, source: "GOOGLE" }`.
       - `status === "ZERO_RESULTS"`:
         - Upsert into `PincodeLocation` with `status: "NOT_FOUND"`, `source: "GOOGLE"`, `latitude: null`, `longitude: null`, `fetchedAt: new Date()`.
         - Return `{ found: false, reason: "NOT_FOUND" }`.
       - Other Google statuses (`OVER_QUERY_LIMIT`, `REQUEST_DENIED`, `INVALID_REQUEST`) or network error / timeout:
         - **Do NOT cache**.
         - Log a warning with the status name (e.g. `[Geocoding] Google Geocoding returned status OVER_QUERY_LIMIT for pincode ${pincode}`), **without logging the key**.
         - Proceed to fallbacks.
5. **Fallbacks (in order, only when Google is unavailable or key is missing):**
   - **Stale cache entry** (`status === "OK"` older than TTL). If present, return `{ found: true, latitude, longitude, source: "STALE_CACHE" }`.
   - **Hardcoded `PINCODE_COORDINATES` map** (16 Indian cities). If present, return `{ found: true, latitude, longitude, source: "FALLBACK" }`.
   - **Advocate/User DB coordinates**:
     - Check `prisma.advocate` where `pincode = ?` and coords exist.
     - Check `prisma.user` where `pincode = ?` and coords exist.
     - If present, return `{ found: true, latitude, longitude, source: "FALLBACK" }`.
   - If none found: return `{ found: false, reason: "UNAVAILABLE" }`.
6. **Logging:**
   - Log: `pincode`, `source`, Google `status`, and duration in ms. Example:
     `[Geocoding] pincode=201301 source=GOOGLE status=OK duration=142ms`

### 2.3 Advocate Location Resolution for Distance
For each advocate in the candidate set, coordinates are determined in this strict priority:
1. `officeLatitude` / `officeLongitude` (if both non-null)
2. `latitude` / `longitude` (if both non-null)
3. The advocate's `pincode` resolved via **cache-only batch lookup**:
   - Collect all distinct pincodes of advocates lacking coordinates.
   - Batch query `prisma.pincodeLocation.findMany({ where: { pincode: { in: distinctPincodes }, status: 'OK' } })`.
   - Fall back to static `PINCODE_COORDINATES` for any missing from cache.
   - **Zero Google API calls per advocate during searches** (keeps search latency under 20ms and costs zero).
4. If coordinates cannot be found from any of the three, the advocate has unknown location.

### 2.4 Distance Tiers & Sorting Behaviour
When user searches with `pincode`:
1. Resolve search pincode via `getPincodeLocation(pincode)`.
   - `NOT_FOUND` → Return HTTP **400**:
     `{ success: false, message: "We couldn't find this pincode. Please check and try again." }`
   - `UNAVAILABLE` (e.g. Google network down and no fallback) → Return HTTP **200** with existing default ordering, `location: { pincode, resolved: false, source: null }`, and all advocates assigned `UNKNOWN_DISTANCE` with `distance: null`.
2. When resolved, assign each advocate to an expanding-radius tier:

| Tier Order | `distanceTier` | `distanceLabel` | Condition |
|:---:|:---|:---|:---|
| 1 | `SAME_PINCODE` | Same pincode | `advocate.pincode === searchPincode` (string trim, case-insensitive), even if coords are null |
| 2 | `WITHIN_5_KM` | Within 5 km | Distance $\le 5.00$ km |
| 3 | `WITHIN_10_KM` | Within 10 km | $5.00 < \text{Distance} \le 10.00$ km |
| 4 | `WITHIN_25_KM` | Within 25 km | $10.00 < \text{Distance} \le 25.00$ km |
| 5 | `WITHIN_50_KM` | Within 50 km | $25.00 < \text{Distance} \le 50.00$ km |
| 6 | `WITHIN_100_KM` | Within 100 km | $50.00 < \text{Distance} \le 100.00$ km |
| 7 | `BEYOND_100_KM` | More than 100 km away | $\text{Distance} > 100.00$ km |
| 8 | `UNKNOWN_DISTANCE` | Distance not available | No coordinates could be resolved |

3. **Sorting Rules:**
   - **Default Sort (`!sort || sort === ''`):**
     1. Primary: `distanceTier` priority (1 to 8).
     2. Secondary: `distance` ascending (closest first).
     3. Tie-breaker: `averageRating` desc, then `id` asc (deterministic).
   - **Explicit Sort (`sort=rating|experience|casesHandled`):**
     - Maintain existing behaviour: the explicit sort determines the list order across the whole set.
     - Every returned advocate still has `distance`, `distanceTier`, and `distanceLabel` computed and attached.
4. **Pagination:**
   - Applied in memory after full-set sorting: `paginated = sortedAdvocates.slice(skip, skip + take)`.
   - Guarantees stable pagination with zero duplicate advocates between page 1 and page 2.
5. **Top-Level Summary & Metadata:**
   - `location`: `{ pincode: "201301", resolved: true, source: "CACHE" }`
   - `areaSummary`: Object with counts for all 8 tiers computed over the entire filtered set:
     ```json
     {
       "SAME_PINCODE": 2,
       "WITHIN_5_KM": 4,
       "WITHIN_10_KM": 3,
       "WITHIN_25_KM": 6,
       "WITHIN_50_KM": 1,
       "WITHIN_100_KM": 0,
       "BEYOND_100_KM": 38,
       "UNKNOWN_DISTANCE": 3
     }
     ```
6. **Without `pincode` parameter:**
   - Exactly preserves existing behaviour (logged-in user distance calculation if coordinates present, DB pagination when possible, no `location` or `areaSummary` keys injected).

---

## 3. Migration SQL

Timestamp: `20261104080000_add_pincode_location_cache`
File: `prisma/migrations/20261104080000_add_pincode_location_cache/migration.sql`

```sql
-- CreateTable
CREATE TABLE "PincodeLocation" (
    "pincode" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "formattedAddress" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PincodeLocation_pkey" PRIMARY KEY ("pincode")
);

-- CreateIndex
CREATE INDEX "PincodeLocation_fetchedAt_idx" ON "PincodeLocation"("fetchedAt");
```

---

## 4. Environment Variables (`.env.example`)

Add the following placeholders to `.env.example`:
```env
# Google Maps Geocoding API (Server-side only; never expose to frontend or log)
GOOGLE_MAPS_API_KEY=
PINCODE_CACHE_TTL_DAYS=30
```

---

## 5. Files to Change / Create (Strict Whitelist)

### New Files Allowed:
1. `src/services/geocoding.service.js`: Standalone Geocoding service with in-flight dedupe, DB caching, negative cache, Google API call, and fallback resolution.
2. `scripts/warm-pincode-cache.js`: CLI script with `--dry-run` and `--apply` flags for pre-warming advocate pincodes.
3. `prisma/migrations/20261104080000_add_pincode_location_cache/migration.sql`: Additive SQL migration.

### Modified Files:
1. `prisma/schema.prisma`: Add `PincodeLocation` model with index on `fetchedAt`.
2. `src/services/advocate.service.js`:
   - Replace old `resolvePincodeCoordinates` with `geocodingService.getPincodeLocation`.
   - Update `getAdvocateCoordinates` to check `officeLatitude/officeLongitude` first, then `latitude/longitude`, then cache-only pincode lookup.
   - Implement tier classification, expanding-radius sorting, tie-breaker, `areaSummary`, and `location` payload.
3. `src/controllers/advocate.controller.js`:
   - Validate `pincode` with 6-digit regex starting with 1-9 (`/^[1-9]\d{5}$/`).
   - Catch `NOT_FOUND` from geocoding and return HTTP 400 `{ success: false, message: "We couldn't find this pincode. Please check and try again." }`.
4. `.env.example`: Add `GOOGLE_MAPS_API_KEY=` and `PINCODE_CACHE_TTL_DAYS=30`.
5. `README.md`: Add new Section **"38. Advocate Search by Pincode (Expanding Radius) — Postman Guide"**.

---

## 6. Request & Response Samples

### 6.1 Confirmation of Complete Backward Compatibility

#### Current (Before) Response — `GET /api/advocates?page=1&limit=2`
```json
{
  "success": true,
  "advocates": [
    {
      "id": "673f8e5b-c2e3-4d7a-8b89-b1d8f7a6e111",
      "fullName": "Adv. Rajesh Sharma",
      "profilePhotoUrl": "https://res.cloudinary.com/.../profile.jpg",
      "experienceYears": 14,
      "casesHandled": 120,
      "practiceAreas": ["Civil", "Corporate"],
      "topCourtPractised": "Delhi High Court",
      "bestPracticeArea": "Civil",
      "courtPractice": ["Delhi High Court", "Tis Hazari Court"],
      "languagesSpoken": ["English", "Hindi"],
      "state": "Delhi",
      "city": "New Delhi",
      "voiceCallPricePer15Min": 500,
      "videoCallPricePer15Min": 800,
      "offlineVisitingFee": 1500,
      "officeVisitDurationMinutes": 30,
      "averageRating": 4.8,
      "totalReviews": 24,
      "officeAddress": "Chamber 214, Western Wing, Tis Hazari Courts",
      "distance": null,
      "likeCount": 15,
      "isSaved": false,
      "isLiked": false,
      "isOnline": true,
      "lastSeenAt": "2026-11-04T06:30:00.000Z",
      "callAvailability": true,
      "pricing": {
        "voice": { "available": true, "pricePer15Min": 500 },
        "video": { "available": true, "pricePer15Min": 800 },
        "offline": { "available": true, "fee": 1500, "durationMinutes": 30 }
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 2,
    "total": 57,
    "totalPages": 29
  }
}
```

#### New (After) Response — Without `pincode` (Zero Changes for Existing Callers)
- Exactly identical to before. Existing clients and frontend screens experience 0 breaking changes.

#### New (After) Response — With `pincode=201301` (`GET /api/advocates?pincode=201301&page=1&limit=2`)
```json
{
  "success": true,
  "location": {
    "pincode": "201301",
    "resolved": true,
    "source": "CACHE"
  },
  "areaSummary": {
    "SAME_PINCODE": 1,
    "WITHIN_5_KM": 2,
    "WITHIN_10_KM": 4,
    "WITHIN_25_KM": 12,
    "WITHIN_50_KM": 18,
    "WITHIN_100_KM": 2,
    "BEYOND_100_KM": 16,
    "UNKNOWN_DISTANCE": 2
  },
  "advocates": [
    {
      "id": "673f8e5b-c2e3-4d7a-8b89-b1d8f7a6e111",
      "fullName": "Adv. Rajesh Sharma",
      "profilePhotoUrl": "https://res.cloudinary.com/.../profile.jpg",
      "experienceYears": 14,
      "casesHandled": 120,
      "practiceAreas": ["Civil", "Corporate"],
      "topCourtPractised": "Delhi High Court",
      "bestPracticeArea": "Civil",
      "courtPractice": ["Delhi High Court", "Tis Hazari Court"],
      "languagesSpoken": ["English", "Hindi"],
      "state": "Uttar Pradesh",
      "city": "Noida",
      "voiceCallPricePer15Min": 500,
      "videoCallPricePer15Min": 800,
      "offlineVisitingFee": 1500,
      "officeVisitDurationMinutes": 30,
      "averageRating": 4.8,
      "totalReviews": 24,
      "officeAddress": "Sector 18, Noida",
      "distance": 0,
      "distanceTier": "SAME_PINCODE",
      "distanceLabel": "Same pincode",
      "likeCount": 15,
      "isSaved": false,
      "isLiked": false,
      "isOnline": true,
      "lastSeenAt": "2026-11-04T06:30:00.000Z",
      "callAvailability": true,
      "pricing": {
        "voice": { "available": true, "pricePer15Min": 500 },
        "video": { "available": true, "pricePer15Min": 800 },
        "offline": { "available": true, "fee": 1500, "durationMinutes": 30 }
      }
    },
    {
      "id": "994a1d2e-f3b4-4c8d-9a01-c2e4f5a6b789",
      "fullName": "Adv. Priya Verma",
      "profilePhotoUrl": null,
      "experienceYears": 8,
      "casesHandled": 65,
      "practiceAreas": ["Family", "Matrimonial"],
      "topCourtPractised": "District Court Noida",
      "bestPracticeArea": "Family",
      "courtPractice": ["District Court Noida"],
      "languagesSpoken": ["English", "Hindi"],
      "state": "Uttar Pradesh",
      "city": "Noida",
      "voiceCallPricePer15Min": 400,
      "videoCallPricePer15Min": 600,
      "offlineVisitingFee": 1000,
      "officeVisitDurationMinutes": 30,
      "averageRating": 4.6,
      "totalReviews": 18,
      "officeAddress": "Sector 62, Noida",
      "distance": 4.25,
      "distanceTier": "WITHIN_5_KM",
      "distanceLabel": "Within 5 km",
      "likeCount": 8,
      "isSaved": false,
      "isLiked": false,
      "isOnline": false,
      "lastSeenAt": "2026-11-04T05:15:00.000Z",
      "callAvailability": false,
      "pricing": {
        "voice": { "available": true, "pricePer15Min": 400 },
        "video": { "available": true, "pricePer15Min": 600 },
        "offline": { "available": true, "fee": 1000, "durationMinutes": 30 }
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 2,
    "total": 57,
    "totalPages": 29
  }
}
```

### 6.2 Error Case: Invalid Pincode (`GET /api/advocates?pincode=000000` or `999999`)
- **HTTP Status:** `400 Bad Request`
- **Response Body:**
```json
{
  "success": false,
  "message": "We couldn't find this pincode. Please check and try again."
}
```

### 6.3 Graceful Degradation: Google Geocoding Unavailable / Timeout
- When Google is down, quota exhausted, or network unreachable and no fallback exists for the searched pincode:
- **HTTP Status:** `200 OK` (Does not crash or fail the search)
- **Response Body:**
```json
{
  "success": true,
  "location": {
    "pincode": "201301",
    "resolved": false,
    "source": null
  },
  "areaSummary": {
    "SAME_PINCODE": 0,
    "WITHIN_5_KM": 0,
    "WITHIN_10_KM": 0,
    "WITHIN_25_KM": 0,
    "WITHIN_50_KM": 0,
    "WITHIN_100_KM": 0,
    "BEYOND_100_KM": 0,
    "UNKNOWN_DISTANCE": 57
  },
  "advocates": [ ... advocates in default database sort, each with distance: null, distanceTier: "UNKNOWN_DISTANCE", distanceLabel: "Distance not available" ... ],
  "pagination": { "page": 1, "limit": 12, "total": 57, "totalPages": 5 }
}
```

---

## 7. Performance & Scalability Analysis

### 7.1 Current Database vs ~1,000 Advocates
- **Current DB:** 57 advocates. In-memory Haversine and sorting takes `< 1ms`.
- **At 1,000 Advocates:**
  - Query selects only `id, officeLatitude, officeLongitude, latitude, longitude, pincode` along with standard presentation fields.
  - Distinct advocate pincodes in India at 1,000 advocates will typically be ~150–250.
  - Batch DB read `prisma.pincodeLocation.findMany({ where: { pincode: { in: [...] } } })` takes `~3–5ms`.
  - 1,000 Haversine calculations in Node.js take `< 1ms`.
  - Array sort of 1,000 items takes `< 1ms`.
  - Total overhead added: `< 10ms`.

### 7.2 At 10,000 Advocates & PostGIS Trigger Point
- **At 10,000 Advocates:**
  - Fetching 10,000 records across the network to Node.js memory consumes ~25–40MB and ~50–80ms of latency per search request.
  - **When PostGIS is needed:** When active advocates exceed ~5,000–10,000 records or concurrent search traffic exceeds ~100 req/sec.
  - **Future PostGIS Architecture:**
    - Enable `postgis` extension on PostgreSQL.
    - Add `coordinates GEOGRAPHY(Point, 4326)` column with GiST spatial index.
    - Query using `ST_DWithin` and `ORDER BY ST_Distance`, offloading spatial sorting and database-level `LIMIT`/`OFFSET` pagination entirely to PostgreSQL.

### 7.3 Google API Quota & Cost Protection
- **Google Maps Geocoding Pricing:** \$5.00 per 1,000 requests.
- **Cache Shielding:**
  - `PincodeLocation` caches coordinates for 30 days (maximum permitted by Google terms).
  - Repeated user searches for the same pincode incur **zero Google API calls** and resolve in `< 2ms` from Postgres.
  - Negative cache (7 days) prevents repeated calls for non-existent pincodes.
  - In-flight deduplication prevents concurrent duplicate hits.
- **Cache Warm Script:**
  - Distinct pincodes in the entire database today: 19.
  - Pre-warming all active advocate pincodes requires at most 19 Google Geocoding calls (~$0.095, well within the $200/month free tier).

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|:---|:---|:---|
| **Google Maps API Key Leak** | High Security Risk | Server-side only; never passed to frontend; never logged; Axios request URLs redacted in logs. |
| **Google Geocoding Outage / Quota Exceeded** | Availability Risk | Graceful fallback pipeline: Stale Cache $\rightarrow$ Static Map $\rightarrow$ Existing DB Coords. If all fail, search returns 200 with default ordering and `resolved: false`. |
| **Search Latency Degradation** | User Experience | Zero Google calls during advocate iteration (cache-only batch lookup). Single Google call allowed only for the search input pincode. |
| **Database Migration Locking** | Production Disruption | Additive migration only: creates new `PincodeLocation` table with index. Zero alterations or locks on existing `Advocate` or `User` tables. |
| **Frontend Breaking Changes** | Client Failure | Response schema remains strictly backward-compatible. Existing keys unchanged; new keys are additive. |

---

## 9. Answers to Open Questions

### Question 1: With an explicit sort (rating etc.) + pincode: keep "sort wins", or sort by tier first and then by the chosen sort inside each tier?
- **Analysis:**
  - **Option A (Sort Wins — Recommended / Default):** If a user explicitly clicks "Sort by Rating (Highest first)", they expect the highest rated advocate in the entire filtered results to appear at #1, regardless of whether they are 2 km or 15 km away. Each advocate still displays their `distanceTier` and `distanceLabel` ("Within 5 km", "Within 25 km"). This matches existing system behaviour.
  - **Option B (Tier First, then Sort within Tier):** Tier 1 (Same Pincode) sorted by rating, then Tier 2 (Within 5 km) sorted by rating, etc.
- **Recommendation:** **Option A (Keep today's behaviour: Sort Wins)**. If `sort` is specified, the explicit sort governs the order across the whole result set, with distance and tiers calculated and returned. When `sort` is omitted (default search), expanding radius tier ordering applies.

### Question 2: Should the search pincode cache also be used later for registration (auto city/state)?
- **Analysis:**
  - `PincodeLocation` stores `pincode`, `latitude`, `longitude`, `formattedAddress`, `source`, `status`, and `fetchedAt`.
  - Future registration endpoints can simply call `geocodingService.getPincodeLocation(pincode)` to resolve city/state from `formattedAddress` or reverse lookup.
- **Recommendation:** **Default: Not in this task.** The `geocoding.service.js` is designed as a standalone, modular service so registration or address backfills can import and reuse it in a future task without refactoring.

---

## 10. Next Steps & Execution Plan (Pending Approval)

1. **Wait for Approval:**
   - Wait for user's explicit "approved" before creating files or running migrations.
2. **Execute Schema & Migration:**
   - Add `PincodeLocation` to `prisma/schema.prisma`.
   - Run `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` to verify SQL.
   - Show migration SQL and wait for user's "OK" before running `npx prisma migrate deploy`.
   - Run `npx prisma generate`.
3. **Implement Services & Controllers:**
   - Create `src/services/geocoding.service.js`.
   - Update `src/services/advocate.service.js` (location priority, cache-only advocate pincode lookup, tier assignment, tie-breaker, `areaSummary`, `location`).
   - Update `src/controllers/advocate.controller.js` (validation, 400 on `NOT_FOUND`, pass through metadata).
   - Create `scripts/warm-pincode-cache.js` (`--dry-run` and `--apply`).
   - Update `.env.example`.
4. **Unit Verification (Stubbed HTTP & Prisma):**
   - Syntax validation (`node --check`).
   - Verify cache hit/miss/expiry, in-flight dedupe, fallback chain, tier boundaries (5.00 vs 5.01, 100.01), SAME_PINCODE with null coords, pagination stability, explicit sort, and lat/lng redaction.
5. **Run Dry-Run Script:**
   - Run `node scripts/warm-pincode-cache.js --dry-run` and display output.
6. **Documentation:**
   - Update `README.md` with Section 38 Postman Guide and Cloud setup checklist.
