// TravelAI server: Express app composed from src/ modules. Routes live here;
// helpers/services/middleware are imported. See ARCHITECTURE.md.

const crypto = require('crypto');
const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const cfg = require('./src/config');
const { log } = require('./src/utils/log');
const { escapeHtml } = require('./src/utils/escape');
const { sanitizeText, sanitizeInterests } = require('./src/utils/sanitize');
const { securityHeaders, buildOriginGuard } = require('./src/middleware/security');
const { createRateLimiter } = require('./src/middleware/rateLimit');
const { TtlLruCache } = require('./src/services/cache');
const gemini = require('./src/services/gemini');
const maps = require('./src/services/maps');
const mailer = require('./src/services/mailer');
const auth = require('./src/services/auth');
const { SavedItineraryStore } = require('./src/services/storage');
const { translateItinerary } = require('./src/services/translate');
const {
  normalizeCityName,
  sanitizeStops,
  buildCityPlan,
  applyCityPlanToItinerary
} = require('./lib/trip-planner-utils');

if (!cfg.isCloudRun) dotenv.config();

const APP_VERSION = require('./package.json').version;
const APP_START_TIME = Date.now();
const PORT = process.env.PORT || 3000;

// === App + middleware wiring ===

const app = express();
app.disable('x-powered-by');
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 1);
app.set('trust proxy', Number.isFinite(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);

const allowedOrigins = cfg.getAllowedOrigins();
const originGuardEnabled = !['off', 'false', '0'].includes(
  String(cfg.envValue('ORIGIN_GUARD') || '').toLowerCase()
);
const originGuard = buildOriginGuard({ allowedOrigins, enabled: originGuardEnabled });

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' }
}));
app.use(compression());

let requestSeq = 0;
app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || `req-${Date.now().toString(36)}-${(requestSeq++).toString(36)}`;
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  }
}));
app.use(express.json({ limit: cfg.envValue('JSON_BODY_LIMIT') || '250kb' }));
app.use(securityHeaders);
app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.css')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static('public'));

// === Caches + stores ===

const itineraryCache = new TtlLruCache({
  ttlMs: Number(cfg.envValue('ITINERARY_CACHE_TTL_MS') || 180000),
  maxEntries: Number(cfg.envValue('ITINERARY_CACHE_MAX_ENTRIES') || 500)
});

const savedStore = new SavedItineraryStore({
  maxPerScope: Number(cfg.envValue('SAVED_MAX_PER_USER') || 25)
});

const writeApiLimiter = createRateLimiter({
  windowMs: Number(cfg.envValue('API_RATE_LIMIT_WINDOW_MS') || 60000),
  maxRequests: Number(cfg.envValue('API_RATE_LIMIT_MAX') || 30)
});

// === Domain helpers (small enough to keep inline) ===

function buildItineraryCacheKey(payload) {
  const normalized = {
    fromPlace: normalizeCityName(payload.fromPlace),
    toPlace: normalizeCityName(payload.toPlace),
    destination: normalizeCityName(payload.destination),
    startDate: payload.startDate,
    endDate: payload.endDate,
    budget: Number(payload.budget || 0),
    travelers: Number(payload.travelers || 1),
    interests: sanitizeInterests(payload.interests),
    transportMode: sanitizeText(payload.transportMode || 'driving', 20).toLowerCase(),
    transportBookingRequired: Boolean(payload.transportBookingRequired),
    stops: sanitizeStops(payload.stops).map((s) => ({ city: normalizeCityName(s.city), days: Number(s.days) }))
  };
  return itineraryCache.hashKey(normalized);
}

const exposeErrorDetails = ['true', '1', 'on'].includes(
  String(cfg.envValue('EXPOSE_ERROR_DETAILS') || '').toLowerCase()
);

function formatApiError(error, fallbackMessage) {
  const providerMessage = error?.message || error?.errorDetails?.[0]?.message;
  if (providerMessage) log.error(fallbackMessage, { error: providerMessage });
  if (exposeErrorDetails && providerMessage) return `${fallbackMessage} (${providerMessage})`;
  return fallbackMessage;
}

function routeError(res, error, fallback, status = 500) {
  res.status(status).json({ success: false, error: formatApiError(error, fallback) });
}

const ITINERARY_SCHEMA = {
  required: ['tripTitle', 'summary', 'totalEstimatedCost', 'days'],
  dayRequired: ['day', 'date', 'city', 'activities'],
  activityRequired: ['time', 'title', 'description', 'location', 'lat', 'lng', 'duration', 'estimatedCost', 'category']
};

function validateItinerary(data) {
  const errors = [];
  for (const field of ITINERARY_SCHEMA.required) if (!data[field]) errors.push(`Missing top-level field: ${field}`);
  if (!Array.isArray(data.days) || data.days.length === 0) {
    errors.push('days must be a non-empty array');
    return errors;
  }
  const seen = new Set();
  data.days.forEach((day, di) => {
    for (const f of ITINERARY_SCHEMA.dayRequired) if (!day[f] && day[f] !== 0) errors.push(`Day ${di + 1}: missing ${f}`);
    if (Array.isArray(day.activities)) {
      day.activities.forEach((act, ai) => {
        for (const f of ITINERARY_SCHEMA.activityRequired) if (!act[f] && act[f] !== 0) errors.push(`Day ${di + 1}, Activity ${ai + 1}: missing ${f}`);
        const placeKey = `${act.title}-${act.location}`;
        if (seen.has(placeKey)) errors.push(`Duplicate place: ${act.title} at ${act.location}`);
        seen.add(placeKey);
        if (act.lat !== undefined && act.lat !== null && (!Number.isFinite(act.lat) || act.lat < -90 || act.lat > 90)) errors.push(`Invalid lat for ${act.title}`);
        if (act.lng !== undefined && act.lng !== null && (!Number.isFinite(act.lng) || act.lng < -180 || act.lng > 180)) errors.push(`Invalid lng for ${act.title}`);
      });
    }
  });
  return errors;
}

function enrichWithBookingLinks(itinerary) {
  if (!itinerary.days) return itinerary;
  itinerary.days.forEach((day) => {
    if (!day.activities) return;
    day.activities.forEach((act) => {
      const query = encodeURIComponent(`${act.title} ${act.location}`);
      act.bookingLinks = {
        googleMaps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(act.location)}&query_place_id=`,
        googleSearch: `https://www.google.com/search?q=${query}+booking`,
        mapsDirection: act.lat && act.lng ? `https://www.google.com/maps/dir/?api=1&destination=${act.lat},${act.lng}` : null
      };
    });
  });
  return itinerary;
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  if (m[3].toUpperCase() === 'AM' && hh === 12) hh = 0;
  if (m[3].toUpperCase() === 'PM' && hh !== 12) hh += 12;
  return hh * 60 + mm;
}

function durationTextToMinutes(d) {
  if (!d || typeof d !== 'string') return 0;
  const h = d.match(/(\d+)\s*hour/i);
  const m = d.match(/(\d+)\s*min/i);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

function getGeminiModel() {
  return gemini.getModel({ apiKey: cfg.getGeminiApiKey() });
}

async function resolveStorageScope(req) {
  const idToken = req.body?.idToken || req.get('x-id-token');
  if (idToken) {
    const user = await auth.verifyGoogleIdToken(idToken, cfg.envValue('GOOGLE_OAUTH_CLIENT_ID'));
    if (user) return { scope: `user:${user.email}`, user };
  }
  const session = sanitizeText(req.body?.sessionId || req.get('x-session-id') || '', 64);
  if (session) return { scope: `anon:${session}`, user: null };
  return null;
}

// === Routes: read-only configuration ===

app.get('/api/maps-key', (req, res) => res.json({ key: cfg.getMapsApiKeyClient() }));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    runtime: cfg.isCloudRun ? 'cloud-run' : 'local',
    version: APP_VERSION,
    uptimeSeconds: Math.round((Date.now() - APP_START_TIME) / 1000),
    geminiConfigured: cfg.hasValidGeminiKey(),
    mapsConfigured: cfg.hasValidMapsKey(),
    mailerConfigured: cfg.hasValidMailerConfig(),
    corsRestricted: allowedOrigins.length > 0,
    itineraryCacheTtlMs: Number(cfg.envValue('ITINERARY_CACHE_TTL_MS') || 180000),
    itineraryCacheSize: itineraryCache.size,
    geminiModel: 'gemini-2.5-flash-lite',
    analyticsId: cfg.envValue('GA_MEASUREMENT_ID') || null
  });
});

app.get('/api/analytics-config', (req, res) => res.json({ measurementId: cfg.envValue('GA_MEASUREMENT_ID') || null }));
app.get('/api/auth-config', (req, res) => res.json({
  googleClientId: cfg.envValue('GOOGLE_OAUTH_CLIENT_ID') || null,
  storageEnabled: true
}));

// === Routes: itinerary generation + replan ===

app.post('/api/generate-itinerary', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const fromCity = sanitizeText(req.body.fromPlace, 100);
    const toCity = sanitizeText(req.body.toPlace, 100);
    const destinationCity = sanitizeText(req.body.destination || toCity, 100);
    const startDateSafe = sanitizeText(req.body.startDate, 12);
    const endDateSafe = sanitizeText(req.body.endDate, 12);
    const budgetValue = Number(req.body.budget);
    const travelersValue = Number(req.body.travelers || 1);
    const interestsSafe = sanitizeInterests(req.body.interests || 'General sightseeing, local food, culture');
    const transportModeSafe = sanitizeText(req.body.transportMode || 'driving', 20).toLowerCase();
    const bookingRequired = Boolean(req.body.transportBookingRequired);
    const stopsSafe = sanitizeStops(req.body.stops);

    if (!toCity || !destinationCity || !startDateSafe || !endDateSafe || !Number.isFinite(budgetValue) || budgetValue <= 0) {
      return res.status(400).json({ success: false, error: 'Missing required fields. To, Destination, dates, and budget are required.' });
    }
    if (!Number.isFinite(travelersValue) || travelersValue < 1 || travelersValue > 20) {
      return res.status(400).json({ success: false, error: 'Travelers must be between 1 and 20.' });
    }
    if (normalizeCityName(toCity) !== normalizeCityName(destinationCity)) {
      return res.status(400).json({ success: false, error: 'To and Destination must be the same city.' });
    }

    let cityPlan;
    try {
      cityPlan = buildCityPlan({ destination: destinationCity, startDate: startDateSafe, endDate: endDateSafe, stops: stopsSafe });
    } catch (validationError) {
      return res.status(400).json({ success: false, error: validationError.message || 'Invalid multi-city input.' });
    }

    if (!cfg.hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured.' });
    }

    const cacheKey = buildItineraryCacheKey({
      fromPlace: fromCity, toPlace: toCity, destination: destinationCity,
      startDate: startDateSafe, endDate: endDateSafe,
      budget: budgetValue, travelers: travelersValue,
      interests: interestsSafe, transportMode: transportModeSafe,
      transportBookingRequired: bookingRequired, stops: stopsSafe
    });
    const cached = itineraryCache.get(cacheKey);
    if (cached) return res.json({ success: true, itinerary: cached, cached: true });

    const stopsText = cityPlan.stops.length > 0
      ? cityPlan.stops.map((s, i) => `${i + 1}. ${s.city} - ${s.days} day(s)`).join('\n')
      : 'none';
    const cityDaySchedule = cityPlan.cityDayPlan.map((d) => `Day ${d.day} (${d.date}): ${d.city}`).join('\n');
    const prompt = `${gemini.BASE_PROMPT}\n\nTRIP DETAILS:\n- From (optional): ${fromCity || 'not provided'}\n- To (final city): ${toCity}\n- Destination city (must match To): ${destinationCity}\n- Start Date: ${startDateSafe}\n- End Date: ${endDateSafe}\n- Total Days: ${cityPlan.totalDays}\n- Intermediate Stops:\n${stopsText}\n- City-Day Plan (must follow exactly):\n${cityDaySchedule}\n- Budget: $${budgetValue} USD total\n- Number of Travelers: ${travelersValue}\n- Interests: ${interestsSafe}\n- Preferred Transport Mode: ${transportModeSafe}\n- Need Transport Booking Options: ${bookingRequired ? 'yes' : 'no'}\n\nHard constraints:\n- Return exactly ${cityPlan.totalDays} day objects.\n- Each day object must include city and match the city-day plan exactly.\n- Keep all activities for each day inside that day's city.\n- If day city changes from previous day, include one transport activity first (category: transport).\n- Also include practical movement between activities considering the preferred transport mode.`;

    const itineraryRaw = await gemini.generateWithRetry({
      model: getGeminiModel(),
      prompt,
      timeoutMs: cfg.GEMINI_TIMEOUT_MS.generate
    });
    const itinerary = applyCityPlanToItinerary(itineraryRaw, cityPlan);
    const errors = validateItinerary(itinerary);
    if (errors.length) log.warn('itinerary validation warnings', { errors });
    const enriched = enrichWithBookingLinks(itinerary);
    itineraryCache.set(cacheKey, enriched);
    res.json({ success: true, itinerary: enriched });
  } catch (error) {
    routeError(res, error, 'Failed to generate itinerary');
  }
});

app.post('/api/replan-activity', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const { itinerary, dayIndex, activityIndex, reason } = req.body;
    const safeDayIndex = Number(dayIndex);
    const safeActivityIndex = Number(activityIndex);
    if (!itinerary || !Array.isArray(itinerary.days) || !Number.isInteger(safeDayIndex) || !Number.isInteger(safeActivityIndex)) {
      return res.status(400).json({ success: false, error: 'Missing required fields for replan.' });
    }
    const day = itinerary.days[safeDayIndex];
    if (!day || !Array.isArray(day.activities) || !day.activities[safeActivityIndex]) {
      return res.status(400).json({ success: false, error: 'Invalid day/activity index for replan.' });
    }
    if (!cfg.hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured.' });
    }
    const activity = day.activities[safeActivityIndex];
    const reasonSafe = sanitizeText(reason, 180);
    const otherActivities = day.activities.filter((_, i) => i !== safeActivityIndex).map((a) => sanitizeText(a.title, 80)).join(', ');

    const prompt = `You are a travel planner. Replace ONE activity in an itinerary.\n\nCURRENT ACTIVITY TO REPLACE:\n- Title: ${activity.title}\n- Time: ${activity.time}\n- Location: ${activity.location}\n- Category: ${sanitizeText(activity.category, 30)}\n${reasonSafe ? `- Reason for change: ${reasonSafe}` : ''}\n\nOTHER ACTIVITIES THAT DAY (avoid duplicates): ${otherActivities}\nDESTINATION: The same area/city as ${activity.location}\nBUDGET REMAINING FOR THIS SLOT: ~$${activity.estimatedCost}\n\nReturn ONLY a single JSON object for the replacement activity (no markdown, no code blocks):\n{\n  "time": "${activity.time}",\n  "title": "New activity name",\n  "description": "Brief description",\n  "location": "Full place name and area",\n  "lat": 0.0,\n  "lng": 0.0,\n  "duration": "${activity.duration}",\n  "estimatedCost": 0,\n  "category": "sightseeing|food|adventure|culture|shopping|transport|relaxation"\n}`;

    const newActivity = await gemini.generateWithRetry({
      model: getGeminiModel(),
      prompt,
      timeoutMs: cfg.GEMINI_TIMEOUT_MS.replanActivity,
      maxRetries: 0
    });

    const query = encodeURIComponent(`${newActivity.title} ${newActivity.location}`);
    newActivity.bookingLinks = {
      googleMaps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(newActivity.location)}`,
      googleSearch: `https://www.google.com/search?q=${query}+booking`,
      mapsDirection: newActivity.lat && newActivity.lng ? `https://www.google.com/maps/dir/?api=1&destination=${newActivity.lat},${newActivity.lng}` : null
    };
    itinerary.days[safeDayIndex].activities[safeActivityIndex] = newActivity;
    res.json({ success: true, itinerary, replacedActivity: activity, newActivity });
  } catch (error) {
    routeError(res, error, 'Failed to replan activity');
  }
});

app.post('/api/replan-day', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const { itinerary, dayIndex, reason } = req.body;
    const safeDayIndex = Number(dayIndex);
    if (!itinerary || !Array.isArray(itinerary.days) || !Number.isInteger(safeDayIndex)) {
      return res.status(400).json({ success: false, error: 'Missing required fields for replan day.' });
    }
    const day = itinerary.days[safeDayIndex];
    if (!day) return res.status(400).json({ success: false, error: 'Invalid day index for replan day.' });
    if (!cfg.hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured.' });
    }
    const reasonSafe = sanitizeText(reason, 220);
    const destination = day.city || day.activities?.[0]?.location || 'the destination';
    const otherDaysPlaces = itinerary.days
      .filter((_, i) => i !== safeDayIndex)
      .flatMap((d) => (Array.isArray(d.activities) ? d.activities : []).map((a) => a.title))
      .filter(Boolean)
      .join(', ');

    const prompt = `${gemini.BASE_PROMPT}\n\nREPLAN REQUEST: Replace ALL activities for Day ${day.day} (${day.date || ''}).\n${reasonSafe ? `Reason: ${reasonSafe}` : ''}\nDestination area: ${destination}\nAVOID these places (already in other days): ${otherDaysPlaces}\nKeep the same date, day number, and city. Return ONLY the single day object as JSON.\n\nReturn format:\n{\n  "day": ${day.day},\n  "date": "${day.date || ''}",\n  "city": "${day.city || destination}",\n  "theme": "New theme",\n  "activities": [ ... ]\n}`;

    const newDay = await gemini.generateWithRetry({
      model: getGeminiModel(),
      prompt,
      timeoutMs: cfg.GEMINI_TIMEOUT_MS.replanDay,
      maxRetries: 0
    });
    newDay.city = newDay.city || day.city || destination;
    itinerary.days[safeDayIndex] = newDay;
    res.json({ success: true, itinerary: enrichWithBookingLinks(itinerary) });
  } catch (error) {
    routeError(res, error, 'Failed to replan day');
  }
});

app.post('/api/replan-segment', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const { itinerary, dayIndex, startActivityIndex, endActivityIndex, reason, constraints = {} } = req.body;
    const safeDayIndex = Number(dayIndex);
    const safeStartIndex = Number(startActivityIndex);
    const safeEndIndex = Number(endActivityIndex);
    if (!itinerary?.days || !Number.isInteger(safeDayIndex) || !Number.isInteger(safeStartIndex) || !Number.isInteger(safeEndIndex)) {
      return res.status(400).json({ success: false, error: 'Missing required fields for segment replan.' });
    }
    const day = itinerary.days[safeDayIndex];
    if (!day || !Array.isArray(day.activities) || safeStartIndex < 0 || safeEndIndex < safeStartIndex || safeEndIndex >= day.activities.length) {
      return res.status(400).json({ success: false, error: 'Invalid segment indexes for replan.' });
    }
    if (!cfg.hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured.' });
    }
    const reasonSafe = sanitizeText(reason, 220);
    const before = day.activities.slice(0, safeStartIndex).map((a) => sanitizeText(a.title, 80)).join(', ');
    const after = day.activities.slice(safeEndIndex + 1).map((a) => sanitizeText(a.title, 80)).join(', ');
    const originalSeg = day.activities.slice(safeStartIndex, safeEndIndex + 1);
    const segmentSize = originalSeg.length;
    const slotBudget = originalSeg.reduce((s, a) => s + Number(a.estimatedCost || 0), 0);
    const maxTravelMinutesPerHop = Number(constraints.maxTravelMinutesPerHop || 90);

    const prompt = `Replan a segment of a day itinerary.\n\nDay context: ${day.theme || `Day ${day.day}`} (${day.date || ''})\nReason: ${reasonSafe || 'Improve fit'}\nKeep activities before segment unchanged: ${before || 'none'}\nKeep activities after segment unchanged: ${after || 'none'}\nSegment length must be exactly ${segmentSize} activities.\nSegment budget should stay near $${slotBudget}.\nMax travel minutes per hop: ${maxTravelMinutesPerHop}.\n\nReturn ONLY JSON:\n{\n  "activities": [\n    {\n      "time": "09:00 AM",\n      "title": "Activity name",\n      "description": "Brief description",\n      "location": "Full place name and area",\n      "lat": 0.0,\n      "lng": 0.0,\n      "duration": "2 hours",\n      "estimatedCost": 0,\n      "category": "sightseeing|food|adventure|culture|shopping|transport|relaxation"\n    }\n  ]\n}`;

    const parsed = await gemini.generateWithRetry({
      model: getGeminiModel(),
      prompt,
      timeoutMs: cfg.GEMINI_TIMEOUT_MS.replanSegment,
      maxRetries: 0
    });
    const newSeg = parsed.activities;
    if (!Array.isArray(newSeg) || newSeg.length !== segmentSize) {
      return res.status(500).json({ success: false, error: 'Segment replan output size mismatch.' });
    }
    day.activities.splice(safeStartIndex, segmentSize, ...newSeg);
    enrichWithBookingLinks(itinerary);
    res.json({ success: true, itinerary, dayIndex: safeDayIndex, startActivityIndex: safeStartIndex, endActivityIndex: safeEndIndex });
  } catch (error) {
    routeError(res, error, 'Failed to replan segment');
  }
});

// === Routes: Maps services ===

app.post('/api/geocode', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const address = sanitizeText(req.body?.address, 200);
    if (!address) return res.status(400).json({ success: false, error: 'address is required.' });
    if (!cfg.hasValidMapsKey()) return res.status(500).json({ success: false, error: 'GOOGLE_MAPS_API_KEY is not configured.' });
    const result = await maps.geocodeAddress(cfg.getMapsApiKeyServer(), address);
    if (!result) return res.json({ success: true, found: false });
    res.json({ success: true, found: true, ...result });
  } catch (error) {
    routeError(res, error, 'Failed to geocode address');
  }
});

app.post('/api/validate-places', originGuard, writeApiLimiter, async (req, res) => {
  try {
    if (!cfg.hasValidMapsKey()) return res.status(500).json({ success: false, error: 'GOOGLE_MAPS_API_KEY is not configured.' });
    const { itinerary, destination } = req.body;
    if (!itinerary?.days) return res.status(400).json({ success: false, error: 'Missing itinerary.' });
    const destinationSafe = sanitizeText(destination, 100);
    const total = itinerary.days.reduce((sum, day) => sum + (Array.isArray(day.activities) ? day.activities.length : 0), 0);
    if (total > 120) return res.status(400).json({ success: false, error: 'Itinerary too large for place validation.' });

    const allActs = itinerary.days.flatMap((day) => Array.isArray(day.activities) ? day.activities : []);
    const concurrency = Number(cfg.envValue('PLACES_CONCURRENCY') || 5);
    const apiKey = cfg.getMapsApiKeyServer();
    const lookups = await maps.mapWithConcurrency(allActs, concurrency, (act) =>
      maps.placesTextSearch(apiKey, `${sanitizeText(act.location || act.title, 120)} ${destinationSafe}`.trim())
    );
    let validatedCount = 0;
    let unresolvedCount = 0;
    allActs.forEach((act, i) => {
      const place = lookups[i] && !lookups[i].__error ? lookups[i] : null;
      if (place?.location) {
        act.placeId = place.id;
        act.location = place.formattedAddress || act.location;
        act.lat = place.location.latitude;
        act.lng = place.location.longitude;
        act.verified = true;
        act.openNow = place.regularOpeningHours?.openNow ?? null;
        act.rating = place.rating ?? null;
        act.mapsUri = place.googleMapsUri || null;
        validatedCount += 1;
      } else {
        act.verified = false;
        unresolvedCount += 1;
      }
    });
    res.json({ success: true, itinerary: enrichWithBookingLinks(itinerary), validatedCount, unresolvedCount });
  } catch (error) {
    routeError(res, error, 'Failed to validate places');
  }
});

app.post('/api/compute-routes', originGuard, writeApiLimiter, async (req, res) => {
  try {
    if (!cfg.hasValidMapsKey()) return res.status(500).json({ success: false, error: 'GOOGLE_MAPS_API_KEY is not configured.' });
    const { itinerary, travelMode } = req.body;
    if (!itinerary?.days) return res.status(400).json({ success: false, error: 'Missing itinerary.' });
    const safeTravelMode = sanitizeText(travelMode || 'DRIVE', 20).toUpperCase();
    const total = itinerary.days.reduce((sum, day) => sum + (Array.isArray(day.activities) ? day.activities.length : 0), 0);
    if (total > 150) return res.status(400).json({ success: false, error: 'Itinerary too large for route computation.' });

    const hops = [];
    for (const day of itinerary.days) {
      const acts = day.activities || [];
      for (let i = 1; i < acts.length; i++) {
        const prev = acts[i - 1];
        const cur = acts[i];
        if (Number.isFinite(prev?.lat) && Number.isFinite(prev?.lng) && Number.isFinite(cur?.lat) && Number.isFinite(cur?.lng)) {
          hops.push({ cur, prev });
        } else {
          cur.travelFromPrevious = { travelMinutes: null, distanceMeters: null };
        }
      }
    }
    const concurrency = Number(cfg.envValue('ROUTES_CONCURRENCY') || 5);
    const apiKey = cfg.getMapsApiKeyServer();
    const results = await maps.mapWithConcurrency(hops, concurrency, ({ prev, cur }) =>
      maps.computeRouteMinutes(apiKey, { lat: prev.lat, lng: prev.lng }, { lat: cur.lat, lng: cur.lng }, safeTravelMode)
    );
    hops.forEach((hop, i) => {
      const r = results[i];
      hop.cur.travelFromPrevious = r && !r.__error ? r : { travelMinutes: null, distanceMeters: null };
    });
    res.json({ success: true, itinerary });
  } catch (error) {
    routeError(res, error, 'Failed to compute routes');
  }
});

app.post('/api/apply-constraints', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const { itinerary, constraints = {} } = req.body;
    if (!itinerary?.days) return res.status(400).json({ success: false, error: 'Missing itinerary.' });

    const maxTravelMinutesPerHop = Number(constraints.maxTravelMinutesPerHop || 90);
    const budgetCap = constraints.budgetCap !== undefined ? Number(constraints.budgetCap) : null;
    const blockedCategories = new Set((constraints.blockedCategories || []).map((s) => String(s).toLowerCase()));
    const findings = [];

    let runningCost = 0;
    itinerary.days.forEach((day, di) => {
      const acts = day.activities || [];
      acts.forEach((act, ai) => {
        runningCost += Number(act.estimatedCost || 0);
        if (blockedCategories.has(String(act.category || '').toLowerCase())) {
          findings.push({ type: 'blocked_category', dayIndex: di, activityIndex: ai, message: `${act.title} violates blocked category constraint.` });
        }
        const travel = act.travelFromPrevious?.travelMinutes;
        if (travel !== undefined && travel !== null && travel > maxTravelMinutesPerHop) {
          findings.push({ type: 'travel_too_long', dayIndex: di, activityIndex: ai, message: `${act.title} has long transfer (${travel} min).` });
        }
        if (ai > 0) {
          const prev = acts[ai - 1];
          const prevStart = parseTimeToMinutes(prev.time);
          const curStart = parseTimeToMinutes(act.time);
          if (prevStart !== null && curStart !== null) {
            const prevEnd = prevStart + durationTextToMinutes(prev.duration) + Number(act.travelFromPrevious?.travelMinutes || 0);
            if (curStart < prevEnd) {
              findings.push({ type: 'time_overlap', dayIndex: di, activityIndex: ai, message: `${act.title} overlaps previous activity timing.` });
            }
          }
        }
      });
    });
    if (budgetCap !== null && runningCost > budgetCap) {
      findings.push({ type: 'over_budget', message: `Estimated cost ${runningCost} exceeds budget cap ${budgetCap}.` });
    }
    res.json({ success: true, feasible: findings.length === 0, findings, summary: { runningCost, budgetCap, maxTravelMinutesPerHop } });
  } catch (error) {
    routeError(res, error, 'Failed to apply constraints');
  }
});

// === Routes: Cloud Translation ===

app.post('/api/translate-itinerary', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const { itinerary, targetLanguage } = req.body;
    if (!itinerary?.days) return res.status(400).json({ success: false, error: 'Missing itinerary.' });
    const target = sanitizeText(targetLanguage, 10);
    if (!target) return res.status(400).json({ success: false, error: 'targetLanguage is required (e.g. "es", "fr", "ja").' });
    if (!cfg.hasValidMapsKey()) return res.status(500).json({ success: false, error: 'GOOGLE_MAPS_API_KEY is not configured (Translation API uses the same key with Translate API enabled).' });
    const translated = await translateItinerary(cfg.getMapsApiKeyServer(), structuredClone(itinerary), target);
    res.json({ success: true, itinerary: translated });
  } catch (error) {
    routeError(res, error, 'Failed to translate itinerary');
  }
});

// === Routes: Email ===

app.post('/api/email-itinerary', originGuard, writeApiLimiter, async (req, res) => {
  try {
    if (!cfg.hasValidMailerConfig()) {
      const missing = cfg.missingMailerFields();
      return res.status(500).json({ success: false, error: `Mail service is not configured. Missing: ${missing.join(', ')}.` });
    }
    const { toEmail, itinerary } = req.body;
    const safeToEmail = sanitizeText(toEmail, 254).toLowerCase();
    if (!safeToEmail || !itinerary?.days) {
      return res.status(400).json({ success: false, error: 'Missing toEmail or itinerary.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeToEmail)) {
      return res.status(400).json({ success: false, error: 'Invalid recipient email address.' });
    }

    const mailerCfg = cfg.getMailerConfig();
    const transporter = mailer.getTransporter(mailerCfg);
    const safeTitle = sanitizeText(itinerary.tripTitle || 'Trip Plan', 160);
    const safeSummary = sanitizeText(itinerary.summary || '', 500);
    const safeCurrency = sanitizeText(itinerary.currency || 'USD', 8);
    const safeTotalCost = Number(itinerary.totalEstimatedCost || 0);

    await transporter.sendMail({
      from: mailerCfg.from,
      to: safeToEmail,
      subject: `Your TravelAI Itinerary: ${safeTitle}`,
      text: `Trip: ${safeTitle}\nSummary: ${safeSummary}\nEstimated Cost: $${Number.isFinite(safeTotalCost) ? safeTotalCost : 0} ${safeCurrency}`,
      html: mailer.itineraryToEmailHtml(itinerary, cfg.getMapsApiKeyServer())
    });
    res.json({ success: true, message: `Itinerary sent to ${safeToEmail}` });
  } catch (error) {
    routeError(res, error, 'Failed to send itinerary email');
  }
});

// === Routes: Saved itineraries ===

app.post('/api/save-itinerary', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const { itinerary } = req.body || {};
    if (!itinerary?.days || !Array.isArray(itinerary.days)) {
      return res.status(400).json({ success: false, error: 'Missing itinerary.' });
    }
    const scopeInfo = await resolveStorageScope(req);
    if (!scopeInfo) return res.status(401).json({ success: false, error: 'Sign in or send X-Session-ID to save.' });
    const result = savedStore.save(scopeInfo.scope, itinerary);
    res.json({ success: true, ...result });
  } catch (error) {
    routeError(res, error, 'Failed to save itinerary');
  }
});

app.post('/api/saved-itineraries', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const scopeInfo = await resolveStorageScope(req);
    if (!scopeInfo) return res.status(401).json({ success: false, error: 'Sign in or send X-Session-ID to load.' });
    const list = savedStore.list(scopeInfo.scope);
    res.json({
      success: true,
      user: scopeInfo.user,
      count: list.length,
      items: list.map(({ id, savedAt, tripTitle }) => ({ id, savedAt, tripTitle }))
    });
  } catch (error) {
    routeError(res, error, 'Failed to list saved itineraries');
  }
});

app.post('/api/saved-itinerary/:id', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const scopeInfo = await resolveStorageScope(req);
    if (!scopeInfo) return res.status(401).json({ success: false, error: 'Sign in or send X-Session-ID to load.' });
    const id = sanitizeText(req.params.id, 64);
    const item = savedStore.get(scopeInfo.scope, id);
    if (!item) return res.status(404).json({ success: false, error: 'Saved itinerary not found.' });
    res.json({ success: true, item });
  } catch (error) {
    routeError(res, error, 'Failed to load saved itinerary');
  }
});

app.post('/api/saved-itinerary/:id/delete', originGuard, writeApiLimiter, async (req, res) => {
  try {
    const scopeInfo = await resolveStorageScope(req);
    if (!scopeInfo) return res.status(401).json({ success: false, error: 'Sign in or send X-Session-ID.' });
    const id = sanitizeText(req.params.id, 64);
    const deleted = savedStore.remove(scopeInfo.scope, id);
    res.json({ success: true, deleted });
  } catch (error) {
    routeError(res, error, 'Failed to delete');
  }
});

// === Bootstrap ===

if (require.main === module) {
  const server = app.listen(PORT, () => {
    log.info('server.start', { port: PORT, version: APP_VERSION, runtime: cfg.isCloudRun ? 'cloud-run' : 'local' });
    console.log(`Travel Planner running at http://localhost:${PORT}`);
  });

  const shutdown = (signal) => {
    log.info('server.shutdown', { signal });
    server.close(() => {
      mailer.closeTransporter();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error('unhandledRejection', { reason: String(reason) }));
  process.on('uncaughtException', (err) => log.error('uncaughtException', { error: err?.message, stack: err?.stack }));
}

module.exports = {
  app,
  _internals: {
    cleanAndParseJSON: gemini.cleanAndParseJSON,
    validateItinerary,
    buildItineraryCacheKey,
    escapeHtml
  }
};
