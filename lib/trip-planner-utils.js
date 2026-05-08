// Pure helpers for multi-city trip planning. No I/O — safe to unit-test.

// Lowercase + collapse whitespace so 'Jaipur' / ' jaipur ' / 'Jaipur ' all match.
function normalizeCityName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseDateInputUtc(dateText) {
  if (!dateText || typeof dateText !== 'string') return null;
  const parts = dateText.split('-').map(Number);
  if (parts.length !== 3) return null;
  const [year, month, day] = parts;
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function toYmdUtc(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

// All YYYY-MM-DD dates from start to end inclusive (UTC); empty if range is invalid.
function buildInclusiveDates(startDate, endDate) {
  const start = parseDateInputUtc(startDate);
  const end = parseDateInputUtc(endDate);
  if (!start || !end || end < start) return [];
  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(toYmdUtc(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function sanitizeStops(stops) {
  if (!Array.isArray(stops)) return [];
  return stops.map((stop) => ({
    city: String(stop?.city || '').trim().replace(/\s+/g, ' '),
    days: Number(stop?.days)
  })).filter((stop) => stop.city);
}

// Allocates trip days to stops first, then destination; throws on invalid input.
function buildCityPlan({ destination, startDate, endDate, stops }) {
  const dates = buildInclusiveDates(startDate, endDate);
  if (!dates.length) {
    throw new Error('Invalid date range. End date must be after or equal to start date.');
  }

  const sanitizedStops = sanitizeStops(stops);
  const normalizedDestination = normalizeCityName(destination);
  const seen = new Set();
  let stopDaysTotal = 0;
  const cleanStops = [];

  for (let i = 0; i < sanitizedStops.length; i += 1) {
    const stop = sanitizedStops[i];
    const normalizedStop = normalizeCityName(stop.city);
    if (normalizedStop === normalizedDestination) {
      throw new Error(`Stop city "${stop.city}" cannot be same as destination city.`);
    }
    if (seen.has(normalizedStop)) {
      throw new Error(`Duplicate stop city: ${stop.city}`);
    }
    seen.add(normalizedStop);
    if (!Number.isInteger(stop.days) || stop.days < 1) {
      throw new Error(`Stop city "${stop.city}" must have at least 1 day.`);
    }
    cleanStops.push(stop);
    stopDaysTotal += stop.days;
  }

  if (cleanStops.length > 0 && stopDaysTotal >= dates.length) {
    throw new Error('Intermediate stop days are too high. Keep at least 1 day for destination city.');
  }

  const destinationDays = dates.length - stopDaysTotal;
  if (destinationDays < 1) {
    throw new Error('Destination city must have at least 1 day.');
  }

  const cityDayPlan = [];
  let pointer = 0;
  cleanStops.forEach((stop) => {
    for (let i = 0; i < stop.days; i += 1) {
      cityDayPlan.push({ day: pointer + 1, date: dates[pointer], city: stop.city });
      pointer += 1;
    }
  });
  for (let i = 0; i < destinationDays; i += 1) {
    cityDayPlan.push({ day: pointer + 1, date: dates[pointer], city: destination });
    pointer += 1;
  }

  return {
    totalDays: dates.length,
    dates,
    stops: cleanStops,
    destinationDays,
    cityDayPlan
  };
}

// Force AI's day list to match the cityPlan exactly (truncate, pad, or relabel).
function applyCityPlanToItinerary(itinerary, cityPlan) {
  if (!Array.isArray(itinerary?.days)) {
    throw new Error('AI response missing day list.');
  }
  if (itinerary.days.length > cityPlan.totalDays) {
    itinerary.days = itinerary.days.slice(0, cityPlan.totalDays);
  }
  if (itinerary.days.length < cityPlan.totalDays) {
    for (let i = itinerary.days.length; i < cityPlan.totalDays; i += 1) {
      const plan = cityPlan.cityDayPlan[i];
      itinerary.days.push({
        day: plan.day,
        date: plan.date,
        city: plan.city,
        theme: `${plan.city} flexible day`,
        activities: []
      });
    }
  }
  itinerary.days.forEach((day, idx) => {
    const plan = cityPlan.cityDayPlan[idx];
    day.day = plan.day;
    day.date = plan.date;
    day.city = plan.city;
  });
  return itinerary;
}

module.exports = {
  normalizeCityName,
  parseDateInputUtc,
  toYmdUtc,
  buildInclusiveDates,
  sanitizeStops,
  buildCityPlan,
  applyCityPlanToItinerary
};
