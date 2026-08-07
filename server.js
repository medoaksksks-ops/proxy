const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const NodeCache = require('node-cache');
require('dotenv').config();

// Handle cookies from environment variable
if (process.env.COOKIES_BASE64) {
  try {
    const cookiesContent = Buffer.from(process.env.COOKIES_BASE64, 'base64').toString('utf-8');
    fs.writeFileSync('/app/.cookies.txt', cookiesContent);
    console.log('✅ Cookies loaded from environment');
  } catch (error) {
    console.error('❌ Failed to load cookies:', error.message);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// CORS config
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'OPTIONS'],
  credentials: false
}));

app.use(express.json());

// Cache (ساعتين للـ info، 30 دقيقة للـ streams)
const infoCache = new NodeCache({ stdTTL: 7200 });
const streamCache = new NodeCache({ stdTTL: 1800 });

const TIMEOUT = 60000;
const MAX_RETRIES = 3;
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

// Logger بسيط وفعّال
const log = {
  info: (msg) => console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`),
  success: (msg) => console.log(`[${new Date().toISOString()}] ✅ ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ❌ ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`)
};

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
  return new Promise((resolve, reject) => {
    try {
      // Build cookies flag if cookies file exists
      const cookiesFlag = fs.existsSync('/app/.cookies.txt') ? '--cookies /app/.cookies.txt' : '';
      const cmd = `yt-dlp --dump-json --no-warnings ${cookiesFlag} "https://www.youtube.com/watch?v=${videoId}"`;
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
  return new Promise((resolve, reject) => {
    try {
      // Build cookies flag if cookies file exists
      const cookiesFlag = fs.existsSync('/app/.cookies.txt') ? '--cookies /app/.cookies.txt' : '';
      const cmd = `yt-dlp --get-url --no-warnings ${cookiesFlag} -f "${format}" "https://www.youtube.com/watch?v=${videoId}"`;
      const result = execSync(cmd, { 
        timeout: TIMEOUT,
        encoding: 'utf-8'
      });
      resolve(result.trim().split('\n')[0]); // أول URL في الـ output
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

  if (cached?.url && Date.now() - cached.timestamp < 300000) { // 5 دقائق
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

      // Cache الـ URL (قصير الأجل)
      streamCache.set(cacheKey, {
        url: streamUrl,
        timestamp: Date.now()
      });

      const title = sanitizeFilename(info.title || 'video');
      
      log.success(`▶️  Playing: ${info.title}`);

      // Redirect للـ URL المباشر (أسرع وأكفأ)
      res.setHeader('Content-Disposition', `inline; filename="${title}.mp4"`);
      res.redirect(streamUrl);
      return;

    } catch (error) {
      lastError = error;
      attempts++;
      log.warn(`Attempt ${attempts} failed: ${error.message}`);
      
      if (attempts < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * attempts)); // exponential backoff
      }
    }
  }

  log.error(`Failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);

  if (lastError?.message.includes('unavailable') || lastError?.message.includes('not available')) {
    return res.status(404).json({ error: 'الفيديو غير متاح أو محذوف' });
  } else if (lastError?.message.includes('private') || lastError?.message.includes('private')) {
    return res.status(403).json({ error: 'الفيديو خاص (private)' });
  } else if (lastError?.message.includes('age')) {
    return res.status(403).json({ error: 'الفيديو يحتاج verification العمر' });


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
 * قائمة الـ formats المتاحة
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
      .filter(f => f.vcodec !== 'none' || f.acodec !== 'none') // skip audio-only
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
      formats: formats.slice(0, 20) // أول 20 format فقط
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
 * GET /
 */
app.get('/', (req, res) => {
  res.json({
    name: '🎬 srver v2 - YouTube Proxy',
    version: '2.0.0',
    environment: NODE_ENV,
    endpoints: {
      video: '/video?v=VIDEO_ID&format=best[height<=720]',
      info: '/info?v=VIDEO_ID',
      formats: '/formats?v=VIDEO_ID',
      health: '/health'
    },
    examples: {
      'Play video': '/video?v=dQw4w9WgXcQ',
      'Get info': '/info?v=dQw4w9WgXcQ',
      'List formats': '/formats?v=dQw4w9WgXcQ',
      'Low quality': '/video?v=dQw4w9WgXcQ&format=worst'
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
╔════════════════════════════════════════╗
║  🎬 srver v2 - YouTube Proxy شغّال 🔥 ║
║  Environment: ${NODE_ENV.padEnd(26, ' ')}║
║  yt-dlp status: ${ytdlpStatus}                      ║
║  http://0.0.0.0:${PORT}                        ║
╚════════════════════════════════════════╝
  `);
  log.success(`Server running on port ${PORT}`);
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
