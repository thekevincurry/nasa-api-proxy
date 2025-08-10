require('dotenv').config();
const express = require('express');
const cors = require('cors');
const redis = require('redis');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Redis setup
const client = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

client.on('error', (err) => console.log('Redis Client Error', err));
client.connect();

// Middleware
app.use(cors());
app.use(express.json());

const NASA_API_KEY = process.env.NASA_API_KEY;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// NASA APOD endpoint
app.get('/api/nasa/apod', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `nasa:apod:${today}`;
    
    // Check cache first
    const cached = await client.get(cacheKey);
    if (cached) {
      console.log('Serving APOD from cache');
      return res.json(JSON.parse(cached));
    }
    
    console.log('Fetching fresh APOD from NASA API');
    
    // Fetch from NASA
    const response = await axios.get(
      `https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}`,
      { timeout: 10000 }
    );
    
    // Cache result for 6 hours
    await client.setex(cacheKey, 21600, JSON.stringify(response.data));
    
    res.json(response.data);
  } catch (error) {
    console.error('APOD API error:', error.message);
    
    // Return fallback data
    const fallback = require('./fallback/apod.json');
    res.json(fallback);
  }
});

// NASA EPIC endpoint
app.get('/api/nasa/epic', async (req, res) => {
  try {
    const cacheKey = 'nasa:epic:latest';
    
    // Check cache first
    const cached = await client.get(cacheKey);
    if (cached) {
      console.log('Serving EPIC from cache');
      return res.json(JSON.parse(cached));
    }
    
    console.log('Fetching fresh EPIC from NASA API');
    
    // Fetch from NASA
    const response = await axios.get(
      `https://api.nasa.gov/EPIC/api/natural?api_key=${NASA_API_KEY}`,
      { timeout: 15000 }
    );
    
    // Cache result for 2 hours
    await client.setex(cacheKey, 7200, JSON.stringify(response.data));
    
    res.json(response.data);
  } catch (error) {
    console.error('EPIC API error:', error.message);
    
    // Return fallback data
    const fallback = require('./fallback/epic.json');
    res.json(fallback);
  }
});

app.listen(PORT, () => {
  console.log(`NASA API Proxy server running on port ${PORT}`);
});
