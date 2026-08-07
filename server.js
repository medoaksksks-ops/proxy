const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const NodeCache = require('node-cache');
const https = require('https');
require('dotenv').config();

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
app.use(express.text({ limit: '10mb' })); // ← اضيفنا الـ text parser

// Cache
const infoCache = new NodeCache({ stdTTL: 7200 });
const streamCache = new NodeCache({ stdTTL: 1800 });
const cookiesCache = new NodeCache({ stdTTL: 300 }); // 5 دقائق

const TIMEOUT = 60000;
const MAX_RETRIES = 3;
const CHUNK_SIZE = 1024 * 1024;

// Logger
const log = {
  info: (msg) => console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`),
  success: (msg) => console.log(`[${new Date().toISOString()}] ✅ ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ❌ ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`)
};

/**
 * جلب الكوكيز من Firebase
 */
async function getCookiesFromFirebase() {
  return new Promise((resolve, reject) => {
    // تحقق من الـ cache أولاً
    const cached = cookiesCache.get('youtube_cookies');
    if (cached) {
      log.info('📦 Cookies from cache (5 min)');
      resolve(cached);
      return;
    }

    const url = FIREBASE_SECRET 
      ? `${FIREBASE_URL}/youtube_cookies.json?auth=${FIREBASE_SECRET}`
      : `${FIREBASE_URL}/youtube_cookies.json`;

    log.info('🌐 Fetching cookies from Firebase...');

    https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      
      res.on('data', chunk => data += chunk);
      
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          
          if (parsed && parsed.value && parsed.value.trim()) {
            cookiesCache.set('youtube_cookies', parsed.value);
            log.success(`✅ Loaded ${parsed.value.length} bytes from Firebase`);
            resolve(parsed.value);
          } else {
            log.warn('⚠️  Cookies empty or not found in Firebase');
            resolve('');
          }
        } catch (e) {
          log.error(`Firebase JSON parse error: ${e.message}`);
          resolve('');
        }
      });
    }).on('error', (err) => {
      log.error(`🔥 Firebase connection error: ${err.message}`);
      resolve('');
    });
  });
}

/**
 * كتابة الكوكيز في ملف مؤقت
 */
async function writeCookiesToFile(cookiesContent) {
  try {
    if (cookiesContent && cookiesContent.trim()) {
      fs.writeFileSync('/tmp/.cookies.txt', cookiesContent);
      return true;
    }
  } catch (error) {
    log.error(`Failed to write cookies: ${error.message}`);
  }
  return false;
}

// Check if yt-dlp is installed
function checkYtDlp() {
  try {
    execSync('yt-dlp --version', { stdio: 'ignore' });
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
 * الحصول على معلومات الفيديو باستخدام yt-dlp
 */
async function getVideoInfo(videoId) {
  return new Promise(async (resolve, reject) => {
    try {
      // جلب الكوكيز من Firebase
      const cookies = await getCookiesFromFirebase();
      
      // اكتب الكوكيز في ملف مؤقت
      if (cookies && cookies.trim()) {
        await writeCookiesToFile(cookies);
        log.info(`📝 Using cookies (${cookies.length} bytes)`);
      } else {
        log.warn('⚠️  No cookies available - trying without');
      }
      
      // بناء الأمر
      const cookiesFlag = fs.existsSync('/tmp/.cookies.txt') ? '--cookies /tmp/.cookies.txt' : '';
      const cmd = `yt-dlp --dump-json --no-warnings ${cookiesFlag} "https://www.youtube.com/watch?v=${videoId}"`;
      
      log.info(`🔍 Fetching info: ${videoId} ${cookiesFlag ? '(with cookies)' : '(no cookies)'}`);
      
      const result = execSync(cmd, { 
        timeout: TIMEOUT,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 10
      });
      resolve(JSON.parse(result));
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * جلب رابط الفيديو المباشر
 */
async function getVideoStreamUrl(videoId, format = 'best') {
  return new Promise(async (resolve, reject) => {
    try {
      // جلب الكوكيز من Firebase
      const cookies = await getCookiesFromFirebase();
      
      // اكتب الكوكيز في ملف مؤقت
      if (cookies && cookies.trim()) {
        await writeCookiesToFile(cookies);
      }
      
      // بناء الأمر
      const cookiesFlag = fs.existsSync('/tmp/.cookies.txt') ? '--cookies /tmp/.cookies.txt' : '';
      const cmd = `yt-dlp --get-url --no-warnings ${cookiesFlag} -f "${format}" "https://www.youtube.com/watch?v=${videoId}"`;
      
      log.info(`⬇️  Fetching stream URL: ${format} ${cookiesFlag ? '(with cookies)' : '(no cookies)'}`);
      
      const result = execSync(cmd, { 
        timeout: TIMEOUT,
        encoding: 'utf-8'
      });
      
      const streamUrl = result.trim().split('\n')[0];
      log.success(`🎬 Got stream URL (${streamUrl.length} chars)`);
      
      resolve(streamUrl);
    } catch (error) {
      reject(error);
    }
  });
}

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
  const cached = streamCache.get(cacheKey);

  if (cached?.url && Date.now() - cached.timestamp < 300000) {
    log.info(`📦 Stream from cache: ${videoId}`);
    return res.redirect(cached.url);
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

      streamCache.set(cacheKey, {
        url: streamUrl,
        timestamp: Date.now()
      });

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
      publishedAt: info.upload_date ? new Date(info.upload_date).toISOString() : null,
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
    ytdlpReady: checkYtDlp()
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
      
      res_fb.on('end', () => {
        if (res_fb.statusCode === 200) {
          cookiesCache.del('youtube_cookies'); // Clear cache
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
 * التحقق من حالة الكوكيز في Firebase
 */
app.get('/api/cookies-status', async (req, res) => {
  try {
    log.info('📊 Checking cookies status...');
    
    const url = FIREBASE_SECRET 
      ? `${FIREBASE_URL}/youtube_cookies.json?auth=${FIREBASE_SECRET}`
      : `${FIREBASE_URL}/youtube_cookies.json`;

    https.get(url, (res_fb) => {
      let data = '';
      res_fb.on('data', chunk => data += chunk);
      res_fb.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const hasCoockes = parsed && parsed.value && parsed.value.trim().length > 0;
          
          res.json({
            hasCoockes: hasCoockes,
            length: parsed && parsed.value ? parsed.value.length : 0,
            preview: parsed && parsed.value ? parsed.value.substring(0, 50) + '...' : 'لا توجد كوكيز',
            updated_at: parsed && parsed.updated_at ? parsed.updated_at : null,
            status: hasCoockes ? '✅ موجودة' : '❌ فارغة أو غير موجودة'
          });
          
          log.success(`✅ Cookies status: ${hasCoockes ? 'OK' : 'EMPTY'}`);
        } catch (e) {
          res.json({ 
            hasCoockes: false, 
            error: 'JSON parse error',
            status: '❌ خطأ في قراءة البيانات'
          });
        }
      });
    }).on('error', (err) => {
      log.error(`Firebase status check error: ${err.message}`);
      res.status(500).json({ 
        error: 'فشل الاتصال مع Firebase',
        hasCoockes: false,
        status: '❌ خطأ في الاتصال'
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /
 */
app.get('/', (req, res) => {
  res.json({
    name: '🎬 srver v2.2 - YouTube Proxy',
    version: '2.2.0',
    environment: NODE_ENV,
    cookies: {
      source: '🔥 Firebase Realtime Database',
      url: FIREBASE_URL,
      cache: '5 دقائق',
      auto_refresh: 'Yes ✅'
    },
    endpoints: {
      video: '/video?v=VIDEO_ID&format=best[height<=720]',
      info: '/info?v=VIDEO_ID',
      formats: '/formats?v=VIDEO_ID',
      health: '/health',
      cookiesStatus: '/api/cookies-status'
    },
    examples: {
      'Play video': '/video?v=dQw4w9WgXcQ',
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
║  🎬 srver v2.2 - YouTube Proxy شغّال 🔥  ║
║  ═════════════════════════════════════    ║
║  Environment: ${NODE_ENV.padEnd(26, ' ')}║
║  yt-dlp: ${ytdlpStatus}  Firebase Cookies ✅    ║
║  Firebase: 🌐 Real-time Database          ║
║  Cache: 5 دقائق                          ║
║  http://0.0.0.0:${PORT}                     ║
╚═══════════════════════════════════════════╝
  `);
  log.success(`✅ Server ready - Fetching cookies from Firebase`);
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
