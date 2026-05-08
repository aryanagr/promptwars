const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const nodemailer = require('nodemailer');
const { jsonrepair } = require('jsonrepair');
const {
  normalizeCityName,
  sanitizeStops,
  buildCityPlan,
  applyCityPlanToItinerary
} = require('./lib/trip-planner-utils');

const isCloudRun = Boolean(process.env.K_SERVICE);
if (!isCloudRun) {
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');
app.set('trust proxy', true);

function readFromFileEnv(name) {
  const filePath = process.env[`${name}_FILE`];
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function envValue(...names) {
  for (const name of names) {
    const direct = (process.env[name] || '').trim();
    if (direct) return direct;
    const fromFile = readFromFileEnv(name);
    if (fromFile) return fromFile;
  }
  return '';
}

function getGeminiApiKey() {
  return envValue('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_KEY');
}

function getMapsApiKey() {
  return envValue('GOOGLE_MAPS_API_KEY', 'MAPS_API_KEY');
}

function getMailerConfig() {
  const host = envValue('SMTP_HOST', 'MAIL_HOST', 'EMAIL_HOST');
  const portRaw = envValue('SMTP_PORT', 'MAIL_PORT', 'EMAIL_PORT');
  const port = Number(portRaw || 587);
  const secureRaw = envValue('SMTP_SECURE', 'MAIL_SECURE', 'EMAIL_SECURE');
  const secure = secureRaw
    ? String(secureRaw).toLowerCase() === 'true'
    : port === 465;
  const user = envValue('SMTP_USER', 'SMTP_USERNAME', 'MAIL_USER', 'EMAIL_USER');
  const pass = envValue('SMTP_PASS', 'SMTP_PASSWORD', 'MAIL_PASS', 'EMAIL_PASS');
  const from = envValue('MAIL_FROM', 'SMTP_FROM', 'EMAIL_FROM') || user;

  return {
    host,
    port,
    secure,
    user,
    pass,
    from
  };
}

function hasValidGeminiKey() {
  const key = getGeminiApiKey();
  return Boolean(key && key !== 'your_gemini_api_key_here');
}

function hasValidMapsKey() {
  const key = getMapsApiKey();
  return Boolean(key);
}

function hasValidMailerConfig() {
  const cfg = getMailerConfig();
  return Boolean(
    cfg.host &&
    Number.isFinite(cfg.port) &&
    cfg.port > 0 &&
    cfg.user &&
    cfg.pass &&
    cfg.from &&
    !isPlaceholderSecret(cfg.pass)
  );
}

function isPlaceholderSecret(value) {
  const v = String(value || '').toLowerCase();
  if (!v) return true;
  return (
    v.includes('replace_with') ||
    v.includes('your_') ||
    v.includes('password_here') ||
    v.includes('app_password_here') ||
    v.includes('changeme')
  );
}

function missingMailerFields() {
  const cfg = getMailerConfig();
  const missing = [];
  if (!cfg.host) missing.push('SMTP_HOST');
  if (!Number.isFinite(cfg.port) || cfg.port <= 0) missing.push('SMTP_PORT');
  if (!cfg.user) missing.push('SMTP_USER');
  if (!cfg.pass || isPlaceholderSecret(cfg.pass)) missing.push('SMTP_PASS');
  if (!cfg.from) missing.push('MAIL_FROM');
  return missing;
}

function sanitizeText(value, maxLen = 160) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function sanitizeInterests(value) {
  return sanitizeText(value, 300);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAllowedOrigins() {
  const raw = envValue('CORS_ORIGINS', 'CORS_ORIGIN');
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://maps.googleapis.com https://maps.gstatic.com https://*.googleusercontent.com",
  "connect-src 'self' https://maps.googleapis.com https://maps.gstatic.com https://places.googleapis.com https://routes.googleapis.com",
  "frame-src 'self' https://www.google.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  res.setHeader('Content-Security-Policy', CSP_DIRECTIVES);
  const forwardedProto = req.headers['x-forwarded-proto'];
  const isHttps = req.secure || String(forwardedProto || '').includes('https');
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

function createRateLimiter({ windowMs, maxRequests }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip || 'unknown'}:${req.path}`;
    const existing = buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    existing.count += 1;
    if (existing.count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ success: false, error: 'Too many requests. Please slow down and retry shortly.' });
    }
    if (buckets.size > 5000) {
      for (const [bucketKey, bucketValue] of buckets.entries()) {
        if (now >= bucketValue.resetAt) buckets.delete(bucketKey);
      }
    }
    return next();
  };
}

const writeApiLimiter = createRateLimiter({
  windowMs: Number(envValue('API_RATE_LIMIT_WINDOW_MS') || 60000),
  maxRequests: Number(envValue('API_RATE_LIMIT_MAX') || 30)
});

const itineraryCache = new Map();
const itineraryCacheTtlMs = Number(envValue('ITINERARY_CACHE_TTL_MS') || 180000);

const GEMINI_TIMEOUT_MS = {
  generate: Number(envValue('GEMINI_GENERATE_TIMEOUT_MS') || 50000),
  replanActivity: Number(envValue('GEMINI_REPLAN_ACTIVITY_TIMEOUT_MS') || 30000),
  replanDay: Number(envValue('GEMINI_REPLAN_DAY_TIMEOUT_MS') || 45000),
  replanSegment: Number(envValue('GEMINI_REPLAN_SEGMENT_TIMEOUT_MS') || 45000)
};

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

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
  return crypto.createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

function getCachedItinerary(cacheKey) {
  const entry = itineraryCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    itineraryCache.delete(cacheKey);
    return null;
  }
  return JSON.parse(JSON.stringify(entry.value));
}

function setCachedItinerary(cacheKey, itinerary) {
  itineraryCache.set(cacheKey, {
    expiresAt: Date.now() + itineraryCacheTtlMs,
    value: JSON.parse(JSON.stringify(itinerary))
  });
}

const allowedOrigins = getAllowedOrigins();
app.use(cors(allowedOrigins.length === 0 ? {} : {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  }
}));
app.use(express.json({ limit: envValue('JSON_BODY_LIMIT') || '250kb' }));
app.use(securityHeadersMiddleware);
app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static('public'));

function getModel() {
  const key = getGeminiApiKey();
  if (!hasValidGeminiKey()) {
    throw new Error('GEMINI_API_KEY is not configured. Set it in Cloud Run env/secrets (or local .env for development).');
  }
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json'
    }
  });
}

function formatApiError(error, fallbackMessage) {
  const providerMessage = error?.message || error?.errorDetails?.[0]?.message;
  if (providerMessage) return `${fallbackMessage} (${providerMessage})`;
  return fallbackMessage;
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function itineraryToEmailHtml(itinerary) {
  const daysHtml = (itinerary.days || []).map(day => {
    const acts = (Array.isArray(day.activities) ? day.activities : []).map(act => {
      const cost = Number(act.estimatedCost || 0);
      return `<li><strong>${escapeHtml(act.time || '')}</strong> - ${escapeHtml(act.title || 'Activity')} (${escapeHtml(act.location || '')}) | ${escapeHtml(act.duration || '')} | $${Number.isFinite(cost) ? cost : 0}</li>`;
    }).join('');
    const dayNum = Number(day.day) || '';
    const dayDate = day.date ? ` - ${escapeHtml(day.date)}` : '';
    return `<h3>Day ${dayNum}${dayDate}</h3><p><strong>${escapeHtml(day.theme || '')}</strong></p><ul>${acts}</ul>`;
  }).join('');

  const tips = (Array.isArray(itinerary.tips) ? itinerary.tips : []).map(t => `<li>${escapeHtml(t)}</li>`).join('');
  const totalCost = Number(itinerary.totalEstimatedCost || 0);
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;">
      <h1>${escapeHtml(itinerary.tripTitle || 'Trip Itinerary')}</h1>
      <p>${escapeHtml(itinerary.summary || '')}</p>
      <p><strong>Total Estimated Cost:</strong> $${Number.isFinite(totalCost) ? totalCost : 0} ${escapeHtml(itinerary.currency || 'USD')}</p>
      ${daysHtml}
      <h3>Travel Tips</h3>
      <ul>${tips}</ul>
    </div>
  `;
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === 'AM' && hh === 12) hh = 0;
  if (ampm === 'PM' && hh !== 12) hh += 12;
  return hh * 60 + mm;
}

function durationTextToMinutes(duration) {
  if (!duration || typeof duration !== 'string') return 0;
  const h = duration.match(/(\d+)\s*hour/i);
  const m = duration.match(/(\d+)\s*min/i);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

async function placesTextSearch(query) {
  const key = getMapsApiKey();
  const url = 'https://places.googleapis.com/v1/places:searchText';
  const body = {
    textQuery: query,
    pageSize: 1
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.googleMapsUri,places.regularOpeningHours.openNow'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Places search failed (${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  return data.places?.[0] || null;
}

async function computeRouteMinutes(origin, destination, travelMode = 'DRIVE') {
  const key = getMapsApiKey();
  const url = 'https://routes.googleapis.com/directions/v2:computeRoutes';
  const body = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
    travelMode
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Routes compute failed (${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  const route = data.routes?.[0];
  if (!route?.duration) return { travelMinutes: null, distanceMeters: null };
  const seconds = Number(String(route.duration).replace('s', ''));
  return { travelMinutes: Math.round(seconds / 60), distanceMeters: route.distanceMeters || null };
}

const ITINERARY_SCHEMA = {
  required: ['tripTitle', 'summary', 'totalEstimatedCost', 'days'],
  dayRequired: ['day', 'date', 'city', 'activities'],
  activityRequired: ['time', 'title', 'description', 'location', 'lat', 'lng', 'duration', 'estimatedCost', 'category']
};

function validateItinerary(data) {
  const errors = [];
  for (const field of ITINERARY_SCHEMA.required) {
    if (!data[field]) errors.push(`Missing top-level field: ${field}`);
  }
  if (!Array.isArray(data.days) || data.days.length === 0) {
    errors.push('days must be a non-empty array');
    return errors;
  }
  const seenPlaces = new Set();
  data.days.forEach((day, di) => {
    for (const f of ITINERARY_SCHEMA.dayRequired) {
      if (!day[f] && day[f] !== 0) errors.push(`Day ${di + 1}: missing ${f}`);
    }
    if (Array.isArray(day.activities)) {
      day.activities.forEach((act, ai) => {
        for (const f of ITINERARY_SCHEMA.activityRequired) {
          if (!act[f] && act[f] !== 0) errors.push(`Day ${di + 1}, Activity ${ai + 1}: missing ${f}`);
        }
        const placeKey = `${act.title}-${act.location}`;
        if (seenPlaces.has(placeKey)) errors.push(`Duplicate place: ${act.title} at ${act.location}`);
        seenPlaces.add(placeKey);
        if (act.lat !== undefined && act.lat !== null) {
          if (!Number.isFinite(act.lat) || act.lat < -90 || act.lat > 90) errors.push(`Invalid lat for ${act.title}`);
        }
        if (act.lng !== undefined && act.lng !== null) {
          if (!Number.isFinite(act.lng) || act.lng < -180 || act.lng > 180) errors.push(`Invalid lng for ${act.title}`);
        }
      });
    }
  });
  return errors;
}

function tryCloseTruncatedJson(text) {
  let inString = false;
  let escaped = false;
  let brace = 0;
  let bracket = 0;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') brace += 1;
      else if (ch === '}') brace -= 1;
      else if (ch === '[') bracket += 1;
      else if (ch === ']') bracket -= 1;
    }
  }
  let repaired = text;
  if (inString) repaired += '"';
  if (bracket > 0) repaired += ']'.repeat(bracket);
  if (brace > 0) repaired += '}'.repeat(brace);
  return repaired;
}

function cleanAndParseJSON(text) {
  let cleaned = (text || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  if (!cleaned) throw new Error('Empty AI response');
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }
  // 1. Fast path: parse as-is.
  try { return JSON.parse(cleaned); } catch {}
  // 2. Truncation repair: close unclosed strings/arrays/objects.
  try { return JSON.parse(tryCloseTruncatedJson(cleaned)); } catch {}
  // 3. Last resort: jsonrepair handles trailing commas, missing commas,
  //    unescaped quotes, smart quotes, single-quoted strings, etc.
  try { return JSON.parse(jsonrepair(cleaned)); } catch (finalErr) {
    const preview = cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned;
    console.error('JSON parse failed after all repairs:', finalErr.message, '| preview:', preview);
    throw new Error('AI returned malformed JSON that could not be repaired.');
  }
}

function enrichWithBookingLinks(itinerary) {
  if (!itinerary.days) return itinerary;
  itinerary.days.forEach(day => {
    if (!day.activities) return;
    day.activities.forEach(act => {
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

const BASE_PROMPT = `Create a concise travel itinerary in raw JSON only (no markdown).
Rules:
- Day-wise plan with realistic times and costs.
- Include varied activities matching interests.
- Use real coordinates.
- Stay within budget.
- Avoid duplicate places.
- Keep each day to 3-4 activities max.
Format:
{
  "tripTitle": "string",
  "summary": "string",
  "totalEstimatedCost": 0,
  "currency": "USD",
  "tips": ["tip1","tip2","tip3"],
  "days": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "city": "string",
      "theme": "string",
      "activities": [
        {
          "time": "09:00 AM",
          "title": "string",
          "description": "string",
          "location": "string",
          "lat": 0.0,
          "lng": 0.0,
          "duration": "60 mins",
          "estimatedCost": 0,
          "category": "sightseeing|food|adventure|culture|shopping|transport|relaxation"
        }
      ]
    }
  ]
}`;

async function generateWithRetry(prompt, maxRetries = 1) {
  const model = getModel();
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await withTimeout(
        model.generateContent(prompt),
        GEMINI_TIMEOUT_MS.generate,
        'AI is taking too long to respond. Please try again.'
      );
      const response = await result.response;
      const text = response.text();
      const itinerary = cleanAndParseJSON(text);
      const errors = validateItinerary(itinerary);

      if (errors.length > 0) console.warn('Validation warnings (serving anyway):', errors);
      return itinerary;
    } catch (err) {
      lastError = err;
      console.error(`Attempt ${attempt + 1} failed:`, err.message);
      if (attempt >= maxRetries) throw lastError;
    }
  }
  throw lastError;
}

app.get('/api/maps-key', (req, res) => {
  res.json({ key: getMapsApiKey() });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    runtime: isCloudRun ? 'cloud-run' : 'local',
    geminiConfigured: hasValidGeminiKey(),
    mapsConfigured: hasValidMapsKey(),
    mailerConfigured: hasValidMailerConfig(),
    corsRestricted: allowedOrigins.length > 0,
    itineraryCacheTtlMs: itineraryCacheTtlMs,
    geminiModel: 'gemini-2.5-flash-lite'
  });
});

app.post('/api/generate-itinerary', writeApiLimiter, async (req, res) => {
  try {
    const {
      fromPlace,
      toPlace,
      destination,
      startDate,
      endDate,
      budget,
      travelers,
      interests,
      transportMode,
      transportBookingRequired,
      stops
    } = req.body;

    const fromCity = sanitizeText(fromPlace, 100);
    const toCity = sanitizeText(toPlace, 100);
    const destinationCity = sanitizeText(destination || toCity, 100);
    const startDateSafe = sanitizeText(startDate, 12);
    const endDateSafe = sanitizeText(endDate, 12);
    const budgetValue = Number(budget);
    const travelersValue = Number(travelers || 1);
    const interestsSafe = sanitizeInterests(interests || 'General sightseeing, local food, culture');
    const transportModeSafe = sanitizeText(transportMode || 'driving', 20).toLowerCase();
    const bookingRequired = Boolean(transportBookingRequired);
    const stopsSafe = sanitizeStops(stops);

    if (!toCity || !destinationCity || !startDateSafe || !endDateSafe || !Number.isFinite(budgetValue) || budgetValue <= 0) {
      return res.status(400).json({ success: false, error: 'Missing required fields. To, Destination, dates, and budget are required.' });
    }
    if (!Number.isFinite(travelersValue) || travelersValue < 1 || travelersValue > 20) {
      return res.status(400).json({ success: false, error: 'Travelers must be between 1 and 20.' });
    }

    if (normalizeCityName(toCity) !== normalizeCityName(destinationCity)) {
      return res.status(400).json({ success: false, error: 'To and Destination must be the same city.' });
    }

    if (!hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set it in Cloud Run env/secrets (or local .env for development).' });
    }

    let cityPlan;
    try {
      cityPlan = buildCityPlan({
        destination: destinationCity,
        startDate: startDateSafe,
        endDate: endDateSafe,
        stops: stopsSafe
      });
    } catch (validationError) {
      return res.status(400).json({ success: false, error: validationError.message || 'Invalid multi-city input.' });
    }

    const cacheKey = buildItineraryCacheKey({
      fromPlace: fromCity,
      toPlace: toCity,
      destination: destinationCity,
      startDate: startDateSafe,
      endDate: endDateSafe,
      budget: budgetValue,
      travelers: travelersValue,
      interests: interestsSafe,
      transportMode: transportModeSafe,
      transportBookingRequired: bookingRequired,
      stops: stopsSafe
    });
    const cachedItinerary = getCachedItinerary(cacheKey);
    if (cachedItinerary) {
      return res.json({ success: true, itinerary: cachedItinerary, cached: true });
    }

    const stopsText = cityPlan.stops.length > 0
      ? cityPlan.stops.map((s, i) => `${i + 1}. ${s.city} - ${s.days} day(s)`).join('\n')
      : 'none';
    const cityDaySchedule = cityPlan.cityDayPlan
      .map((d) => `Day ${d.day} (${d.date}): ${d.city}`)
      .join('\n');

    const prompt = `${BASE_PROMPT}\n\nTRIP DETAILS:\n- From (optional): ${fromCity || 'not provided'}\n- To (final city): ${toCity}\n- Destination city (must match To): ${destinationCity}\n- Start Date: ${startDateSafe}\n- End Date: ${endDateSafe}\n- Total Days: ${cityPlan.totalDays}\n- Intermediate Stops:\n${stopsText}\n- City-Day Plan (must follow exactly):\n${cityDaySchedule}\n- Budget: $${budgetValue} USD total\n- Number of Travelers: ${travelersValue}\n- Interests: ${interestsSafe}\n- Preferred Transport Mode: ${transportModeSafe}\n- Need Transport Booking Options: ${bookingRequired ? 'yes' : 'no'}\n\nHard constraints:\n- Return exactly ${cityPlan.totalDays} day objects.\n- Each day object must include city and match the city-day plan exactly.\n- Do not put Jaipur activities on a Bangalore day or vice versa.\n- Keep all activities for each day inside that day's city.\n- If day city changes from previous day, include one transport activity first (category: transport).\n- Also include practical movement between activities considering the preferred transport mode.`;

    const itineraryRaw = await generateWithRetry(prompt);
    const itinerary = applyCityPlanToItinerary(itineraryRaw, cityPlan);
    const enriched = enrichWithBookingLinks(itinerary);
    setCachedItinerary(cacheKey, enriched);
    res.json({ success: true, itinerary: enriched });
  } catch (error) {
    console.error('Error generating itinerary:', error);
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to generate itinerary') });
  }
});

app.post('/api/replan-activity', writeApiLimiter, async (req, res) => {
  try {
    const { itinerary, dayIndex, activityIndex, reason } = req.body;
    const safeDayIndex = Number(dayIndex);
    const safeActivityIndex = Number(activityIndex);
    if (!itinerary || !Array.isArray(itinerary.days) || !Number.isInteger(safeDayIndex) || !Number.isInteger(safeActivityIndex)) {
      return res.status(400).json({ success: false, error: 'Missing required fields for replan.' });
    }

    if (!hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set it in Cloud Run env/secrets (or local .env for development).' });
    }

    const day = itinerary.days[safeDayIndex];
    if (!day || !Array.isArray(day.activities) || !day.activities[safeActivityIndex]) {
      return res.status(400).json({ success: false, error: 'Invalid day/activity index for replan.' });
    }
    const activity = day.activities[safeActivityIndex];
    const reasonSafe = sanitizeText(reason, 180);

    const otherActivities = day.activities
      .filter((_, i) => i !== safeActivityIndex)
      .map((a) => sanitizeText(a.title, 80))
      .join(', ');

    const model = getModel();
    const prompt = `You are a travel planner. Replace ONE activity in an itinerary.

CURRENT ACTIVITY TO REPLACE:
- Title: ${activity.title}
- Time: ${activity.time}
- Location: ${activity.location}
- Category: ${sanitizeText(activity.category, 30)}
${reasonSafe ? `- Reason for change: ${reasonSafe}` : ''}

OTHER ACTIVITIES THAT DAY (avoid duplicates): ${otherActivities}
DESTINATION: The same area/city as ${activity.location}
BUDGET REMAINING FOR THIS SLOT: ~$${activity.estimatedCost}

Return ONLY a single JSON object for the replacement activity (no markdown, no code blocks):
{
  "time": "${activity.time}",
  "title": "New activity name",
  "description": "Brief description",
  "location": "Full place name and area",
  "lat": 0.0,
  "lng": 0.0,
  "duration": "${activity.duration}",
  "estimatedCost": 0,
  "category": "sightseeing|food|adventure|culture|shopping|transport|relaxation"
}`;

    const result = await withTimeout(
      model.generateContent(prompt),
      GEMINI_TIMEOUT_MS.replanActivity,
      'AI is taking too long to respond. Please try again.'
    );
    const text = result.response.text();
    const newActivity = cleanAndParseJSON(text);

    const query = encodeURIComponent(`${newActivity.title} ${newActivity.location}`);
    newActivity.bookingLinks = {
      googleMaps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(newActivity.location)}`,
      googleSearch: `https://www.google.com/search?q=${query}+booking`,
      mapsDirection: newActivity.lat && newActivity.lng ? `https://www.google.com/maps/dir/?api=1&destination=${newActivity.lat},${newActivity.lng}` : null
    };

    itinerary.days[safeDayIndex].activities[safeActivityIndex] = newActivity;
    res.json({ success: true, itinerary, replacedActivity: activity, newActivity });
  } catch (error) {
    console.error('Error replanning:', error);
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to replan activity') });
  }
});

app.post('/api/replan-day', writeApiLimiter, async (req, res) => {
  try {
    const { itinerary, dayIndex, reason } = req.body;
    const safeDayIndex = Number(dayIndex);
    if (!itinerary || !Array.isArray(itinerary.days) || !Number.isInteger(safeDayIndex)) {
      return res.status(400).json({ success: false, error: 'Missing required fields for replan day.' });
    }
    if (!hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set it in Cloud Run env/secrets (or local .env for development).' });
    }

    const day = itinerary.days[safeDayIndex];
    if (!day) {
      return res.status(400).json({ success: false, error: 'Invalid day index for replan day.' });
    }
    const reasonSafe = sanitizeText(reason, 220);
    const destination = day.city || day.activities?.[0]?.location || 'the destination';

    const otherDaysPlaces = itinerary.days
      .filter((_, i) => i !== safeDayIndex)
      .flatMap(d => (Array.isArray(d.activities) ? d.activities : []).map(a => a.title))
      .filter(Boolean)
      .join(', ');

    const prompt = `${BASE_PROMPT}\n\nREPLAN REQUEST: Replace ALL activities for Day ${day.day} (${day.date || ''}).\n${reasonSafe ? `Reason: ${reasonSafe}` : ''}\nDestination area: ${destination}\nAVOID these places (already in other days): ${otherDaysPlaces}\nKeep the same date, day number, and city. Return ONLY the single day object as JSON.\n\nReturn format:\n{\n  "day": ${day.day},\n  "date": "${day.date || ''}",\n  "city": "${day.city || destination}",\n  "theme": "New theme",\n  "activities": [ ... ]\n}`;

    const model = getModel();
    const result = await withTimeout(
      model.generateContent(prompt),
      GEMINI_TIMEOUT_MS.replanDay,
      'AI is taking too long to respond. Please try again.'
    );
    const text = result.response.text();
    const newDay = cleanAndParseJSON(text);

    newDay.city = newDay.city || day.city || destination;
    itinerary.days[safeDayIndex] = newDay;
    const enriched = enrichWithBookingLinks(itinerary);

    res.json({ success: true, itinerary: enriched });
  } catch (error) {
    console.error('Error replanning day:', error);
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to replan day') });
  }
});

app.post('/api/validate-places', writeApiLimiter, async (req, res) => {
  try {
    if (!hasValidMapsKey()) {
      return res.status(500).json({ success: false, error: 'GOOGLE_MAPS_API_KEY is not configured.' });
    }
    const { itinerary, destination } = req.body;
    if (!itinerary?.days) return res.status(400).json({ success: false, error: 'Missing itinerary.' });
    const destinationSafe = sanitizeText(destination, 100);
    const totalActivities = itinerary.days.reduce((sum, day) => sum + (Array.isArray(day.activities) ? day.activities.length : 0), 0);
    if (totalActivities > 120) {
      return res.status(400).json({ success: false, error: 'Itinerary too large for place validation.' });
    }

    let validatedCount = 0;
    let unresolvedCount = 0;
    for (const day of itinerary.days) {
      for (const act of day.activities || []) {
        const place = await placesTextSearch(`${sanitizeText(act.location || act.title, 120)} ${destinationSafe}`.trim());
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
      }
    }
    const enriched = enrichWithBookingLinks(itinerary);
    res.json({ success: true, itinerary: enriched, validatedCount, unresolvedCount });
  } catch (error) {
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to validate places') });
  }
});

app.post('/api/compute-routes', writeApiLimiter, async (req, res) => {
  try {
    if (!hasValidMapsKey()) {
      return res.status(500).json({ success: false, error: 'GOOGLE_MAPS_API_KEY is not configured.' });
    }
    const { itinerary, travelMode } = req.body;
    if (!itinerary?.days) return res.status(400).json({ success: false, error: 'Missing itinerary.' });
    const safeTravelMode = sanitizeText(travelMode || 'DRIVE', 20).toUpperCase();
    const totalActivities = itinerary.days.reduce((sum, day) => sum + (Array.isArray(day.activities) ? day.activities.length : 0), 0);
    if (totalActivities > 150) {
      return res.status(400).json({ success: false, error: 'Itinerary too large for route computation.' });
    }

    for (const day of itinerary.days) {
      const acts = day.activities || [];
      for (let i = 1; i < acts.length; i++) {
        const prev = acts[i - 1];
        const cur = acts[i];
        if (prev?.lat && prev?.lng && cur?.lat && cur?.lng) {
          const route = await computeRouteMinutes(
            { lat: prev.lat, lng: prev.lng },
            { lat: cur.lat, lng: cur.lng },
            safeTravelMode
          );
          cur.travelFromPrevious = route;
        } else {
          cur.travelFromPrevious = { travelMinutes: null, distanceMeters: null };
        }
      }
    }
    res.json({ success: true, itinerary });
  } catch (error) {
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to compute routes') });
  }
});

app.post('/api/apply-constraints', writeApiLimiter, async (req, res) => {
  try {
    const { itinerary, constraints = {} } = req.body;
    if (!itinerary?.days) return res.status(400).json({ success: false, error: 'Missing itinerary.' });

    const maxTravelMinutesPerHop = Number(constraints.maxTravelMinutesPerHop || 90);
    const budgetCap = constraints.budgetCap !== undefined ? Number(constraints.budgetCap) : null;
    const blockedCategories = new Set((constraints.blockedCategories || []).map(s => String(s).toLowerCase()));
    const findings = [];

    let runningCost = 0;
    itinerary.days.forEach((day, di) => {
      const acts = day.activities || [];
      acts.forEach((act, ai) => {
        const cost = Number(act.estimatedCost || 0);
        runningCost += cost;

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

    res.json({
      success: true,
      feasible: findings.length === 0,
      findings,
      summary: { runningCost, budgetCap, maxTravelMinutesPerHop }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to apply constraints') });
  }
});

app.post('/api/replan-segment', writeApiLimiter, async (req, res) => {
  try {
    if (!hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set it in Cloud Run env/secrets (or local .env for development).' });
    }
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
    const reasonSafe = sanitizeText(reason, 220);
    const before = day.activities.slice(0, safeStartIndex).map((a) => sanitizeText(a.title, 80)).join(', ');
    const after = day.activities.slice(safeEndIndex + 1).map((a) => sanitizeText(a.title, 80)).join(', ');
    const originalSeg = day.activities.slice(safeStartIndex, safeEndIndex + 1);
    const segmentSize = originalSeg.length;
    const slotBudget = originalSeg.reduce((s, a) => s + Number(a.estimatedCost || 0), 0);

    const maxTravelMinutesPerHop = Number(constraints.maxTravelMinutesPerHop || 90);
    const prompt = `Replan a segment of a day itinerary.\n\nDay context: ${day.theme || `Day ${day.day}`} (${day.date || ''})\nReason: ${reasonSafe || 'Improve fit'}\nKeep activities before segment unchanged: ${before || 'none'}\nKeep activities after segment unchanged: ${after || 'none'}\nSegment length must be exactly ${segmentSize} activities.\nSegment budget should stay near $${slotBudget}.\nMax travel minutes per hop: ${maxTravelMinutesPerHop}.\n\nReturn ONLY JSON:\n{\n  "activities": [\n    {\n      "time": "09:00 AM",\n      "title": "Activity name",\n      "description": "Brief description",\n      "location": "Full place name and area",\n      "lat": 0.0,\n      "lng": 0.0,\n      "duration": "2 hours",\n      "estimatedCost": 0,\n      "category": "sightseeing|food|adventure|culture|shopping|transport|relaxation"\n    }\n  ]\n}`;

    const model = getModel();
    const result = await withTimeout(
      model.generateContent(prompt),
      GEMINI_TIMEOUT_MS.replanSegment,
      'AI is taking too long to respond. Please try again.'
    );
    const parsed = cleanAndParseJSON(result.response.text());
    const newSeg = parsed.activities;
    if (!Array.isArray(newSeg) || newSeg.length !== segmentSize) {
      return res.status(500).json({ success: false, error: 'Segment replan output size mismatch.' });
    }

    day.activities.splice(safeStartIndex, segmentSize, ...newSeg);
    enrichWithBookingLinks(itinerary);
    res.json({ success: true, itinerary, dayIndex: safeDayIndex, startActivityIndex: safeStartIndex, endActivityIndex: safeEndIndex });
  } catch (error) {
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to replan segment') });
  }
});

app.post('/api/email-itinerary', writeApiLimiter, async (req, res) => {
  try {
    if (!hasValidMailerConfig()) {
      const missing = missingMailerFields();
      return res.status(500).json({
        success: false,
        error: `Mail service is not configured. Missing: ${missing.join(', ')}. Set SMTP_* (or MAIL_*/EMAIL_* aliases).`
      });
    }
    const { toEmail, itinerary } = req.body;
    const safeToEmail = sanitizeText(toEmail, 254).toLowerCase();
    if (!safeToEmail || !itinerary?.days) {
      return res.status(400).json({ success: false, error: 'Missing toEmail or itinerary.' });
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(safeToEmail)) {
      return res.status(400).json({ success: false, error: 'Invalid recipient email address.' });
    }

    const cfg = getMailerConfig();
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass }
    });

    const safeTitle = sanitizeText(itinerary.tripTitle || 'Trip Plan', 160);
    const safeSummary = sanitizeText(itinerary.summary || '', 500);
    const safeCurrency = sanitizeText(itinerary.currency || 'USD', 8);
    const safeTotalCost = Number(itinerary.totalEstimatedCost || 0);
    const subject = `Your TravelAI Itinerary: ${safeTitle}`;
    const html = itineraryToEmailHtml(itinerary);
    const text = `Trip: ${safeTitle}\nSummary: ${safeSummary}\nEstimated Cost: $${Number.isFinite(safeTotalCost) ? safeTotalCost : 0} ${safeCurrency}`;

    await transporter.sendMail({
      from: cfg.from,
      to: safeToEmail,
      subject,
      text,
      html
    });

    res.json({ success: true, message: `Itinerary sent to ${safeToEmail}` });
  } catch (error) {
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to send itinerary email') });
  }
});

app.listen(PORT, () => {
  console.log(`Travel Planner running at http://localhost:${PORT}`);
});
