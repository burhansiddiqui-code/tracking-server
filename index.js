const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');
 
const app  = express();
const PORT = process.env.PORT || 8080;
 
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
 
// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: "Burhan's Tracking Server is running." });
});
 
// ── Ship24 endpoint ───────────────────────────────────────
app.post('/track', async (req, res) => {
  const { trackingNumbers, ship24ApiKey } = req.body;
  if (!trackingNumbers?.length) return res.status(400).json({ error: 'No tracking numbers.' });
 
  const results = [];
  for (const num of trackingNumbers) {
    try {
      let result = null;
      if (ship24ApiKey) result = await trackShip24(num, ship24ApiKey);
      results.push(result || emptyResult(num, 'No data'));
    } catch(e) { results.push(emptyResult(num, e.message)); }
    await sleep(600);
  }
  res.json({ results });
});
 
// ── 17Track endpoint ──────────────────────────────────────
app.post('/track17/register', async (req, res) => {
  const { numbers, apiKey } = req.body;
  if (!numbers?.length) return res.status(400).json({ error: 'No numbers.' });
 
  try {
    // numbers can be array of strings OR array of objects with {number, carrier}
    const body = numbers.map(n => {
      if (typeof n === 'string') return { number: n };
      return n; // already an object with number + optional carrier
    });
    const response = await axios.post(
      'https://api.17track.net/track/v2.2/register',
      body,
      { headers: { 'Content-Type': 'application/json', '17token': apiKey } }
    );
    res.json(response.data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
 
app.post('/track17/getinfo', async (req, res) => {
  const { numbers, apiKey } = req.body;
  if (!numbers?.length) return res.status(400).json({ error: 'No numbers.' });
 
  try {
    const body = numbers.map(n => ({ number: n }));
    const response = await axios.post(
      'https://api.17track.net/track/v2.2/gettrackinfo',
      body,
      { headers: { 'Content-Type': 'application/json', '17token': apiKey } }
    );
    res.json(response.data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
 
// ── Royal Mail Scraper ────────────────────────────────────
async function trackRoyalMail(trackingNumber) {
  try {
    const res = await axios.get(
      `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }, timeout: 15000 }
    );
    const $ = cheerio.load(res.data);
    const body = $('body').text();
    const isDelivered = body.toLowerCase().includes('delivered');
    const dateMatch = body.match(/(\d{2}[-\/]\d{2}[-\/]\d{4})/);
    return {
      trackingNumber, courier: 'ROYAL MAIL',
      statusCode: isDelivered ? 'delivered' : 'in_transit',
      status: isDelivered ? 'Delivered' : 'In Transit',
      deliveryStatus: isDelivered ? 'Delivered' : 'In Transit',
      isDelivered, delivDate: isDelivered ? (dateMatch?.[1] || null) : null,
      estimatedDelivery: null, actualDelivery: isDelivered ? (dateMatch?.[1] || null) : null,
      signedBy: null, origin: '—', destination: '—',
      lastEvent: isDelivered ? 'Delivered' : 'In Transit',
      lastLocation: '—', lastTime: null, totalEvents: 1, source: 'Royal Mail', error: null,
    };
  } catch(e) { return null; }
}
 
// ── Team Global Scraper ───────────────────────────────────
async function trackTeamGlobal(trackingNumber) {
  try {
    const res = await axios.get(
      `https://teamglobalexp.com/myparcel?shipmentID=${trackingNumber}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36' }, timeout: 15000 }
    );
    const $ = cheerio.load(res.data);
    const body = $('body').text();
    const isDelivered = body.toLowerCase().includes('delivered');
    const dateMatch = body.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}\s*(?:AM|PM))/i);
    const location = $('[class*="location"]').first().text().trim() || '—';
    return {
      trackingNumber, courier: 'TEAM GLOBAL EXPRESS',
      statusCode: isDelivered ? 'delivered' : 'in_transit',
      status: isDelivered ? 'Delivered' : 'In Transit',
      deliveryStatus: isDelivered ? 'Delivered' : 'In Transit',
      isDelivered, delivDate: isDelivered ? (dateMatch?.[1] || null) : null,
      estimatedDelivery: null, actualDelivery: isDelivered ? (dateMatch?.[1] || null) : null,
      signedBy: null, origin: '—', destination: location,
      lastEvent: isDelivered ? 'Delivered' : 'In Transit',
      lastLocation: location, lastTime: null, totalEvents: 1, source: 'Team Global Express', error: null,
    };
  } catch(e) { return null; }
}
 
// ── Ship24 ────────────────────────────────────────────────
async function trackShip24(trackingNumber, apiKey) {
  try {
    const res = await axios.post(
      'https://api.ship24.com/public/v1/trackers/track',
      { trackingNumber, forceRefresh: true },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 }
    );
    const trackings = res.data?.data?.trackings;
    if (trackings?.length > 0 && (trackings[0].events||[]).length > 0) return normaliseShip24(trackings[0]);
    const tid = res.data?.data?.tracker?.id || trackings?.[0]?.tracker?.id;
    if (tid) {
      await sleep(3000);
      const r2 = await axios.get(
        `https://api.ship24.com/public/v1/trackers/${tid}/results`,
        { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 }
      );
      const t2 = r2.data?.data?.trackings;
      if (t2?.length > 0) return normaliseShip24(t2[0]);
    }
  } catch(e) {
    if (e.response?.status === 401) throw new Error('Invalid Ship24 API key');
  }
  return null;
}
 
function normaliseShip24(t) {
  const tracker = t.tracker || {};
  const shipment = t.shipment || {};
  const delivery = shipment.delivery || {};
  const events = (t.events || []).map((e, i) => ({
    index: i+1, timestamp: e.datetime || e.occurrenceDatetime || null,
    status: toHuman(e.status || e.statusCode || ''),
    statusCode: (e.statusCode || e.status || '').toLowerCase(),
    location: buildLoc(e.location), description: e.statusMilestone || e.description || e.status || '',
    courier: (e.courierCode || tracker.courierCode || '').toUpperCase(),
  })).sort((a,b) => (b.timestamp ? new Date(b.timestamp) : 0) - (a.timestamp ? new Date(a.timestamp) : 0));
  const latest = events[0] || {};
  const sc = (shipment.statusCode || '').toLowerCase();
  const ds = (delivery.status || '').toLowerCase();
  const lsc = (latest.statusCode || '').toLowerCase();
  const isDelivered = delivery.isDelivered === true || sc.includes('delivered') || ds.includes('delivered') || lsc.includes('delivered');
  let delivDate = null;
  if (isDelivered) {
    delivDate = delivery.actualDeliveryDate || delivery.deliveryDate;
    if (!delivDate) { const ev = events.find(e => e.statusCode?.includes('delivered')); delivDate = ev?.timestamp || latest.timestamp; }
  }
  return {
    trackingNumber: tracker.trackingNumber || shipment.trackingNumber || '?',
    courier: (latest.courier || tracker.courierCode || 'Unknown').toUpperCase(),
    statusCode: sc || lsc || '', status: toHuman(sc || ds || lsc || ''),
    deliveryStatus: toHuman(ds || sc || lsc || ''), isDelivered, delivDate,
    estimatedDelivery: delivery.estimatedDeliveryDate || null, actualDelivery: delivery.actualDeliveryDate || null,
    signedBy: delivery.signedBy || null, origin: buildLoc(shipment.origin) || '—', destination: buildLoc(shipment.destination) || '—',
    lastEvent: latest.description || latest.status || '—', lastLocation: latest.location || '—',
    lastTime: latest.timestamp || null, totalEvents: events.length, source: 'Ship24', error: null,
  };
}
 
function buildLoc(l) { if (!l) return ''; return [l.city,l.state,l.countryCode,l.country].filter(Boolean).join(', ') || l.name || ''; }
function toHuman(s) { if (!s) return '—'; return s.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()); }
function emptyResult(num, err) {
  return { trackingNumber:num, courier:'—', statusCode:'unknown', status:err?'Error':'No Data',
    deliveryStatus:'—', isDelivered:false, delivDate:null, estimatedDelivery:null, actualDelivery:null,
    signedBy:null, origin:'—', destination:'—', lastEvent:err||'No data', lastLocation:'—',
    lastTime:null, totalEvents:0, source:'—', error:err||null };
}
function sleep(ms) { return new Promise(r => setTimeout(r,ms)); }
 
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
