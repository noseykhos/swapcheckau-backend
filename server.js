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

const AU_STRICT_FILTER = [
  'buyingOptions:{FIXED_PRICE}',
  'itemLocationCountry:AU',
  'conditions:{NEW}',
  'deliveryCountry:AU',
  'currency:AUD',
].join(',');

const AU_SUGGEST_FILTER = [
  'buyingOptions:{FIXED_PRICE}',
  'itemLocationCountry:AU',
  'currency:AUD',
].join(',');

function isRelevantItem(title) {
  const t = title.toLowerCase();
  if (!t.includes('pokemon') && !t.includes('pokémon')) return false;
  const junk = ['single', 'lot of', 'damaged', 'played', 'heavy played', 'lightly played', 'nm/', 'psa', 'bgs', 'cgc'];
  for (const j of junk) { if (t.includes(j)) return false; }
  return true;
}

app.get('/api/suggest', async (req, res) => {
  const query = req.query.q;
  if (!query || query.length < 2) return res.json({ suggestions: [] });
  try {
    const token = await getEbayToken();
    const response = await axios.get(
      'https://api.ebay.com/buy/browse/v1/item_summary/search',
      {
        params: {
          q: `pokemon tcg ${query} sealed`,
          filter: AU_SUGGEST_FILTER,
          limit: 12,
          sort: 'bestMatch',
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
          'Accept-Language': 'en-AU',
        },
      }
    );
    const items = (response.data.itemSummaries || []).filter(i => isRelevantItem(i.title));
    const seen = new Set();
    const suggestions = [];
    for (const item of items) {
      const key = item.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 45);
      if (!seen.has(key)) {
        seen.add(key);
        suggestions.push({
          name: item.title,
          price: parseFloat(item.price?.value || 0),
          image: item.image?.imageUrl || null,
        });
      }
    }
    res.json({ suggestions: suggestions.slice(0, 6) });
  } catch (err) {
    console.error('Suggest error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Suggestions failed' });
  }
});

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
          filter: AU_STRICT_FILTER,
          sort: 'newlyListed',
          limit: 25,
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_AU',
          'Accept-Language': 'en-AU',
        },
      }
    );
    const rawItems = response.data.itemSummaries || [];
    const items = rawItems.filter(item => {
      const options = item.buyingOptions || [];
      const hasFixed = options.includes('FIXED_PRICE');
      const hasAuction = options.includes('AUCTION');
      const hasBestOffer = options.includes('BEST_OFFER');
      const currency = item.price?.currency;
      const location = item.itemLocation?.country;
      return hasFixed && !hasAuction && !hasBestOffer && currency === 'AUD' && location === 'AU';
    });
    if (!items.length) {
      return res.json({
        name: query,
        lastSold: null,
        avg: null,
        high: null,
        low: null,
        sales: 0,
        trend: 'unknown',
        recentSales: [],
        note: 'No Buy It Now AU listings found for this product.'
      });
    }
    const prices = items.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 0);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const firstHalf = prices.slice(0, Math.floor(prices.length / 2));
    const secondHalf = prices.slice(Math.floor(prices.length / 2));
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / (firstHalf.length || 1);
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / (secondHalf.length || 1);
    let trend = 'stable';
    if (firstAvg > secondAvg * 1.05) trend = 'up';
    else if (firstAvg < secondAvg * 0.95) trend = 'down';
    const recentSales = items.slice(0, 6).map(item => ({
      title: item.title,
      price: parseFloat(item.price?.value || 0),
      buyingOption: 'Buy It Now',
      location: item.itemLocation?.city || 'Australia',
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
      dataType: 'BUY_IT_NOW_AU_ONLY',
    });
  } catch (err) {
    console.error('Sold error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch price data', details: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'SwapCheckAU', version: '1.1.0', filters: 'BUY_IT_NOW_AU_AUD_NEW_ONLY' });
});

app.listen(PORT, () => {
  console.log(`SwapCheckAU backend v1.1 running on port ${PORT}`);
  console.log('Filters: Buy It Now | AU sellers | AUD only | New/Sealed');
});
