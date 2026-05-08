const fs = require('fs');
const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const nodemailer = require('nodemailer');

const isCloudRun = Boolean(process.env.K_SERVICE);
if (!isCloudRun) {
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static('public'));

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
  return {
    host: envValue('SMTP_HOST'),
    port: Number(envValue('SMTP_PORT') || 587),
    secure: String(envValue('SMTP_SECURE') || 'false').toLowerCase() === 'true',
    user: envValue('SMTP_USER'),
    pass: envValue('SMTP_PASS'),
    from: envValue('MAIL_FROM') || envValue('SMTP_USER')
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
  return Boolean(cfg.host && cfg.port && cfg.user && cfg.pass && cfg.from);
}

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
      maxOutputTokens: 1400,
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
    const acts = (day.activities || []).map(act => (
      `<li><strong>${act.time || ''}</strong> - ${act.title || 'Activity'} (${act.location || ''}) | ${act.duration || ''} | $${act.estimatedCost || 0}</li>`
    )).join('');
    return `<h3>Day ${day.day}${day.date ? ` - ${day.date}` : ''}</h3><p><strong>${day.theme || ''}</strong></p><ul>${acts}</ul>`;
  }).join('');

  const tips = (itinerary.tips || []).map(t => `<li>${t}</li>`).join('');
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;">
      <h1>${itinerary.tripTitle || 'Trip Itinerary'}</h1>
      <p>${itinerary.summary || ''}</p>
      <p><strong>Total Estimated Cost:</strong> $${itinerary.totalEstimatedCost || 0} ${itinerary.currency || 'USD'}</p>
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
  dayRequired: ['day', 'activities'],
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
        if (act.lat && (act.lat < -90 || act.lat > 90)) errors.push(`Invalid lat for ${act.title}`);
        if (act.lng && (act.lng < -180 || act.lng > 180)) errors.push(`Invalid lng for ${act.title}`);
      });
    }
  });
  return errors;
}

function cleanAndParseJSON(text) {
  let cleaned = (text || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  if (!cleaned) throw new Error('Empty AI response');
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try lightweight repair for truncated LLM JSON.
    let inString = false;
    let escaped = false;
    let brace = 0;
    let bracket = 0;
    for (const ch of cleaned) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '{') brace += 1;
        if (ch === '}') brace -= 1;
        if (ch === '[') bracket += 1;
        if (ch === ']') bracket -= 1;
      }
    }
    let repaired = cleaned;
    if (inString) repaired += '"';
    if (bracket > 0) repaired += ']'.repeat(bracket);
    if (brace > 0) repaired += '}'.repeat(brace);
    return JSON.parse(repaired);
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
        22000,
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
  res.json({ key: process.env.GOOGLE_MAPS_API_KEY });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    runtime: isCloudRun ? 'cloud-run' : 'local',
    geminiConfigured: hasValidGeminiKey(),
    mapsConfigured: hasValidMapsKey()
  });
});

app.post('/api/generate-itinerary', async (req, res) => {
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
      transportBookingRequired
    } = req.body;

    if (!destination || !startDate || !endDate || !budget || !fromPlace || !toPlace) {
      return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    if (!hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set it in Cloud Run env/secrets (or local .env for development).' });
    }

    const prompt = `${BASE_PROMPT}\n\nTRIP DETAILS:\n- From: ${fromPlace}\n- To: ${toPlace}\n- Destination Area: ${destination}\n- Start Date: ${startDate}\n- End Date: ${endDate}\n- Budget: $${budget} USD total\n- Number of Travelers: ${travelers || 1}\n- Interests: ${interests || 'General sightseeing, local food, culture'}\n- Preferred Transport Mode: ${transportMode || 'driving'}\n- Need Transport Booking Options: ${transportBookingRequired ? 'yes' : 'no'}\n\nAlso include practical movement between activities considering the preferred transport mode.`;

    const itinerary = await generateWithRetry(prompt);
    const enriched = enrichWithBookingLinks(itinerary);
    res.json({ success: true, itinerary: enriched });
  } catch (error) {
    console.error('Error generating itinerary:', error);
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to generate itinerary') });
  }
});

app.post('/api/replan-activity', async (req, res) => {
  try {
    const { itinerary, dayIndex, activityIndex, reason } = req.body;
    if (!itinerary || dayIndex === undefined || activityIndex === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required fields for replan.' });
    }

    if (!hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set it in Cloud Run env/secrets (or local .env for development).' });
    }

    const day = itinerary.days[dayIndex];
    const activity = day.activities[activityIndex];

    const otherActivities = day.activities
      .filter((_, i) => i !== activityIndex)
      .map(a => a.title)
      .join(', ');

    const model = getModel();
    const prompt = `You are a travel planner. Replace ONE activity in an itinerary.

CURRENT ACTIVITY TO REPLACE:
- Title: ${activity.title}
- Time: ${activity.time}
- Location: ${activity.location}
- Category: ${activity.category}
${reason ? `- Reason for change: ${reason}` : ''}

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
      20000,
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

    itinerary.days[dayIndex].activities[activityIndex] = newActivity;
    res.json({ success: true, itinerary, replacedActivity: activity, newActivity });
  } catch (error) {
    console.error('Error replanning:', error);
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to replan activity') });
  }
});

app.post('/api/replan-day', async (req, res) => {
  try {
    const { itinerary, dayIndex, reason } = req.body;
    if (!hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set it in Cloud Run env/secrets (or local .env for development).' });
    }

    const day = itinerary.days[dayIndex];
    const destination = day.activities[0]?.location || 'the destination';

    const otherDaysPlaces = itinerary.days
      .filter((_, i) => i !== dayIndex)
      .flatMap(d => d.activities.map(a => a.title))
      .join(', ');

    const prompt = `${BASE_PROMPT}\n\nREPLAN REQUEST: Replace ALL activities for Day ${day.day} (${day.date || ''}).\n${reason ? `Reason: ${reason}` : ''}\nDestination area: ${destination}\nAVOID these places (already in other days): ${otherDaysPlaces}\nKeep the same date and day number. Return ONLY the single day object as JSON.\n\nReturn format:\n{\n  "day": ${day.day},\n  "date": "${day.date || ''}",\n  "theme": "New theme",\n  "activities": [ ... ]\n}`;

    const model = getModel();
    const result = await withTimeout(
      model.generateContent(prompt),
      25000,
      'AI is taking too long to respond. Please try again.'
    );
    const text = result.response.text();
    const newDay = cleanAndParseJSON(text);

    itinerary.days[dayIndex] = newDay;
    const enriched = enrichWithBookingLinks(itinerary);

    res.json({ success: true, itinerary: enriched });
  } catch (error) {
    console.error('Error replanning day:', error);
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to replan day') });
  }
});

app.post('/api/validate-places', async (req, res) => {
  try {
    if (!hasValidMapsKey()) {
      return res.status(500).json({ success: false, error: 'GOOGLE_MAPS_API_KEY is not configured.' });
    }
    const { itinerary, destination } = req.body;
    if (!itinerary?.days) return res.status(400).json({ success: false, error: 'Missing itinerary.' });

    let validatedCount = 0;
    let unresolvedCount = 0;
    for (const day of itinerary.days) {
      for (const act of day.activities || []) {
        const place = await placesTextSearch(`${act.location || act.title} ${destination || ''}`.trim());
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

app.post('/api/compute-routes', async (req, res) => {
  try {
    if (!hasValidMapsKey()) {
      return res.status(500).json({ success: false, error: 'GOOGLE_MAPS_API_KEY is not configured.' });
    }
    const { itinerary, travelMode } = req.body;
    if (!itinerary?.days) return res.status(400).json({ success: false, error: 'Missing itinerary.' });

    for (const day of itinerary.days) {
      const acts = day.activities || [];
      for (let i = 1; i < acts.length; i++) {
        const prev = acts[i - 1];
        const cur = acts[i];
        if (prev?.lat && prev?.lng && cur?.lat && cur?.lng) {
          const route = await computeRouteMinutes(
            { lat: prev.lat, lng: prev.lng },
            { lat: cur.lat, lng: cur.lng },
            travelMode || 'DRIVE'
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

app.post('/api/apply-constraints', async (req, res) => {
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

app.post('/api/replan-segment', async (req, res) => {
  try {
    if (!hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set it in Cloud Run env/secrets (or local .env for development).' });
    }
    const { itinerary, dayIndex, startActivityIndex, endActivityIndex, reason, constraints = {} } = req.body;
    if (!itinerary?.days || dayIndex === undefined || startActivityIndex === undefined || endActivityIndex === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required fields for segment replan.' });
    }
    const day = itinerary.days[dayIndex];
    const before = day.activities.slice(0, startActivityIndex).map(a => a.title).join(', ');
    const after = day.activities.slice(endActivityIndex + 1).map(a => a.title).join(', ');
    const originalSeg = day.activities.slice(startActivityIndex, endActivityIndex + 1);
    const segmentSize = originalSeg.length;
    const slotBudget = originalSeg.reduce((s, a) => s + Number(a.estimatedCost || 0), 0);

    const prompt = `Replan a segment of a day itinerary.\n\nDay context: ${day.theme || `Day ${day.day}`} (${day.date || ''})\nReason: ${reason || 'Improve fit'}\nKeep activities before segment unchanged: ${before || 'none'}\nKeep activities after segment unchanged: ${after || 'none'}\nSegment length must be exactly ${segmentSize} activities.\nSegment budget should stay near $${slotBudget}.\nMax travel minutes per hop: ${constraints.maxTravelMinutesPerHop || 90}.\n\nReturn ONLY JSON:\n{\n  "activities": [\n    {\n      "time": "09:00 AM",\n      "title": "Activity name",\n      "description": "Brief description",\n      "location": "Full place name and area",\n      "lat": 0.0,\n      "lng": 0.0,\n      "duration": "2 hours",\n      "estimatedCost": 0,\n      "category": "sightseeing|food|adventure|culture|shopping|transport|relaxation"\n    }\n  ]\n}`;

    const model = getModel();
    const result = await withTimeout(
      model.generateContent(prompt),
      25000,
      'AI is taking too long to respond. Please try again.'
    );
    const parsed = cleanAndParseJSON(result.response.text());
    const newSeg = parsed.activities;
    if (!Array.isArray(newSeg) || newSeg.length !== segmentSize) {
      return res.status(500).json({ success: false, error: 'Segment replan output size mismatch.' });
    }

    day.activities.splice(startActivityIndex, segmentSize, ...newSeg);
    enrichWithBookingLinks(itinerary);
    res.json({ success: true, itinerary, dayIndex, startActivityIndex, endActivityIndex });
  } catch (error) {
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to replan segment') });
  }
});

app.post('/api/email-itinerary', async (req, res) => {
  try {
    if (!hasValidMailerConfig()) {
      return res.status(500).json({
        success: false,
        error: 'Mail service is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.'
      });
    }
    const { toEmail, itinerary } = req.body;
    if (!toEmail || !itinerary?.days) {
      return res.status(400).json({ success: false, error: 'Missing toEmail or itinerary.' });
    }

    const cfg = getMailerConfig();
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass }
    });

    const subject = `Your TravelAI Itinerary: ${itinerary.tripTitle || 'Trip Plan'}`;
    const html = itineraryToEmailHtml(itinerary);
    const text = `Trip: ${itinerary.tripTitle || 'Trip Plan'}\nSummary: ${itinerary.summary || ''}\nEstimated Cost: $${itinerary.totalEstimatedCost || 0} ${itinerary.currency || 'USD'}`;

    await transporter.sendMail({
      from: cfg.from,
      to: toEmail,
      subject,
      text,
      html
    });

    res.json({ success: true, message: `Itinerary sent to ${toEmail}` });
  } catch (error) {
    res.status(500).json({ success: false, error: formatApiError(error, 'Failed to send itinerary email') });
  }
});

app.listen(PORT, () => {
  console.log(`Travel Planner running at http://localhost:${PORT}`);
});
