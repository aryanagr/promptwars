// Google Cloud Translation API (v2) — translates itinerary text fields into
// a target language. Used by /api/translate-itinerary to add localization.

const { sanitizeText } = require('../utils/sanitize');

async function translateBatch(apiKey, texts, targetLang, sourceLang) {
  if (!apiKey || !Array.isArray(texts) || !texts.length) return texts;
  const params = new URLSearchParams({ key: apiKey, target: targetLang, format: 'text' });
  if (sourceLang) params.set('source', sourceLang);
  for (const t of texts) params.append('q', t);
  const resp = await fetch(`https://translation.googleapis.com/language/translate/v2?${params.toString()}`);
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Translate failed (${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  return (data.data?.translations || []).map((t) => t.translatedText);
}

// Walk the itinerary, collect every translatable string, send as one batch.
async function translateItinerary(apiKey, itinerary, targetLang) {
  if (!itinerary || !targetLang) return itinerary;
  const safeLang = sanitizeText(targetLang, 10).toLowerCase();
  const buckets = [];
  const slots = [];
  const push = (obj, key) => {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) {
      slots.push({ obj, key });
      buckets.push(v);
    }
  };
  push(itinerary, 'tripTitle');
  push(itinerary, 'summary');
  (itinerary.tips || []).forEach((tip, i) => {
    if (typeof tip === 'string' && tip.trim()) {
      slots.push({ obj: itinerary.tips, key: i });
      buckets.push(tip);
    }
  });
  for (const day of itinerary.days || []) {
    push(day, 'theme');
    for (const act of day.activities || []) {
      push(act, 'title');
      push(act, 'description');
    }
  }
  if (!buckets.length) return itinerary;
  const translated = await translateBatch(apiKey, buckets, safeLang);
  slots.forEach((slot, i) => {
    const out = translated[i];
    if (typeof out === 'string') slot.obj[slot.key] = out;
  });
  itinerary.translatedTo = safeLang;
  return itinerary;
}

module.exports = { translateBatch, translateItinerary };
