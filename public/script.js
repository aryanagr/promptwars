let map, markers = [], itineraryData = null, currentDayIndex = 0, mapsReady = false;

// Set default dates
document.addEventListener('DOMContentLoaded', () => {
  const today = new Date();
  const nextWeek = new Date(today);
  nextWeek.setDate(today.getDate() + 3);
  document.getElementById('start-date').value = formatDate(today);
  document.getElementById('end-date').value = formatDate(nextWeek);
});

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

// Form submission
document.getElementById('trip-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('generate-btn');
  btn.querySelector('.btn-text').style.display = 'none';
  btn.querySelector('.btn-loader').style.display = 'inline-flex';
  btn.disabled = true;

  document.getElementById('hero').style.display = 'none';
  document.getElementById('loading-section').style.display = 'flex';
  animateLoadingSteps();

  const interests = [...document.querySelectorAll('.interest-chip input:checked')]
    .map(cb => cb.value).join(', ') || 'General sightseeing';

  const payload = {
    destination: document.getElementById('destination').value,
    startDate: document.getElementById('start-date').value,
    endDate: document.getElementById('end-date').value,
    budget: document.getElementById('budget').value,
    travelers: document.getElementById('travelers').value,
    interests
  };

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
      if (!mapsReady) {
        showError('Itinerary generated, but Google Maps failed to load. Check Maps API key/referrer settings.');
      }
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      showError('Request timed out. The AI took too long — please try again.');
    } else if (err?.message) {
      showError(err.message);
    } else {
      showError('Network error. Check your connection and try again.');
    }
  }
});

function showError(msg) {
  document.getElementById('loading-section').style.display = 'none';
  document.getElementById('hero').style.display = 'flex';
  const btn = document.getElementById('generate-btn');
  btn.querySelector('.btn-text').style.display = 'inline';
  btn.querySelector('.btn-loader').style.display = 'none';
  btn.disabled = false;

  // Show toast
  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.innerHTML = `⚠️ ${msg}`;
  document.body.appendChild(toast);
  setTimeout(() => { toast.classList.add('show'); }, 10);
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 400); }, 5000);

  resetLoadingSteps();
}

function resetForm() {
  document.getElementById('hero').style.display = 'flex';
  document.getElementById('loading-section').style.display = 'none';
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

// Load Google Maps
async function loadMapsAPI() {
  if (window.google && window.google.maps) return;
  const res = await fetch('/api/maps-key');
  const { key } = await res.json();
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY');
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=marker`;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(script);
  });
}

// Render results
function renderResults(data) {
  if (window._loadingInterval) clearInterval(window._loadingInterval);
  document.getElementById('loading-section').style.display = 'none';
  document.getElementById('results-section').style.display = 'block';

  document.getElementById('trip-title').textContent = data.tripTitle || 'Your Trip';
  document.getElementById('trip-summary').textContent = data.summary || '';

  let totalPlaces = 0;
  data.days.forEach(d => totalPlaces += (d.activities || []).length);
  document.getElementById('stat-days').textContent = data.days.length;
  document.getElementById('stat-places').textContent = totalPlaces;
  document.getElementById('stat-cost').textContent = '$' + (data.totalEstimatedCost || 0);

  // Day tabs
  const tabsEl = document.getElementById('day-tabs');
  tabsEl.innerHTML = '';
  data.days.forEach((day, i) => {
    const tab = document.createElement('button');
    tab.className = 'day-tab' + (i === 0 ? ' active' : '');
    tab.textContent = 'Day ' + day.day;
    tab.onclick = () => showDay(i, data);
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

  showDay(0, data);
  if (mapsReady) {
    initMap(data);
  } else {
    const mapEl = document.getElementById('map');
    if (mapEl) {
      mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#a0a0c0;padding:16px;text-align:center;">Map unavailable. Configure a valid Google Maps API key and allowed referrers.</div>';
    }
  }
}

function showDay(index, data) {
  currentDayIndex = index;
  document.querySelectorAll('.day-tab').forEach((t, i) => {
    t.classList.toggle('active', i === index);
  });

  const day = data.days[index];
  const content = document.getElementById('itinerary-content');
  content.innerHTML = '';

  const section = document.createElement('div');
  section.className = 'day-section';

  // Day header with replan button
  section.innerHTML = `
    <div class="day-header-row">
      <div class="day-header">📌 ${day.theme || 'Day ' + day.day} <span style="font-size:13px;color:var(--text-secondary);font-weight:400;">${day.date || ''}</span></div>
      <button class="btn-replan-day" onclick="replanDay(${index})">🔄 Replan Day</button>
    </div>`;

  (day.activities || []).forEach((act, ai) => {
    const cat = (act.category || '').toLowerCase();
    const card = document.createElement('div');
    card.className = `activity-card glass-card cat-${cat}`;
    card.id = `activity-${index}-${ai}`;

    const bookingHTML = act.bookingLinks ? `
      <div class="activity-actions">
        <a href="${act.bookingLinks.googleMaps}" target="_blank" class="action-link">📍 View on Maps</a>
        <a href="${act.bookingLinks.googleSearch}" target="_blank" class="action-link">🔍 Book</a>
        ${act.bookingLinks.mapsDirection ? `<a href="${act.bookingLinks.mapsDirection}" target="_blank" class="action-link">🧭 Directions</a>` : ''}
        <button class="action-link replan-btn" onclick="replanActivity(${index}, ${ai})">🔄 Swap</button>
      </div>` : `<div class="activity-actions"><button class="action-link replan-btn" onclick="replanActivity(${index}, ${ai})">🔄 Swap</button></div>`;

    card.innerHTML = `
      <div class="activity-time">${act.time || ''}</div>
      <div class="activity-title">${act.title || 'Activity'}</div>
      <div class="activity-desc">${act.description || ''}</div>
      <div class="activity-meta">
        <span>📍 ${act.location || ''}</span>
        <span>⏱️ ${act.duration || ''}</span>
        <span>💰 $${act.estimatedCost || 0}</span>
      </div>
      ${bookingHTML}`;

    card.addEventListener('click', (e) => {
      if (e.target.closest('a') || e.target.closest('button')) return;
      if (map && act.lat && act.lng) {
        map.panTo({ lat: act.lat, lng: act.lng });
        map.setZoom(15);
      }
    });
    section.appendChild(card);
  });

  content.appendChild(section);
  if (mapsReady) highlightDayOnMap(day);
}

// Replan activity
async function replanActivity(dayIndex, activityIndex) {
  const card = document.getElementById(`activity-${dayIndex}-${activityIndex}`);
  if (card) card.style.opacity = '0.5';

  const reason = prompt('Why do you want to change this? (optional)') || '';

  try {
    const res = await fetch('/api/replan-activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itinerary: itineraryData, dayIndex, activityIndex, reason })
    });
    const data = await res.json();
    if (data.success) {
      itineraryData = data.itinerary;
      showDay(dayIndex, itineraryData);
      // Flash effect on new card
      const newCard = document.getElementById(`activity-${dayIndex}-${activityIndex}`);
      if (newCard) { newCard.classList.add('just-replaced'); setTimeout(() => newCard.classList.remove('just-replaced'), 2000); }
    } else {
      if (card) card.style.opacity = '1';
      showError(data.error || 'Failed to swap activity.');
    }
  } catch (err) {
    if (card) card.style.opacity = '1';
    showError('Network error during replan.');
  }
}

// Replan day
async function replanDay(dayIndex) {
  const reason = prompt('What would you prefer for this day? (optional)') || '';
  const content = document.getElementById('itinerary-content');
  content.innerHTML = '<div class="replan-loading"><span class="spinner"></span> Replanning day...</div>';

  try {
    const res = await fetch('/api/replan-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itinerary: itineraryData, dayIndex, reason })
    });
    const data = await res.json();
    if (data.success) {
      itineraryData = data.itinerary;
      showDay(dayIndex, itineraryData);
    } else {
      showDay(dayIndex, itineraryData);
      showError(data.error || 'Failed to replan day.');
    }
  } catch (err) {
    showDay(dayIndex, itineraryData);
    showError('Network error during replan.');
  }
}

function initMap(data) {
  const allCoords = [];
  data.days.forEach(d => (d.activities || []).forEach(a => {
    if (a.lat && a.lng) allCoords.push({ lat: a.lat, lng: a.lng });
  }));

  const center = allCoords.length > 0
    ? { lat: allCoords.reduce((s,c) => s+c.lat, 0)/allCoords.length, lng: allCoords.reduce((s,c) => s+c.lng, 0)/allCoords.length }
    : { lat: 0, lng: 0 };

  map = new google.maps.Map(document.getElementById('map'), {
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
  highlightDayOnMap(data.days[0]);
}

function highlightDayOnMap(day) {
  markers.forEach(m => m.setMap(null));
  markers = [];
  if (!day.activities) return;
  const bounds = new google.maps.LatLngBounds();
  const colors = { sightseeing:'#6c5ce7', food:'#f39c12', adventure:'#e74c3c', culture:'#9b59b6', shopping:'#fd79a8', transport:'#636e72', relaxation:'#00cec9' };

  day.activities.forEach((act, i) => {
    if (!act.lat || !act.lng) return;
    const pos = { lat: act.lat, lng: act.lng };
    bounds.extend(pos);
    const marker = new google.maps.Marker({
      position: pos, map,
      title: act.title,
      label: { text: String(i + 1), color: '#fff', fontWeight: '700', fontSize: '12px' },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 14, fillColor: colors[act.category] || '#6c5ce7', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
    });
    const infoWindow = new google.maps.InfoWindow({
      content: `<div style="color:#333;padding:4px;max-width:200px;"><strong>${act.title}</strong><br><small>${act.time} · ${act.duration} · $${act.estimatedCost}</small></div>`
    });
    marker.addListener('click', () => infoWindow.open(map, marker));
    markers.push(marker);
  });

  if (markers.length > 1) map.fitBounds(bounds, 50);
  else if (markers.length === 1) { map.setCenter(markers[0].getPosition()); map.setZoom(14); }
}

// Back button
document.getElementById('back-btn').addEventListener('click', () => {
  resetForm();
  itineraryData = null;
});

document.getElementById('email-btn').addEventListener('click', async () => {
  if (!itineraryData) {
    showError('Generate an itinerary first.');
    return;
  }
  const toEmail = (prompt('Enter recipient email address') || '').trim();
  if (!toEmail) return;

  try {
    const res = await fetch('/api/email-itinerary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toEmail, itinerary: itineraryData })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showError(data.error || `Failed to send email (${res.status}).`);
      return;
    }
    alert(data.message || 'Itinerary emailed successfully.');
  } catch (err) {
    showError('Network error while sending email.');
  }
});
