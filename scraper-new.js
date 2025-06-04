const puppeteer = require('puppeteer');
const { exec } = require("node:child_process")
const { promisify } = require("node:util")

async function scrapeTunebatData(artistName, songName, spotifyTrackId) {
  const { stdout: chromiumPath } = await promisify(exec)("which chromium");
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chromiumPath.trim(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--enable-javascript',
      '--disable-blink-features=AutomationControlled'  // Hide automation
    ],
    ignoreHTTPSErrors: true
  });

  try {
    const page = await browser.newPage();
    
    // Set a more realistic browser environment
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36'
    );
    
    // Set headers to look more like a real browser
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });

    // Override the navigator.webdriver property to avoid detection
    await page.evaluateOnNewDocument(() => {
      delete Object.getPrototypeOf(navigator).webdriver;
      window.chrome = { runtime: {} };
      window.navigator.chrome = { runtime: {} };
      
      // Add more browser-like properties
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
      
      // Pass webdriver checks
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    // Format the URL segments
    const fmt = text => text
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');

    const url = `https://tunebat.com/Info/${fmt(songName)}-${fmt(artistName)}/${spotifyTrackId}`;
    console.log(`[Scraper] Navigating to ${url}`);

    // Navigate with retries
    let retries = 3;
    let pageData = null;

    while (retries > 0) {
      try {
        await page.goto(url, {
          waitUntil: 'networkidle0',
          timeout: 30000
        });

        // Add random delays between actions to appear more human-like
                                  await new Promise(resolve => setTimeout(resolve, 3956 + Math.random() * 1487));
        
        // Check if we hit a security check or error page
        const content = await page.content();
        if (content.includes('security check') || content.includes('Too Many Requests')) {
          console.log('[Scraper] Hit security check, retrying...');
          await new Promise(resolve => setTimeout(resolve, 4000 + Math.random() * 2000));
          retries--;
          continue;
        }

        // Save debug screenshot
        await page.screenshot({ path: 'debug.png' });

        // Extract data with more specific selectors
        pageData = await page.evaluate(() => {
          const data = {
            title: '',
            artist: '',
            album: '',
            key: '',
            camelot: '',
            bpm: '',
            duration: '',
            releaseDate: '',
            explicit: false,
            popularity: '',
            energy: '',
            danceability: '',
            happiness: '',
            acousticness: '',
            instrumentalness: '',
            liveness: '',
            speechiness: '',
            loudness: '',
            albumArt: ''
          };

          // Helper: Try multiple selectors
          const getElement = (selectors) => {
            for (const selector of (Array.isArray(selectors) ? selectors : [selectors])) {
              const element = document.querySelector(selector);
              if (element) return element;
            }
            return null;
          };

          // Helper: Get text content safely
          const getText = (selectors) => {
            const element = getElement(selectors);
            return element ? element.textContent.trim() : '';
          };

          // Helper: Find text with pattern
          const findText = (pattern) => {
            const text = document.body.textContent || '';
            const match = text.match(pattern);
            return match ? match[1].trim() : '';
          };

          // Try to get key metadata first
          const metaResults = [
            ['title', ['h1', '[class*="title"]', '[class*="name"]']],
            ['artist', ['.artist-name', '[class*="artist"]', '[class*="performer"]']],
            ['album', ['.album-name', '[class*="album"]']]
          ].map(([key, selectors]) => {
            data[key] = getText(selectors);
            return !!data[key];
          });

          // If we couldn't find basic metadata, page probably didn't load properly
          if (!metaResults.some(r => r)) {
            return null;
          }

          // Find album art
          const albumArt = getElement('img[alt*="album"], img[alt*="Album"], img[src*="album"]');
          data.albumArt = albumArt ? albumArt.src : '';

          // Musical attributes with different possible formats
          [
            ['key', /Key:\s*([A-G][♯♭]?\s*(?:Major|Minor|maj|min))/i, /([A-G][♯♭]?\s*(?:Major|Minor|maj|min))/i],
            ['camelot', /Camelot:\s*(\d+[AB])/i, /(\d+[AB])/],
            ['bpm', /BPM:\s*(\d+)/i, /Tempo:\s*(\d+)/i, /(\d+)\s*BPM/i],
            ['duration', /Duration:\s*(\d+:\d+)/i],            ['releaseDate', /Release Date:\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i],
            ['popularity', /(\d+)\s*(?:\/\s*\d+)?\s*Popularity/i],
            ['energy', /(\d+)\s*(?:\/\s*\d+)?\s*Energy/i],
            ['danceability', /(\d+)\s*(?:\/\s*\d+)?\s*Danceability/i],
            ['happiness', /(\d+)\s*(?:\/\s*\d+)?\s*Happiness/i],
            ['acousticness', /(\d+)\s*(?:\/\s*\d+)?\s*Acousticness/i],
            ['instrumentalness', /(\d+)\s*(?:\/\s*\d+)?\s*Instrumentalness/i],
            ['liveness', /(\d+)\s*(?:\/\s*\d+)?\s*Liveness/i],
            ['speechiness', /(\d+)\s*(?:\/\s*\d+)?\s*Speechiness/i],
            ['loudness', /([-]?\d+(?:\.\d+)?)\s*(?:dB)?\s*Loudness/i]
          ].forEach(([key, ...patterns]) => {
            for (const pattern of patterns) {
              const value = findText(pattern);
              if (value) {
                data[key] = value;
                break;
              }
            }
          });          // Look for explicit tag
          data.explicit = /Explicit:\s*Yes/i.test(document.body.textContent);

          // Extract recommended tracks
          const recommendations = [];
          const recommendedTracks = document.querySelectorAll('.ant-row.pDoqI');
          recommendedTracks.forEach(track => {
            try {
              const title = track.querySelector('.aZDDf')?.textContent?.trim() || '';
              const artist = track.querySelector('._2zAVA')?.textContent?.trim() || '';
              const spotifyLink = track.querySelector('.NWuk-[href*="spotify.com"]')?.href || '';
              const trackId = spotifyLink.split('/').pop();
              const key = track.querySelector('.lAjUd')?.textContent?.trim() || '';
              const bpm = track.querySelectorAll('.lAjUd')[1]?.textContent?.trim() || '';
              const camelot = track.querySelectorAll('.lAjUd')[2]?.textContent?.trim() || '';
              const popularity = track.querySelectorAll('.lAjUd')[3]?.textContent?.trim() || '';
              const albumArt = track.querySelector('img')?.src || '';

              if (trackId) {
                recommendations.push({
                  title,
                  artist,
                  spotifyId: trackId,
                  key,
                  bpm,
                  camelot,
                  popularity,
                  albumArt
                });
              }
            } catch (e) {
              console.error('Error parsing recommendation:', e);
            }
          });

          data.recommendations = recommendations;

          return data;
        });

        if (pageData) {
          console.log('[Scraper] Successfully extracted data');
          break;
        }

        console.log('[Scraper] No data found, retrying...');
        retries--;
                                  await new Promise(resolve => setTimeout(resolve, 2500 + Math.random() * 1000))

      } catch (err) {
        console.log('[Scraper] Error:', err.message);
        retries--;
        if (retries > 0) {
                                    await new Promise(resolve => setTimeout(resolve, 4500 + Math.random() * 1500));
        }
      }
    }

    return {
      success: !!pageData,
      url,
      data: pageData || {},
      error: !pageData ? 'Failed to extract data' : undefined,
      debugImagePath: 'debug.png'
    };

  } catch (err) {
    console.error('[Scraper] Fatal error:', err);
    return {
      success: false,
      error: err.message,
      debugImagePath: 'debug.png'
    };
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeTunebatData };
