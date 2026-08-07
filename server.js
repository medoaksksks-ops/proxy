const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const NodeCache = require('node-cache');
const https = require('https');
require('dotenv').config();

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Firebase config
const FIREBASE_URL = process.env.FIREBASE_URL || 'https://english-73376-default-rtdb.firebaseio.com';
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';

// CORS config
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: false
}));

app.use(express.json());
app.use(express.text({ limit: '10mb' }));

// ---------------- Cache ----------------
const infoCache = new NodeCache({ stdTTL: 7200 });          // معلومات فيديو/بحث/related: ساعتين
const trendingCache = new NodeCache({ stdTTL: 1200 });      // الرائج: 20 دقيقة
const streamCache = new NodeCache({ stdTTL: 240 });         // روابط التشغيل المباشرة بتنتهي بسرعة: 4 دقايق بس

const TIMEOUT = 60000;
const MAX_RETRIES = 3;

// Logger
const log = {
  info: (msg) => console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`),
  success: (msg) => console.log(`[${new Date().toISOString()}] ✅ ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ❌ ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`)
};

// ==========================================================================
// Concurrency limiter — بيمنع الـ Railway instance من إنه يتحمّل أكتر من طاقته
// (كل عملية yt-dlp بتاخد وقت وذاكرة، فمينفعش نسيب عدد لا نهائي يشتغلوا مع بعض)
// ==========================================================================
class Semaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  acquire() {
    if (this.current < this.max) { this.current++; return Promise.resolve(); }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    this.current--;
    const next = this.queue.shift();
    if (next) { this.current++; next(); }
  }
}
const YTDLP_CONCURRENCY = parseInt(process.env.YTDLP_CONCURRENCY, 10) || 4;
const ytdlpLimiter = new Semaphore(YTDLP_CONCURRENCY);

// ==========================================================================
// كوكيز يوتيوب — بيتحدّثوا في الخلفية كل 5 دقايق بدل ما كل request يعمل طلب
// لـ Firebase لوحده (كان بيسبب race condition وبطء ومكالمات مكررة كتير)
// ==========================================================================
const COOKIES_PATH = '/tmp/.cookies.txt';
let cookiesReady = false;

function fetchCookiesFromFirebase() {
  return new Promise((resolve) => {
    const url = FIREBASE_SECRET
      ? `${FIREBASE_URL}/youtube_cookies.json?auth=${FIREBASE_SECRET}`
      : `${FIREBASE_URL}/youtube_cookies.json`;

    https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed && parsed.value ? parsed.value : '');
        } catch (e) {
          log.error(`Firebase JSON parse error: ${e.message}`);
          resolve('');
        }
      });
    }).on('error', (err) => {
      log.error(`🔥 Firebase connection error: ${err.message}`);
      resolve('');
    }).on('timeout', function () { this.destroy(); resolve(''); });
  });
}

let lastCookiesContent = '';
async function refreshCookies() {
  try {
    const content = await fetchCookiesFromFirebase();
    if (content && content.trim() && content !== lastCookiesContent) {
      fs.writeFileSync(COOKIES_PATH, content);
      lastCookiesContent = content;
      cookiesReady = true;
      log.success(`🍪 Cookies refreshed (${content.length} bytes)`);
    } else if (!content) {
      log.warn('⚠️  No cookies available in Firebase yet');
    }
  } catch (e) {
    log.error(`Cookie refresh failed: ${e.message}`);
  }
}
refreshCookies();
setInterval(refreshCookies, 5 * 60 * 1000);

// Check if yt-dlp is installed
function checkYtDlp() {
  try {
    require('child_process').execSync('yt-dlp --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Validation
function isValidVideoId(id) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function sanitizeFilename(name) {
  return name.replace(/[^\w\s-]/g, '').substring(0, 100) || 'video';
}

/**
 * تشغيل yt-dlp بشكل غير متزامن (async) بدون shell — بيستقبل الـ args كمصفوفة
 * عشان محدّش يقدر يحقن أوامر شل حتى لو query البحث فيه رموز غريبة، وكمان
 * بيدي كل request مكانه في الطابور (semaphore) بدل ما يبوّظ السيرفر كله.
 */
async function runYtDlp(args, { timeout = TIMEOUT, maxBuffer = 1024 * 1024 * 10 } = {}) {
  await ytdlpLimiter.acquire();
  try {
    const finalArgs = cookiesReady ? ['--cookies', COOKIES_PATH, ...args] : args;
    const { stdout } = await execFileAsync('yt-dlp', ['--no-warnings', ...finalArgs], {
      timeout,
      maxBuffer,
      encoding: 'utf-8'
    });
    return stdout;
  } finally {
    ytdlpLimiter.release();
  }
}

/** بيحوّل ناتج --dump-json (سطر لكل فيديو) لمصفوفة عناصر موحّدة الشكل */
function parseFlatItems(raw, excludeId) {
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      let item;
      try { item = JSON.parse(line); } catch (e) { return null; }
      if (!item || !item.id) return null;
      return {
        id: item.id,
        title: item.title || 'بدون عنوان',
        author: item.uploader || item.channel || 'Unknown',
        channelId: item.channel_id || '',
        duration: item.duration || 0,
        thumbnail: item.thumbnails?.length
          ? item.thumbnails[item.thumbnails.length - 1].url
          : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
        viewCount: item.view_count || 0
      };
    })
    .filter(v => v && v.id !== excludeId);
}

/**
 * الحصول على معلومات الفيديو الكاملة
 */
async function getVideoInfo(videoId) {
  const stdout = await runYtDlp(['--dump-json', `https://www.youtube.com/watch?v=${videoId}`]);
  return JSON.parse(stdout);
}

/**
 * جلب رابط الفيديو المباشر
 */
async function getVideoStreamUrl(videoId, format = 'best') {
  const stdout = await runYtDlp(['--get-url', '-f', format, `https://www.youtube.com/watch?v=${videoId}`]);
  const streamUrl = stdout.trim().split('\n')[0];
  log.success(`🎬 Got stream URL (${streamUrl.length} chars)`);
  return streamUrl;
}

/**
 * البحث عن فيديوهات على يوتيوب باستخدام yt-dlp (بدون أي اعتماد على YouTube Data API)
 */
async function searchVideos(query, limit = 10) {
  log.info(`🔎 Searching: "${query}" (limit ${limit})`);
  const stdout = await runYtDlp([`ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist']);
  return parseFlatItems(stdout);
}

/**
 * جلب الفيديوهات المقترحة/ذات الصلة (related) لفيديو معين
 * بيستخدم playlist المكسات التلقائية اللي يوتيوب بيولدها (RD + videoId)
 */
async function getRelatedVideos(videoId, limit = 10) {
  const url = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
  log.info(`🧭 Fetching related videos for: ${videoId}`);

  let items = [];
  try {
    const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--yes-playlist', '--playlist-end', String(limit + 1), url]);
    items = parseFlatItems(stdout, videoId);
  } catch (e) {
    log.warn(`Flat related fetch failed: ${e.message}`);
  }

  if (items.length === 0) {
    log.warn('⚠️  Flat related empty, retrying with full extraction...');
    const stdout = await runYtDlp(['--dump-json', '--yes-playlist', '--playlist-end', String(limit + 1), '--skip-download', url]);
    items = parseFlatItems(stdout, videoId);
  }

  return items.slice(0, limit);
}

/**
 * جلب الفيديوهات الرائجة (Trending) — بدل اعتماد على chart=mostPopular بتاع
 * YouTube Data API، بنجيب تبويب "الرائج" مباشرة من يوتيوب عن طريق yt-dlp.
 * لو ده فشل لأي سبب (يوتيوب بيغيّر شكل الصفحة أحيانًا)، بنعمل fallback:
 * بحث في عدة موضوعات مصرية شائعة وترتيب النتائج حسب المشاهدات.
 */
async function getTrendingVideos(region = 'EG', limit = 20) {
  let items = [];

  try {
    const url = `https://www.youtube.com/feed/trending?gl=${encodeURIComponent(region)}`;
    const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(limit), url]);
    items = parseFlatItems(stdout);
  } catch (e) {
    log.warn(`Trending feed failed (${e.message}), falling back to search-based trending`);
  }

  if (items.length < 5) {
    const fallbackQueries = ['أخبار مصر اليوم', 'أغاني مصرية جديدة', 'كوميدي مصري', 'رياضة مصر أهداف', 'بودكاست مصري'];
    const pool = [];
    for (const q of fallbackQueries) {
      try {
        const stdout = await runYtDlp([`ytsearch10:${q}`, '--dump-json', '--flat-playlist']);
        pool.push(...parseFlatItems(stdout));
      } catch (e) {
        log.warn(`Trending fallback query failed "${q}": ${e.message}`);
      }
    }
    // شيل التكرار، ورتّب حسب المشاهدات تنازليًا
    const seen = new Set();
    items = pool
      .filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; })
      .sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
  }

  return items.slice(0, limit);
}

// ==========================================================================
// Routes
// ==========================================================================

/**
 * GET /trending?region=EG&limit=20
 */
app.get('/trending', async (req, res) => {
  const region = (req.query.region || 'EG').toUpperCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 40);
  const cacheKey = `trending_${region}_${limit}`;

  const cached = trendingCache.get(cacheKey);
  if (cached) {
    log.info(`📦 Trending from cache: ${region}`);
    return res.json(cached);
  }

  try {
    const results = await getTrendingVideos(region, limit);
    const response = { region, count: results.length, results };
    trendingCache.set(cacheKey, response);
    log.success(`✅ Trending done: ${region} (${results.length} نتيجة)`);
    res.json(response);
  } catch (error) {
    log.error(`Error fetching trending: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الفيديوهات الرائجة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /search?q=QUERY&limit=10
 */
app.get('/search', async (req, res) => {
  const { q: query, limit = 10 } = req.query;

  if (!query || !query.trim()) {
    return res.status(400).json({
      error: 'كلمة البحث مطلوبة',
      example: '/search?q=funny+cats&limit=10'
    });
  }

  const searchLimit = Math.min(parseInt(limit, 10) || 10, 30);
  const cacheKey = `search_${query}_${searchLimit}`;
  const cached = infoCache.get(cacheKey);

  if (cached) {
    log.info(`📦 Search from cache: "${query}"`);
    return res.json(cached);
  }

  try {
    const results = await searchVideos(query, searchLimit);
    const response = { query, count: results.length, results };

    infoCache.set(cacheKey, response);
    log.success(`✅ Search done: "${query}" (${results.length} نتيجة)`);

    res.json(response);
  } catch (error) {
    log.error(`Error searching: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر تنفيذ البحث',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /related?v=VIDEO_ID&limit=10
 */
app.get('/related', async (req, res) => {
  const { v: videoId, limit = 10 } = req.query;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({
      error: 'Video ID مطلوب وصحيح (11 حرف)',
      example: '/related?v=dQw4w9WgXcQ&limit=10'
    });
  }

  const relatedLimit = Math.min(parseInt(limit, 10) || 10, 30);
  const cacheKey = `related_${videoId}_${relatedLimit}`;
  const cached = infoCache.get(cacheKey);

  if (cached) {
    log.info(`📦 Related from cache: ${videoId}`);
    return res.json(cached);
  }

  try {
    const results = await getRelatedVideos(videoId, relatedLimit);
    const response = { id: videoId, count: results.length, results };

    infoCache.set(cacheKey, response);
    log.success(`✅ Related done: ${videoId} (${results.length} نتيجة)`);

    res.json(response);
  } catch (error) {
    log.error(`Error fetching related: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الفيديوهات المقترحة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /video?v=VIDEO_ID
 */
app.get('/video', async (req, res) => {
  const { v: videoId, format = 'best[height<=720]' } = req.query;

  if (!videoId || !isValidVideoId(videoId)) {
    log.error(`Invalid video ID: ${videoId}`);
    return res.status(400).json({
      error: 'Video ID مطلوب وصحيح (11 حرف)',
      example: '/video?v=dQw4w9WgXcQ&format=best[height<=720]'
    });
  }

  const cacheKey = `stream_${videoId}_${format}`;
  const cachedUrl = streamCache.get(cacheKey);

  if (cachedUrl) {
    log.info(`📦 Stream from cache: ${videoId}`);
    return res.redirect(cachedUrl);
  }

  let attempts = 0;
  let lastError = null;

  while (attempts < MAX_RETRIES) {
    try {
      log.info(`🎬 Fetching video: ${videoId} (attempt ${attempts + 1}/${MAX_RETRIES})`);

      const [info, streamUrl] = await Promise.all([
        getVideoInfo(videoId),
        getVideoStreamUrl(videoId, format)
      ]);

      if (!streamUrl) {
        throw new Error('Failed to get stream URL');
      }

      streamCache.set(cacheKey, streamUrl);

      const title = sanitizeFilename(info.title || 'video');
      log.success(`▶️  Playing: ${info.title}`);

      res.setHeader('Content-Disposition', `inline; filename="${title}.mp4"`);
      res.redirect(streamUrl);
      return;

    } catch (error) {
      lastError = error;
      attempts++;
      log.warn(`Attempt ${attempts} failed: ${error.message}`);

      if (attempts < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * attempts));
      }
    }
  }

  log.error(`Failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);

  if (lastError?.message.includes('unavailable') || lastError?.message.includes('not available')) {
    return res.status(404).json({ error: 'الفيديو غير متاح أو محذوف' });
  } else if (lastError?.message.includes('private')) {
    return res.status(403).json({ error: 'الفيديو خاص (private)' });
  } else if (lastError?.message.includes('age')) {
    return res.status(403).json({ error: 'الفيديو يحتاج verification العمر' });
  }

  res.status(500).json({
    error: 'فشل في تشغيل الفيديو',
    details: NODE_ENV === 'development' ? lastError?.message : undefined
  });
});

/**
 * GET /info?v=VIDEO_ID
 */
app.get('/info', async (req, res) => {
  const videoId = req.query.v;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }

  const cached = infoCache.get(`info_${videoId}`);
  if (cached) {
    log.info(`📋 Info from cache: ${videoId}`);
    return res.json(cached);
  }

  try {
    log.info(`📥 Fetching info: ${videoId}`);
    const info = await getVideoInfo(videoId);

    const result = {
      id: videoId,
      title: info.title,
      duration: info.duration || 0,
      author: info.uploader || info.channel || 'Unknown',
      channelId: info.channel_id || '',
      description: info.description || '',
      thumbnail: info.thumbnail || '',
      publishedAt: info.upload_date ? new Date(
        `${info.upload_date.slice(0,4)}-${info.upload_date.slice(4,6)}-${info.upload_date.slice(6,8)}`
      ).toISOString() : null,
      viewCount: info.view_count || 0,
      likeCount: info.like_count || 0,
      ageRestricted: info.age_limit ? info.age_limit > 0 : false,
      isLive: info.is_live || false,
      formats: info.formats?.length || 0
    };

    infoCache.set(`info_${videoId}`, result);
    log.success(`✅ Got info: ${info.title}`);

    res.json(result);

  } catch (error) {
    log.error(`Error fetching info: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب معلومات الفيديو',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /formats?v=VIDEO_ID
 */
app.get('/formats', async (req, res) => {
  const videoId = req.query.v;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }

  try {
    log.info(`📊 Fetching formats: ${videoId}`);
    const info = await getVideoInfo(videoId);

    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
      .map(f => ({
        formatId: f.format_id,
        format: f.format,
        videoCodec: f.vcodec,
        audioCodec: f.acodec,
        height: f.height,
        width: f.width,
        fps: f.fps,
        fileSize: f.filesize || 'unknown'
      }))
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    res.json({
      id: videoId,
      title: info.title,
      formats: formats.slice(0, 20)
    });

  } catch (error) {
    log.error(`Error fetching formats: ${error.message}`);
    res.status(500).json({ error: 'تعذّر جلب الـ formats' });
  }
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'operational',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlpReady: checkYtDlp(),
    cookiesReady,
    concurrency: { max: YTDLP_CONCURRENCY, current: ytdlpLimiter.current, queued: ytdlpLimiter.queue.length }
  });
});

/**
 * POST /api/update-cookies
 */
app.post('/api/update-cookies', async (req, res) => {
  try {
    const cookies = req.body;

    if (!cookies || !cookies.trim()) {
      log.error('Empty cookies received');
      return res.status(400).json({ error: 'الكوكيز فارغة' });
    }

    log.info(`📝 Updating cookies (${cookies.length} bytes)...`);

    const url = `${FIREBASE_URL}/youtube_cookies.json`;
    const auth = FIREBASE_SECRET ? `?auth=${FIREBASE_SECRET}` : '';
    const fullUrl = url + auth;

    const payloadData = JSON.stringify({
      value: cookies,
      updated_at: new Date().toISOString()
    });

    const options = {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadData)
      }
    };

    const req_firebase = https.request(fullUrl, options, (res_fb) => {
      let response = '';

      res_fb.on('data', chunk => response += chunk);

      res_fb.on('end', async () => {
        if (res_fb.statusCode === 200) {
          await refreshCookies(); // حدّث الكوكيز فورًا بدل ما نستنى الـ interval
          log.success('✅ Cookies updated in Firebase');
          res.json({
            success: true,
            message: 'تم تحديث الكوكيز ✅',
            timestamp: new Date().toISOString(),
            size: cookies.length
          });
        } else {
          log.error(`Firebase returned ${res_fb.statusCode}: ${response}`);
          res.status(500).json({
            error: 'فشل في تحديث الكوكيز',
            details: response
          });
        }
      });
    });

    req_firebase.on('error', (err) => {
      log.error(`Firebase update error: ${err.message}`);
      res.status(500).json({
        error: 'فشل الاتصال بـ Firebase',
        details: err.message
      });
    });

    req_firebase.end(payloadData);

  } catch (error) {
    log.error(`Post error: ${error.message}`);
    res.status(500).json({
      error: 'خطأ في السيرفر',
      details: error.message
    });
  }
});

/**
 * GET /api/cookies-status
 */
app.get('/api/cookies-status', async (req, res) => {
  res.json({
    hasCoockes: cookiesReady,
    length: lastCookiesContent.length,
    preview: lastCookiesContent ? lastCookiesContent.substring(0, 50) + '...' : 'لا توجد كوكيز',
    status: cookiesReady ? '✅ موجودة' : '❌ فارغة أو غير موجودة'
  });
});

/**
 * GET /
 */
app.get('/', (req, res) => {
  res.json({
    name: '🎬 srver v3.0 - YouTube Proxy (بدون اعتماد على YouTube Data API)',
    version: '3.0.0',
    environment: NODE_ENV,
    cookies: {
      source: '🔥 Firebase Realtime Database',
      url: FIREBASE_URL,
      refresh: 'كل 5 دقايق في الخلفية',
      ready: cookiesReady
    },
    concurrency: { max: YTDLP_CONCURRENCY },
    endpoints: {
      trending: '/trending?region=EG&limit=20',
      video: '/video?v=VIDEO_ID&format=best[height<=720]',
      info: '/info?v=VIDEO_ID',
      formats: '/formats?v=VIDEO_ID',
      search: '/search?q=QUERY&limit=10',
      related: '/related?v=VIDEO_ID&limit=10',
      health: '/health',
      cookiesStatus: '/api/cookies-status'
    },
    examples: {
      'Trending': '/trending?region=EG',
      'Play video': '/video?v=dQw4w9WgXcQ',
      'Search videos': '/search?q=funny+cats',
      'Related videos': '/related?v=dQw4w9WgXcQ',
      'Check cookies': '/api/cookies-status'
    }
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint غير موجود', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  log.error(`Unhandled error: ${err.message}`);
  res.status(500).json({
    error: 'خطأ في السيرفر',
    details: NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  const ytdlpStatus = checkYtDlp() ? '✅' : '❌';
  console.log(`
╔═══════════════════════════════════════════╗
║  🎬 srver v3.0 - YouTube Proxy شغّال 🔥    ║
║  ═════════════════════════════════════     ║
║  Environment: ${NODE_ENV.padEnd(26, ' ')}║
║  yt-dlp: ${ytdlpStatus}  Firebase Cookies (bg refresh)  ║
║  Concurrency: ${String(YTDLP_CONCURRENCY).padEnd(24, ' ')}║
║  http://0.0.0.0:${PORT}                        ║
╚═══════════════════════════════════════════╝
  `);
  log.success(`✅ Server ready - no YouTube Data API dependency`);
  log.info(`📍 Firebase: ${FIREBASE_URL}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log.warn('Shutting down...');
  server.close(() => {
    log.success('Server stopped');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  log.warn('Terminating...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled Rejection: ${reason}`);
});
