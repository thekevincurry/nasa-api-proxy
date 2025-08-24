require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const dns = require('dns');
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// NASA API Proxy Server
// =====================
// This server proxies NASA APIs that require authentication.
// 
// Current endpoints:
// - /api/nasa/apod - NASA Astronomy Picture of the Day (requires API key)
// 
// Note: EPIC (Earth Polychromatic Imaging Camera) endpoint removed.
// The iOS app now uses direct NASA EPIC API calls (no authentication required).

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.set('trust proxy', true); // allow x-forwarded-* headers for proto/host behind proxies

// Simple request timeout flag (default 20s) to guide handlers; we avoid sending a 504 here to prevent double responses
const ROUTE_TIMEOUT_MS = parseInt(process.env.ROUTE_TIMEOUT_MS || '20000', 10);
app.use((req, res, next) => {
  res.setHeader('X-Server', 'The-Inner-Citadel');
  req.timedOut = false;
  const timer = setTimeout(() => { req.timedOut = true; }, ROUTE_TIMEOUT_MS);
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

function isDone(res) {
  return res.headersSent || res.writableEnded;
}

function respondJson(res, body, status = 200) {
  if (isDone(res)) return false;
  if (status !== 200) res.status(status);
  res.json(body);
  return true;
}

const NASA_API_KEY = process.env.NASA_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // e.g. https://stoic-app-thbdd.ondigitalocean.app

// Serve cached static assets (images) from a writable dir via /cdn (default: /tmp/public)
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join('/tmp', 'public');
app.use('/cdn', express.static(PUBLIC_DIR, {
  maxAge: '12h',
  immutable: false,
}));

// Meta storage for last-known-good items (EPIC support removed - app now uses direct NASA API)
const META_DIR = path.join(PUBLIC_DIR, '_meta');

// Create an axios client that prefers IPv4 (helps avoid IPv6/proxy issues) and reuses connections
const ipv4Lookup = (hostname, options, callback) => {
  return dns.lookup(hostname, { all: false, family: 4 }, callback);
};
const axiosClient = axios.create({
  timeout: 20000,
  httpAgent: new http.Agent({ keepAlive: true, lookup: ipv4Lookup }),
  httpsAgent: new https.Agent({ keepAlive: true, lookup: ipv4Lookup }),
  headers: {
    'User-Agent': 'The-Inner-Citadel/1.0 (+https://example.com)'
  }
});

// Separate client for image downloads: prefer IPv4, disable keep-alive, follow redirects, set Accept for images
const axiosImageClient = axios.create({
  timeout: 20000,
  maxRedirects: 5,
  httpAgent: new http.Agent({ keepAlive: false, lookup: ipv4Lookup }),
  httpsAgent: new https.Agent({ keepAlive: false, lookup: ipv4Lookup }),
  headers: {
    'User-Agent': 'The-Inner-Citadel/1.0 (+https://example.com)',
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Encoding': 'identity',
    'Connection': 'close'
  }
});

const NASA_TRACE = /^(1|true|yes)$/i.test(process.env.NASA_TRACE || '');
function trace(...args) {
  if (NASA_TRACE) console.log('[TRACE]', ...args);
}

// Generic fetch with simple retry/backoff; do not retry on 4xx
async function fetchJsonWithRetry(url, { attempts = 2, initialDelayMs = 250, timeoutMs = 15000 } = {}) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
  const resp = await axiosClient.get(url, { responseType: 'json', timeout: timeoutMs });
      return resp.data;
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        // Client error (except 429): do not retry
        break;
      }
      if (i < attempts) {
        const delay = initialDelayMs * Math.pow(2, i - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr || new Error('Request failed');
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true }).catch(() => {});
}

function getPublicBase(req) {
  if (PUBLIC_BASE_URL && PUBLIC_BASE_URL.startsWith('http')) return PUBLIC_BASE_URL;
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return '';
  return `${proto}://${host}`;
}

// Download an image to the local cache if missing; return absolute public URL
async function cacheImageIfNeeded(sourceUrl, subpath, req) {
  try {
    const localPath = path.join(PUBLIC_DIR, subpath);
    const localDir = path.dirname(localPath);
    await ensureDir(localDir);
    if (!fs.existsSync(localPath)) {
      console.log(`⬇️ Caching image -> ${sourceUrl} -> /cdn/${subpath}`);
      // Attempt download with retry/backoff; do not retry on 404
      let success = false;
      let lastErr = null;
      for (let i = 1; i <= 3; i++) {
        try {
          // Quick HEAD preflight to avoid long hangs on bad URLs; short timeout
          try {
            const u = new URL(sourceUrl);
            try {
              const ip = await dns.promises.lookup(u.hostname, { family: 4 });
              trace('DNS A', u.hostname, '->', ip.address);
            } catch (e) {
              trace('DNS lookup failed', u.hostname, e.message);
            }
            const head = await axiosImageClient.head(sourceUrl, { timeout: 5000, validateStatus: () => true });
            trace('HEAD', head.status, sourceUrl);
            if (head.status === 404) {
              // Not found: no more retries for this URL
              lastErr = new Error('404 Not Found (HEAD)');
              break;
            }
          } catch (e) {
            trace('HEAD error', e.message);
            // Continue to GET attempt; HEAD may be blocked by some CDNs
          }
          const resp = await axiosImageClient.get(sourceUrl, { responseType: 'stream' });
          await new Promise((resolve, reject) => {
            const w = fs.createWriteStream(localPath);
            resp.data.pipe(w);
            w.on('finish', resolve);
            w.on('error', reject);
          });
          success = true;
          break;
        } catch (e) {
          lastErr = e;
          const status = e.response?.status;
          if (status === 404) {
            // Not found: do not retry this URL
            break;
          }
          if (i < 3) {
            const delay = 300 * Math.pow(2, i - 1);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
      if (!success) {
        throw lastErr || new Error('Image download failed');
      }
      console.log(`🗂️ Image cached: /cdn/${subpath}`);
    } else {
      console.log(`🗂️ Using cached image: /cdn/${subpath}`);
    }
  const base = getPublicBase(req) || '';
  return `${base}/cdn/${subpath}`;
  } catch (e) {
    console.error('❌ cacheImageIfNeeded error:', e.message);
    return null;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString()
  });
});

// Helper function to extract YouTube video ID
function extractYouTubeId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// NASA APOD endpoint
app.get('/api/nasa/apod', async (req, res) => {
  try {
    // Use date from query parameter or default to today
    const requestedDate = req.query.date || new Date().toISOString().split('T')[0];
    
    console.log(`Fetching APOD from NASA API for date: ${requestedDate}`);
    
    if (!NASA_API_KEY) {
      throw new Error('NASA_API_KEY not configured');
    }
    
    // Build API URL with date parameter
    const apiUrl = `https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}` + 
                   (req.query.date ? `&date=${req.query.date}` : '');
    
    // Fetch from NASA
  const response = await axiosClient.get(apiUrl, { timeout: 10000 });
    
    // Handle video content by providing thumbnail or fallback
    const nasaData = response.data;
    
  // Handle different media types
  if (nasaData.media_type === 'video' && nasaData.url) {
      // Standard video content with URL (YouTube, Vimeo, etc.)
      if (nasaData.url.includes('youtube.com') || nasaData.url.includes('youtu.be')) {
        // Extract YouTube video ID and create thumbnail URL
        const videoId = extractYouTubeId(nasaData.url);
        if (videoId) {
          nasaData.thumbnail_url = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        }
      } else if (nasaData.url.includes('vimeo.com')) {
        // For Vimeo, we'll need to keep the original URL
        // Vimeo thumbnails require API calls, so we'll use a space placeholder
        nasaData.thumbnail_url = "https://images.unsplash.com/photo-1446776877081-d282a0f896e2?w=800&h=600&fit=crop";
      }
      
      // Keep the original video URL for potential future video playback
      nasaData.video_url = nasaData.url;
    } else if (nasaData.media_type === 'other' || 
               (nasaData.explanation && 
                (nasaData.explanation.toLowerCase().includes('video') || 
                 nasaData.explanation.toLowerCase().includes('animation') ||
                 nasaData.explanation.toLowerCase().includes('time-lapse')))) {
      // Handle NASA-hosted videos or other content that mentions video
      // These often don't have direct URLs in the API but are video content
      nasaData.media_type = 'video'; // Convert to video for app handling
      nasaData.isNasaHosted = true;
      
      // Provide a space-themed thumbnail for NASA-hosted videos
      nasaData.thumbnail_url = "https://images.unsplash.com/photo-1446776877081-d282a0f896e2?w=800&h=600&fit=crop";
      
      // If no URL is provided, create a link to the APOD page where the video can be viewed
      if (!nasaData.url) {
        const dateStr = nasaData.date.replace(/-/g, '');
        const year = dateStr.substring(2, 4);
        const month = dateStr.substring(4, 6);
        const day = dateStr.substring(6, 8);
        nasaData.video_url = `https://apod.nasa.gov/apod/ap${year}${month}${day}.html`;
        nasaData.url = nasaData.video_url; // Provide a fallback URL
      }
    }
    
    // Choose a display URL (image) to cache & serve from our backend
    let originalDisplay = null;
    if (nasaData.media_type === 'image') {
      originalDisplay = nasaData.hdurl || nasaData.url || null;
    } else if (nasaData.media_type === 'video') {
      originalDisplay = nasaData.thumbnail_url || null;
    }

    if (originalDisplay) {
      try {
        // Determine extension
        const ext = path.extname(new URL(originalDisplay).pathname) || '.jpg';
        const dateStr = (nasaData.date || new Date().toISOString().split('T')[0]).replace(/\//g, '-');
        const filename = `apod_${dateStr}${ext}`;
        const subpath = path.join('nasa', 'apod', filename);
  const cdnUrl = await cacheImageIfNeeded(originalDisplay, subpath, req);
        if (cdnUrl) {
          nasaData.display_url = cdnUrl; // prefer this in clients
          nasaData.original_url = originalDisplay; // keep original for reference
        }
      } catch (e) {
        console.error('APOD cache error:', e.message);
      }
    }

  console.log('✅ APOD fetched successfully');
  if (!respondJson(res, nasaData)) return;
  } catch (error) {
    console.error('APOD API error:', error.message);
    
    // Return fallback data
    const fallback = {
      title: "Earthrise",
      explanation: "This iconic image shows Earth rising over the lunar horizon, captured during the Apollo 8 mission. When API services are temporarily unavailable, we show this timeless view of our home planet.",
      url: "https://apod.nasa.gov/apod/image/1812/earthrise_apollo8_4133.jpg",
      hdurl: "https://apod.nasa.gov/apod/image/1812/earthrise_apollo8_4133.jpg",
      media_type: "image",
      date: new Date().toISOString().split('T')[0]
    };
    
  // Also set display_url to a known reliable image
  fallback.display_url = fallback.hdurl || fallback.url;
  console.log('📷 Serving fallback APOD data');
  respondJson(res, fallback);
  }
});

// Debug endpoint to check environment
app.get('/debug', (req, res) => {
  res.json({
    nasa_api_key: NASA_API_KEY ? 'configured' : 'missing',
    port: PORT,
    node_env: process.env.NODE_ENV || 'development'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 NASA APOD Proxy server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Debug info: http://localhost:${PORT}/debug`);
  console.log(`🗂️ CDN cache directory: ${PUBLIC_DIR}`);
  console.log(`ℹ️  EPIC API removed - iOS app now uses direct NASA API`);
});
