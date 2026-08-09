const express = require('express');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
// (مش محتاجين مكتبة cors تاني، الهيدرز بقت بتتحط يدوي فوق)
const NodeCache = require('node-cache');
const https = require('https');
require('dotenv').config();

// ==========================================================================
// 🔖 srver v5.5.0 "الإصلاح" — نسخة معدلة تركز على استخراج جودات صحيحة:
//   • إصلاح YTDLP_EXTRA_ARGS لاستخدام فقط --js-runtimes node
//   • استخراج الجودات من الفورمات الفعلية فقط
//   • عدم إظهار جودات غير موجودة
//   • معالجة أخطاء واضحة وتسجيل شامل
//   • حفظ جميع endpoints الموجودة
// ==========================================================================
const SERVER_VERSION = '5.5.0';

// Agent واحد بيعيد استخدام نفس اتصالات TCP/TLS بدل ما يفتح اتصال جديد لكل
// طلب لجوجل — ده اللي بيدي إحساس "سريع" فعلي في البث والـ API calls
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Firebase config
const FIREBASE_URL = process.env.FIREBASE_URL || 'https://english-73376-default-rtdb.firebaseio.com';
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';

// CORS — بروكسي عام (بحث/ترند/فيديو) من غير كوكيز أو تسجيل دخول، فمفيش أي خطورة
// من السماح لأي دومين. بنحطه يدوي هنا (مش عبر مكتبة cors) عشان نضمن إن الـ header
// يوصل دايمًا في كل رد، من غير ما يعتمد على أي متغيّر بيئة ممكن يبوّظ الموضوع.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Timing-Allow-Origin', '*'); // عشان الموقع يقدر يقيس حجم البيانات المُستهلكة فعليًا (Resource Timing API)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());
app.use(express.text({ limit: '10mb' }));

// ---------------- Cache ----------------
const infoCache = new NodeCache({ stdTTL: 7200 });          // معلومات فيديو/بحث/related: ساعتين
const trendingCache = new NodeCache({ stdTTL: 1200 });      // الرائج: 20 دقيقة
const streamCache = new NodeCache({ stdTTL: 240 });         // روابط التشغيل المباشرة بتنتهي بسرعة: 4 دقايق بس
const channelCache = new NodeCache({ stdTTL: 3600 });       // بيانات وفيديوهات القنوات: ساعة

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

    https.get(url, { timeout: 5000, agent: keepAliveAgent }, (res) => {
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

/**
 * ==========================================================================
 * تحديث yt-dlp تلقائيًا — يوتيوب بيغيّر طريقة تشفير الفيديوهات باستمرار،
 * ولو نسخة yt-dlp قديمة بتوقف تقرأ الفورمات فجأة ("Requested format is
 * not available") لحد ما حد يحدّثها. بدل ما نستنى deploy جديد (اللي ممكن
 * برضو يستخدم نسخة قديمة متخزّنة في كاش الداكر)، بنحدّثها من جوّه السيرفر
 * نفسه أول ما يشتغل، وبعدين كل 12 ساعة تلقائيًا.
 * ==========================================================================
 */
async function updateYtDlp() {
  try {
    log.info('🔄 جاري التأكد من تحديث yt-dlp...');
    const { stdout } = await execFileAsync('pip3', [
      'install', '--break-system-packages', '--no-cache-dir', '--upgrade', 'yt-dlp[default]'
    ], { timeout: 120000 });
    const alreadyLatest = /already up-to-date|already satisfied/i.test(stdout);
    if (alreadyLatest) {
      log.info('✅ yt-dlp أصلًا أحدث نسخة');
    } else {
      log.success('✅ تم تحديث yt-dlp لأحدث نسخة');
    }
  } catch (e) {
    log.error(`فشل تحديث yt-dlp: ${e.message}`);
  }
}
updateYtDlp();
setInterval(updateYtDlp, 12 * 60 * 60 * 1000);

// Check if yt-dlp is installed
function checkYtDlp() {
  try {
    require('child_process').execSync('yt-dlp --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Check if ffmpeg is installed
function checkFfmpeg() {
  try {
    require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
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
 * ==========================================================================
 * إعدادات yt-dlp المبسطة:
 * بدل الـ player_client محدد، نستخدم فقط --js-runtimes node
 * يسمح لـ yt-dlp يختار الـ clients المناسبة بدل ما نفرض عليه واحدة معينة
 * ==========================================================================
 */
const YTDLP_EXTRA_ARGS = [
  '--js-runtimes', 'node'
];

/**
 * ==========================================================================
 * تشغيل yt-dlp بشكل آمن بدون shell مع معالجة أخطاء محسّنة
 * ==========================================================================
 */
async function runYtDlp(args, { timeout = TIMEOUT, maxBuffer = 1024 * 1024 * 10 } = {}) {
  await ytdlpLimiter.acquire();
  try {
    const finalArgs = cookiesReady ? ['--cookies', COOKIES_PATH, ...args] : args;
    
    const { stdout, stderr } = await execFileAsync('yt-dlp', [...YTDLP_EXTRA_ARGS, ...finalArgs], {
      timeout,
      maxBuffer,
      encoding: 'utf-8'
    });

    return { stdout, stderr };
  } catch (error) {
    // تسجيل الخطأ مع معلومات مفيدة بدون إظهار محتوى cookies
    const errorLog = {
      message: error.message,
      code: error.code,
      signal: error.signal
    };

    // إذا كان في stderr، اعرضه (بس بدون محتوى cookies)
    if (error.stderr) {
      errorLog.stderr = error.stderr;
    }

    // استخرج video ID من الـ args إن وجد
    const videoIdArg = args.find((arg, i) => arg === 'https://www.youtube.com/watch?v=' || 
                                             (typeof arg === 'string' && arg.match(/^[a-zA-Z0-9_-]{11}$/)));
    if (videoIdArg) {
      errorLog.videoId = videoIdArg.match(/[a-zA-Z0-9_-]{11}/)?.[0];
    }

    log.error(`yt-dlp error: ${JSON.stringify(errorLog)}`);
    throw error;
  } finally {
    ytdlpLimiter.release();
  }
}

/**
 * ==========================================================================
 * استخراج الجودات الفعلية من الفورمات التي يرجعها yt-dlp
 * هذه الدالة تستخرج فقط الجودات التي موجودة فعليًا
 * ==========================================================================
 */
function extractRealQualities(formats) {
  if (!Array.isArray(formats) || formats.length === 0) {
    return [];
  }

  const heights = new Set();

  // حلقة عبر كل الـ formats وجمع الـ heights الفعلية فقط
  for (const fmt of formats) {
    // تحقق أن هذا format فيديو (لا يكون image ولا audio فقط)
    if (fmt.vcodec && fmt.vcodec !== 'none' && fmt.height) {
      heights.add(fmt.height);
    }
  }

  // حول الـ Set إلى مصفوفة ورتبها من الأعلى إلى الأقل
  const qualitiesArray = Array.from(heights).sort((a, b) => b - a);

  return qualitiesArray.map(h => ({
    height: h,
    label: `${h}p`,
    value: String(h)
  }));
}

/**
 * ==========================================================================
 * استخراج معلومات الفيديو والفورمات من yt-dlp
 * ==========================================================================
 */
async function getVideoInfo(videoId) {
  try {
    const { stdout } = await runYtDlp([
      '-j',
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    const info = JSON.parse(stdout);
    return info;
  } catch (error) {
    log.error(`Failed to get video info for ${videoId}: ${error.message}`);
    throw error;
  }
}

/**
 * ==========================================================================
 * دالة مساعدة: اختيار أفضل format فيديو + audio بناءً على الارتفاع المطلوب
 * ==========================================================================
 */
function selectBestFormat(formats, maxHeight = null) {
  if (!Array.isArray(formats) || formats.length === 0) {
    return null;
  }

  // فلترة الـ video formats (يجب أن تكون vcodec !== 'none')
  const videoFormats = formats.filter(f => 
    f.vcodec && f.vcodec !== 'none' && f.height
  );

  if (videoFormats.length === 0) {
    return null;
  }

  // إذا كان محدد ارتفاع، اختر أفضل format أقل من أو مساوي للارتفاع
  let selectedVideo = null;
  if (maxHeight !== null) {
    selectedVideo = videoFormats
      .filter(f => f.height <= maxHeight)
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  }

  // إذا لم يوجد format مناسب في الارتفاع المحدد، اختر أفضل واحد
  if (!selectedVideo) {
    selectedVideo = videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  }

  // اختر أفضل audio format
  const audioFormats = formats.filter(f => 
    f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
  );
  const selectedAudio = audioFormats.sort((a, b) => 
    (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0)
  )[0];

  return { video: selectedVideo, audio: selectedAudio };
}

/**
 * ==========================================================================
 * استخراج format ID بناءً على الارتفاع المطلوب
 * ==========================================================================
 */
function getFormatSelector(formats, requestedHeight = null) {
  const selected = selectBestFormat(formats, requestedHeight);
  
  if (!selected || !selected.video) {
    return 'best';
  }

  // بناء selector: video format + audio format
  const videoId = selected.video.format_id;
  const audioId = selected.audio ? selected.audio.format_id : null;

  if (audioId) {
    return `${videoId}+${audioId}`;
  }
  return videoId;
}

/**
 * ==========================================================================
 * دالة FFmpeg merge streaming — لدمج video + audio مباشرة بدون تخزين
 * ==========================================================================
 */
function streamMergedViaFfmpeg(videoUrl, audioUrl, res) {
  const ffmpegArgs = [
    '-i', videoUrl,
    '-i', audioUrl,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-f', 'mp4',
    'pipe:1'
  ];

  const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  ffmpegProcess.stdout.pipe(res);

  ffmpegProcess.on('error', (err) => {
    log.error(`FFmpeg error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'FFmpeg streaming failed' });
    }
  });

  res.on('close', () => {
    ffmpegProcess.kill();
  });
}

// ============================= ENDPOINTS ==============================

/**
 * GET /home
 */
app.get('/home', async (req, res) => {
  try {
    const region = (req.query.region || 'EG').toUpperCase();
    const perSection = parseInt(req.query.perSection) || 12;
    const cacheKey = `home:${region}:${perSection}`;

    const cached = infoCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    log.info(`Fetching home for region: ${region}`);
    const { stdout } = await runYtDlp([
      'https://www.youtube.com/',
      '-j',
      '--extract-flat=in_playlist',
      '--skip-download'
    ]);

    const parsed = JSON.parse(stdout);
    const sections = [];

    if (parsed.entries) {
      const chunked = [];
      for (let i = 0; i < parsed.entries.length; i += perSection) {
        chunked.push(parsed.entries.slice(i, i + perSection));
      }

      chunked.forEach((chunk, idx) => {
        sections.push({
          section_id: `section_${idx}`,
          title: `Section ${idx + 1}`,
          videos: chunk.map(v => ({
            id: v.id,
            title: v.title,
            thumbnail: v.thumbnail || null,
            duration: v.duration || null,
            channel: v.channel || null
          }))
        });
      });
    }

    const result = { region, sections };
    infoCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    log.error(`Home feed error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الصفحة الرئيسية',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /trending
 */
app.get('/trending', async (req, res) => {
  try {
    const region = (req.query.region || 'EG').toUpperCase();
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    const cacheKey = `trending:${region}:${page}:${limit}`;

    const cached = trendingCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    log.info(`Fetching trending for ${region} (page ${page})`);
    const { stdout } = await runYtDlp([
      `https://www.youtube.com/trending?gl=${region}`,
      '-j',
      '--extract-flat=in_playlist',
      '--skip-download'
    ]);

    const parsed = JSON.parse(stdout);
    const allVideos = parsed.entries || [];
    const videos = allVideos.slice(offset, offset + limit);

    const result = {
      region,
      page,
      limit,
      total: allVideos.length,
      hasMore: offset + limit < allVideos.length,
      videos: videos.map(v => ({
        id: v.id,
        title: v.title,
        thumbnail: v.thumbnail || null,
        duration: v.duration || null,
        channel: v.channel || null,
        views: v.view_count || null
      }))
    };

    trendingCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    log.error(`Trending error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الفيديوهات الرائجة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /search
 */
app.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) {
      return res.status(400).json({ error: 'Missing search query (q)' });
    }

    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    const cacheKey = `search:${q}:${page}:${limit}`;

    const cached = infoCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    log.info(`Searching: ${q} (page ${page})`);
    const { stdout } = await runYtDlp([
      `ytsearch${limit * page}:${q}`,
      '-j',
      '--extract-flat=in_playlist',
      '--skip-download'
    ]);

    const parsed = JSON.parse(stdout);
    const allVideos = parsed.entries || [];
    const videos = allVideos.slice(offset, offset + limit);

    const result = {
      query: q,
      page,
      limit,
      total: allVideos.length,
      hasMore: offset + limit < allVideos.length,
      videos: videos.map(v => ({
        id: v.id,
        title: v.title,
        thumbnail: v.thumbnail || null,
        duration: v.duration || null,
        channel: v.channel || null
      }))
    };

    infoCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    log.error(`Search error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر البحث',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /related
 */
app.get('/related', async (req, res) => {
  try {
    const videoId = req.query.v;
    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'Missing or invalid video ID (v)' });
    }

    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    const cacheKey = `related:${videoId}:${page}:${limit}`;

    const cached = infoCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    log.info(`Fetching related videos for ${videoId}`);
    const { stdout } = await runYtDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '-j',
      '--extract-flat=in_playlist',
      '--skip-download'
    ]);

    const parsed = JSON.parse(stdout);
    const allVideos = (parsed.related_videos || parsed.entries || []);
    const videos = allVideos.slice(offset, offset + limit);

    const result = {
      videoId,
      page,
      limit,
      total: allVideos.length,
      hasMore: offset + limit < allVideos.length,
      videos: videos.map(v => ({
        id: v.id,
        title: v.title,
        thumbnail: v.thumbnail || null,
        duration: v.duration || null,
        channel: v.channel || null
      }))
    };

    infoCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    log.error(`Related videos error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الفيديوهات ذات الصلة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /channel
 */
app.get('/channel', async (req, res) => {
  try {
    const channelId = req.query.id;
    if (!channelId) {
      return res.status(400).json({ error: 'Missing channel ID (id)' });
    }

    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    const cacheKey = `channel:${channelId}:${page}:${limit}`;

    const cached = channelCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    log.info(`Fetching channel ${channelId} (page ${page})`);
    const { stdout } = await runYtDlp([
      `https://www.youtube.com/channel/${channelId}/videos`,
      '-j',
      '--extract-flat=in_playlist',
      '--skip-download'
    ]);

    const parsed = JSON.parse(stdout);
    const allVideos = parsed.entries || [];
    const videos = allVideos.slice(offset, offset + limit);

    const result = {
      channelId,
      title: parsed.title || 'Unknown Channel',
      description: parsed.description || '',
      page,
      limit,
      total: allVideos.length,
      hasMore: offset + limit < allVideos.length,
      videos: videos.map(v => ({
        id: v.id,
        title: v.title,
        thumbnail: v.thumbnail || null,
        duration: v.duration || null
      }))
    };

    channelCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    log.error(`Channel error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب بيانات القناة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /comments
 */
app.get('/comments', async (req, res) => {
  try {
    const videoId = req.query.v;
    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'Missing or invalid video ID (v)' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const cacheKey = `comments:${videoId}:${limit}`;

    const cached = infoCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    log.info(`Fetching comments for ${videoId}`);
    const { stdout } = await runYtDlp([
      `https://www.youtube.com/watch?v=${videoId}`,
      '--write-comments',
      '--dump-json',
      '--skip-download'
    ]);

    const info = JSON.parse(stdout);
    const comments = (info.comments || []).slice(0, limit);

    const result = {
      videoId,
      total: comments.length,
      comments: comments.map(c => ({
        author: c.author,
        text: c.text,
        time: c.time,
        likes: c.like_count || 0
      }))
    };

    infoCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    log.error(`Comments error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب التعليقات',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /info
 */
app.get('/info', async (req, res) => {
  try {
    const videoId = req.query.v;
    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'Missing or invalid video ID (v)' });
    }

    const cacheKey = `info:${videoId}`;
    const cached = infoCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    log.info(`Fetching info for ${videoId}`);
    const info = await getVideoInfo(videoId);

    const result = {
      id: info.id,
      title: info.title,
      description: info.description,
      duration: info.duration,
      uploader: info.uploader,
      uploader_id: info.uploader_id,
      view_count: info.view_count,
      like_count: info.like_count || 0,
      upload_date: info.upload_date,
      thumbnail: info.thumbnail
    };

    infoCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    log.error(`Info error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب معلومات الفيديو',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /formats
 * عرض كل الـ formats الفعلية التي يوفرها yt-dlp
 */
app.get('/formats', async (req, res) => {
  try {
    const videoId = req.query.v;
    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'Missing or invalid video ID (v)' });
    }

    const cacheKey = `formats:${videoId}`;
    const cached = infoCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    log.info(`Fetching formats for ${videoId}`);
    const info = await getVideoInfo(videoId);

    if (!info.formats) {
      return res.status(400).json({
        error: 'لم يتمكن yt-dlp من استخراج الفورمات',
        details: 'قد يكون الفيديو محميًا أو غير متاح',
        videoId
      });
    }

    // فلترة video formats فقط (بدون audio-only)
    const videoFormats = info.formats
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .map(f => ({
        format_id: f.format_id,
        format: f.format,
        video_codec: f.vcodec || 'unknown',
        audio_codec: f.acodec || 'none',
        height: f.height,
        width: f.width,
        fps: f.fps || null,
        file_size: f.filesize || null,
        ext: f.ext
      }));

    const result = {
      videoId,
      title: info.title,
      totalFormats: info.formats.length,
      videoFormats: videoFormats.length,
      formats: videoFormats
    };

    infoCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    log.error(`Formats error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الفورمات',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /video/qualities
 * عرض الجودات الموجودة فعليًا فقط
 */
app.get('/video/qualities', async (req, res) => {
  try {
    const videoId = req.query.v;
    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'Missing or invalid video ID (v)' });
    }

    const cacheKey = `qualities:${videoId}`;
    const cached = infoCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    log.info(`Fetching qualities for ${videoId}`);
    const info = await getVideoInfo(videoId);

    if (!info.formats || info.formats.length === 0) {
      return res.status(400).json({
        error: 'لا توجد فورمات فيديو متاحة',
        details: 'قد يكون الفيديو محميًا أو غير متاح',
        videoId
      });
    }

    // استخراج الجودات الفعلية فقط
    const qualities = extractRealQualities(info.formats);

    // أضف audio option إذا كان في audio formats
    const hasAudio = info.formats.some(f => 
      f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
    );

    if (hasAudio) {
      qualities.push({
        height: 0,
        label: 'Audio Only',
        value: 'audio'
      });
    }

    const result = {
      id: videoId,
      title: info.title,
      qualities,
      count: qualities.length
    };

    infoCache.set(cacheKey, result);
    log.success(`✅ Qualities extracted: ${videoId} (${qualities.length} جودة فعلية)`);
    res.json(result);
  } catch (error) {
    log.error(`Qualities error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الجودات المتاحة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /video
 * تشغيل الفيديو بجودة محددة أو تلقائية
 */
app.get('/video', async (req, res) => {
  try {
    const videoId = req.query.v;
    const qualityParam = req.query.quality;
    const formatParam = req.query.format;

    if (!videoId || !isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'Missing or invalid video ID (v)' });
    }

    log.info(`Playing video ${videoId}${qualityParam ? ` at quality ${qualityParam}` : ''}`);

    // جلب معلومات الفيديو والفورمات
    const info = await getVideoInfo(videoId);

    if (!info.formats || info.formats.length === 0) {
      return res.status(400).json({
        error: 'لا توجد فورمات فيديو متاحة',
        details: 'قد يكون الفيديو محميًا أو غير متاح'
      });
    }

    let selectedFormat = formatParam;

    // إذا طلب quality محددة
    if (qualityParam) {
      if (qualityParam === 'audio') {
        // audio only
        const audioFormat = info.formats.find(f => 
          f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
        );
        if (!audioFormat) {
          return res.status(400).json({
            error: 'Audio quality not available for this video'
          });
        }
        selectedFormat = audioFormat.format_id;
      } else {
        // جودة فيديو محددة
        const requestedHeight = parseInt(qualityParam);
        const realQualities = extractRealQualities(info.formats);
        const qualityExists = realQualities.some(q => q.height === requestedHeight);

        if (!qualityExists) {
          return res.status(400).json({
            error: `الجودة المطلوبة (${qualityParam}p) غير متاحة لهذا الفيديو`,
            availableQualities: realQualities.map(q => q.label),
            videoId
          });
        }

        selectedFormat = getFormatSelector(info.formats, requestedHeight);
      }
    } else {
      // بدون جودة محددة، استخدم أفضل format
      selectedFormat = getFormatSelector(info.formats);
    }

    if (!selectedFormat) {
      return res.status(400).json({
        error: 'تعذّر اختيار format مناسب للفيديو'
      });
    }

    log.info(`Using format selector: ${selectedFormat}`);

    // جلب الفيديو بالـ format المختار
    const { stdout: urlsJson } = await runYtDlp([
      '-f', selectedFormat,
      '-g',
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    const urls = urlsJson.trim().split('\n').filter(Boolean);

    if (urls.length === 0) {
      return res.status(400).json({
        error: 'تعذّر الحصول على روابط البث'
      });
    }

    // إذا كان في URL واحد فقط (progressive stream)
    if (urls.length === 1) {
      res.redirect(urls[0]);
    } else if (urls.length === 2) {
      // video + audio ← استخدم FFmpeg merge
      res.setHeader('Content-Type', 'video/mp4');
      streamMergedViaFfmpeg(urls[0], urls[1], res);
    } else {
      // fallback: استخدم أول URL
      res.redirect(urls[0]);
    }
  } catch (error) {
    log.error(`Video streaming error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر تشغيل الفيديو',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  const ytdlpReady = checkYtDlp();
  const ffmpegReady = checkFfmpeg();

  res.json({
    status: 'operational',
    version: SERVER_VERSION,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      ytdlp: {
        ready: ytdlpReady,
        version: (() => {
          try {
            return require('child_process').execSync('yt-dlp --version', { encoding: 'utf-8' }).trim();
          } catch {
            return 'unknown';
          }
        })()
      },
      ffmpeg: {
        ready: ffmpegReady,
        status: ffmpegReady ? '✅ Available' : '❌ Not available'
      },
      nodejs: {
        ready: true,
        version: process.version
      },
      cookies: {
        ready: cookiesReady,
        status: cookiesReady ? '✅ Loaded' : '❌ Waiting for Firebase'
      }
    },
    concurrency: {
      max: YTDLP_CONCURRENCY,
      current: ytdlpLimiter.current,
      queued: ytdlpLimiter.queue.length
    }
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
    name: '🎬 srver v5.5.0 "الإصلاح" - YouTube Proxy (بدون اعتماد على YouTube Data API)',
    version: SERVER_VERSION,
    environment: NODE_ENV,
    improvements: {
      'v5.5.0': 'إصلاح نظام استخراج الجودات - عرض الجودات الموجودة فعليًا فقط، معالجة أخطاء محسّنة',
      'v5.4.1': 'دعم جودات 1080p/1440p/2160p مع FFmpeg merge'
    },
    cookies: {
      source: '🔥 Firebase Realtime Database',
      url: FIREBASE_URL,
      refresh: 'كل 5 دقايق في الخلفية',
      ready: cookiesReady
    },
    concurrency: { max: YTDLP_CONCURRENCY },
    endpoints: {
      home: '/home?region=EG&perSection=12',
      trending: '/trending?region=EG&limit=20&page=1',
      video: '/video?v=VIDEO_ID&quality=1080',
      videoQualities: '/video/qualities?v=VIDEO_ID',
      info: '/info?v=VIDEO_ID',
      formats: '/formats?v=VIDEO_ID',
      search: '/search?q=QUERY&limit=20&page=1',
      related: '/related?v=VIDEO_ID&limit=10&page=1',
      channel: '/channel?id=CHANNEL_ID&limit=20&page=1',
      comments: '/comments?v=VIDEO_ID&limit=50',
      health: '/health',
      cookiesStatus: '/api/cookies-status'
    },
    examples: {
      'Home feed': '/home?region=EG',
      'Trending': '/trending?region=EG&page=1',
      'Play video (auto quality)': '/video?v=dQw4w9WgXcQ',
      'Play video 1080p': '/video?v=dQw4w9WgXcQ&quality=1080',
      'All available qualities': '/video/qualities?v=dQw4w9WgXcQ',
      'Search': '/search?q=funny+cats&page=1',
      'Related': '/related?v=dQw4w9WgXcQ',
      'Channel': '/channel?id=UCuAXFkgsw1L7xaCfnd5JJOw',
      'Comments': '/comments?v=dQw4w9WgXcQ'
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
  const ffmpegStatus = checkFfmpeg() ? '✅' : '❌';
  console.log(`
╔═══════════════════════════════════════════╗
║  🎬 srver v${SERVER_VERSION} "الإصلاح" شغّال 🔥    ║
║  ═════════════════════════════════════     ║
║  Environment: ${NODE_ENV.padEnd(26, ' ')}║
║  yt-dlp: ${ytdlpStatus}  ffmpeg: ${ffmpegStatus}                   ║
║  Concurrency: ${String(YTDLP_CONCURRENCY).padEnd(24, ' ')}║
║  http://0.0.0.0:${PORT}                        ║
╚═══════════════════════════════════════════╝
  `);
  log.success(`✅ Server ready - no YouTube Data API dependency`);
  log.info(`🆕 v5.5.0: Fixed quality extraction - shows only real qualities from yt-dlp`);
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
