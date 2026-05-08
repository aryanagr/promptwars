require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

function getGeminiApiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_KEY ||
    ''
  ).trim();
}

function hasValidGeminiKey() {
  const key = getGeminiApiKey();
  return Boolean(key && key !== 'your_gemini_api_key_here');
}

function getModel() {
  const key = getGeminiApiKey();
  if (!hasValidGeminiKey()) {
    throw new Error('GEMINI_API_KEY is not configured. Set a real Gemini API key in .env and restart server.');
  }
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
}

function formatApiError(error, fallbackMessage) {
  const providerMessage = error?.message || error?.errorDetails?.[0]?.message;
  if (providerMessage) return `${fallbackMessage} (${providerMessage})`;
  return fallbackMessage;
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
  let cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }
  return JSON.parse(cleaned);
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

const BASE_PROMPT = `You are an expert travel planner with deep knowledge of destinations worldwide. Create a detailed, personalized travel itinerary.

IMPORTANT RULES:
1. Create a day-by-day itinerary with specific places, times, and estimated costs.
2. Include a mix of popular attractions and hidden gems based on the traveler's interests.
3. Provide ACCURATE latitude and longitude coordinates for each place — these MUST be real coordinates.
4. Keep the total estimated cost within the budget.
5. Include breakfast, lunch, and dinner recommendations each day.
6. Add practical travel tips specific to the destination.
7. Do NOT repeat the same place across multiple days.
8. Ensure activities don't overlap in time — leave travel time between locations.
9. Consider typical opening hours for each venue.

RESPOND IN THIS EXACT JSON FORMAT (no markdown, no code blocks, just raw JSON):
{
  "tripTitle": "Amazing trip title",
  "summary": "2-3 sentence trip overview",
  "totalEstimatedCost": 0,
  "currency": "USD",
  "tips": ["tip1", "tip2", "tip3", "tip4", "tip5"],
  "days": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "theme": "Day theme/title",
      "activities": [
        {
          "time": "09:00 AM",
          "title": "Activity name",
          "description": "Brief description of the activity and why it's recommended",
          "location": "Full place name and area",
          "lat": 0.0,
          "lng": 0.0,
          "duration": "2 hours",
          "estimatedCost": 0,
          "category": "sightseeing|food|adventure|culture|shopping|transport|relaxation"
        }
      ]
    }
  ]
}`;

async function generateWithRetry(prompt, maxRetries = 2) {
  const model = getModel();
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      const itinerary = cleanAndParseJSON(text);
      const errors = validateItinerary(itinerary);

      if (errors.length > 0 && attempt < maxRetries) {
        console.warn(`Attempt ${attempt + 1} validation errors:`, errors);
        continue;
      }
      if (errors.length > 0) {
        console.warn('Validation warnings (serving anyway):', errors);
      }
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
    geminiConfigured: hasValidGeminiKey(),
    mapsConfigured: Boolean((process.env.GOOGLE_MAPS_API_KEY || '').trim())
  });
});

app.post('/api/generate-itinerary', async (req, res) => {
  try {
    const { destination, startDate, endDate, budget, travelers, interests } = req.body;

    if (!destination || !startDate || !endDate || !budget) {
      return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    if (!hasValidGeminiKey()) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set a real Gemini API key in .env and restart server.' });
    }

    const prompt = `${BASE_PROMPT}\n\nTRIP DETAILS:\n- Destination: ${destination}\n- Start Date: ${startDate}\n- End Date: ${endDate}\n- Budget: $${budget} USD total\n- Number of Travelers: ${travelers || 1}\n- Interests: ${interests || 'General sightseeing, local food, culture'}`;

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
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set a real Gemini API key in .env and restart server.' });
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

    const result = await model.generateContent(prompt);
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
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY is not configured. Set a real Gemini API key in .env and restart server.' });
    }

    const day = itinerary.days[dayIndex];
    const destination = day.activities[0]?.location || 'the destination';

    const otherDaysPlaces = itinerary.days
      .filter((_, i) => i !== dayIndex)
      .flatMap(d => d.activities.map(a => a.title))
      .join(', ');

    const prompt = `${BASE_PROMPT}\n\nREPLAN REQUEST: Replace ALL activities for Day ${day.day} (${day.date || ''}).\n${reason ? `Reason: ${reason}` : ''}\nDestination area: ${destination}\nAVOID these places (already in other days): ${otherDaysPlaces}\nKeep the same date and day number. Return ONLY the single day object as JSON.\n\nReturn format:\n{\n  "day": ${day.day},\n  "date": "${day.date || ''}",\n  "theme": "New theme",\n  "activities": [ ... ]\n}`;

    const model = getModel();
    const result = await model.generateContent(prompt);
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

app.listen(PORT, () => {
  console.log(`Travel Planner running at http://localhost:${PORT}`);
});
