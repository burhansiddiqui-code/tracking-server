const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');
 
const app  = express();
const PORT = process.env.PORT || 3000;
 
// Allow all origins
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
 
// ── Health check ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: "Burhan's Tracking Server is running." });
});
 
// ── Main tracking endpoint ────────────────────────────────
app.post('/track', async (req, res) => {
  const { trackingNumbers, ship24ApiKey } = req.body;
 
  if (!trackingNumbers || !trackingNumbers.length) {
    return res.status(400).json({ error: 'No tracking numbers provided.' });
  }
 
  const results = [];
 
  for (const num of trackingNumbers) {
    try {
      const courier = detectCourier(num);
      let result = null;
 
      if (courier === 'royalmail') {
        result = await trackRoyalMail(num);
        if (!result && ship24ApiKey) result = await trackShip24(num, ship24ApiKey, 'royal-mail');
      } else if (courier === 'teamglobal') {
        if (ship24ApiKey) result = await trackShip24(num, ship24ApiKey, null);
        if (!result || result.totalEvents === 0) result = await trackTeamGlobal(num);
      } else if (courier === 'auspost') {
        if (ship24ApiKey) result = await trackShip24(num, ship24ApiKey, 'australia-post');
        if (!result || result.totalEvents === 0) {
          if (ship24ApiKey) result = await trackShip24(num, ship24ApiKey, null);
        }
      } else {
        if (ship24ApiKey) result = await trackShip24(num, ship24ApiKey, null);
      }
 
      results.push(result || emptyResult(num, 'No data found'));
    } catch (e) {
      results.push(emptyResult(num, e.message));
    }
 
    await sleep(600);
  }
 
  res.json({ results });
});
 
// ── Courier Detection ─────────────────────────────────────
function detectCourier(num) {
  const n = num.toUpperCase().trim();
  if (/^014\d{9,12}$/.test(n)) return 'auspost';
  if (/^[A-Z]{2}\d{8}[A-Z]{2}$/.test(n)) return 'royalmail';
  if (/^\d{12}$/.test(n) && !n.startsWith('014')) return 'teamglobal';
  return 'ship24';
}
 
// ── Ship24 API ────────────────────────────────────────────
async function trackShip24(trackingNumber, apiKey, courierCode) {
  try {
    const payload = { trackingNumber, forceRefresh: true };
    if (courierCode) payload.courierCode = courierCode;
 
    const res = await axios.post(
      'https://api.ship24.com/public/v1/trackers/track',
      payload,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 }
    );
 
    const trackings = res.data?.data?.trackings;
    if (trackings?.length > 0 && (trackings[0].events||[]).length > 0) {
      return normalise(trackings[0], 'Ship24');
    }
 
    const tid = res.data?.data?.tracker?.id || trackings?.[0]?.tracker?.id;
    if (tid) {
      await sleep(3000);
      const r2 = await axios.get(
        `https://api.ship24.com/public/v1/trackers/${tid}/results`,
        { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 }
      );
      const t2 = r2.data?.data?.trackings;
      if (t2?.length > 0) return normalise(t2[0], 'Ship24');
    }
  } catch (e) {
    if (e.response?.status === 401) throw new Error('Invalid Ship24 API key');
    console.error('Ship24 error:', e.message);
  }
  return null;
}
 
// ── Royal Mail ────────────────────────────────────────────
async function trackRoyalMail(trackingNumber) {
  try {
    const url = `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      timeout: 15000,
    });
 
    const $ = cheerio.load(res.data);
    const bodyText = $('body').text();
 
    const isDelivered = bodyText.toLowerCase().includes('delivered');
    const dateMatch = bodyText.match(/(\d{2}[-\/]\d{2}[-\/]\d{4})/);
 
    return {
      trackingNumber,
      courier: 'ROYAL MAIL',
      statusCode: isDelivered ? 'delivered' : 'in_transit',
      status: isDelivered ? 'Delivered' : 'In Transit',
      deliveryStatus: isDelivered ? 'Delivered' : 'In Transit',
      isDelivered,
      delivDate: isDelivered ? (dateMatch?.[1] || null) : null,
      estimatedDelivery: null,
      actualDelivery: isDelivered ? (dateMatch?.[1] || null) : null,
      signedBy: null,
      origin: '—', destination: '—',
      lastEvent: isDelivered ? 'Delivered' : 'In Transit',
      lastLocation: '—', lastTime: null,
      totalEvents: 1,
      source: 'Royal Mail',
      error: null,
    };
  } catch (e) {
    console.error('Royal Mail error:', e.message);
    return null;
  }
}
 
// ── Team Global Express ───────────────────────────────────
async function trackTeamGlobal(trackingNumber) {
  try {
    const url = `https://teamglobalexp.com/myparcel?shipmentID=${trackingNumber}`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 15000,
    });
 
    const $ = cheerio.load(res.data);
    const bodyText = $('body').text();
 
    const isDelivered = bodyText.toLowerCase().includes('delivered');
    const location = $('[class*="location"]').first().text().trim() || '—';
    const dateMatch = bodyText.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}\s*(?:AM|PM))/i);
 
    return {
      trackingNumber,
      courier: 'TEAM GLOBAL EXPRESS',
      statusCode: isDelivered ? 'delivered' : 'in_transit',
      status: isDelivered ? 'Delivered' : 'In Transit',
      deliveryStatus: isDelivered ? 'Delivered' : 'In Transit',
      isDelivered,
      delivDate: isDelivered ? (dateMatch?.[1] || null) : null,
      estimatedDelivery: null,
      actualDelivery: isDelivered ? (dateMatch?.[1] || null) : null,
      signedBy: null,
      origin: '—', destination: location,
      lastEvent: isDelivered ? 'Delivered' : 'In Transit',
      lastLocation: location, lastTime: null,
      totalEvents: 1,
      source: 'Team Global Express',
      error: null,
    };
  } catch (e) {
    console.error('Team Global error:', e.message);
    return null;
  }
}
 
// ── Normalise Ship24 ──────────────────────────────────────
function normalise(t, source) {
  const tracker  = t.tracker  || {};
  const shipment = t.shipment || {};
  const delivery = shipment.delivery || {};
 
  const events = (t.events || []).map((e, i) => ({
    index: i+1,
    timestamp:   e.datetime || e.occurrenceDatetime || null,
    status:      toHuman(e.status || e.statusCode || ''),
    statusCode:  (e.statusCode || e.status || '').toLowerCase(),
    location:    buildLoc(e.location),
    description: e.statusMilestone || e.description || e.status || '',
    courier:     (e.courierCode || tracker.courierCode || '').toUpperCase(),
  })).sort((a, b) =>
    (b.timestamp ? new Date(b.timestamp) : 0) - (a.timestamp ? new Date(a.timestamp) : 0)
  );
 
  const latest = events[0] || {};
  const sc  = (shipment.statusCode || '').toLowerCase();
  const ds  = (delivery.status || '').toLowerCase();
  const lsc = (latest.statusCode || '').toLowerCase();
 
  const isDelivered = delivery.isDelivered === true
    || sc.includes('delivered') || ds.includes('delivered') || lsc.includes('delivered');
 
  let delivDate = null;
  if (isDelivered) {
    delivDate = delivery.actualDeliveryDate || delivery.deliveryDate;
    if (!delivDate) {
      const ev = events.find(e => e.statusCode?.includes('delivered'));
      delivDate = ev?.timestamp || latest.timestamp;
    }
  }
 
  return {
    trackingNumber: tracker.trackingNumber || shipment.trackingNumber || '?',
    courier: (latest.courier || tracker.courierCode || 'Unknown').toUpperCase(),
    statusCode: sc || lsc || '',
    status: toHuman(sc || ds || lsc || ''),
    deliveryStatus: toHuman(ds || sc || lsc || ''),
    isDelivered,
    delivDate,
    estimatedDelivery: delivery.estimatedDeliveryDate || null,
    actualDelivery:    delivery.actualDeliveryDate    || null,
    signedBy:          delivery.signedBy || null,
    origin:      buildLoc(shipment.origin)      || '—',
    destination: buildLoc(shipment.destination) || '—',
    lastEvent:    latest.description || latest.status || '—',
    lastLocation: latest.location    || '—',
    lastTime:     latest.timestamp   || null,
    totalEvents:  events.length,
    source:       source || 'Ship24',
    error: null,
  };
}
 
function buildLoc(l) {
  if (!l) return '';
  return [l.city, l.state, l.countryCode, l.country].filter(Boolean).join(', ') || l.name || '';
}
 
function toHuman(s) {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
 
function emptyResult(trackingNumber, error) {
  return {
    trackingNumber, courier: '—', statusCode: 'unknown',
    status: error ? 'Error' : 'No Data',
    deliveryStatus: '—', isDelivered: false,
    delivDate: null, estimatedDelivery: null, actualDelivery: null,
    signedBy: null, origin: '—', destination: '—',
    lastEvent: error || 'No data returned',
    lastLocation: '—', lastTime: null, totalEvents: 0,
    source: '—', error: error || null,
  };
}
 
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
 
app.listen(PORT, () => {
  console.log(`Tracking server running on port ${PORT}`);
});
