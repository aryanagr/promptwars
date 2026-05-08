// Unit tests for the JSON-repair parser and itinerary schema validator.
process.env.ORIGIN_GUARD = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('../server');

const { cleanAndParseJSON, validateItinerary, buildItineraryCacheKey, escapeHtml } = _internals;

// === cleanAndParseJSON ===

test('cleanAndParseJSON: well-formed JSON parses unchanged', () => {
  const obj = cleanAndParseJSON('{"a":1,"b":"hello"}');
  assert.deepEqual(obj, { a: 1, b: 'hello' });
});

test('cleanAndParseJSON: code-fenced JSON gets unwrapped', () => {
  const obj = cleanAndParseJSON('```json\n{"a":1}\n```');
  assert.deepEqual(obj, { a: 1 });
});

test('cleanAndParseJSON: text before and after the object is trimmed', () => {
  const obj = cleanAndParseJSON('Sure! Here you go:\n{"a":2}\nLet me know if you want changes.');
  assert.deepEqual(obj, { a: 2 });
});

test('cleanAndParseJSON: truncated string is auto-closed', () => {
  // Cuts off mid-string and mid-object — both must be repaired.
  const obj = cleanAndParseJSON('{"a":"hello world');
  assert.equal(obj.a, 'hello world');
});

test('cleanAndParseJSON: trailing commas are stripped', () => {
  const obj = cleanAndParseJSON('{"a":1,"b":[1,2,3,],}');
  assert.deepEqual(obj, { a: 1, b: [1, 2, 3] });
});

test('cleanAndParseJSON: missing comma between properties is recovered', () => {
  const obj = cleanAndParseJSON('{"a":1 "b":2}');
  assert.deepEqual(obj, { a: 1, b: 2 });
});

test('cleanAndParseJSON: smart quotes are normalized', () => {
  const obj = cleanAndParseJSON('{"a": “smart”}');
  assert.equal(obj.a, 'smart');
});

test('cleanAndParseJSON: empty input throws', () => {
  assert.throws(() => cleanAndParseJSON(''), /empty/i);
});

test('cleanAndParseJSON: whitespace-only input throws empty error', () => {
  assert.throws(() => cleanAndParseJSON('   \n\t  '), /empty/i);
});

// === validateItinerary ===

test('validateItinerary: complete itinerary returns no errors', () => {
  const errors = validateItinerary({
    tripTitle: 'Trip',
    summary: 'Summary',
    totalEstimatedCost: 100,
    days: [{
      day: 1,
      date: '2026-05-10',
      city: 'Jaipur',
      activities: [{
        time: '09:00 AM', title: 'A', description: 'd', location: 'L',
        lat: 26.9, lng: 75.8, duration: '60 mins', estimatedCost: 10, category: 'food'
      }]
    }]
  });
  assert.deepEqual(errors, []);
});

test('validateItinerary: missing top-level fields are reported', () => {
  const errors = validateItinerary({});
  assert.ok(errors.some((e) => /tripTitle/.test(e)));
  assert.ok(errors.some((e) => /summary/.test(e)));
  assert.ok(errors.some((e) => /totalEstimatedCost/.test(e)));
});

test('validateItinerary: rejects out-of-range lat/lng', () => {
  const errors = validateItinerary({
    tripTitle: 'T', summary: 'S', totalEstimatedCost: 0,
    days: [{
      day: 1, date: '2026-05-10', city: 'X',
      activities: [{
        time: '09:00 AM', title: 'A', description: 'd', location: 'L',
        lat: 200, lng: -999, duration: '1h', estimatedCost: 1, category: 'food'
      }]
    }]
  });
  assert.ok(errors.some((e) => /lat/i.test(e)));
  assert.ok(errors.some((e) => /lng/i.test(e)));
});

test('validateItinerary: ACCEPTS lat/lng of zero (null island)', () => {
  const errors = validateItinerary({
    tripTitle: 'T', summary: 'S', totalEstimatedCost: 0,
    days: [{
      day: 1, date: '2026-05-10', city: 'X',
      activities: [{
        time: '09:00 AM', title: 'A', description: 'd', location: 'L',
        lat: 0, lng: 0, duration: '1h', estimatedCost: 1, category: 'food'
      }]
    }]
  });
  assert.ok(!errors.some((e) => /lat|lng/i.test(e)));
});

test('validateItinerary: flags duplicate place', () => {
  const dupAct = {
    time: '09:00 AM', title: 'Same', description: 'd', location: 'Same Place',
    lat: 1, lng: 1, duration: '1h', estimatedCost: 1, category: 'food'
  };
  const errors = validateItinerary({
    tripTitle: 'T', summary: 'S', totalEstimatedCost: 0,
    days: [{
      day: 1, date: '2026-05-10', city: 'X',
      activities: [dupAct, { ...dupAct, time: '11:00 AM' }]
    }]
  });
  assert.ok(errors.some((e) => /duplicate/i.test(e)));
});

// === buildItineraryCacheKey ===

test('buildItineraryCacheKey: equivalent payloads hash identically', () => {
  const a = buildItineraryCacheKey({
    fromPlace: 'Mumbai', toPlace: 'Jaipur', destination: 'Jaipur',
    startDate: '2026-05-10', endDate: '2026-05-12',
    budget: 1000, travelers: 2, interests: 'food, culture',
    transportMode: 'driving', transportBookingRequired: false,
    stops: [{ city: 'Udaipur', days: 1 }]
  });
  const b = buildItineraryCacheKey({
    // Same values, different casing/whitespace where normalize should win.
    fromPlace: '  mumbai ', toPlace: 'JAIPUR', destination: 'jaipur',
    startDate: '2026-05-10', endDate: '2026-05-12',
    budget: 1000, travelers: 2, interests: 'food, culture',
    transportMode: 'DRIVING', transportBookingRequired: false,
    stops: [{ city: ' UDAIPUR ', days: 1 }]
  });
  assert.equal(a, b);
});

test('buildItineraryCacheKey: differing budget produces different key', () => {
  const base = {
    fromPlace: 'A', toPlace: 'B', destination: 'B',
    startDate: '2026-05-10', endDate: '2026-05-12',
    budget: 1000, travelers: 1, interests: 'x',
    transportMode: 'driving', transportBookingRequired: false, stops: []
  };
  const a = buildItineraryCacheKey(base);
  const b = buildItineraryCacheKey({ ...base, budget: 2000 });
  assert.notEqual(a, b);
});

// === escapeHtml ===

test('escapeHtml: escapes the standard XSS characters', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('"hello"&\'world\''), '&quot;hello&quot;&amp;&#39;world&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});
