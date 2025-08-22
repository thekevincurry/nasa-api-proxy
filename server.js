require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.set('trust proxy', true); // allow x-forwarded-* headers for proto/host behind proxies

const NASA_API_KEY = process.env.NASA_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // e.g. https://stoic-app-thbdd.ondigitalocean.app

// Serve cached static assets (images) from a writable dir via /cdn (default: /tmp/public)
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join('/tmp', 'public');
app.use('/cdn', express.static(PUBLIC_DIR, {
  maxAge: '12h',
  immutable: false,
}));

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
      const resp = await axios.get(sourceUrl, { responseType: 'stream', timeout: 20000 });
      await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(localPath);
        resp.data.pipe(w);
        w.on('finish', resolve);
        w.on('error', reject);
      });
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
    const response = await axios.get(apiUrl, { timeout: 10000 });
    
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
    res.json(nasaData);
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
  res.json(fallback);
  }
});

// NASA EPIC endpoint
app.get('/api/nasa/epic', async (req, res) => {
  try {
    console.log('Fetching EPIC from NASA API');
    
    if (!NASA_API_KEY) {
      throw new Error('NASA_API_KEY not configured');
    }
    
    // Fetch from NASA: allow optional ?date=YYYY-MM-DD and fallback across recent days if needed
    const dateParam = (req.query.date || '').toString().trim();
    const baseApi = 'https://api.nasa.gov/EPIC/api/natural';
    const tryFetch = async (url) => axios.get(url, { timeout: 20000 }).then(r => r.data).catch(() => null);
    let items = null;
    if (dateParam) {
      items = await tryFetch(`${baseApi}/date/${dateParam}?api_key=${NASA_API_KEY}`);
    } else {
      items = await tryFetch(`${baseApi}?api_key=${NASA_API_KEY}`);
    }
    // If nothing came back, look back up to 5 days
    if (!items || (Array.isArray(items) && items.length === 0)) {
      const lookback = 5;
      const now = new Date();
      for (let i = 1; i <= lookback; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        d.setUTCDate(d.getUTCDate() - i);
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const ds = `${yyyy}-${mm}-${dd}`;
        const alt = await tryFetch(`${baseApi}/date/${ds}?api_key=${NASA_API_KEY}`);
        if (alt && Array.isArray(alt) && alt.length > 0) { items = alt; break; }
      }
    }
    if (!items) throw new Error('EPIC API returned no data');
    // Attach backend-hosted image_url for each record and cache the image
    items = Array.isArray(items) ? items : [items];
    const enhanced = [];
    for (const item of items) {
      try {
        // EPIC date like "YYYY-MM-DD HH:mm:ss" => yyyy/MM/dd
        const dateObj = new Date((item.date || '').replace(' ', 'T') + 'Z');
        const yyyy = String(dateObj.getUTCFullYear());
        const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(dateObj.getUTCDate()).padStart(2, '0');
        const datePath = `${yyyy}/${mm}/${dd}`;

        // Try PNG then JPG on epic.gsfc first, then api.nasa.gov as a fallback (with key)
        const extCandidates = ['png', 'jpg'];
        let chosen = null;
        for (const ext of extCandidates) {
          const filename = `${item.image}.${ext}`;
          const gsfcUrl = `https://epic.gsfc.nasa.gov/archive/natural/${datePath}/${ext}/${filename}`;
          const subpath = path.join('nasa', 'epic', yyyy, mm, dd, filename);
          const cdnUrl = await cacheImageIfNeeded(gsfcUrl, subpath, req);
          if (cdnUrl) { chosen = { cdnUrl, original: gsfcUrl }; break; }
        }
        if (!chosen && NASA_API_KEY) {
          for (const ext of extCandidates) {
            const filename = `${item.image}.${ext}`;
            const apiUrl = `https://api.nasa.gov/EPIC/archive/natural/${datePath}/${ext}/${filename}?api_key=${NASA_API_KEY}`;
            const subpath = path.join('nasa', 'epic', yyyy, mm, dd, filename);
            const cdnUrl = await cacheImageIfNeeded(apiUrl, subpath, req);
            if (cdnUrl) { chosen = { cdnUrl, original: `https://epic.gsfc.nasa.gov/archive/natural/${datePath}/${ext}/${filename}` }; break; }
          }
        }

        if (chosen) {
          enhanced.push({ ...item, image_url: chosen.cdnUrl, original_url: chosen.original });
        } else {
          // Could not cache; return item without image_url to avoid 404s
          enhanced.push({ ...item, original_url: undefined });
        }
      } catch (e) {
        console.error('EPIC enhance error:', e.message);
        enhanced.push(item);
      }
    }

    console.log('✅ EPIC fetched successfully');
    res.json(enhanced);
  } catch (error) {
    console.error('EPIC API error:', error.message);
    
    // Return fallback data
    const fallback = [{
      identifier: "20240810_000000",
      caption: "This image was taken by the EPIC camera aboard the NOAA DSCOVR satellite",
      image: "epic_1b_20240810000000",
      version: "03",
      centroid_coordinates: {
        lat: 0.0,
        lon: 0.0
      },
      dscovr_j2000_position: {
        x: -1394708.63,
        y: 576971.88,
        z: 246324.69
      },
      lunar_j2000_position: {
        x: 25949.44,
        y: -351738.88,
        z: -152481.00
      },
      sun_j2000_position: {
        x: -37296566.44,
        y: -139990462.88,
        z: -60673090.00
      },
      attitude_quaternions: {
        q0: -0.374760,
        q1: 0.024730,
        q2: 0.015829,
        q3: 0.926654
      },
      date: "2024-08-10 00:00:00",
      coords: {
        centroid_coordinates: {
          lat: 0.0,
          lon: 0.0
        },
        dscovr_j2000_position: {
          x: -1394708.63,
          y: 576971.88,
          z: 246324.69
        },
        lunar_j2000_position: {
          x: 25949.44,
          y: -351738.88,
          z: -152481.00
        },
        sun_j2000_position: {
          x: -37296566.44,
          y: -139990462.88,
          z: -60673090.00
        },
        attitude_quaternions: {
          q0: -0.374760,
          q1: 0.024730,
          q2: 0.015829,
          q3: 0.926654
        }
      }
    }];
    
    // Provide image_url for fallback as well (try PNG, then JPG, then api.nasa.gov)
    try {
      const item = fallback[0];
      const dateObj = new Date(item.date.replace(' ', 'T') + 'Z');
      const yyyy = String(dateObj.getUTCFullYear());
      const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dateObj.getUTCDate()).padStart(2, '0');
      const datePath = `${yyyy}/${mm}/${dd}`;
      const extCandidates = ['png', 'jpg'];
      let chosen = null;
      for (const ext of extCandidates) {
        const filename = `${item.image}.${ext}`;
        const gsfcUrl = `https://epic.gsfc.nasa.gov/archive/natural/${datePath}/${ext}/${filename}`;
        const subpath = path.join('nasa', 'epic', yyyy, mm, dd, filename);
        const cdnUrl = await cacheImageIfNeeded(gsfcUrl, subpath, req);
        if (cdnUrl) { chosen = { cdnUrl, original: gsfcUrl }; break; }
      }
      if (!chosen && NASA_API_KEY) {
        for (const ext of extCandidates) {
          const filename = `${item.image}.${ext}`;
          const apiUrl = `https://api.nasa.gov/EPIC/archive/natural/${datePath}/${ext}/${filename}?api_key=${NASA_API_KEY}`;
          const subpath = path.join('nasa', 'epic', yyyy, mm, dd, filename);
          const cdnUrl = await cacheImageIfNeeded(apiUrl, subpath, req);
          if (cdnUrl) { chosen = { cdnUrl, original: `https://epic.gsfc.nasa.gov/archive/natural/${datePath}/${ext}/${filename}` }; break; }
        }
      }
      if (chosen) {
        fallback[0] = { ...item, image_url: chosen.cdnUrl, original_url: chosen.original };
      }
    } catch {}
    console.log('🌍 Serving fallback EPIC data');
    res.json(fallback);
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
  console.log(`🚀 NASA API Proxy server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Debug info: http://localhost:${PORT}/debug`);
  console.log(`🗂️ CDN cache directory: ${PUBLIC_DIR}`);
});
