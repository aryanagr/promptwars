// TravelAI frontend: collects form input, calls /api endpoints, renders the
// itinerary into day tabs / activity cards / Google Map markers.

// === Module-scope state (no bundler — globals on purpose) ===

let gMap, markers = [], itineraryData = null, currentDayIndex = 0, mapsReady = false;
let directionsService = null;
let directionsRenderer = null;
const ACTIVITIES_PER_PAGE = 5;
const dayActivityPage = {};
let replanInFlight = false;
let routeInFlight = false;
const userPreferences = {
  fromPlace: '',
  toPlace: '',
  transportMode: 'driving',
  transportBookingRequired: false
};
const MAX_INTERMEDIATE_STOPS = 6;

// Set default dates
document.addEventListener('DOMContentLoaded', () => {
  const today = new Date();
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 3);
  document.getElementById('start-date').value = formatDate(today);
  document.getElementById('end-date').value = formatDate(nextWeek);
  initRoutePlannerInputs();
  refreshServiceAvailability();
});

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function normalizeCityName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// === HTML escaping helpers (used wherever AI/user data lands in innerHTML) ===

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Allow only http/https/mailto/tel/relative — drop javascript: and data: URLs.
function safeUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  if (/^(https?:|mailto:|tel:)/i.test(raw) || raw.startsWith('/') || raw.startsWith('#')) {
    return escapeHtml(raw);
  }
  return '';
}

// === Form helpers (city sync, intermediate stops, validation) ===

function syncDestinationWithTo() {
  const toInput = document.getElementById('to-place');
  const destinationInput = document.getElementById('destination');
  if (!toInput || !destinationInput) return;
  destinationInput.value = toInput.value.trim();
}

function createStopRow(city = '', days = 1) {
  const row = document.createElement('div');
  row.className = 'stop-row';
  row.innerHTML = `
    <input type="text" class="stop-city" data-field="city" placeholder="e.g. Udaipur, India" value="${city}" aria-label="Intermediate stop city">
    <input type="number" class="stop-days" data-field="days" min="1" max="30" step="1" value="${days}" aria-label="Days in this stop city">
    <button type="button" class="btn-secondary stop-remove-btn" aria-label="Remove stop">✖</button>
  `;
  const removeBtn = row.querySelector('.stop-remove-btn');
  removeBtn.addEventListener('click', () => row.remove());
  return row;
}

function addStopRow(city = '', days = 1) {
  const container = document.getElementById('stops-container');
  if (!container) return;
  if (container.children.length >= MAX_INTERMEDIATE_STOPS) {
    showToast(`You can add up to ${MAX_INTERMEDIATE_STOPS} stops.`);
    return;
  }
  container.appendChild(createStopRow(city, days));
}

function collectIntermediateStops() {
  const container = document.getElementById('stops-container');
  if (!container) return [];
  const rows = [...container.querySelectorAll('.stop-row')];
  return rows.map((row) => {
    const city = (row.querySelector('[data-field="city"]')?.value || '').trim();
    const daysRaw = row.querySelector('[data-field="days"]')?.value;
    const days = Number(daysRaw);
    return { city, days };
  }).filter((stop) => stop.city);
}

function calculateTripDays(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const diff = end.getTime() - start.getTime();
  if (diff < 0) return 0;
  return Math.floor(diff / 86400000) + 1;
}

function validateIntermediateStops(stops, destination, totalTripDays) {
  let stopDaysTotal = 0;
  const seen = new Set();
  const normalizedDestination = normalizeCityName(destination);

  for (let i = 0; i < stops.length; i += 1) {
    const stop = stops[i];
    const normalizedCity = normalizeCityName(stop.city);
    if (!normalizedCity) {
      return { valid: false, error: `Stop ${i + 1} city is empty.` };
    }
    if (normalizedCity === normalizedDestination) {
      return { valid: false, error: `Stop ${i + 1} cannot be same as destination city.` };
    }
    if (seen.has(normalizedCity)) {
      return { valid: false, error: `Duplicate stop city: ${stop.city}` };
    }
    seen.add(normalizedCity);

    if (!Number.isInteger(stop.days) || stop.days < 1) {
      return { valid: false, error: `Stop ${i + 1} days must be at least 1.` };
    }
    stopDaysTotal += stop.days;
  }

  if (stops.length > 0 && stopDaysTotal >= totalTripDays) {
    return { valid: false, error: 'Stop days are too many. Keep at least 1 day for destination city.' };
  }
  return { valid: true, stopDaysTotal };
}

function initRoutePlannerInputs() {
  const toInput = document.getElementById('to-place');
  if (toInput) {
    toInput.addEventListener('input', syncDestinationWithTo);
    toInput.addEventListener('blur', syncDestinationWithTo);
  }
  syncDestinationWithTo();

  const addStopBtn = document.getElementById('add-stop-btn');
  if (addStopBtn) {
    addStopBtn.addEventListener('click', () => addStopRow('', 1));
  }
}

// Disable email button when SMTP isn't configured server-side.
async function refreshServiceAvailability() {
  const emailBtn = document.getElementById('email-btn');
  if (!emailBtn) return;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const mailEnabled = Boolean(data?.mailerConfigured);
    emailBtn.disabled = !mailEnabled;
    emailBtn.setAttribute('aria-disabled', String(!mailEnabled));
    emailBtn.title = mailEnabled ? '' : 'Email disabled: configure SMTP env vars on the server.';
  } catch {
    // Ignore health-check failures here to avoid blocking itinerary UX.
  }
}

// === Form submission → /api/generate-itinerary → renderResults ===

document.getElementById('trip-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const interests = [...document.querySelectorAll('.interest-chip input:checked')]
    .map(cb => cb.value).join(', ') || 'General sightseeing';

  userPreferences.fromPlace = document.getElementById('from-place').value.trim();
  userPreferences.toPlace = document.getElementById('to-place').value.trim();
  userPreferences.transportMode = document.getElementById('transport-mode').value;
  userPreferences.transportBookingRequired = !!document.getElementById('book-transport-required').checked;
  syncDestinationWithTo();

  const destinationCity = document.getElementById('destination').value.trim();
  const startDate = document.getElementById('start-date').value;
  const endDate = document.getElementById('end-date').value;
  const budget = document.getElementById('budget').value;
  const travelers = document.getElementById('travelers').value;
  const stops = collectIntermediateStops().map((stop) => ({
    city: stop.city,
    days: Number(stop.days)
  }));
  const tripDays = calculateTripDays(startDate, endDate);

  if (!userPreferences.toPlace) {
    showError('To (final city) is required.');
    return;
  }
  if (!destinationCity) {
    showError('Destination city is required.');
    return;
  }
  if (normalizeCityName(userPreferences.toPlace) !== normalizeCityName(destinationCity)) {
    showError('To and Destination must be the same city.');
    return;
  }
  if (!startDate || !endDate || tripDays < 1) {
    showError('Please provide a valid start and end date.');
    return;
  }
  const stopValidation = validateIntermediateStops(stops, destinationCity, tripDays);
  if (!stopValidation.valid) {
    showError(stopValidation.error);
    return;
  }

  const payload = {
    fromPlace: userPreferences.fromPlace,
    toPlace: userPreferences.toPlace,
    destination: destinationCity,
    startDate,
    endDate,
    budget,
    travelers,
    interests,
    transportMode: userPreferences.transportMode,
    transportBookingRequired: userPreferences.transportBookingRequired,
    stops
  };

  const btn = document.getElementById('generate-btn');
  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loader').style.display = 'inline-flex';
  btn.disabled = true;
  document.getElementById('hero').style.display = 'none';
  document.getElementById('loading-section').style.display = 'flex';
  document.getElementById('loading-section').setAttribute('aria-busy', 'true');
  animateLoadingSteps();

  // Timeout controller - 60 second max
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const res = await fetch('/api/generate-itinerary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeout);
    let data = null;
    try {
      data = await res.json();
    } catch (parseErr) {
      throw new Error(`Invalid API response (${res.status}).`);
    }

    if (!res.ok || !data?.success) {
      showError(data?.error || `Request failed (${res.status}).`);
      return;
    }

    if (data.success) {
      itineraryData = data.itinerary;
      try {
        await loadMapsAPI();
        mapsReady = true;
      } catch (mapErr) {
        mapsReady = false;
        console.error('Google Maps load failed:', mapErr);
      }
      renderResults(data.itinerary);
      if (!mapsReady) showToast('Itinerary generated, but Google Maps failed to load. Check Maps API key/referrer settings.');
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      showFatalError('Request timed out. The AI took too long — please try again.');
    } else if (err?.message) {
      showFatalError(err.message);
    } else {
      showFatalError('Network error. Check your connection and try again.');
    }
  }
});

// === Toast / fatal error UI ===

function showToast(msg, type = 'error') {
  const announcer = document.getElementById('sr-announcer');
  if (announcer) announcer.textContent = msg;
  const toast = document.createElement('div');
  toast.className = `error-toast${type === 'success' ? ' success' : ''}`;
  toast.setAttribute('role', type === 'success' ? 'status' : 'alert');
  toast.setAttribute('aria-live', type === 'success' ? 'polite' : 'assertive');
  toast.textContent = `${type === 'success' ? '✅' : '⚠️'} ${msg}`;
  document.body.appendChild(toast);
  setTimeout(() => { toast.classList.add('show'); }, 10);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 400); }, 5000);
}

function showFatalError(msg) {
  document.getElementById('loading-section').style.display = 'none';
  document.getElementById('loading-section').setAttribute('aria-busy', 'false');
  document.getElementById('hero').style.display = 'flex';
  document.getElementById('results-section').style.display = 'none';
  const btn = document.getElementById('generate-btn');
  btn.querySelector('.btn-text').style.display = 'inline';
  btn.querySelector('.btn-loader').style.display = 'none';
  btn.disabled = false;
  showToast(msg);
  resetLoadingSteps();
}

function showError(msg) {
  showToast(msg);
}

function setReplanBusy(isBusy) {
  replanInFlight = isBusy;
  document.querySelectorAll('.replan-btn, .btn-replan-day').forEach(btn => {
    btn.classList.toggle('replan-busy', isBusy);
    if (isBusy) btn.setAttribute('disabled', 'disabled');
    else btn.removeAttribute('disabled');
  });
}

// === Modal prompt — Promise<string|null>; null = cancelled ===

function askReason(titleText, options = {}) {
  const modal = document.getElementById('reason-modal');
  const input = document.getElementById('reason-input');
  const okBtn = document.getElementById('reason-ok');
  const cancelBtn = document.getElementById('reason-cancel');
  const title = document.getElementById('reason-modal-title');

  if (!modal || !input || !okBtn || !cancelBtn || !title) {
    return Promise.resolve(prompt(titleText) || '');
  }

  return new Promise(resolve => {
    title.textContent = titleText;
    input.value = '';
    input.type = options.inputType || 'text';
    if (options.placeholder !== undefined) input.placeholder = options.placeholder;
    if (options.autocomplete !== undefined) input.autocomplete = options.autocomplete;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => input.focus(), 10);

    const cleanup = (value) => {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      input.type = 'text';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      input.removeEventListener('keydown', onKeyDown);
      resolve(value);
    };

    const onOk = () => {
      const value = input.value.trim();
      if (typeof options.validate === 'function') {
        const error = options.validate(value);
        if (error) { showToast(error); input.focus(); return; }
      }
      cleanup(value);
    };
    const onCancel = () => cleanup(null);
    const onBackdrop = (e) => { if (e.target === modal) cleanup(null); };
    const onKeyDown = (e) => {
      if (e.key === 'Enter') onOk();
      if (e.key === 'Escape') onCancel();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    input.addEventListener('keydown', onKeyDown);
  });
}

function resetForm() {
  document.getElementById('hero').style.display = 'flex';
  document.getElementById('loading-section').style.display = 'none';
  document.getElementById('loading-section').setAttribute('aria-busy', 'false');
  document.getElementById('results-section').style.display = 'none';
  const btn = document.getElementById('generate-btn');
  btn.querySelector('.btn-text').style.display = 'inline';
  btn.querySelector('.btn-loader').style.display = 'none';
  btn.disabled = false;
  resetLoadingSteps();
}

function resetLoadingSteps() {
  ['step-1','step-2','step-3','step-4'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove('active','done');
  });
  document.getElementById('step-1').textContent = '🔍 Researching destination';
  document.getElementById('step-2').textContent = '📍 Finding best locations';
  document.getElementById('step-3').textContent = '📋 Building day-by-day plan';
  document.getElementById('step-4').textContent = '💰 Optimizing for budget';
  document.getElementById('step-1').classList.add('active');
}

function animateLoadingSteps() {
  const steps = ['step-1','step-2','step-3','step-4'];
  const labels = ['🔍 Researching destination','📍 Finding best locations','📋 Building day-by-day plan','💰 Optimizing for budget'];
  let i = 0;
  const interval = setInterval(() => {
    if (i > 0) {
      document.getElementById(steps[i-1]).classList.remove('active');
      document.getElementById(steps[i-1]).classList.add('done');
      document.getElementById(steps[i-1]).textContent = '✅ ' + labels[i-1].slice(2);
    }
    if (i < steps.length) {
      document.getElementById(steps[i]).classList.add('active');
      i++;
    } else {
      clearInterval(interval);
    }
  }, 2500);
  window._loadingInterval = interval;
}

// === Google Maps SDK loader (idempotent) ===

async function loadMapsAPI() {
  if (window.google && window.google.maps) return;
  window.gm_authFailure = () => {
    mapsReady = false;
    showMapUnavailable('Google Maps authorization failed. Check key restrictions for localhost.');
  };
  const res = await fetch('/api/maps-key', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Maps key request failed (${res.status}).`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Maps key endpoint returned non-JSON response.');
  }
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error('Maps key endpoint returned invalid JSON.');
  }
  const key = payload?.key;
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=marker`;
    script.async = true;
    script.onload = () => {
      if (window.google && window.google.maps) resolve();
      else reject(new Error('Google Maps SDK loaded but unavailable.'));
    };
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(script);
  });
}

function showMapUnavailable(msg) {
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  mapEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'map-unavailable';
  wrap.textContent = msg;
  mapEl.appendChild(wrap);
}

function toLatLng(activity) {
  const lat = Number(activity?.lat);
  const lng = Number(activity?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// === Render: results header → day tabs → tips → first-day map ===

function renderResults(data) {
  if (window._loadingInterval) clearInterval(window._loadingInterval);
  document.getElementById('loading-section').style.display = 'none';
  document.getElementById('loading-section').setAttribute('aria-busy', 'false');
  document.getElementById('results-section').style.display = 'block';

  document.getElementById('trip-title').textContent = data.tripTitle || 'Your Trip';
  document.getElementById('trip-summary').textContent = data.summary || '';

  let totalPlaces = 0;
  data.days.forEach(d => totalPlaces += (d.activities || []).filter(a => !a.discarded).length);
  document.getElementById('stat-days').textContent = data.days.length;
  document.getElementById('stat-places').textContent = totalPlaces;
  document.getElementById('stat-cost').textContent = '$' + (data.totalEstimatedCost || 0);
  updateSummaryStats();

  // Day tabs (WAI-ARIA tabs pattern with arrow-key navigation)
  const tabsEl = document.getElementById('day-tabs');
  tabsEl.innerHTML = '';
  tabsEl.setAttribute('role', 'tablist');
  tabsEl.setAttribute('aria-label', 'Trip days');
  data.days.forEach((day, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `day-tab-${i}`;
    tab.className = 'day-tab' + (i === 0 ? ' active' : '');
    tab.textContent = 'Day ' + day.day;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(i === 0));
    tab.setAttribute('tabindex', i === 0 ? '0' : '-1');
    tab.addEventListener('click', () => showDay(i, data));
    tab.addEventListener('keydown', (e) => {
      const total = data.days.length;
      let next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % total;
      else if (e.key === 'ArrowLeft') next = (i - 1 + total) % total;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = total - 1;
      if (next !== null) {
        e.preventDefault();
        showDay(next, data);
        const target = document.getElementById(`day-tab-${next}`);
        if (target) target.focus();
      }
    });
    tabsEl.appendChild(tab);
  });

  // Tips
  const tipsList = document.getElementById('tips-list');
  tipsList.innerHTML = '';
  if (data.tips) {
    data.tips.forEach(t => {
      const li = document.createElement('li');
      li.textContent = t;
      tipsList.appendChild(li);
    });
  }

  if (mapsReady) {
    initMap(data);
  } else {
    showMapUnavailable('Map unavailable. Configure a valid Google Maps API key and allowed referrers.');
  }
  showDay(0, data);
}

// Re-renders one day's activity list (paginated) and re-pins the map.
function showDay(index, data) {
  currentDayIndex = index;
  document.querySelectorAll('.day-tab').forEach((t, i) => {
    t.classList.toggle('active', i === index);
    t.setAttribute('aria-selected', String(i === index));
    t.setAttribute('tabindex', i === index ? '0' : '-1');
  });

  const day = data.days[index];
  if (!dayActivityPage[index]) dayActivityPage[index] = 1;
  const content = document.getElementById('itinerary-content');
  content.innerHTML = '';

  const section = document.createElement('div');
  section.className = 'day-section';

  // Day header with replan button
  const dayHeaderText = escapeHtml(day.theme || 'Day ' + day.day);
  const dayMetaText = escapeHtml(`${day.date || ''}${day.city ? ` · ${day.city}` : ''}`);
  const safeIndex = Number(index);
  section.innerHTML = `
    <div class="day-header-row">
      <div class="day-header">📌 ${dayHeaderText} <span style="font-size:13px;color:var(--text-secondary);font-weight:400;">${dayMetaText}</span></div>
      <div class="day-header-actions">
        <button class="btn-route-day" onclick="startRoute(${safeIndex})">▶ Start Route</button>
        <button class="btn-route-day" onclick="clearRoute()">✖ Clear Route</button>
        <button class="btn-replan-day" onclick="replanDay(${safeIndex})">🔄 Replan Day</button>
      </div>
    </div>`;

  const activities = (day.activities || [])
    .map((act, originalIndex) => ({ act, originalIndex }))
    .filter(item => !item.act.discarded);
  const totalPages = Math.max(1, Math.ceil(activities.length / ACTIVITIES_PER_PAGE));
  if (dayActivityPage[index] > totalPages) dayActivityPage[index] = totalPages;
  const page = dayActivityPage[index];
  const start = (page - 1) * ACTIVITIES_PER_PAGE;
  const end = start + ACTIVITIES_PER_PAGE;
  const pageActivities = activities.slice(start, end);

  pageActivities.forEach((item) => {
    const act = item.act;
    const ai = item.originalIndex;
    const cat = (act.category || '').toLowerCase();
    const card = document.createElement('div');
    card.className = `activity-card glass-card cat-${cat}`;
    card.id = `activity-${index}-${ai}`;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Focus ${act.title || 'activity'} on map`);

    const dIdx = Number(index);
    const aIdx = Number(ai);
    const checkedAttr = act.discarded ? '' : 'checked';
    const controlsHTML = `
        <button class="action-link replan-btn" onclick="replanActivity(${dIdx}, ${aIdx})">🔄 Swap</button>
        <button class="action-link reorder-btn" onclick="moveActivity(${dIdx}, ${aIdx}, -1)">↑ Move Up</button>
        <button class="action-link reorder-btn" onclick="moveActivity(${dIdx}, ${aIdx}, 1)">↓ Move Down</button>
        <button class="action-link discard-btn" onclick="discardActivity(${dIdx}, ${aIdx})">✖ Discard</button>
        <label class="keep-toggle"><input type="checkbox" ${checkedAttr} onchange="toggleKeep(${dIdx}, ${aIdx}, this.checked)">Keep</label>`;

    let bookingHTML;
    if (act.bookingLinks) {
      const mapsHref = safeUrl(act.bookingLinks.googleMaps);
      const searchHref = safeUrl(act.bookingLinks.googleSearch);
      const dirHref = safeUrl(act.bookingLinks.mapsDirection);
      bookingHTML = `
      <div class="activity-actions">
        ${mapsHref ? `<a href="${mapsHref}" target="_blank" rel="noopener noreferrer" class="action-link">📍 View on Maps</a>` : ''}
        ${searchHref ? `<a href="${searchHref}" target="_blank" rel="noopener noreferrer" class="action-link">🔍 Book</a>` : ''}
        ${dirHref ? `<a href="${dirHref}" target="_blank" rel="noopener noreferrer" class="action-link">🧭 Directions</a>` : ''}
        ${controlsHTML}
      </div>`;
    } else {
      bookingHTML = `<div class="activity-actions">${controlsHTML}</div>`;
    }

    const cost = Number(act.estimatedCost || 0);
    card.innerHTML = `
      <div class="activity-time">${escapeHtml(act.time || '')}</div>
      <div class="activity-title">${escapeHtml(act.title || 'Activity')}</div>
      <div class="activity-desc">${escapeHtml(act.description || '')}</div>
      <div class="activity-meta">
        <span>📍 ${escapeHtml(act.location || '')}</span>
        <span>⏱️ ${escapeHtml(act.duration || '')}</span>
        <span>💰 $${Number.isFinite(cost) ? cost : 0}</span>
      </div>
      ${bookingHTML}`;

    const focusOnMap = (e) => {
      if (e.target.closest('a') || e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;
      const pos = toLatLng(act);
      if (gMap && pos) {
        gMap.panTo(pos);
        gMap.setZoom(15);
      }
    };
    card.addEventListener('click', focusOnMap);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        focusOnMap(e);
      }
    });
    section.appendChild(card);
  });

  if (pageActivities.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'replan-loading';
    empty.textContent = 'No activities left for this day. Replan day or enable kept items.';
    section.appendChild(empty);
  }

  if (totalPages > 1) {
    const pagination = document.createElement('div');
    pagination.className = 'activity-pagination';
    const prevDisabled = page <= 1 ? 'disabled' : '';
    const nextDisabled = page >= totalPages ? 'disabled' : '';
    pagination.innerHTML = `
      <button class="btn-secondary pagination-btn" ${prevDisabled} onclick="changeActivityPage(${index}, -1)">← Prev</button>
      <span class="pagination-label">Page ${page} / ${totalPages}</span>
      <button class="btn-secondary pagination-btn" ${nextDisabled} onclick="changeActivityPage(${index}, 1)">Next →</button>
    `;
    section.appendChild(pagination);
  }

  content.appendChild(section);
  if (mapsReady && gMap) {
    try {
      highlightDayOnMap(day);
    } catch (e) {
      console.error('Failed to render map markers:', e);
      mapsReady = false;
      showMapUnavailable('Map rendering failed. Please refresh after checking Maps API restrictions.');
    }
  }
}

function changeActivityPage(dayIndex, delta) {
  dayActivityPage[dayIndex] = Math.max(1, (dayActivityPage[dayIndex] || 1) + delta);
  showDay(dayIndex, itineraryData);
}

function updateSummaryStats() {
  if (!itineraryData?.days) return;
  let totalPlaces = 0;
  let totalCost = 0;
  itineraryData.days.forEach(day => {
    (day.activities || []).forEach(act => {
      if (act.discarded) return;
      totalPlaces += 1;
      totalCost += Number(act.estimatedCost || 0);
    });
  });
  document.getElementById('stat-days').textContent = itineraryData.days.length;
  document.getElementById('stat-places').textContent = totalPlaces;
  document.getElementById('stat-cost').textContent = '$' + totalCost;
}

// === Activity-list mutators (local state; no server call) ===

function toggleKeep(dayIndex, activityIndex, isChecked) {
  const day = itineraryData?.days?.[dayIndex];
  if (!day?.activities?.[activityIndex]) return;
  day.activities[activityIndex].discarded = !isChecked;
  updateSummaryStats();
  showDay(dayIndex, itineraryData);
}

function discardActivity(dayIndex, activityIndex) {
  const day = itineraryData?.days?.[dayIndex];
  if (!day?.activities?.[activityIndex]) return;
  day.activities[activityIndex].discarded = true;
  updateSummaryStats();
  showToast('Activity discarded.', 'success');
  showDay(dayIndex, itineraryData);
}

function moveActivity(dayIndex, activityIndex, delta) {
  const day = itineraryData?.days?.[dayIndex];
  if (!day?.activities) return;
  const target = activityIndex + delta;
  if (target < 0 || target >= day.activities.length) return;
  const temp = day.activities[activityIndex];
  day.activities[activityIndex] = day.activities[target];
  day.activities[target] = temp;
  showToast('Activity order updated.', 'success');
  showDay(dayIndex, itineraryData);
}

// === Replan handlers (call /api/replan-* and re-render) ===

async function replanActivity(dayIndex, activityIndex) {
  if (replanInFlight) {
    showToast('Replan already in progress. Please wait.');
    return;
  }
  const card = document.getElementById(`activity-${dayIndex}-${activityIndex}`);
  if (card) card.style.opacity = '0.5';

  const reason = await askReason('Why do you want to change this? (optional)');
  if (reason === null) {
    if (card) card.style.opacity = '1';
    return;
  }

  setReplanBusy(true);

  try {
    const res = await fetch('/api/replan-activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itinerary: itineraryData, dayIndex, activityIndex, reason })
    });
    let data = null;
    try {
      data = await res.json();
    } catch (parseErr) {
      throw new Error(`Invalid replan response (${res.status}).`);
    }

    if (!res.ok || !data?.success) {
      throw new Error(data?.error || `Failed to swap activity (${res.status}).`);
    }
    if (!data?.itinerary?.days) {
      throw new Error('Replan succeeded but itinerary payload is invalid.');
    }

    itineraryData = data.itinerary;
    showDay(dayIndex, itineraryData);
    updateSummaryStats();
    const newCard = document.getElementById(`activity-${dayIndex}-${activityIndex}`);
    if (newCard) {
      newCard.classList.add('just-replaced');
      setTimeout(() => newCard.classList.remove('just-replaced'), 2000);
    }
    showToast('Activity swapped successfully.', 'success');
  } catch (err) {
    console.error('Replan activity failed:', err);
    showError(err?.message || 'Network error during replan.');
  } finally {
    if (card) card.style.opacity = '1';
    setReplanBusy(false);
  }
}

// Replan day
async function replanDay(dayIndex) {
  if (replanInFlight) {
    showToast('Replan already in progress. Please wait.');
    return;
  }
  const reason = await askReason('What would you prefer for this day? (optional)');
  if (reason === null) return;

  setReplanBusy(true);
  const content = document.getElementById('itinerary-content');
  content.innerHTML = '<div class="replan-loading"><span class="spinner"></span> Replanning day...</div>';

  try {
    const res = await fetch('/api/replan-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itinerary: itineraryData, dayIndex, reason })
    });
    let data = null;
    try {
      data = await res.json();
    } catch (parseErr) {
      throw new Error(`Invalid replan-day response (${res.status}).`);
    }

    if (!res.ok || !data?.success) {
      throw new Error(data?.error || `Failed to replan day (${res.status}).`);
    }
    if (!data?.itinerary?.days) {
      throw new Error('Replan-day succeeded but itinerary payload is invalid.');
    }
    itineraryData = data.itinerary;
    showDay(dayIndex, itineraryData);
    updateSummaryStats();
    showToast('Day replanned successfully.', 'success');
  } catch (err) {
    console.error('Replan day failed:', err);
    showDay(dayIndex, itineraryData);
    showError(err?.message || 'Network error during replan.');
  } finally {
    setReplanBusy(false);
  }
}

// === Map init + per-day marker render + multi-stop route drawing ===

function initMap(data) {
  const allCoords = [];
  data.days.forEach(d => (d.activities || []).forEach(a => {
    const pos = toLatLng(a);
    if (pos) allCoords.push(pos);
  }));

  const center = allCoords.length > 0
    ? { lat: allCoords.reduce((s,c) => s+c.lat, 0)/allCoords.length, lng: allCoords.reduce((s,c) => s+c.lng, 0)/allCoords.length }
    : { lat: 0, lng: 0 };

  try {
    gMap = new google.maps.Map(document.getElementById('map'), {
      center, zoom: 12,
      styles: [
        { elementType: 'geometry', stylers: [{ color: '#1d1d3b' }] },
        { elementType: 'labels.text.stroke', stylers: [{ color: '#1d1d3b' }] },
        { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b9' }] },
        { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c2c54' }] },
        { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e0e2c' }] },
        { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#242452' }] },
        { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#6c5ce7' }] },
        { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2c2c54' }] }
      ],
      disableDefaultUI: true, zoomControl: true
    });
    directionsService = new google.maps.DirectionsService();
    directionsRenderer = new google.maps.DirectionsRenderer({
      suppressMarkers: true,
      preserveViewport: false,
      polylineOptions: { strokeColor: '#00cec9', strokeOpacity: 0.9, strokeWeight: 5 }
    });
    directionsRenderer.setMap(gMap);
    highlightDayOnMap(data.days[0]);
  } catch (e) {
    mapsReady = false;
    showMapUnavailable('Unable to initialize map. Check API key, Maps JS API enablement, and billing.');
  }
}

function highlightDayOnMap(day) {
  if (!gMap || typeof gMap.fitBounds !== 'function') {
    return;
  }
  if (!day || !Array.isArray(day.activities)) {
    return;
  }
  markers.forEach(m => m.setMap(null));
  markers = [];
  const bounds = new google.maps.LatLngBounds();
  const colors = { sightseeing:'#6c5ce7', food:'#f39c12', adventure:'#e74c3c', culture:'#9b59b6', shopping:'#fd79a8', transport:'#636e72', relaxation:'#00cec9' };

  day.activities.forEach((act, i) => {
    if (act.discarded) return;
    const pos = toLatLng(act);
    if (!pos) return;
    bounds.extend(pos);
    const marker = new google.maps.Marker({
      position: pos, map: gMap,
      title: act.title,
      label: { text: String(i + 1), color: '#fff', fontWeight: '700', fontSize: '12px' },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 14, fillColor: colors[act.category] || '#6c5ce7', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
    });
    const infoCost = Number(act.estimatedCost || 0);
    const infoWindow = new google.maps.InfoWindow({
      content: `<div style="color:#333;padding:4px;max-width:200px;"><strong>${escapeHtml(act.title || '')}</strong><br><small>${escapeHtml(act.time || '')} · ${escapeHtml(act.duration || '')} · $${Number.isFinite(infoCost) ? infoCost : 0}</small></div>`
    });
    marker.addListener('click', () => infoWindow.open(gMap, marker));
    markers.push(marker);
  });

  if (markers.length > 1) gMap.fitBounds(bounds, 50);
  else if (markers.length === 1) { gMap.setCenter(markers[0].getPosition()); gMap.setZoom(14); }
}

function clearRoute() {
  if (directionsRenderer) directionsRenderer.set('directions', null);
}

function getTravelModeForMaps() {
  if (!window.google?.maps?.TravelMode) return null;
  const mode = String(userPreferences.transportMode || 'driving').toLowerCase();
  if (mode === 'walking') return google.maps.TravelMode.WALKING;
  if (mode === 'bicycling') return google.maps.TravelMode.BICYCLING;
  if (mode === 'transit') return google.maps.TravelMode.TRANSIT;
  return google.maps.TravelMode.DRIVING;
}

function routeStatusMessage(status) {
  if (status === 'MAX_WAYPOINTS_EXCEEDED') return 'Too many stops for a single route. Showing a shorter route.';
  if (status === 'ZERO_RESULTS') return 'No route found for this travel mode between selected places.';
  if (status === 'NOT_FOUND') return 'One or more route locations could not be identified.';
  if (status === 'OVER_QUERY_LIMIT') return 'Maps quota reached. Try again in a few seconds.';
  if (status === 'REQUEST_DENIED') return 'Maps request denied. Check API restrictions and enabled APIs.';
  if (status === 'INVALID_REQUEST') return 'Invalid route request for selected travel mode.';
  if (status === 'UNKNOWN_ERROR') return 'Temporary Maps error. Please retry.';
  return `Route failed: ${status || 'UNKNOWN'}`;
}

function normalizeRoutePoints(points, maxTotalPoints = 25) {
  const unique = [];
  const seen = new Set();
  points.forEach((p) => {
    if (!p) return;
    const key = `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(p);
  });
  if (unique.length > maxTotalPoints) return unique.slice(0, maxTotalPoints);
  return unique;
}

function requestDirectionsRoute(request) {
  return new Promise((resolve, reject) => {
    directionsService.route(request, (result, status) => {
      if (status === 'OK' && result) {
        resolve(result);
        return;
      }
      const err = new Error(routeStatusMessage(status));
      err.status = status || 'UNKNOWN_ERROR';
      reject(err);
    });
  });
}

function buildRouteRequest(points, travelMode, includeWaypoints) {
  const request = {
    origin: points[0],
    destination: points[points.length - 1],
    travelMode
  };
  if (includeWaypoints) {
    request.waypoints = points.slice(1, -1).map((p) => ({ location: p, stopover: true }));
    request.optimizeWaypoints = false;
  }
  return request;
}

// Tries preferred travel mode; falls back to driving when transit lacks waypoints.
async function startRoute(dayIndex) {
  if (!mapsReady || !gMap || !directionsService || !directionsRenderer) {
    showToast('Map is not ready yet.');
    return;
  }
  if (routeInFlight) {
    showToast('Route is already being generated. Please wait.');
    return;
  }
  const day = itineraryData?.days?.[dayIndex];
  if (!day) return;

  const rawPoints = (day.activities || [])
    .filter(act => !act.discarded)
    .map(toLatLng)
    .filter(Boolean);
  const points = normalizeRoutePoints(rawPoints, 25);

  if (rawPoints.length > points.length) {
    showToast('Removed duplicate/extra stops to build a valid route.', 'success');
  }

  if (points.length < 2) {
    showToast('Need at least 2 valid locations to draw route.');
    return;
  }

  const preferredMode = getTravelModeForMaps() || google.maps.TravelMode.DRIVING;
  const hasWaypoints = points.length > 2;
  const candidates = [];

  // Transit does not support multi-waypoint itinerary requests in DirectionsService.
  if (preferredMode === google.maps.TravelMode.TRANSIT) {
    candidates.push({
      label: 'transit direct',
      request: buildRouteRequest(points, google.maps.TravelMode.TRANSIT, false)
    });
    candidates.push({
      label: 'driving full itinerary',
      request: buildRouteRequest(points, google.maps.TravelMode.DRIVING, hasWaypoints)
    });
  } else {
    candidates.push({
      label: `${String(preferredMode).toLowerCase()} full itinerary`,
      request: buildRouteRequest(points, preferredMode, hasWaypoints)
    });
    if (preferredMode !== google.maps.TravelMode.DRIVING) {
      candidates.push({
        label: 'driving full itinerary',
        request: buildRouteRequest(points, google.maps.TravelMode.DRIVING, hasWaypoints)
      });
    }
  }

  routeInFlight = true;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const result = await requestDirectionsRoute(candidate.request);
      directionsRenderer.setDirections(result);
      if (i > 0) {
        showToast(`Using fallback route: ${candidate.label}.`, 'success');
      } else {
        showToast('Route generated.', 'success');
      }
      routeInFlight = false;
      return;
    } catch (err) {
      console.warn('Route candidate failed:', candidate.label, err?.status || err?.message);
      if (i === candidates.length - 1) {
        showToast(err?.message || 'Failed to draw route.');
      }
    }
  }
  routeInFlight = false;
}

// === Header buttons (back, email) ===

document.getElementById('back-btn').addEventListener('click', () => {
  resetForm();
  itineraryData = null;
});

document.getElementById('email-btn').addEventListener('click', async () => {
  if (!itineraryData) {
    showError('Generate an itinerary first.');
    return;
  }
  const toEmail = await askReason('Send itinerary to which email?', {
    placeholder: 'you@example.com',
    inputType: 'email',
    autocomplete: 'email',
    validate: (v) => {
      if (!v) return 'Email address is required.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Please enter a valid email address.';
      return null;
    }
  });
  if (toEmail === null || !toEmail) return;

  try {
    const res = await fetch('/api/email-itinerary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toEmail, itinerary: itineraryData })
    });
    let data = null;
    try { data = await res.json(); } catch { /* swallow; fall through to status check */ }
    if (!res.ok || !data?.success) {
      showError(data?.error || `Failed to send email (${res.status}).`);
      return;
    }
    showToast(data.message || 'Itinerary emailed successfully.', 'success');
  } catch (err) {
    showError('Network error while sending email.');
  }
});
