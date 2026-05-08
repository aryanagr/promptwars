const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildInclusiveDates,
  sanitizeStops,
  buildCityPlan,
  applyCityPlanToItinerary
} = require('../lib/trip-planner-utils');

test('buildInclusiveDates returns inclusive day list', () => {
  const dates = buildInclusiveDates('2026-05-10', '2026-05-12');
  assert.deepEqual(dates, ['2026-05-10', '2026-05-11', '2026-05-12']);
});

test('sanitizeStops trims and removes empty city rows', () => {
  const stops = sanitizeStops([
    { city: ' Udaipur ', days: '2' },
    { city: '', days: 1 },
    { city: '  ', days: 3 }
  ]);
  assert.deepEqual(stops, [{ city: 'Udaipur', days: 2 }]);
});

test('buildCityPlan allocates stop days first then destination days', () => {
  const plan = buildCityPlan({
    destination: 'Jaipur',
    startDate: '2026-05-10',
    endDate: '2026-05-13',
    stops: [{ city: 'Udaipur', days: 1 }]
  });
  assert.equal(plan.totalDays, 4);
  assert.equal(plan.destinationDays, 3);
  assert.deepEqual(plan.cityDayPlan.map((d) => d.city), ['Udaipur', 'Jaipur', 'Jaipur', 'Jaipur']);
});

test('buildCityPlan rejects stop city equal to destination', () => {
  assert.throws(() => buildCityPlan({
    destination: 'Jaipur',
    startDate: '2026-05-10',
    endDate: '2026-05-12',
    stops: [{ city: 'Jaipur', days: 1 }]
  }), /cannot be same as destination/i);
});

test('applyCityPlanToItinerary normalizes days and pads if needed', () => {
  const cityPlan = buildCityPlan({
    destination: 'Jaipur',
    startDate: '2026-05-10',
    endDate: '2026-05-12',
    stops: [{ city: 'Udaipur', days: 1 }]
  });
  const itinerary = {
    tripTitle: 'Sample',
    summary: 'Sample',
    totalEstimatedCost: 100,
    days: [
      { day: 10, date: '2099-01-01', city: 'Wrong', activities: [] },
      { day: 11, date: '2099-01-02', city: 'Wrong', activities: [] }
    ]
  };
  const normalized = applyCityPlanToItinerary(itinerary, cityPlan);
  assert.equal(normalized.days.length, 3);
  assert.deepEqual(normalized.days.map((d) => d.day), [1, 2, 3]);
  assert.deepEqual(normalized.days.map((d) => d.city), ['Udaipur', 'Jaipur', 'Jaipur']);
  assert.equal(normalized.days[2].theme, 'Jaipur flexible day');
});
