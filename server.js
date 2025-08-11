require('dotenv').config();
const express = require('express');
const cors = require('cors');
const redis = require('redis');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Redis setup with error handling
let client = null;
let redisConnected = false;

async function initRedis() {
  try {
    if (process.env.REDIS_URL) {
      console.log('Connecting to Redis:', process.env.REDIS_URL.replace(/\/\/.*@/, '//***:***@'));
      client = redis.createClient({
        url: process.env.REDIS_URL
      });
      
      client.on('error', (err) => {
        console.log('Redis Client Error:', err.message);
        redisConnected = false;
      });
      
      client.on('connect', () => {
        console.log('✅ Redis connected successfully');
        redisConnected = true;
      });
      
      client.on('disconnect', () => {
        console.log('❌ Redis disconnected');
        redisConnected = false;
      });
      
      await client.connect();
    } else {
      console.log('⚠️ No REDIS_URL found, running without cache');
    }
  } catch (error) {
    console.log('⚠️ Redis connection failed, running without cache:', error.message);
    redisConnected = false;
  }
}

// Initialize Redis
initRedis();

// Middleware
app.use(cors());
app.use(express.json());

const NASA_API_KEY = process.env.NASA_API_KEY;

// Cache helper functions
async function getCache(key) {
  if (!redisConnected || !client) {
    return null;
  }
  try {
    return await client.get(key);
  } catch (error) {
    console.log('Cache read error:', error.message);
    return null;
  }
}

async function setCache(key, value, ttl) {
  if (!redisConnected || !client) {
    return;
  }
  try {
    await client.setex(key, ttl, value);
  } catch (error) {
    console.log('Cache write error:', error.message);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    redis: redisConnected ? 'connected' : 'disconnected',
    caching: redisConnected ? 'enabled' : 'disabled'
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
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `nasa:apod:${today}`;
    
    // Check cache first
    const cached = await getCache(cacheKey);
    if (cached) {
      console.log('Serving APOD from cache');
      return res.json(JSON.parse(cached));
    }
    
    console.log('Fetching fresh APOD from NASA API');
    
    if (!NASA_API_KEY) {
      throw new Error('NASA_API_KEY not configured');
    }
    
    // Fetch from NASA
    const response = await axios.get(
      `https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}`,
      { timeout: 10000 }
    );
    
    // Handle video content by providing thumbnail or fallback
    const nasaData = response.data;
    if (nasaData.media_type === 'video' && nasaData.url) {
      // For videos, try to extract a thumbnail or use a placeholder
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
    }
    
    // Cache result for 6 hours
    await setCache(cacheKey, JSON.stringify(nasaData), 21600);
    
    console.log('✅ APOD fetched and cached successfully');
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
    
    console.log('📷 Serving fallback APOD data');
    res.json(fallback);
  }
});

// NASA EPIC endpoint
app.get('/api/nasa/epic', async (req, res) => {
  try {
    const cacheKey = 'nasa:epic:latest';
    
    // Check cache first
    const cached = await getCache(cacheKey);
    if (cached) {
      console.log('Serving EPIC from cache');
      return res.json(JSON.parse(cached));
    }
    
    console.log('Fetching fresh EPIC from NASA API');
    
    if (!NASA_API_KEY) {
      throw new Error('NASA_API_KEY not configured');
    }
    
    // Fetch from NASA
    const response = await axios.get(
      `https://api.nasa.gov/EPIC/api/natural?api_key=${NASA_API_KEY}`,
      { timeout: 15000 }
    );
    
    // Cache result for 2 hours
    await setCache(cacheKey, JSON.stringify(response.data), 7200);
    
    console.log('✅ EPIC fetched and cached successfully');
    res.json(response.data);
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
    
    console.log('🌍 Serving fallback EPIC data');
    res.json(fallback);
  }
});

// Debug endpoint to check environment
app.get('/debug', (req, res) => {
  res.json({
    nasa_api_key: NASA_API_KEY ? 'configured' : 'missing',
    redis_url: process.env.REDIS_URL ? 'configured' : 'missing',
    redis_connected: redisConnected,
    port: PORT,
    node_env: process.env.NODE_ENV || 'development'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 NASA API Proxy server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Debug info: http://localhost:${PORT}/debug`);
});
