// Gemini integration: model factory, prompt template, JSON-repair parser, retry.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { jsonrepair } = require('jsonrepair');
const { log } = require('../utils/log');

let memoizedModel = null;
let memoizedModelKey = null;

function getModel({ apiKey, modelName = 'gemini-2.5-flash-lite', maxOutputTokens = 4096, temperature = 0.5 } = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured.');
  if (memoizedModel && memoizedModelKey === apiKey) return memoizedModel;
  const genAI = new GoogleGenerativeAI(apiKey);
  memoizedModel = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' }
  });
  memoizedModelKey = apiKey;
  return memoizedModel;
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
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
  if (jsonStart !== -1 && jsonEnd !== -1) cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  try { return JSON.parse(cleaned); } catch {}
  try { return JSON.parse(tryCloseTruncatedJson(cleaned)); } catch {}
  try { return JSON.parse(jsonrepair(cleaned)); } catch (finalErr) {
    const preview = cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned;
    log.error('JSON parse failed after all repairs', { error: finalErr.message, preview });
    throw new Error('AI returned malformed JSON that could not be repaired.');
  }
}

async function generateWithRetry({ model, prompt, timeoutMs, maxRetries = 1 }) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await withTimeout(model.generateContent(prompt), timeoutMs, 'AI is taking too long to respond. Please try again.');
      const response = await result.response;
      return cleanAndParseJSON(response.text());
    } catch (err) {
      lastError = err;
      log.warn('gemini.attempt.failed', { attempt: attempt + 1, error: err.message });
      if (attempt >= maxRetries) throw lastError;
    }
  }
  throw lastError;
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

module.exports = {
  getModel,
  withTimeout,
  cleanAndParseJSON,
  tryCloseTruncatedJson,
  generateWithRetry,
  BASE_PROMPT
};
