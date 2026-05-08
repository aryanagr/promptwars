let map, markers = [], itineraryData = null;

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

  try {
    const res = await fetch('/api/generate-itinerary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      itineraryData = data.itinerary;
      await loadMapsAPI();
      renderResults(data.itinerary);
    } else {
      alert('Error: ' + data.error);
      resetForm();
    }
  } catch (err) {
    console.error(err);
    alert('Failed to generate itinerary. Check your API keys and try again.');
    resetForm();
  }
});

function resetForm() {
  document.getElementById('hero').style.display = 'flex';
  document.getElementById('loading-section').style.display = 'none';
  document.getElementById('results-section').style.display = 'none';
  const btn = document.getElementById('generate-btn');
  btn.querySelector('.btn-text').style.display = 'inline';
  btn.querySelector('.btn-loader').style.display = 'none';
  btn.disabled = false;
}

function animateLoadingSteps() {
  const steps = ['step-1','step-2','step-3','step-4'];
  let i = 0;
  const interval = setInterval(() => {
    if (i > 0) {
      document.getElementById(steps[i-1]).classList.remove('active');
      document.getElementById(steps[i-1]).classList.add('done');
      document.getElementById(steps[i-1]).textContent = '✅ ' + document.getElementById(steps[i-1]).textContent.slice(2);
    }
    if (i < steps.length) {
      document.getElementById(steps[i]).classList.add('active');
      i++;
    } else {
      clearInterval(interval);
    }
  }, 2500);
}

// Load Google Maps dynamically
async function loadMapsAPI() {
  if (window.google && window.google.maps) return;
  const res = await fetch('/api/maps-key');
  const { key } = await res.json();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=marker`;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// Render results
function renderResults(data) {
  document.getElementById('loading-section').style.display = 'none';
  document.getElementById('results-section').style.display = 'block';

  document.getElementById('trip-title').textContent = data.tripTitle;
  document.getElementById('trip-summary').textContent = data.summary;

  let totalPlaces = 0;
  data.days.forEach(d => totalPlaces += d.activities.length);
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
  initMap(data);
}

function showDay(index, data) {
  // Update tabs
  document.querySelectorAll('.day-tab').forEach((t, i) => {
    t.classList.toggle('active', i === index);
  });

  const day = data.days[index];
  const content = document.getElementById('itinerary-content');
  content.innerHTML = '';

  const section = document.createElement('div');
  section.className = 'day-section';
  section.innerHTML = `<div class="day-header">📌 ${day.theme || 'Day ' + day.day} <span style="font-size:13px;color:var(--text-secondary);font-weight:400;">${day.date || ''}</span></div>`;

  day.activities.forEach(act => {
    const cat = (act.category || '').toLowerCase();
    const card = document.createElement('div');
    card.className = `activity-card glass-card cat-${cat}`;
    card.innerHTML = `
      <div class="activity-time">${act.time}</div>
      <div class="activity-title">${act.title}</div>
      <div class="activity-desc">${act.description}</div>
      <div class="activity-meta">
        <span>📍 ${act.location}</span>
        <span>⏱️ ${act.duration}</span>
        <span>💰 $${act.estimatedCost}</span>
      </div>`;
    card.addEventListener('click', () => {
      if (map && act.lat && act.lng) {
        map.panTo({ lat: act.lat, lng: act.lng });
        map.setZoom(15);
      }
    });
    section.appendChild(card);
  });

  content.appendChild(section);

  // Update map markers for this day
  highlightDayOnMap(day);
}

function initMap(data) {
  const allCoords = [];
  data.days.forEach(d => d.activities.forEach(a => {
    if (a.lat && a.lng) allCoords.push({ lat: a.lat, lng: a.lng });
  }));

  const center = allCoords.length > 0
    ? { lat: allCoords.reduce((s,c) => s+c.lat, 0)/allCoords.length, lng: allCoords.reduce((s,c) => s+c.lng, 0)/allCoords.length }
    : { lat: 0, lng: 0 };

  map = new google.maps.Map(document.getElementById('map'), {
    center,
    zoom: 12,
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
    disableDefaultUI: true,
    zoomControl: true
  });

  highlightDayOnMap(data.days[0]);
}

function highlightDayOnMap(day) {
  markers.forEach(m => m.setMap(null));
  markers = [];
  const bounds = new google.maps.LatLngBounds();
  const colors = { sightseeing:'#6c5ce7', food:'#f39c12', adventure:'#e74c3c', culture:'#9b59b6', shopping:'#fd79a8', transport:'#636e72', relaxation:'#00cec9' };

  day.activities.forEach((act, i) => {
    if (!act.lat || !act.lng) return;
    const pos = { lat: act.lat, lng: act.lng };
    bounds.extend(pos);
    const marker = new google.maps.Marker({
      position: pos,
      map,
      title: act.title,
      label: { text: String(i + 1), color: '#fff', fontWeight: '700', fontSize: '12px' },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 14,
        fillColor: colors[act.category] || '#6c5ce7',
        fillOpacity: 1,
        strokeColor: '#fff',
        strokeWeight: 2
      }
    });

    const infoWindow = new google.maps.InfoWindow({
      content: `<div style="color:#333;padding:4px;"><strong>${act.title}</strong><br><small>${act.time} · ${act.duration} · $${act.estimatedCost}</small></div>`
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
  // Reset loading steps
  ['step-1','step-2','step-3','step-4'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove('active','done');
    el.textContent = el.textContent.replace('✅ ','');
  });
  document.getElementById('step-1').classList.add('active');
});
