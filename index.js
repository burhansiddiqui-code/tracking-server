const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Health check ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: "Burhan's Tracking Server is running." });
});

// ── Main tracking endpoint ────────────────────────────────
// POST /track
// Body: { trackingNumbers: ["123", "456"], ship24ApiKey: "apik_..." }
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
      } else if (courier === 'teamglobal') {
        // Try Ship24 first
        if (ship24ApiKey) {
          result = await trackShip24(num, ship24ApiKey);
        }
        // If no events from Ship24, scrape Team Global
        if (!result || result.totalEvents === 0) {
          result = await trackTeamGlobal(num);
        }
      } else {
        // All other couriers — Ship24
        if (ship24ApiKey) {
          result = await trackShip24(num, ship24ApiKey);
        }
      }

      results.push(result || emptyResult(num, 'No data found'));
    } catch (e) {
      results.push(emptyResult(num, e.message));
    }

    // Rate limit — wait between requests
    await sleep(800);
  }

  res.json({ results });
});

// ── Courier Detection ─────────────────────────────────────
function detectCourier(num) {
  const n = num.toUpperCase().trim();
  // Royal Mail: 2 letters + 8 digits + 2 letters (GB, GK, etc)
  if (/^[A-Z]{2}\d{8}[A-Z]{2}$/.test(n)) return 'royalmail';
  // Team Global Express: 12 digit numeric
  if (/^\d{12}$/.test(n)) return 'teamglobal';
  return 'ship24';
}

// ── Ship24 API ────────────────────────────────────────────
async function trackShip24(trackingNumber, apiKey) {
  try {
    const res = await axios.post(
      'https://api.ship24.com/public/v1/trackers/track',
      { trackingNumber, forceRefresh: true },
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );

    const trackings = res.data?.data?.trackings;
    if (trackings && trackings.length > 0) {
      return normalise(trackings[0], 'Ship24');
    }

    // Tracker created — fetch results
    const trackerId = res.data?.data?.tracker?.id;
    if (trackerId) {
      await sleep(2000);
      const r2 = await axios.get(
        `https://api.ship24.com/public/v1/trackers/${trackerId}/results`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      const t2 = r2.data?.data?.trackings;
      if (t2 && t2.length > 0) return normalise(t2[0], 'Ship24');
    }
  } catch (e) {
    if (e.response?.status === 401) throw new Error('Invalid Ship24 API key');
    console.error('Ship24 error:', e.message);
  }
  return null;
}

// ── Royal Mail Scraper ────────────────────────────────────
async function trackRoyalMail(trackingNumber) {
  try {
    const url = `https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Referer': 'https://www.royalmail.com/',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(res.data);
    return parseRoyalMailHTML($, trackingNumber);
  } catch (e) {
    console.error('Royal Mail scrape error:', e.message);

    // Try API endpoint directly
    try {
      const apiRes = await axios.get(
        `https://api.royalmail.com/tracking/v1/events?trackingNumbers=${trackingNumber}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json',
            'X-IBM-Client-Id': 'royalmail-public',
          },
          timeout: 10000,
        }
      );
      return parseRoyalMailAPI(apiRes.data, trackingNumber);
    } catch (e2) {
      console.error('Royal Mail API error:', e2.message);
      return emptyResult(trackingNumber, 'Royal Mail: ' + e.message);
    }
  }
}

function parseRoyalMailHTML($, trackingNumber) {
  // Extract status
  let status = $('h2.tracking-status, .delivery-status, h2').first().text().trim()
    || $('[class*="status"]').first().text().trim()
    || 'Unknown';

  // Extract delivery date
  let deliveryDate = null;
  const bodyText = $('body').text();
  const dateMatch = bodyText.match(/delivered[^.]*?(\d{2}[-\/]\d{2}[-\/]\d{4})/i)
    || bodyText.match(/(\d{2}[-\/]\d{2}[-\/]\d{4})/);
  if (dateMatch) deliveryDate = dateMatch[1];

  // Extract tracking number shown on page
  const trackNum = $('[class*="tracking-number"], [class*="reference"]').first().text().trim()
    || trackingNumber;

  // Extract service
  const service = $('[class*="service"], [class*="product"]').first().text().trim() || '';

  const isDelivered = status.toLowerCase().includes('delivered')
    || bodyText.toLowerCase().includes('successfully delivered');

  // Extract events
  const events = [];
  $('[class*="event"], [class*="tracking-event"], li[class*="track"]').each((i, el) => {
    const text = $(el).text().trim();
    if (text) {
      events.push({
        index: i + 1,
        timestamp: null,
        status: text.substring(0, 50),
        statusCode: isDelivered ? 'delivered' : 'in_transit',
        location: '',
        description: text,
        courier: 'ROYAL MAIL',
      });
    }
  });

  if (status === 'Unknown' && !isDelivered) {
    return emptyResult(trackingNumber, 'Royal Mail: Could not parse tracking page');
  }

  return {
    trackingNumber,
    courier:        'ROYAL MAIL',
    statusCode:     isDelivered ? 'delivered' : 'in_transit',
    status:         status || (isDelivered ? 'Delivered' : 'In Transit'),
    deliveryStatus: status || (isDelivered ? 'Delivered' : 'In Transit'),
    isDelivered,
    deliveryDate,
    estimatedDelivery: null,
    actualDelivery:    deliveryDate,
    signedBy:       null,
    origin:         '—',
    destination:    '—',
    lastEvent:      events[0]?.description || status,
    lastLocation:   '—',
    lastTime:       null,
    totalEvents:    events.length || 1,
    source:         'Royal Mail',
    error:          null,
  };
}

function parseRoyalMailAPI(data, trackingNumber) {
  const piece = data?.mailPieces?.[0];
  if (!piece) return emptyResult(trackingNumber, 'Royal Mail: No data');

  const events = (piece.events || []).map((e, i) => ({
    index:       i + 1,
    timestamp:   e.eventDateTime || null,
    status:      e.eventDescription || '',
    statusCode:  (e.eventCode || '').toLowerCase(),
    location:    e.locationName || '',
    description: e.eventDescription || '',
    courier:     'ROYAL MAIL',
  }));

  const latest     = events[0] || {};
  const isDelivered = events.some(e => e.description?.toLowerCase().includes('delivered'));
  const delivDate  = events.find(e => e.description?.toLowerCase().includes('delivered'))?.timestamp;

  return {
    trackingNumber,
    courier:        'ROYAL MAIL',
    statusCode:     isDelivered ? 'delivered' : 'in_transit',
    status:         latest.description || '—',
    deliveryStatus: isDelivered ? 'Delivered' : latest.description || '—',
    isDelivered,
    deliveryDate:   delivDate || null,
    estimatedDelivery: piece.estimatedDelivery || null,
    actualDelivery: delivDate || null,
    signedBy:       piece.signature?.recipientName || null,
    origin:         '—',
    destination:    '—',
    lastEvent:      latest.description || '—',
    lastLocation:   latest.location    || '—',
    lastTime:       latest.timestamp   || null,
    totalEvents:    events.length,
    source:         'Royal Mail API',
    error:          null,
  };
}

// ── Team Global Express Scraper ───────────────────────────
async function trackTeamGlobal(trackingNumber) {
  try {
    const url = `https://teamglobalexp.com/myparcel?shipmentID=${trackingNumber}`;
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9',
        'Referer': 'https://teamglobalexp.com/',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(res.data);
    return parseTeamGlobalHTML($, trackingNumber);
  } catch (e) {
    console.error('Team Global error:', e.message);
    return emptyResult(trackingNumber, 'Team Global Express: ' + e.message);
  }
}

function parseTeamGlobalHTML($, trackingNumber) {
  // Delivery status
  const statusEl = $('[class*="delivery-status"], .status-badge, [class*="status"]').first().text().trim()
    || $('strong:contains("Delivered"), span:contains("Delivered")').first().text().trim()
    || $('body').text().match(/Delivered|In Transit|Out for Delivery/i)?.[0]
    || 'Unknown';

  // Location
  const location = $('[class*="location"], [class*="parcel-location"]').first().text().trim()
    || $('strong').filter((i, el) => $(el).text().match(/WA|NSW|VIC|QLD|SA|TAS|NT|ACT/)).first().text().trim()
    || '—';

  // Date and time
  const bodyText = $('body').text();
  const dateMatch = bodyText.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}\s*(?:AM|PM))/i)
    || bodyText.match(/(\d{2}\/\d{2}\/\d{4})/);
  const deliveryDate = dateMatch ? dateMatch[1].trim() : null;

  // Events — tracking timeline
  const events = [];
  $('[class*="tracking-detail"], [class*="timeline"], [class*="event"]').each((i, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text && text.length > 3) {
      events.push({
        index:       i + 1,
        timestamp:   null,
        status:      text.substring(0, 60),
        statusCode:  text.toLowerCase().includes('delivered') ? 'delivered' : 'in_transit',
        location:    location,
        description: text,
        courier:     'TEAM GLOBAL EXPRESS',
      });
    }
  });

  const isDelivered = statusEl.toLowerCase().includes('delivered')
    || bodyText.toLowerCase().includes('successfully delivered');

  return {
    trackingNumber,
    courier:        'TEAM GLOBAL EXPRESS',
    statusCode:     isDelivered ? 'delivered' : 'in_transit',
    status:         statusEl,
    deliveryStatus: statusEl,
    isDelivered,
    deliveryDate:   isDelivered ? deliveryDate : null,
    estimatedDelivery: null,
    actualDelivery: isDelivered ? deliveryDate : null,
    signedBy:       null,
    origin:         '—',
    destination:    location || '—',
    lastEvent:      events[0]?.description || statusEl,
    lastLocation:   location,
    lastTime:       deliveryDate,
    totalEvents:    events.length || 1,
    source:         'Team Global Express',
    error:          null,
  };
}

// ── Normalise Ship24 Response ─────────────────────────────
function normalise(t, source) {
  const tracker  = t.tracker  || {};
  const shipment = t.shipment || {};
  const delivery = shipment.delivery || {};

  const events = (t.events || []).map((e, i) => ({
    index:       i + 1,
    timestamp:   e.datetime || e.occurrenceDatetime || null,
    status:      toHuman(e.status || e.statusCode || ''),
    statusCode:  (e.statusCode || e.status || '').toLowerCase(),
    location:    buildLocation(e.location),
    description: e.statusMilestone || e.description || e.status || '',
    courier:     (e.courierCode || tracker.courierCode || '').toUpperCase(),
  })).sort((a, b) =>
    (b.timestamp ? new Date(b.timestamp) : 0) - (a.timestamp ? new Date(a.timestamp) : 0)
  );

  const latest = events[0] || {};
  const sc = (shipment.statusCode || '').toLowerCase();
  const ds = (delivery.status || '').toLowerCase();
  const lsc = (latest.statusCode || '').toLowerCase();

  const isDelivered = delivery.isDelivered === true
    || sc.includes('delivered') || ds.includes('delivered') || lsc.includes('delivered');

  let deliveryDate = null;
  if (isDelivered) {
    deliveryDate = delivery.actualDeliveryDate || delivery.deliveryDate;
    if (!deliveryDate) {
      const ev = events.find(e => e.statusCode?.includes('delivered'));
      deliveryDate = ev?.timestamp || latest.timestamp;
    }
  }

  return {
    trackingNumber: tracker.trackingNumber || shipment.trackingNumber || '?',
    courier:        (latest.courier || tracker.courierCode || 'Unknown').toUpperCase(),
    statusCode:     sc || lsc || '',
    status:         toHuman(sc || ds || lsc || ''),
    deliveryStatus: toHuman(ds || sc || lsc || ''),
    isDelivered,
    deliveryDate,
    estimatedDelivery: delivery.estimatedDeliveryDate || null,
    actualDelivery:    delivery.actualDeliveryDate    || null,
    signedBy:          delivery.signedBy || null,
    origin:      buildLocation(shipment.origin)      || '—',
    destination: buildLocation(shipment.destination) || '—',
    lastEvent:    latest.description || latest.status || '—',
    lastLocation: latest.location    || '—',
    lastTime:     latest.timestamp   || null,
    totalEvents:  events.length,
    source:       source || 'Ship24',
    error:        null,
  };
}

// ── Helpers ───────────────────────────────────────────────
function buildLocation(loc) {
  if (!loc) return '';
  return [loc.city, loc.state, loc.countryCode, loc.country].filter(Boolean).join(', ') || loc.name || '';
}

function toHuman(s) {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function emptyResult(trackingNumber, error) {
  return {
    trackingNumber,
    courier:        '—',
    statusCode:     'unknown',
    status:         error ? 'Error' : 'No Data',
    deliveryStatus: '—',
    isDelivered:    false,
    deliveryDate:   null,
    estimatedDelivery: null,
    actualDelivery: null,
    signedBy:       null,
    origin:         '—',
    destination:    '—',
    lastEvent:      error || 'No data returned',
    lastLocation:   '—',
    lastTime:       null,
    totalEvents:    0,
    source:         '—',
    error:          error || null,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Start server ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Tracking server running on port ${PORT}`);
});
