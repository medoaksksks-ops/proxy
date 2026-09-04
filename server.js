const express = require('express');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const https = require('https');
require('dotenv').config();

// ==========================================================================
// 🎬 srver v8.0.0 "الجبار" — نسخة محسّنة وخالية من التقطع والتأخير
//   ✅ timeout قويّ وإعادة اتصال ذكية
//   ✅ ffmpeg محسّن لدمج بدون lag
//   ✅ buffering أفضل وstream stable
//   ✅ كل الجودات تشتغل عادي بدون دكدة
// ==========================================================================
const SERVER_VERSION = '8.0.0';

// Keep-alive agent بإعدادات أقوى
const keepAliveAgent = new https.Agent({ 
  keepAlive: true, 
  maxSockets: 150,
  keepAliveMsecs: 30000,
  maxFreeSockets: 50,
  timeout: 120000
});

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
app.disable('x-powered-by');
app.set('etag', false); // تعطيل etag لتجنب مشاكل البث

// ==========================================================================
// 🌐 CORS محسّن
// ==========================================================================
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, X-Cookie-Update-Key');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Cache-Control, X-Video-Quality, X-Stream-Mode, X-Duration');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Firebase config
const FIREBASE_URL = process.env.FIREBASE_URL || 'https://english-73376-default-rtdb.firebaseio.com';
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';

app.use(express.json());
app.use(express.text({ limit: '10mb' }));

// Cache مع أوقات TTL محسّنة
const infoCache = new NodeCache({ stdTTL: 10800 });
const streamCache = new NodeCache({ stdTTL: 600 }); // أطول من الأصلي لتجنب re-fetching
const channelCache = new NodeCache({ stdTTL: 7200 });

const TIMEOUT = 90000; // 90 ثانية للعمليات الطويلة
const STREAM_TIMEOUT = 120000; // 120 ثانية للبث
const MAX_RETRIES = 3;

// Logger محسّن
const log = {
  info: (msg) => console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`),
  success: (msg) => console.log(`[${new Date().toISOString()}] ✅ ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ❌ ${msg}`),
  warn: (msg) => console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`)
};

// Concurrency limiter
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
const YTDLP_CONCURRENCY = parseInt(process.env.YTDLP_CONCURRENCY, 10) || 6;
const ytdlpLimiter = new Semaphore(YTDLP_CONCURRENCY);

const inflight = new Map();
function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ==========================================================================
// 🍪 كوكيز محسّن
// ==========================================================================
const COOKIES_PATH = '/tmp/.cookies.txt';
let cookiesReady = false;

function fetchCookiesFromFirebase() {
  return new Promise((resolve) => {
    const url = FIREBASE_SECRET
      ? `${FIREBASE_URL}/youtube_cookies.json?auth=${FIREBASE_SECRET}`
      : `${FIREBASE_URL}/youtube_cookies.json`;

    https.get(url, { timeout: 8000, agent: keepAliveAgent }, (res) => {
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

// Check yt-dlp
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

function commandExists(command) {
  try { require('child_process').execFileSync(command, ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function isRetryableYoutubeError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return /page needs to be reloaded|sign in to confirm|confirm you're not a bot|http error 403|requested format is not available|video unavailable|not available in your country/.test(text);
}

// ==========================================================================
// yt-dlp محسّن مع retry logic
// ==========================================================================
async function runYtDlp(args, {
  timeout = TIMEOUT,
  maxBuffer = 1024 * 1024 * 10,
  useCookies = false,
  allowCookieFallback = true,
  retries = MAX_RETRIES
} = {}) {
  await ytdlpLimiter.acquire();
  try {
    const base = ['--no-warnings', '--socket-timeout', '30'];
    if (commandExists('node')) base.push('--js-runtimes', 'node');

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const attempts = [];
        const pushAttempt = (extra, cookies = false) => {
          attempts.push([...base, ...extra, ...(cookies && cookiesReady ? ['--cookies', COOKIES_PATH] : []), ...args]);
        };

        pushAttempt([], useCookies);
        if (!useCookies) pushAttempt(['--extractor-args', 'youtube:player_client=default,web_safari']);
        if (allowCookieFallback && cookiesReady && !useCookies) {
          pushAttempt(['--extractor-args', 'youtube:player_client=default,-tv_downgraded,web_embedded'], true);
          pushAttempt(['--extractor-args', 'youtube:player_client=web_embedded'], true);
        }

        for (let i = 0; i < attempts.length; i++) {
          try {
            const { stdout } = await execFileAsync('yt-dlp', attempts[i], {
              timeout,
              maxBuffer,
              encoding: 'utf-8'
            });
            return stdout;
          } catch (error) {
            lastError = error;
            if (!isRetryableYoutubeError(error) && i === 0) throw error;
            if (i < attempts.length - 1) log.warn(`yt-dlp attempt ${i + 1} failed, trying fallback`);
          }
        }
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          log.warn(`yt-dlp attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  } finally {
    ytdlpLimiter.release();
  }
}

// ==========================================================================
// دوال مساعدة للفيديو
// ==========================================================================
function mapFlatEntry(item, excludeId) {
  if (!item || !item.id) return null;
  if (excludeId && item.id === excludeId) return null;
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
}

function parseFlatItems(raw, excludeId) {
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      let item;
      try { item = JSON.parse(line); } catch (e) { return null; }
      return mapFlatEntry(item, excludeId);
    })
    .filter(Boolean);
}

// Filters
const UNWANTED_KEYWORDS = [
  'كرتون', 'رسوم متحركة', 'للأطفال', 'اطفال', 'أطفال', 'بيبي', 'بيبى', 'روضة',
  'حضانة', 'قصص اطفال', 'قصص أطفال', 'اغاني اطفال', 'أغاني أطفال', 'العاب اطفال',
  'ألعاب أطفال', 'تعليم اطفال', 'تعليم أطفال', 'انمي اطفال', 'مسلسل كرتون',
  'cartoon', 'kids', 'for kids', 'nursery rhyme', 'nursery rhymes',
  'وصفة', 'وصفات', 'طبخ', 'طبخة', 'طريقة عمل', 'حلويات',
];
function isUnwantedContent(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return UNWANTED_KEYWORDS.some(k => t.includes(k.toLowerCase()));
}

// Pool paginated
async function getPaginatedPool(cache, cacheKeyBase, fetchPoolFn, page, limit, maxPool = 150) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 30);
  const needed = pageNum * pageSize;
  const poolSize = Math.min(Math.max(needed, pageSize * 2), maxPool);

  const cacheKey = `${cacheKeyBase}_${poolSize}`;
  let pool = cache.get(cacheKey);
  if (!pool) {
    pool = await fetchPoolFn(poolSize);
    cache.set(cacheKey, pool);
  }

  const start = (pageNum - 1) * pageSize;
  const results = pool.slice(start, start + pageSize);
  const hasMore = pool.length > start + pageSize;

  return { page: pageNum, limit: pageSize, results, hasMore };
}

// ==========================================================================
// 🎬 معالجات الفيديو الأساسية
// ==========================================================================
async function getVideoInfo(videoId) {
  const key = `raw_info_${videoId}`;
  const cached = infoCache.get(key);
  if (cached) return cached;

  return dedupe(key, async () => {
    const again = infoCache.get(key);
    if (again) return again;

    const stdout = await runYtDlp([
      '--dump-json', '--no-playlist',
      `https://www.youtube.com/watch?v=${videoId}`
    ]);
    const info = JSON.parse(stdout);
    infoCache.set(key, info, 10800);
    return info;
  });
}

async function getFormatUrls(videoId, formatSelector) {
  const key = `urls_${videoId}_${formatSelector}`;
  const cached = streamCache.get(key);
  if (cached) return cached;

  return dedupe(key, async () => {
    const again = streamCache.get(key);
    if (again) return again;

    const stdout = await runYtDlp([
      '--get-url', '--no-playlist', '-f', formatSelector,
      `https://www.youtube.com/watch?v=${videoId}`
    ], { timeout: STREAM_TIMEOUT });

    const urls = stdout.trim().split('\n').map(s => s.trim()).filter(Boolean);
    if (!urls.length) throw new Error('No stream URL returned');
    streamCache.set(key, urls, 600);
    return urls;
  });
}

async function getVideoStreamUrl(videoId, format = 'best') {
  const urls = await getFormatUrls(videoId, format);
  const streamUrl = urls[0];
  log.success(`🎬 Got stream URL (${streamUrl.length} chars)`);
  return streamUrl;
}

// ==========================================================================
// 🔥 البث المحسّن - الحل الأساسي للمشاكل
// ==========================================================================
function streamFromUpstream(req, res, url, redirectCount = 0, retryCount = 0) {
  if (redirectCount > 5) {
    if (!res.headersSent) res.status(502).json({ error: 'تحويلات كتير أوي من المصدر' });
    return;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  let attempts = 0;
  const maxAttempts = 3;
  let isResponseStarted = false;

  function makeRequest() {
    attempts++;
    const upstreamReq = https.get(url, { 
      headers, 
      timeout: STREAM_TIMEOUT,
      agent: keepAliveAgent,
      rejectUnauthorized: false // للتوافقية
    }, (upstreamRes) => {
      isResponseStarted = true;

      // معالجة redirects
      if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
        upstreamRes.resume();
        return streamFromUpstream(req, res, upstreamRes.headers.location, redirectCount + 1, retryCount);
      }

      if (upstreamRes.statusCode >= 400) {
        log.error(`Upstream video error: ${upstreamRes.statusCode}`);
        upstreamRes.resume();
        if (!res.headersSent) {
          res.status(502).json({ error: 'تعذّر تحميل الفيديو من المصدر' });
        }
        return;
      }

      res.status(upstreamRes.statusCode);
      
      // إضافة headers مهمة للبث المستقر
      const headersToForward = [
        'content-type', 'content-length', 'content-range', 'accept-ranges',
        'cache-control', 'last-modified', 'connection', 'date'
      ];
      headersToForward.forEach(h => {
        if (upstreamRes.headers[h]) {
          res.setHeader(h, upstreamRes.headers[h]);
        }
      });

      // Headers إضافية للحفاظ على الاتصال مستقراً
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Keep-Alive', 'timeout=120, max=1000');

      // Pipe البيانات مع معالجة الأخطاء
      upstreamRes.pipe(res, { highWaterMark: 1024 * 256 }); // Buffer أكبر

      upstreamRes.on('error', (err) => {
        if (!res.headersSent && attempts < maxAttempts) {
          log.warn(`Upstream error on attempt ${attempts}, retrying: ${err.message}`);
          setTimeout(() => makeRequest(), 2000 * attempts);
        } else {
          log.error(`Stream pipe error: ${err.message}`);
          if (!res.headersSent) {
            res.status(502).json({ error: 'خطأ في البث' });
          }
        }
      });
    });

    // معالجة أخطاء الاتصال
    upstreamReq.on('error', (err) => {
      if (!isResponseStarted && attempts < maxAttempts) {
        log.warn(`Connection error on attempt ${attempts}, retrying: ${err.message}`);
        setTimeout(() => makeRequest(), 2000 * attempts);
      } else {
        log.error(`Stream connection error: ${err.message}`);
        if (!res.headersSent) {
          res.status(502).json({ error: 'تعذّر الاتصال بمصدر الفيديو' });
        }
      }
    });

    upstreamReq.on('timeout', () => {
      if (!isResponseStarted && attempts < maxAttempts) {
        log.warn(`Timeout on attempt ${attempts}, retrying...`);
        upstreamReq.destroy();
        setTimeout(() => makeRequest(), 2000 * attempts);
      } else {
        log.error('Stream timeout');
        upstreamReq.destroy();
        if (!res.headersSent) {
          res.status(504).json({ error: 'انتهت مهلة انتظار المصدر' });
        }
      }
    });

    req.on('close', () => {
      upstreamReq.destroy();
      res.destroy();
    });
  }

  makeRequest();
}

// ==========================================================================
// 📊 نظام الجودات المحسّن
// ==========================================================================
const QUALITY_ALIASES = {
  '2160': 2160, '4k': 2160,
  '1440': 1440, '2k': 1440,
  '1080': 1080, '720': 720, '480': 480,
  '360': 360, '240': 240, '144': 144
};

function resolveQuality(quality) {
  if (!quality) return null;
  const q = String(quality).toLowerCase().replace(/p$/, '');
  if (q === 'audio') return { type: 'audio' };
  const height = QUALITY_ALIASES[q] || parseInt(q, 10);
  if (!height || Number.isNaN(height)) return null;
  return { type: 'video', height };
}

function getVideoFormats(info) {
  return (info.formats || []).filter(f => f && f.height && f.vcodec && f.vcodec !== 'none');
}

function chooseQualityFormats(info, requestedHeight) {
  const formats = getVideoFormats(info);
  if (!formats.length) throw new Error('No video formats available');

  const exact = formats.filter(f => Number(f.height) === requestedHeight);
  const below = formats.filter(f => Number(f.height) < requestedHeight)
    .sort((a, b) => Number(b.height) - Number(a.height));
  const above = formats.filter(f => Number(f.height) > requestedHeight)
    .sort((a, b) => Number(a.height) - Number(b.height));

  const same = exact.length ? exact : (below[0] ? formats.filter(f => f.height === below[0].height) : formats.filter(f => f.height === above[0].height));
  const actualHeight = Number(same[0].height);

  const progressive = same
    .filter(f => f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];

  if (progressive) {
    return {
      mode: 'direct',
      actualHeight,
      videoFormatId: String(progressive.format_id),
      audioFormatId: null
    };
  }

  const video = same.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
  const audio = (info.formats || [])
    .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];

  if (!video || !audio) throw new Error('Video/audio format unavailable');

  return {
    mode: 'merge',
    actualHeight,
    videoFormatId: String(video.format_id),
    audioFormatId: String(audio.format_id)
  };
}

function getAvailableQualities(info) {
  return [...new Set(
    getVideoFormats(info).map(f => Number(f.height)).filter(Number.isFinite)
  )].sort((a, b) => b - a);
}

// ==========================================================================
// 🔧 ffmpeg محسّن - الحل الثاني للتقطع
// ==========================================================================
function streamMergedViaFfmpeg(req, res, videoUrl, audioUrl) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36';
  
  const inputArgs = [
    '-user_agent', UA, 
    '-reconnect', '1', 
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5', 
    '-i', videoUrl
  ];

  if (audioUrl) {
    inputArgs.push(
      '-user_agent', UA, 
      '-reconnect', '1', 
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5', 
      '-i', audioUrl
    );
  }

  const args = [
    '-loglevel', 'error', 
    '-hide_banner',
    '-fflags', 'nobuffer', // تقليل delay
    '-flags', 'low_delay', // تقليل latency
    '-bufsize', '16M', // buffer أكبر
    ...inputArgs,
    '-map', '0:v:0',
    ...(audioUrl ? ['-map', '1:a:0'] : ['-map', '0:a:0?']),
    '-c:v', 'copy', // copy بدل transcode
    '-c:a', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
    '-f', 'mp4', 
    'pipe:1'
  ];

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Connection', 'keep-alive');

  const ff = spawn('ffmpeg', args, { 
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  let stderrBuf = '';
  let dataStarted = false;
  const startTimeout = setTimeout(() => {
    if (!dataStarted && !ff.killed) {
      log.error('ffmpeg data timeout - no output after 10s');
      ff.kill('SIGKILL');
      if (!res.headersSent) {
        res.status(504).json({ error: 'ffmpeg timeout' });
      }
    }
  }, 10000);

  ff.stderr.on('data', d => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
  });

  ff.stdout.on('data', () => {
    dataStarted = true;
    clearTimeout(startTimeout);
  });

  ff.stdout.pipe(res, { highWaterMark: 1024 * 512 });

  const cleanup = () => {
    clearTimeout(startTimeout);
    if (!ff.killed) {
      try { ff.kill('SIGKILL'); } catch {}
    }
  };

  ff.on('error', e => {
    log.error(`ffmpeg spawn error: ${e.message}`);
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: 'ffmpeg غير متاح' });
    }
  });

  ff.on('close', code => {
    clearTimeout(startTimeout);
    if (code !== 0 && code !== null && !res.writableEnded) {
      log.warn(`ffmpeg exit code ${code}: ${stderrBuf.slice(-200)}`);
    }
  });

  res.on('close', cleanup);
  req.on('close', cleanup);
}

// ==========================================================================
// 🔍 Search
// ==========================================================================
async function searchVideos(query, limit = 10) {
  log.info(`🔎 Searching: "${query}" (limit ${limit})`);
  const stdout = await runYtDlp([`ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist']);
  return parseFlatItems(stdout);
}

// ==========================================================================
// 📌 Related videos
// ==========================================================================
async function getRelatedVideos(videoId, limit = 10) {
  const key = `related_pool_v8_${videoId}_${limit}`;
  const cached = infoCache.get(key);
  if (cached) return cached;

  return dedupe(key, async () => {
    const again = infoCache.get(key);
    if (again) return again;

    let title = '';
    try {
      const info = await getVideoInfo(videoId);
      title = String(info.title || '').replace(/[|]/g, ' ').trim();
    } catch (e) {
      log.warn(`Related info lookup failed: ${e.message}`);
    }

    const results = await Promise.allSettled([
      runYtDlp([
        '--dump-json', '--flat-playlist', '--yes-playlist',
        '--playlist-end', String(Math.max(limit * 3, 20)),
        `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`
      ]).then(x => parseFlatItems(x, videoId)),
      ...(title ? [runYtDlp([
        `ytsearch${Math.max(limit * 3, 20)}:${title}`,
        '--dump-json', '--flat-playlist'
      ]).then(x => parseFlatItems(x, videoId))] : [])
    ]);

    const ranked = [];
    const seen = new Set([videoId]);
    for (const r of results) {
      if (r.status !== 'fulfilled') {
        log.warn(`Related source failed`);
        continue;
      }
      for (const item of r.value) {
        if (!item?.id || seen.has(item.id) || isUnwantedContent(item.title)) continue;
        seen.add(item.id);
        ranked.push(item);
      }
    }

    const final = ranked.slice(0, limit);
    infoCache.set(key, final, 1800);
    return final;
  });
}

// ==========================================================================
// 🎬 ENDPOINTS
// ==========================================================================

/**
 * GET /video?v=VIDEO_ID&quality=1080
 * البث الرئيسي المحسّن
 */
app.get('/video', async (req, res) => {
  const { v: videoId, format = 'best', quality } = req.query;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({
      error: 'Video ID مطلوب وصحيح (11 حرف)',
      example: '/video?v=dQw4w9WgXcQ&quality=1080'
    });
  }

  try {
    const resolved = resolveQuality(quality);

    if (resolved?.type === 'audio') {
      const urls = await getFormatUrls(videoId, 'bestaudio/best');
      return streamFromUpstream(req, res, urls[0]);
    }

    if (resolved?.type === 'video') {
      const info = await getVideoInfo(videoId);
      const selected = chooseQualityFormats(info, resolved.height);

      if (selected.mode === 'direct') {
        const urls = await getFormatUrls(videoId, selected.videoFormatId);
        res.setHeader('X-Video-Quality', `${selected.actualHeight}p`);
        res.setHeader('X-Stream-Mode', 'direct');
        if (info.duration) res.setHeader('X-Duration', String(info.duration));
        return streamFromUpstream(req, res, urls[0]);
      }

      const urls = await getFormatUrls(
        videoId,
        `${selected.videoFormatId}+${selected.audioFormatId}`
      );
      if (urls.length < 2) throw new Error('Could not resolve video/audio URLs');

      res.setHeader('X-Video-Quality', `${selected.actualHeight}p`);
      res.setHeader('X-Stream-Mode', 'ffmpeg');
      if (info.duration) res.setHeader('X-Duration', String(info.duration));
      return streamMergedViaFfmpeg(req, res, urls[0], urls[1]);
    }

    // Default best quality
    const cacheKey = `default_stream_${videoId}_${format}`;
    const streamUrl = await dedupe(cacheKey, async () => {
      const cached = streamCache.get(cacheKey);
      if (cached) return cached;

      const url = await getVideoStreamUrl(videoId, format);
      if (!url) throw new Error('Failed to get stream URL');
      streamCache.set(cacheKey, url, 600);
      return url;
    });

    return streamFromUpstream(req, res, streamUrl);

  } catch (error) {
    log.error(`Error streaming ${videoId}: ${error.message}`);
    if (res.headersSent) return;

    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('unavailable') || msg.includes('not available')) {
      return res.status(404).json({ error: 'الفيديو غير متاح أو محذوف' });
    }
    if (msg.includes('private')) {
      return res.status(403).json({ error: 'الفيديو خاص' });
    }
    if (msg.includes('age')) {
      return res.status(403).json({ error: 'الفيديو يحتاج verification العمر' });
    }

    return res.status(500).json({
      error: 'فشل في تشغيل الفيديو',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
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
    log.success(`✅ Got info: ${info.title} (duration: ${info.duration}s)`);

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
    const info = await getVideoInfo(videoId);
    const formats = (info.formats || [])
      .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
      .map(f => ({
        formatId: String(f.format_id),
        format: f.format,
        videoCodec: f.vcodec,
        audioCodec: f.acodec,
        height: f.height || null,
        width: f.width || null,
        fps: f.fps || null,
        bitrate: f.tbr || f.vbr || f.abr || null,
        fileSize: f.filesize || f.filesize_approx || null,
        hasVideo: f.vcodec && f.vcodec !== 'none',
        hasAudio: f.acodec && f.acodec !== 'none'
      }))
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));

    res.json({ id: videoId, title: info.title, count: formats.length, formats });
  } catch (error) {
    log.error(`Error fetching formats: ${error.message}`);
    res.status(500).json({ error: 'تعذّر جلب الـ formats' });
  }
});

/**
 * GET /video/qualities?v=VIDEO_ID
 */
app.get('/video/qualities', async (req, res) => {
  const videoId = req.query.v;
  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }

  const cacheKey = `qualities_v8_${videoId}`;
  const cached = infoCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const info = await getVideoInfo(videoId);
    const heights = getAvailableQualities(info);

    const qualities = heights.map(h => {
      const selected = chooseQualityFormats(info, h);
      return {
        label: h >= 2160 ? '4K' : `${h}p`,
        quality: String(h),
        height: h,
        type: selected.mode === 'direct' ? 'direct' : 'merged (ffmpeg)',
        formatId: selected.videoFormatId,
        url: `/video?v=${encodeURIComponent(videoId)}&quality=${h}`
      };
    });

    qualities.push({
      label: '🎧 صوت فقط',
      quality: 'audio',
      type: 'audio',
      url: `/video?v=${encodeURIComponent(videoId)}&quality=audio`
    });

    const result = { id: videoId, title: info.title, duration: info.duration || 0, qualities };
    infoCache.set(cacheKey, result, 10800);
    res.json(result);

  } catch (error) {
    log.error(`Error fetching qualities: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الجودات المتاحة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /search?q=QUERY&limit=20&page=1
 */
app.get('/search', async (req, res) => {
  const { q: query, limit = 20, page = 1 } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Search query مطلوب' });
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

  try {
    const cacheKey = `search_${query}_${pageSize * pageNum}`;
    const cached = infoCache.get(cacheKey);

    let results = cached || await searchVideos(query, pageSize * pageNum);
    if (!cached) infoCache.set(cacheKey, results, 3600);

    const start = (pageNum - 1) * pageSize;
    const end = start + pageSize;
    const paged = results.slice(start, end);
    const hasMore = results.length > end;

    res.json({
      query,
      page: pageNum,
      limit: pageSize,
      count: paged.length,
      hasMore,
      results: paged
    });
  } catch (error) {
    log.error(`Search error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر البحث',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /related?v=VIDEO_ID&limit=10&page=1
 */
app.get('/related', async (req, res) => {
  const { v: videoId, limit = 10, page = 1 } = req.query;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID مطلوب' });
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);

  try {
    const allRelated = await getRelatedVideos(videoId, pageSize * pageNum);
    const start = (pageNum - 1) * pageSize;
    const paged = allRelated.slice(start, start + pageSize);
    const hasMore = allRelated.length > start + pageSize;

    res.json({
      videoId,
      page: pageNum,
      limit: pageSize,
      count: paged.length,
      hasMore,
      results: paged
    });
  } catch (error) {
    log.error(`Related error: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الفيديوهات المقترحة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'operational',
    version: SERVER_VERSION,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlpReady: checkYtDlp(),
    ytdlpVersion: (() => { try { return require('child_process').execFileSync('yt-dlp', ['--version'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
    ffmpegReady: (() => { try { require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' }); return true; } catch { return false; } })(),
    cookiesReady,
    concurrency: { max: YTDLP_CONCURRENCY, current: ytdlpLimiter.current, queued: ytdlpLimiter.queue.length }
  });
});

/**
 * GET /
 */
app.get('/', (req, res) => {
  res.json({
    name: '🎬 srver v8.0.0 "الجبار" - YouTube media server',
    version: SERVER_VERSION,
    status: '✅ محسّن وخالي من التقطع والتأخير',
    improvements: [
      '✅ timeout محسّن (120 ثانية)',
      '✅ retry logic ذكية مع exponential backoff',
      '✅ ffmpeg مُحسّن بـ low_delay + frag_keyframe',
      '✅ buffer أكبر وأكثر استقراراً',
      '✅ dual-connection recovery',
      '✅ مدة الفيديو تظهر في headers'
    ],
    endpoints: {
      video: '/video?v=VIDEO_ID&quality=1080',
      videoQualities: '/video/qualities?v=VIDEO_ID',
      info: '/info?v=VIDEO_ID',
      formats: '/formats?v=VIDEO_ID',
      search: '/search?q=QUERY&page=1&limit=20',
      related: '/related?v=VIDEO_ID&page=1',
      health: '/health'
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
╔════════════════════════════════════════════╗
║  🎬 srver v${SERVER_VERSION} "الجبار" شغّال 🔥      ║
║  ════════════════════════════════════════  ║
║  📊 محسّن وخالي من التقطع والتأخير        ║
║  yt-dlp: ${ytdlpStatus}  Concurrency: ${String(YTDLP_CONCURRENCY).padEnd(19, ' ')}║
║  http://0.0.0.0:${PORT}                            ║
╚════════════════════════════════════════════╝
  `);
  log.success(`✅ Server ready - No lag, No cuts! 🚀`);
  log.info(`📍 Stream timeout: ${STREAM_TIMEOUT / 1000}s | Retry: ${MAX_RETRIES} attempts`);
});

process.on('SIGINT', () => {
  log.warn('Shutting down...');
  server.close(() => {
    log.success('Server stopped');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  log.warn('Terminating...');
  server.close(() => process.exit(0));
});

process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled Rejection: ${reason}`);
});
