// Google Maps server-side clients: Places, Routes, Geocoding, Static Maps,
// plus a small concurrency helper used to parallelize per-activity calls.

async function placesTextSearch(apiKey, query) {
  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.googleMapsUri,places.regularOpeningHours.openNow'
    },
    body: JSON.stringify({ textQuery: query, pageSize: 1 })
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Places search failed (${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  return data.places?.[0] || null;
}

async function computeRouteMinutes(apiKey, origin, destination, travelMode = 'DRIVE') {
  const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode
    })
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

async function geocodeAddress(apiKey, address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Geocoding failed (${resp.status}): ${txt}`);
  }
  const data = await resp.json();
  if (data.status !== 'OK' || !data.results?.length) return null;
  const r = data.results[0];
  return {
    formattedAddress: r.formatted_address,
    lat: r.geometry?.location?.lat,
    lng: r.geometry?.location?.lng,
    placeId: r.place_id,
    types: r.types || []
  };
}

function buildStaticMapUrl(apiKey, activities, { width = 600, height = 320 } = {}) {
  if (!apiKey) return null;
  const points = (activities || [])
    .map((a) => ({ lat: Number(a.lat), lng: Number(a.lng), title: a.title }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (points.length === 0) return null;
  const markers = points
    .slice(0, 10)
    .map((p, i) => `markers=color:red%7Clabel:${i + 1}%7C${p.lat},${p.lng}`)
    .join('&');
  return `https://maps.googleapis.com/maps/api/staticmap?size=${width}x${height}&scale=2&${markers}&key=${encodeURIComponent(apiKey)}`;
}

// Run async tasks with bounded concurrency. Preserves order in the results array.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { results[i] = await fn(items[i], i); }
      catch (err) { results[i] = { __error: err }; }
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = {
  placesTextSearch,
  computeRouteMinutes,
  geocodeAddress,
  buildStaticMapUrl,
  mapWithConcurrency
};
