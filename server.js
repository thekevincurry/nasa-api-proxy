require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const NASA_API_KEY = process.env.NASA_API_KEY;

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
    
    // Fetch from NASA
    const response = await axios.get(
      `https://api.nasa.gov/EPIC/api/natural?api_key=${NASA_API_KEY}`,
      { timeout: 15000 }
    );
    
    console.log('✅ EPIC fetched successfully');
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
    port: PORT,
    node_env: process.env.NODE_ENV || 'development'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 NASA API Proxy server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Debug info: http://localhost:${PORT}/debug`);
});
