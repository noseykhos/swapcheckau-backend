require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let ebayToken = null;
let tokenExpiry = null;

async function getEbayToken() {
  if (ebayToken && tokenExpiry && Date.now() < tokenExpiry) return ebayToken;
  const clientId = process.env.EBAY_APP_ID;
  const clientSecret = process.env.EBAY_CERT_ID;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  try {
    const response = await axios.post(
      'https://api.ebay.com/identity/v1/oauth2/token',
      'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
      { headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    ebayToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
    return ebayToken;
  } catch (err) {
    console.error('Token error:', err.response?.data || err.message);
    throw new Error('Failed to get eBay token');
  }
}

const AU_FILTER = 'buyingOptions:{FIXED_PRICE},itemLocationCountry:AU,currency:AUD';

// Clean and normalise a product title
function cleanTitle(title) {
  return title
    .replace(/\b(brand new|sealed|new|au stock|free postage|fast shipping|australia|factory)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// Filter out junk listings that aren't the exact product
// e.g. "lot of 2", "x2", "in hand", "5% off", "ME 2.5", bundles of multiple
function isJunkListing(title) {
  const t = title.toLowerCase();
  const junkPatterns = [
    /\blot of \d+/,          // lot of 2, lot of 5
    /\bx\d+\b/,              // x2, x3, x4
    /\d+x\b/,                // 2x, 4x
    /\bin hand\b/,           // in hand
    /\bpre.?order\b/,        // pre-order
    /\b\d+\s*%\s*off\b/,    // 5% off, 10% off
    /\bme \d+\.\d+\b/,      // ME 2.5
    /\bmega evolution\b/,    // Mega Evolution bundle
    /\bjob lot\b/,           // job lot
    /\bbundle of\b/,         // bundle of
    /\bwholesale\b/,         // wholesale
    /\bjob\s*lot\b/,         // job lot
  ];
  return junkPatterns.some(p => p.test(t));
}

// Score how closely a listing matches the search query
function scoreMatch(title, query) {
  const t = title.toLowerCase();
  const q = query.toLowerCase();
  const qWords = q.split(' ').filter(w => w.length > 1);
  let score = 0;
  for (const word of qWords) { if (t.includes(word)) score += 10; }
  if (t.startsWith(q)) score += 20;
  if (t.includes(q)) score += 15;
  // Penalty for junk add-ons not in the search query
  const addons = ['dice', 'sleeves', 'coin', 'promo', 'pin', 'figure', 'plush', 'poster', 'accessory', 'badge', 'mat', 'playmat', 'binder', 'portfolio'];
  for (const addon of addons) { if (t.includes(addon) && !q.includes(addon)) score -= 25; }
  return score;
}

// ─── Suggest — returns best matching products only ───
app.get('/api/suggest', async (req, res) => {
  const query = req.query.q;
  if (!query || query.length < 2) return res.json({ suggestions: [] });
  try {
    const token = await getEbayToken();
    const response = await axios.get(
      'https://api.ebay.com/buy/browse/v1/item_summary/search',
      {
        params: {
          q: `pokemon ${query}`,
          filter: AU_FILTER,
          limit: 25,
          sort: 'bestMatch',
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
        },
      }
    );

    const items = (response.data.itemSummaries || [])
      .filter(i => !isJunkListing(i.title))
      .map(i => ({ ...i, _score: scoreMatch(i.title, query) }))
      .filter(i => i._score > 0)
      .sort((a, b) => b._score - a._score);

    // Group by similar title
    const groups = {};
    for (const item of items) {
      const cleaned = cleanTitle(item.title);
      const key = cleaned.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 35);
      if (!groups[key]) {
        groups[key] = { name: cleaned, prices: [], image: item.image?.imageUrl || null, score: item._score };
      }
      const price = parseFloat(item.price?.value || 0);
      if (price > 0) groups[key].prices.push(price);
    }

    const suggestions = Object.values(groups)
      .filter(g => g.prices.length > 0)
      .sort((a, b) => b.score - a.score)
      .map(g => ({
        name: g.name,
        avgPrice: (g.prices.reduce((a, b) => a + b, 0) / g.prices.length).toFixed(2),
        listings: g.prices.length,
        image: g.image,
      }))
      .slice(0, 5);

    res.json({ suggestions });
  } catch (err) {
    console.error('Suggest error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Suggestions failed' });
  }
});

// ─── Price data — aggregated AU Buy It Now prices ───
app.get('/api/sold', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Query required' });
  try {
    const token = await getEbayToken();
    const response = await axios.get(
      'https://api.ebay.com/buy/browse/v1/item_summary/search',
      {
        params: {
          q: query,
          filter: AU_FILTER,
          sort: 'newlyListed',
          limit: 25,
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
        },
      }
    );

    const rawItems = (response.data.itemSummaries || []).filter(i => !isJunkListing(i.title));

    // Strict filter — Buy It Now only, no auctions, no best offer, AUD, AU seller
    const items = rawItems.filter(item => {
      const options = item.buyingOptions || [];
      return (
        options.includes('FIXED_PRICE') &&
        !options.includes('AUCTION') &&
        item.price?.currency === 'AUD' &&
        item.itemLocation?.country === 'AU'
      );
    });

    if (!items.length) {
      return res.json({ name: query, lastSold: null, avg: null, high: null, low: null, sales: 0, trend: 'unknown', recentSales: [] });
    }

    const prices = items.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const high = Math.max(...prices);
    const low = Math.min(...prices);

    // Trend
    const mid = Math.floor(prices.length / 2);
    const recentAvg = prices.slice(0, mid).reduce((a, b) => a + b, 0) / (mid || 1);
    const olderAvg = prices.slice(mid).reduce((a, b) => a + b, 0) / (prices.slice(mid).length || 1);
    let trend = 'stable';
    if (recentAvg > olderAvg * 1.05) trend = 'up';
    else if (recentAvg < olderAvg * 0.95) trend = 'down';

    // Recent sales — clean titles
    const recentSales = items.slice(0, 5).map(item => ({
      title: cleanTitle(item.title),
      price: parseFloat(item.price?.value || 0),
      buyingOption: 'Buy It Now',
      date: item.itemCreationDate
        ? new Date(item.itemCreationDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'Recent',
      image: item.image?.imageUrl || null,
      url: item.itemWebUrl,
    }));

    res.json({
      name: query,
      lastSold: parseFloat(prices[0].toFixed(2)),
      avg: parseFloat(avg.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      sales: prices.length,
      trend,
      recentSales,
    });
  } catch (err) {
    console.error('Sold error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch price data' });
  }
});

// ─── Health ───
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'SwapCheckAU', version: '1.2.0' });
});

app.listen(PORT, () => {
  console.log(`SwapCheckAU backend v1.2 running on port ${PORT}`);
});
