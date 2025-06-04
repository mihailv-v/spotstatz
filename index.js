require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('@replit/node-fetch');
const querystring = require('querystring');
const cookieParser = require('cookie-parser');
const { scrapeTunebatData } = require('./scraper-new');

const app = express();
const PORT = process.env.PORT || 8888;

// Spotify configuration — replace with your own in prod
const SPOTIFY_CLIENT_ID     = process.env.CLIENT_ID     || process.env.CLIENT_ID_1     || 'your_spotify_client_id';
const SPOTIFY_CLIENT_SECRET = process.env.CLIENT_SECRET || process.env.CLIENT_SECRET_1 || 'your_spotify_client_secret';
const SPOTIFY_REDIRECT_URI  = `https://27198efb-849b-445c-9d0f-3aacf3823c91-00-1gzfiiouj0qrm.picard.replit.dev:3000/callback`;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(cookieParser());

// Logging utility
function log(component, action, details) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${component}] ${action}:`, details);
}

// Simple in‑memory state store (swap for Redis/DB in prod)
const stateStore = new Map();
const userPlaylists = new Map();
const playlistRefreshInterval = 5 * 60 * 1000; // 5 minutes

async function getUserPlaylists(userId, accessToken, forceRefresh = false) {
  log('Playlists', 'Fetching user playlists', { userId, forceRefresh });
  
  const userCache = userPlaylists.get(userId);
  const now = Date.now();

  if (!forceRefresh && userCache && (now - userCache.timestamp < playlistRefreshInterval)) {
    log('Playlists', 'Using cached playlists', { userId, playlistCount: userCache.playlists.length });
    return userCache.playlists;
  }

  const playlists = [];
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50';

  while (url) {
    const response = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`Failed to fetch playlists: ${data.error?.message || 'Unknown error'}`);
    }

    playlists.push(...data.items);
    url = data.next;
  }

  userPlaylists.set(userId, {
    timestamp: now,
    playlists: playlists
  });

  return playlists;
}

async function getOrCreatePlaylist(userId, accessToken, name) {
  log('Playlists', 'Getting or creating playlist', { userId, name });
  
  if (name.length > 100) {
    name = name.substring(0, 97) + '...';
  }

  try {
    let playlists = await getUserPlaylists(userId, accessToken);
    let existing = playlists.find(p => p.name === name);

    if (!existing) {
      log('Playlists', 'Playlist not found, refreshing cache', { name });
      playlists = await getUserPlaylists(userId, accessToken, true);
      existing = playlists.find(p => p.name === name);
    }

    if (existing) {
      log('Playlists', 'Found existing playlist', { name, id: existing.id });
      return existing.id;
    }

    log('Playlists', 'Creating new playlist', { name });
    const create = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        public: false,
        description: 'Created by Song Data Analyzer'
      })
    });
    
    if (!create.ok) {
      throw new Error('Failed to create playlist');
    }

    const newPlaylist = await create.json();
    
    // Update cache with new playlist
    playlists.push(newPlaylist);
    userPlaylists.set(userId, {
      timestamp: Date.now(),
      playlists: playlists
    });

    return newPlaylist.id;
  } catch (err) {
    log('Playlists', 'Error in getOrCreatePlaylist', { error: err.message, name });
    throw err;
  }
}

async function addTrackToPlaylist(playlistId, trackId, accessToken) {
  log('Playlists', 'Adding track to playlist', { playlistId, trackId });
  
  const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      uris: [`spotify:track:${trackId}`]
    })
  });

  if (!response.ok) {
    const error = await response.json();
    log('Playlists', 'Error adding track', { playlistId, trackId, error });
    throw new Error(`Failed to add track: ${error.error?.message || 'Unknown error'}`);
  }

  log('Playlists', 'Successfully added track', { playlistId, trackId });
  return response.json();
}

// Serve UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function generateRandomString(length) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

function extractSpotifyTrackId(input) {
  input = input.trim();
  if (/^[a-zA-Z0-9]{22}$/.test(input)) {
    return input;
  }
  const patterns = [
    /spotify:track:([a-zA-Z0-9]{22})/,
    /open\.spotify\.com\/track\/([a-zA-Z0-9]{22})/,
    /spotify\.com\/track\/([a-zA-Z0-9]{22})/
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return null;
}

// —————————————————————————————
// OAuth login & callback
// —————————————————————————————

app.get('/login', (req, res) => {
  const state = generateRandomString(16);
  stateStore.set(state, Date.now());
  const scope = 'user-read-currently-playing user-read-playback-state playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative';
  res.redirect('https://accounts.spotify.com/authorize?' + querystring.stringify({
    response_type: 'code',
    client_id:     SPOTIFY_CLIENT_ID,
    scope,
    redirect_uri:  SPOTIFY_REDIRECT_URI,
    state
  }));
});

app.get('/callback', async (req, res) => {
  const code  = req.query.code  || null;
  const state = req.query.state || null;

  if (!state || !stateStore.has(state)) {
    return res.redirect('/#' + querystring.stringify({ error: 'state_mismatch' }));
  }
  stateStore.delete(state);

  const tokenOpts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization':  'Basic ' +
        Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
    },
    body: querystring.stringify({
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
      grant_type:   'authorization_code'
    })
  };

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', tokenOpts);
    const data     = await tokenRes.json();

    if (!tokenRes.ok) {
      return res.redirect('/#' + querystring.stringify({ error: 'invalid_token' }));
    }

    // Secure, HTTP-only cookies
    res.cookie('access_token', data.access_token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   data.expires_in * 1000
    });
    if (data.refresh_token) {
      res.cookie('refresh_token', data.refresh_token, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        maxAge:   30 * 24 * 60 * 60 * 1000  // 30 days
      });
    }

    res.redirect('/#' + querystring.stringify({ success: 'logged_in' }));
  } catch (err) {
    console.error('Error during token exchange:', err);
    res.redirect('/#' + querystring.stringify({ error: 'server_error' }));
  }
});

// —————————————————————————————
// Token refresh
// —————————————————————————————

app.post('/api/refresh_token', async (req, res) => {
  const refresh_token = req.cookies.refresh_token;
  if (!refresh_token) {
    return res.status(401).json({ error: 'No refresh token available' });
  }

  const opts = {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' +
        Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
    },
    body: querystring.stringify({
      grant_type:    'refresh_token',
      refresh_token
    })
  };

  try {
    const r = await fetch('https://accounts.spotify.com/api/token', opts);
    const d = await r.json();
    if (!r.ok) {
      return res.status(401).json({ error: 'Failed to refresh token' });
    }
    res.cookie('access_token', d.access_token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   d.expires_in * 1000
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error refreshing token:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// —————————————————————————————
// Auth status & logout
// —————————————————————————————

app.get('/api/auth-status', (req, res) => {
  res.json({ authenticated: !!req.cookies.access_token });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
  res.json({ success: true });
});

// —————————————————————————————
// Spotify API helpers
// —————————————————————————————

async function getSpotifyTrackInfo(trackId, accessToken) {
  try {
    const resp = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return {
      id:           json.id,
      name:         json.name,
      artists:      json.artists.map(a => a.name),
      album:        json.album.name,
      release_date: json.album.release_date,
      external_urls: json.external_urls,
      preview_url:  json.preview_url,
      explicit:     json.explicit,      // now a boolean
      popularity:   json.popularity
    };
  } catch (err) {
    console.error('Error fetching track info:', err);
    return null;
  }
}

// —————————————————————————————
// Main analyze endpoint
// —————————————————————————————

app.post('/api/analyze', async (req, res) => {
  const { input, mode } = req.body;
  const access_token    = req.cookies.access_token;

  if (!access_token) {
    return res.status(401).json({ success: false, error: 'Not authenticated with Spotify' });
  }

  try {
    let trackId, spotifyTrackInfo;

    if (mode === 'current') {
      const r = await fetch(
        'https://api.spotify.com/v1/me/player/currently-playing',
        { headers: { 'Authorization': 'Bearer ' + access_token } }
      );

      if (r.status === 204) {
        return res.json({ success: false, error: 'No track currently playing' });
      }
      if (!r.ok) {
        return res.status(r.status).json({ success: false, error: 'Failed to get currently playing track' });
      }

      const json = await r.json();
      if (!json.item || json.item.type !== 'track') {
        return res.json({ success: false, error: 'Currently playing item is not a track' });
      }

      trackId = json.item.id;
      spotifyTrackInfo = {
        id:      json.item.id,
        name:    json.item.name,
        artists: json.item.artists.map(a => a.name),
        album:   json.item.album.name
      };

    } else {
      if (!input) {
        return res.status(400).json({ success: false, error: 'Spotify link or track ID is required' });
      }
      trackId = extractSpotifyTrackId(input);
      if (!trackId) {
        return res.status(400).json({ success: false, error: 'Invalid Spotify link or track ID' });
      }
      spotifyTrackInfo = await getSpotifyTrackInfo(trackId, access_token);
      if (!spotifyTrackInfo) {
        return res.status(404).json({ success: false, error: 'Track not found on Spotify' });
      }
    }

    const artistName = spotifyTrackInfo.artists.join(' ');
    const songName   = spotifyTrackInfo.name;
    const tunebatRes = await scrapeTunebatData(artistName, songName, trackId);

    res.json({
      success:  tunebatRes.success,
      spotify:  spotifyTrackInfo,
      tunebat:  tunebatRes.data,
      tunebatUrl: tunebatRes.url,
      error:    tunebatRes.error
    });
  } catch (err) {
    console.error('Error in analyze endpoint:', err);
    res.status(500).json({ success: false, error: 'Internal server error', details: err.message });
  }
});

// —————————————————————————————
// Playlist management
// —————————————————————————————

async function getUserPlaylists(userId, accessToken, forceRefresh = false) {
  log('Playlists', 'Fetching user playlists', { userId, forceRefresh });
  
  const userCache = userPlaylists.get(userId);
  const now = Date.now();

  if (!forceRefresh && userCache && (now - userCache.timestamp < playlistRefreshInterval)) {
    log('Playlists', 'Using cached playlists', { userId, playlistCount: userCache.playlists.length });
    return userCache.playlists;
  }

  const playlists = [];
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50';

  while (url) {
    const response = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + accessToken }
    });
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`Failed to fetch playlists: ${data.error?.message || 'Unknown error'}`);
    }

    playlists.push(...data.items);
    url = data.next;
  }

  userPlaylists.set(userId, {
    timestamp: now,
    playlists: playlists
  });

  return playlists;
}

async function getOrCreatePlaylist(userId, accessToken, name) {
  log('Playlists', 'Getting or creating playlist', { userId, name });
  
  if (name.length > 100) {
    name = name.substring(0, 97) + '...';
  }

  try {
    let playlists = await getUserPlaylists(userId, accessToken);
    let existing = playlists.find(p => p.name === name);

    if (!existing) {
      log('Playlists', 'Playlist not found, refreshing cache', { name });
      playlists = await getUserPlaylists(userId, accessToken, true);
      existing = playlists.find(p => p.name === name);
    }

    if (existing) {
      log('Playlists', 'Found existing playlist', { name, id: existing.id });
      return existing.id;
    }

    log('Playlists', 'Creating new playlist', { name });
    const create = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        public: false,
        description: 'Created by Song Data Analyzer'
      })
    });
    
    if (!create.ok) {
      throw new Error('Failed to create playlist');
    }

    const newPlaylist = await create.json();
    
    // Update cache with new playlist
    playlists.push(newPlaylist);
    userPlaylists.set(userId, {
      timestamp: Date.now(),
      playlists: playlists
    });

    return newPlaylist.id;
  } catch (err) {
    log('Playlists', 'Error in getOrCreatePlaylist', { error: err.message, name });
    throw err;
  }
}

async function addTrackToPlaylist(playlistId, trackId, accessToken) {
  log('Playlists', 'Adding track to playlist', { playlistId, trackId });
  
  const response = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      uris: [`spotify:track:${trackId}`]
    })
  });

  if (!response.ok) {
    const error = await response.json();
    log('Playlists', 'Error adding track', { playlistId, trackId, error });
    throw new Error(`Failed to add track: ${error.error?.message || 'Unknown error'}`);
  }

  log('Playlists', 'Successfully added track', { playlistId, trackId });
  return response.json();
}

app.post('/api/add-to-playlist', async (req, res) => {
  const { playlistName, trackId } = req.body;
  const access_token = req.cookies.access_token;

  if (!access_token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const userResponse = await fetch('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': 'Bearer ' + access_token }
    });

    if (!userResponse.ok) {
      throw new Error('Failed to get user information');
    }

    const userData = await userResponse.json();
    const playlistId = await getOrCreatePlaylist(userData.id, access_token, playlistName);
    await addTrackToPlaylist(playlistId, trackId, access_token);

    res.json({ success: true, playlistId });
  } catch (err) {
    console.error('Error adding to playlist:', err);
    res.status(500).json({ error: err.message || 'Failed to add to playlist' });
  }
});

// —————————————————————————————
// Health check
// —————————————————————————————

app.get('/api/health', (req, res) => {
  res.json({
    status:            'OK',
    timestamp:         new Date().toISOString(),
    spotify_configured: !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET)
  });
});

// Currently playing endpoint
app.get('/api/currently-playing', async (req, res) => {
  const access_token = req.cookies.access_token;
  if (!access_token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': 'Bearer ' + access_token }
    });

    if (response.status === 204) {
      return res.json({ playing: false, message: 'No track currently playing' });
    }

    if (!response.ok) {
      return res.status(response.status).json({ 
        playing: false, 
        error: 'Failed to get currently playing track' 
      });
    }

    const data = await response.json();
    if (!data.item || data.item.type !== 'track') {
      return res.json({ 
        playing: false, 
        message: 'Currently playing item is not a track' 
      });
    }

    res.json({
      playing: true,
      track: {
        id: data.item.id,
        name: data.item.name,
        artists: data.item.artists.map(a => a.name),
        album: data.item.album.name
      }
    });
  } catch (err) {
    console.error('Error getting currently playing:', err);
    res.status(500).json({ 
      playing: false, 
      error: 'Server error' 
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT}`);
  console.log(`Spotify redirect URI: ${SPOTIFY_REDIRECT_URI}`);

  if (SPOTIFY_CLIENT_ID === 'your_spotify_client_id') {
    console.warn('⚠️  WARNING: set SPOTIFY_CLIENT_ID & SPOTIFY_CLIENT_SECRET in your env!');
  }
});
