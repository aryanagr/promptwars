// SMTP email service: pooled transporter + HTML body builder with map images.

const nodemailer = require('nodemailer');
const { escapeHtml } = require('../utils/escape');
const { buildStaticMapUrl } = require('./maps');

let memoizedTransporter = null;
let memoizedFingerprint = null;

function getTransporter(cfg) {
  const fingerprint = `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.user}`;
  if (memoizedTransporter && memoizedFingerprint === fingerprint) return memoizedTransporter;
  memoizedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    pool: true,
    maxConnections: 3,
    auth: { user: cfg.user, pass: cfg.pass }
  });
  memoizedFingerprint = fingerprint;
  return memoizedTransporter;
}

function closeTransporter() {
  if (memoizedTransporter && typeof memoizedTransporter.close === 'function') {
    memoizedTransporter.close();
  }
  memoizedTransporter = null;
  memoizedFingerprint = null;
}

function itineraryToEmailHtml(itinerary, mapsApiKey) {
  const daysHtml = (itinerary.days || []).map((day) => {
    const acts = (Array.isArray(day.activities) ? day.activities : []).map((act) => {
      const cost = Number(act.estimatedCost || 0);
      return `<li><strong>${escapeHtml(act.time || '')}</strong> - ${escapeHtml(act.title || 'Activity')} (${escapeHtml(act.location || '')}) | ${escapeHtml(act.duration || '')} | $${Number.isFinite(cost) ? cost : 0}</li>`;
    }).join('');
    const mapUrl = buildStaticMapUrl(mapsApiKey, day.activities);
    const mapImg = mapUrl ? `<p><img src="${escapeHtml(mapUrl)}" alt="Day ${escapeHtml(String(day.day || ''))} route" style="max-width:100%;border-radius:8px;border:1px solid #ddd;"></p>` : '';
    const dayNum = Number(day.day) || '';
    const dayDate = day.date ? ` - ${escapeHtml(day.date)}` : '';
    return `<h3>Day ${dayNum}${dayDate}</h3><p><strong>${escapeHtml(day.theme || '')}</strong></p>${mapImg}<ul>${acts}</ul>`;
  }).join('');

  const tips = (Array.isArray(itinerary.tips) ? itinerary.tips : [])
    .map((t) => `<li>${escapeHtml(t)}</li>`).join('');
  const totalCost = Number(itinerary.totalEstimatedCost || 0);
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;">
      <h1>${escapeHtml(itinerary.tripTitle || 'Trip Itinerary')}</h1>
      <p>${escapeHtml(itinerary.summary || '')}</p>
      <p><strong>Total Estimated Cost:</strong> $${Number.isFinite(totalCost) ? totalCost : 0} ${escapeHtml(itinerary.currency || 'USD')}</p>
      ${daysHtml}
      <h3>Travel Tips</h3>
      <ul>${tips}</ul>
    </div>
  `;
}

module.exports = { getTransporter, closeTransporter, itineraryToEmailHtml };
