const express = require('express');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const https = require('https');
require('dotenv').config();

// ==========================================================================
// 🔖 server v5.7.0 "جبارة ⚡" — تحسينات startup latency مع الحفاظ على كل الـfeatures:
//   • Format selection ذكي (Progressive first → Direct stream)
//   • FFmpeg فقط عند الحاجة (منفصل video+audio)
//   • Smart format metadata caching
//   • Request deduplication
//   • Range support محسّن
// ==========================================================================
const SERVER_VERSION = '6.3.6-6.0-stream-quality-ytdlp-client-fix';

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Lightweight request diagnostics; never expose cookies or auth material.
app.use((req, res, next) => {
  metrics.requests++;
  const started = process.hrtime.bigint();
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  req.requestId = rid;
  res.setHeader('X-Request-ID', rid);
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms > 1500) log.warn(`🐢 ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms [${rid}]`);
  });
  next();
});

// Firebase config
const FIREBASE_URL = process.env.FIREBASE_URL || 'https://english-73376-default-rtdb.firebaseio.com';
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';

// CORS — بروكسي عام (بحث/ترند/فيديو) من غير كوكيز أو تسجيل دخول
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Timing-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());
app.use(express.text({ limit: '10mb' }));

// ============= Caches =============
const infoCache = new NodeCache({ stdTTL: 7200 });          // 2 hours
const trendingCache = new NodeCache({ stdTTL: 1200 });      // 20 minutes
const streamCache = new NodeCache({ stdTTL: 240 });         // 4 minutes (URLs expire)
const formatCache = new NodeCache({ stdTTL: 3600 });        // 1 hour (format metadata)
const channelCache = new NodeCache({ stdTTL: 3600 });       // 1 hour
const failureCache = new NodeCache({ stdTTL: 20 });         // 20 seconds
const liveCache = new NodeCache({ stdTTL: 20 });             // short-lived live URLs

// Track in-flight format extractions to avoid duplicate yt-dlp calls
const inFlightFormats = new Map();
// Deduplicate expensive URL/metadata extraction across simultaneous requests.
const inFlightUrls = new Map();
const inFlightInfo = new Map();
const metrics = {
  requests: 0, errors: 0, cacheHits: 0, cacheMisses: 0,
  ytDlpRuns: 0, startedAt: Date.now(), lastError: null
};

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
// Concurrency limiter
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
// Cookies — YouTube cookies from Firebase
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
 * Auto-update yt-dlp
 */
async function updateYtDlp() {
  try {
    log.info('🔄 جاري التأكد من تحديث yt-dlp...');
    const { stdout } = await execFileAsync('pip3', [
      'install', '--break-system-packages', '--no-cache-dir', '--upgrade', 'yt-dlp[default]', 'yt-dlp-ejs'
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
// yt-dlp is installed by the Docker image. Do not run pip during startup or requests.
// Keeping package management out of the runtime prevents startup races and latency.

function checkYtDlp() {
  try {
    require('child_process').execSync('yt-dlp --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ==========================================================================
// yt-dlp configuration — CRITICAL: DO NOT CHANGE
// ==========================================================================
const YTDLP_EXTRA_ARGS = [
  '--extractor-args', 'youtube:player_client=default,web_embedded',
  '--js-runtimes', 'node'
];

let lastStderrLogTs = 0;
async function runYtDlp(args, { timeout = TIMEOUT, maxBuffer = 1024 * 1024 * 10 } = {}) {
  metrics.ytDlpRuns++;
  await ytdlpLimiter.acquire();
  try {
    const finalArgs = cookiesReady ? ['--cookies', COOKIES_PATH, ...args] : args;
    const { stdout, stderr } = await execFileAsync('yt-dlp', [...YTDLP_EXTRA_ARGS, ...finalArgs], {
      timeout,
      maxBuffer,
      encoding: 'utf-8'
    });
    if (stderr && stderr.trim() && Date.now() - lastStderrLogTs > 10000) {
      lastStderrLogTs = Date.now();
      log.warn(`yt-dlp stderr (sample): ${stderr.trim().slice(0, 300)}`);
    }
    return stdout;
  } catch (e) {
    if (e.stderr && !e.message.includes(e.stderr.trim().slice(0, 30))) {
      const shortStderr = e.stderr.trim().split('\n').slice(-2).join(' | ').slice(0, 250);
      e.message = `${e.message.split('\n')[0]} :: ${shortStderr}`;
    }
    throw e;
  } finally {
    ytdlpLimiter.release();
  }
}

// ==========================================================================
// Validation & Helpers
// ==========================================================================
function isValidVideoId(id) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function sanitizeFilename(name) {
  return name.replace(/[^\w\s-]/g, '').substring(0, 100) || 'video';
}

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

const UNWANTED_KEYWORDS = [
  'كرتون', 'رسوم متحركة', 'للأطفال', 'اطفال', 'أطفال', 'بيبي', 'بيبى', 'روضة',
  'حضانة', 'قصص اطفال', 'قصص أطفال', 'اغاني اطفال', 'أغاني أطفال', 'العاب اطفال',
  'ألعاب أطفال', 'تعليم اطفال', 'تعليم أطفال', 'انمي اطفال', 'مسلسل كرتون',
  'cartoon', 'kids', 'for kids', 'nursery rhyme', 'nursery rhymes', 'cocomelon',
  'baby shark', 'peppa pig', 'toddler', 'preschool', 'children song',
  'وصفة', 'وصفات', 'طبخ', 'طبخة', 'طريقة عمل', 'حلويات', 'أكلة', 'اكلة',
  'مطبخ', 'شيف', 'recipe', 'cooking', 'kitchen'
];

function isUnwantedContent(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return UNWANTED_KEYWORDS.some(k => t.includes(k.toLowerCase()));
}

function filterUnwanted(items) {
  return items.filter(v => !isUnwantedContent(v.title));
}

// ==========================================================================
// Core Video Functions
// ==========================================================================

/**
 * Get complete video info with format metadata
 * بيرجع info + formats
 */
async function getVideoInfo(videoId) {
  const key = `info_${videoId}`;
  const cached = infoCache.get(key);
  if (cached) { metrics.cacheHits++; return cached; }
  metrics.cacheMisses++;
  if (inFlightInfo.has(videoId)) return inFlightInfo.get(videoId);

  const promise = (async () => {
    try {
      const stdout = await runYtDlp(['--dump-json', `https://www.youtube.com/watch?v=${videoId}`], { timeout: 45000 });
      const info = JSON.parse(stdout);
      infoCache.set(key, info);
      return info;
    } catch (e) {
      metrics.errors++;
      metrics.lastError = { at: new Date().toISOString(), message: e.message };
      throw e;
    } finally {
      inFlightInfo.delete(videoId);
    }
  })();
  inFlightInfo.set(videoId, promise);
  return promise;
}

/**
 * Fast path for common low/medium progressive qualities.
 * This avoids parsing a full --dump-json response on the first play request.
 */
async function getFastProgressiveUrl(videoId, height) {
  const h = Math.max(1, Number(height) || 0);
  if (!h || h > 720) return null;
  const key = `fast_progressive_${videoId}_${h}`;
  const cached = streamCache.get(key);
  if (cached) { metrics.cacheHits++; return cached; }
  metrics.cacheMisses++;
  if (inFlightUrls.has(key)) return inFlightUrls.get(key);

  const promise = (async () => {
    try {
      const selector = `best[height<=${h}][vcodec!=none][acodec!=none]/best[height<=${h}]`;
      const stdout = await runYtDlp([
        '--get-url', '-f', selector,
        `https://www.youtube.com/watch?v=${videoId}`
      ], { timeout: 22000, maxBuffer: 1024 * 1024 * 2 });
      const url = stdout.trim().split(/\r?\n/).filter(Boolean)[0];
      if (url) {
        streamCache.set(key, url);
        return url;
      }
      return null;
    } catch (e) {
      log.warn(`Fast progressive lookup failed (${videoId}/${h}): ${e.message}`);
      return null;
    } finally {
      inFlightUrls.delete(key);
    }
  })();
  inFlightUrls.set(key, promise);
  return promise;
}

/**
 * Get format metadata for a video (cached)
 * استخراج معلومات الـformats فقط بدون URL extraction
 */
async function getFormatMetadata(videoId) {
  const cacheKey = `formats_meta_${videoId}`;
  const cached = formatCache.get(cacheKey);
  if (cached) {
    log.info(`📦 Format metadata from cache: ${videoId}`);
    return cached;
  }

  // Check if extraction is in-flight
  if (inFlightFormats.has(videoId)) {
    log.info(`⏳ Waiting for in-flight format extraction: ${videoId}`);
    return inFlightFormats.get(videoId);
  }

  const promise = (async () => {
    try {
      const info = await getVideoInfo(videoId);
      const formats = info.formats || [];
      
      const metadata = {
        videoId,
        title: info.title,
        duration: info.duration,
        hasProgressiveFormats: false,
        progressiveFormats: [],
        videoOnlyFormats: {},
        audioOnlyFormats: [],
        allFormats: formats,
        allHeights: []
      };

      // Analyze formats
      formats.forEach(f => {
        if (f.vcodec !== 'none' && f.acodec !== 'none') {
          // Progressive (video + audio together)
          metadata.hasProgressiveFormats = true;
          metadata.progressiveFormats.push(f.format_id);
        } else if (f.vcodec !== 'none') {
          // Video only
          const h = f.height || 0;
          if (!metadata.videoOnlyFormats[h]) {
            metadata.videoOnlyFormats[h] = [];
          }
          metadata.videoOnlyFormats[h].push(f.format_id);
        } else if (f.acodec !== 'none') {
          // Audio only
          metadata.audioOnlyFormats.push(f.format_id);
        }
      });

      metadata.allHeights = [...new Set(
        formats
          .filter(f => f && f.vcodec !== 'none' && Number(f.height) > 0)
          .map(f => Number(f.height))
      )].sort((a, b) => b - a);

      metadata.isLive = Boolean(info.is_live || info.live_status === 'is_live');
      metadata.liveStatus = info.live_status || null;

      // Prewarm every direct/progressive format returned by yt-dlp.
      const progressive = formats
        .filter(f => f && f.url && f.vcodec !== 'none' && f.acodec !== 'none')
        .sort((a, b) => {
          const ah = Number(a.height) || 0, bh = Number(b.height) || 0;
          if (ah !== bh) return bh - ah;
          return (Number(b.tbr) || 0) - (Number(a.tbr) || 0);
        });

      for (const f of progressive) {
        streamCache.set(`urls_${videoId}_${f.format_id}`, [f.url]);
      }
      if (progressive[0]?.url) {
        streamCache.set(`stream_default_${videoId}`, progressive[0].url);
      }

      formatCache.set(cacheKey, metadata);
      return metadata;
    } catch (e) {
      log.error(`Format metadata extraction failed: ${e.message}`);
      inFlightFormats.delete(videoId);
      throw e;
    } finally {
      inFlightFormats.delete(videoId);
    }
  })();

  inFlightFormats.set(videoId, promise);
  return promise;
}

/**
 * Get streaming URL for a format selector
 * بيرجع واحد أو أكتر من الروابط (فيديو، صوت، أو مدمج)
 */
async function getFormatUrls(videoId, formatSelector) {
  const key = `urls_${videoId}_${formatSelector}`;
  const cached = streamCache.get(key);
  if (cached) { metrics.cacheHits++; return Array.isArray(cached) ? cached : [cached]; }
  metrics.cacheMisses++;
  if (inFlightUrls.has(key)) return inFlightUrls.get(key);

  const promise = (async () => {
    try {
      // Fast path: use URLs already returned by the metadata extraction when available.
      const info = await getVideoInfo(videoId);
      const ids = String(formatSelector).split('+');
      const direct = ids.map(id => (info.formats || []).find(f => String(f.format_id) === String(id))?.url).filter(Boolean);
      if (direct.length === ids.length) {
        streamCache.set(key, direct);
        return direct;
      }

      const stdout = await runYtDlp(['--get-url', '-f', formatSelector, `https://www.youtube.com/watch?v=${videoId}`], { timeout: 45000 });
      const urls = stdout.trim().split('\n').map(x => x.trim()).filter(Boolean);
      if (urls.length) streamCache.set(key, urls);
      return urls;
    } finally {
      inFlightUrls.delete(key);
    }
  })();
  inFlightUrls.set(key, promise);
  return promise;
}

/**
 * Select best progressive format for requested quality
 * بيرجع format_id أو null
 */
function selectProgressiveFormat(metadata, requestedHeight) {
  const formats = metadata.allFormats || [];
  const target = Number(requestedHeight) || 0;
  if (!target) return null;

  // First determine the best REAL video height available at or below target.
  const actualHeights = [...new Set(
    formats.filter(f => f && f.vcodec !== 'none' && Number(f.height) > 0)
      .map(f => Number(f.height))
  )].sort((a, b) => b - a);
  const bestHeight = actualHeights.find(h => h <= target);
  if (!bestHeight) return null;

  // Only return a progressive format when it represents that real best height.
  // This prevents a requested 1080p stream from silently becoming 720p.
  const candidates = formats
    .filter(f => f && Number(f.height) === bestHeight && f.vcodec !== 'none' && f.acodec !== 'none' && f.url)
    .sort((a, b) => (Number(b.abr) || 0) - (Number(a.abr) || 0));

  return candidates[0]?.format_id || null;
}

/**
 * Select best separate video+audio formats
 * بيرجع [videoFormatId, audioFormatId]
 */
function selectSeparateFormats(metadata, requestedHeight) {
  const videoHeights = Object.keys(metadata.videoOnlyFormats)
    .map(Number)
    .filter(h => h > 0)
    .sort((a, b) => b - a);

  if (!videoHeights.length) {
    return null;
  }

  // Find best video height
  let bestHeight = videoHeights.find(h => h <= requestedHeight) || videoHeights[0];
  const videoFormats = metadata.videoOnlyFormats[bestHeight];
  const videoFormatId = videoFormats ? videoFormats[0] : null;

  if (!videoFormatId) return null;

  // Get best audio
  const audioFormatId = metadata.audioOnlyFormats.length ? metadata.audioOnlyFormats[0] : null;

  return audioFormatId ? [videoFormatId, audioFormatId] : null;
}

// ==========================================================================

function pickBestProgressiveUrl(metadata, requestedHeight = 0) {
  const formats = (metadata?.allFormats || [])
    .filter(f => f && f.url && f.vcodec !== 'none' && f.acodec !== 'none' && Number(f.height) > 0);
  if (!formats.length) return null;
  const target = Number(requestedHeight) || 0;
  return formats.sort((a, b) => {
    const ah = Number(a.height) || 0, bh = Number(b.height) || 0;
    const aOk = !target || ah <= target, bOk = !target || bh <= target;
    if (aOk !== bOk) return aOk ? -1 : 1;
    if (aOk && ah !== bh) return bh - ah;
    if (!aOk && ah !== bh) return ah - bh;
    return (Number(b.tbr) || 0) - (Number(a.tbr) || 0);
  })[0];
}

function getAvailableQualityObjects(metadata, videoId) {
  const formats = metadata?.allFormats || [];
  const heights = [...new Set(
    formats.filter(f => f && f.vcodec !== 'none' && Number(f.height) > 0)
      .map(f => Number(f.height))
  )].sort((a, b) => b - a);
  const progressiveHeights = new Set(
    formats.filter(f => f && f.vcodec !== 'none' && f.acodec !== 'none' && Number(f.height) > 0)
      .map(f => Number(f.height))
  );
  return heights.map(h => ({
    label: h >= 2160 ? '4K' : `${h}p`,
    quality: String(h),
    height: h,
    type: progressiveHeights.has(h) ? 'direct' : 'merged (ffmpeg)',
    url: `/video?v=${encodeURIComponent(videoId)}&quality=${h}`
  }));
}

async function getLiveStreamUrl(videoId) {
  const key = `live_${videoId}`;
  const cached = liveCache.get(key);
  if (cached) return cached;
  if (inFlightUrls.has(key)) return inFlightUrls.get(key);

  const promise = (async () => {
    try {
      const stdout = await runYtDlp([
        '--get-url', '-f', 'best',
        `https://www.youtube.com/watch?v=${videoId}`
      ], { timeout: 30000, maxBuffer: 1024 * 1024 * 4 });
      const url = stdout.trim().split(/\r?\n/).filter(Boolean)[0];
      if (!url) throw new Error('Live stream URL not available');
      liveCache.set(key, url);
      return url;
    } finally {
      inFlightUrls.delete(key);
    }
  })();

  inFlightUrls.set(key, promise);
  return promise;
}

// Streaming functions
// ==========================================================================

/**
 * Direct stream from URL (proxy)
 */
function streamFromUpstream(req, res, url, redirectCount = 0) {
  if (redirectCount > 5) {
    if (!res.headersSent) res.status(502).json({ error: 'تحويلات كتير أوي من المصدر' });
    return;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  const upstreamReq = https.get(url, { headers, timeout: 20000, agent: keepAliveAgent }, (upstreamRes) => {
    if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
      upstreamRes.resume();
      return streamFromUpstream(req, res, upstreamRes.headers.location, redirectCount + 1);
    }

    if (upstreamRes.statusCode >= 400) {
      log.error(`Upstream video error: ${upstreamRes.statusCode}`);
      if (!res.headersSent) res.status(502).json({ error: 'تعذّر تحميل الفيديو من المصدر' });
      upstreamRes.resume();
      return;
    }

    res.status(upstreamRes.statusCode);
    if (!res.getHeader('Accept-Ranges')) res.setHeader('Accept-Ranges', upstreamRes.headers['accept-ranges'] || 'bytes');
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']
      .forEach(h => { if (upstreamRes.headers[h]) res.setHeader(h, upstreamRes.headers[h]); });

    if (req.method === 'HEAD') { upstreamRes.resume(); return res.end(); }
    upstreamRes.pipe(res);
  });

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('Upstream timeout')));
  upstreamReq.on('error', (err) => {
    log.error(`Stream proxy error: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: 'تعذّر الاتصال بمصدر الفيديو' });
  });

  req.on('close', () => upstreamReq.destroy());
}

/**
 * Merge video+audio via FFmpeg (fallback)
 */
function streamMergedViaFfmpeg(req, res, videoUrl, audioUrl) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const inputArgs = ['-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', videoUrl];
  if (audioUrl) inputArgs.push('-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', audioUrl);

  const args = [
    '-loglevel', 'error', '-hide_banner',
    ...inputArgs,
    '-map', '0:v:0', ...(audioUrl ? ['-map', '1:a:0'] : ['-map', '0:a:0?']),
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1'
  ];

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-cache');

  const ff = spawn('ffmpeg', args);
  let stderrBuf = '';
  ff.stderr.on('data', d => { stderrBuf += d.toString(); });
  ff.stdout.pipe(res);
  ff.on('error', (e) => {
    log.error(`ffmpeg spawn error: ${e.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'ffmpeg غير متاح على السيرفر' });
  });
  ff.on('close', (code) => {
    if (code !== 0 && code !== null && !res.writableEnded) {
      log.warn(`ffmpeg exited with code ${code}: ${stderrBuf.slice(-300)}`);
    }
  });
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch {} });
}

// ==========================================================================
// Quality mapping
// ==========================================================================
const QUALITY_HEIGHTS = {
  '2160': 2160, '4k': 2160,
  '1440': 1440, '2k': 1440,
  '1080': 1080,
  '720': 720,
  '480': 480,
  '360': 360,
  '240': 240,
  '144': 144
};

function resolveQuality(quality) {
  if (!quality) return null;
  const q = String(quality).toLowerCase().replace('p', '');
  if (q === 'audio') return { type: 'audio' };
  const height = QUALITY_HEIGHTS[q] || parseInt(q, 10);
  if (!height || Number.isNaN(height)) return null;
  return { type: 'video', height };
}

function availableHeights(metadata) {
  return [...new Set((metadata?.allFormats || [])
    .filter(f => f && f.vcodec !== 'none' && Number(f.height) > 0)
    .map(f => Number(f.height)))]
    .sort((a, b) => b - a);
}

function findExactProgressive(metadata, height) {
  return (metadata?.allFormats || [])
    .filter(f => f && f.url && f.vcodec !== 'none' && f.acodec !== 'none' && Number(f.height) === Number(height))
    .sort((a, b) => (Number(b.tbr) || 0) - (Number(a.tbr) || 0))[0] || null;
}

function findExactVideoOnly(metadata, height) {
  return (metadata?.allFormats || [])
    .filter(f => f && f.url && f.vcodec !== 'none' && f.acodec === 'none' && Number(f.height) === Number(height))
    .sort((a, b) => (Number(b.tbr) || 0) - (Number(a.tbr) || 0))[0] || null;
}

function findBestAudio(metadata) {
  return (metadata?.allFormats || [])
    .filter(f => f && f.url && f.vcodec === 'none' && f.acodec !== 'none')
    .sort((a, b) => (Number(b.abr) || 0) - (Number(a.abr) || 0))[0] || null;
}

function getAvailableQualityObjects(metadata, videoId) {
  const formats = metadata?.allFormats || [];
  const heights = availableHeights(metadata);
  const progressiveHeights = new Set(
    formats.filter(f => f && f.vcodec !== 'none' && f.acodec !== 'none' && Number(f.height) > 0)
      .map(f => Number(f.height))
  );
  return heights.map(h => ({
    label: h >= 2160 ? '4K' : `${h}p`,
    quality: String(h),
    height: h,
    type: progressiveHeights.has(h) ? 'direct' : 'merged (ffmpeg)',
    url: `/video?v=${encodeURIComponent(videoId)}&quality=${h}`
  }));
}

// ==========================================================================
// Search, related, and recommendations functions
// ==========================================================================

async function searchVideos(query, limit = 10) {
  log.info(`🔎 Searching: "${query}" (limit ${limit})`);
  const stdout = await runYtDlp([`ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist']);
  return parseFlatItems(stdout);
}

async function getRelatedVideos(videoId, limit = 10) {
  const url = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
  log.info(`🧭 Fetching related videos for: ${videoId} (limit ${limit})`);

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

const FOLLOWED_CREATORS = [
  'كامل العربي',
  'اوشا',
  'صلاح القصة وما فيها',
  'سامح سند',
  'بدر العلوي',
  'ابو الصادق',
  'مستر محمد ايمن الجوهري',
  'مستر محمد صلاح مدرس لغة انجليزية',
  'مستر محمد عبدالمعبود',
  'مستر رضا الفاروق',
  'انجلشاوي',
  'عبقري لغة خالد صقر',
  'قناة توست',
  'كوتش الغلابة'
];

async function getFollowedCreatorsPool(perCreator = 4) {
  const settled = await Promise.allSettled(
    FOLLOWED_CREATORS.map(name => runYtDlp([`ytsearch${perCreator}:${name}`, '--dump-json', '--flat-playlist']))
  );
  const pool = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') pool.push(...filterUnwanted(parseFlatItems(r.value)));
    else log.warn(`Followed creator fetch failed "${FOLLOWED_CREATORS[i]}": ${r.reason?.message}`);
  });
  return pool;
}

async function getRecommendedVideos(region = 'EG', limit = 20) {
  let items = [];
  const seen = new Set();
  function addUnique(list) {
    list.forEach(v => { if (v && v.id && !seen.has(v.id)) { seen.add(v.id); items.push(v); } });
  }

  try {
    const perCreator = Math.max(3, Math.ceil((limit * 1.4) / FOLLOWED_CREATORS.length));
    const creatorsPool = await getFollowedCreatorsPool(perCreator);
    addUnique(creatorsPool.sort(() => Math.random() - 0.5));
  } catch (e) {
    log.warn(`Followed creators pool failed: ${e.message}`);
  }

  if (items.length < limit) {
    try {
      const url = `https://www.youtube.com/feed/trending?gl=${encodeURIComponent(region)}`;
      const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(limit * 2), url]);
      addUnique(filterUnwanted(parseFlatItems(stdout)));
    } catch (e) {
      log.warn(`Trending feed failed (${e.message}), falling back to search-based mix`);
    }
  }

  if (items.length < limit) {
    const topicPool = [
      'أخبار مصر اليوم', 'أغاني مصرية جديدة', 'كوميدي مصري', 'رياضة مصر أهداف',
      'بودكاست عربي', 'أفلام كوميدي مصرية', 'مسلسلات رمضان', 'تكنولوجيا وتقنية',
      'ألعاب فيديو', 'سيارات ومحركات', 'سفر وسياحة', 'كورة أهداف دوري أبطال أوروبا',
      'علوم وتاريخ', 'موسيقى عربي مختلط', 'تمثيليات وكواليس', 'أفلام أكشن مترجمة'
    ];
    const shuffled = topicPool.sort(() => Math.random() - 0.5).slice(0, 5);
    const perQuery = Math.max(10, Math.ceil(limit / shuffled.length) + 5);
    const settled = await Promise.allSettled(
      shuffled.map(q => runYtDlp([`ytsearch${perQuery}:${q}`, '--dump-json', '--flat-playlist']))
    );
    const pool = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') pool.push(...filterUnwanted(parseFlatItems(r.value)));
      else log.warn(`Recommended fallback query failed "${shuffled[i]}": ${r.reason?.message}`);
    });
    addUnique(pool.sort(() => Math.random() - 0.5));
  }

  return { items: items.slice(0, limit), personalized: false };
}

// ==========================================================================
// Home sections
// ==========================================================================
const HOME_SECTIONS = [
  { key: 'trending', title: '🔥 الرائج الآن', query: null },
  { key: 'music', title: '🎵 موسيقى', query: 'أغاني عربي جديد 2026' },
  { key: 'sports', title: '⚽ رياضة', query: 'أهداف وملخصات مباريات' },
  { key: 'gaming', title: '🎮 ألعاب', query: 'ألعاب فيديو جيمنج' },
  { key: 'news', title: '📰 أخبار', query: 'أخبار عاجلة اليوم' },
  { key: 'tech', title: '💻 تكنولوجيا', query: 'تكنولوجيا مراجعات تقنية' },
  { key: 'entertainment', title: '🎬 ترفيه وأفلام', query: 'أفلام ومسلسلات تريلر' },
  { key: 'podcasts', title: '🎙️ بودكاست', query: 'بودكاست عربي حوار' },
  { key: 'comedy', title: '😂 كوميدي', query: 'فيديوهات كوميدي مضحكة' },
  { key: 'live', title: '🔴 مباشر الآن', query: 'بث مباشر live' }
];

async function getHomeFeed(region = 'EG', perSection = 12) {
  log.info(`🏠 Building home feed (region ${region}, ${perSection}/section)`);

  const sections = {};
  const mixed = [];
  const seen = new Set();

  const promises = HOME_SECTIONS.map(async section => {
    try {
      let items = [];
      if (section.query === null) {
        const url = `https://www.youtube.com/feed/trending?gl=${encodeURIComponent(region)}`;
        const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(perSection + 1), url]);
        items = filterUnwanted(parseFlatItems(stdout)).slice(0, perSection);
      } else {
        items = filterUnwanted(await searchVideos(section.query, perSection + 5)).slice(0, perSection);
      }
      sections[section.key] = { title: section.title, videos: items };
      items.forEach(v => { if (v && v.id && !seen.has(v.id)) { seen.add(v.id); mixed.push(v); } });
    } catch (e) {
      log.warn(`Section "${section.key}" failed: ${e.message}`);
      sections[section.key] = { title: section.title, videos: [] };
    }
  });

  await Promise.allSettled(promises);

  return { region, sections, mixed: mixed.slice(0, perSection * 3) };
}

/**
 * Paginated pool helper
 */
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

/**
 * Get channel videos
 */
async function getChannelVideos(channelId, limit = 20) {
  log.info(`📺 Fetching channel: ${channelId} (limit ${limit})`);
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(limit + 1), url]);
  const items = parseFlatItems(stdout);
  return {
    channel: { id: channelId },
    videos: items.slice(0, limit)
  };
}

// ==========================================================================
// HTTP Routes
// ==========================================================================

/**
 * GET /
 */
app.get('/', (req, res) => {
  res.json({
    name: '🎬 server v' + SERVER_VERSION + ' "جبارة ⚡"',
    version: SERVER_VERSION,
    environment: NODE_ENV,
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
    videoQualityValues: ['144', '240', '360', '480', '720', '1080', '1440', '2160', 'audio'],
    improvements: ['Prewarmed first-play URL', 'All detected qualities', 'Live stream support', 'Request deduplication', 'Range support']
  });
});

/**
 * GET /home
 */
app.get('/home', async (req, res) => {
  const region = (req.query.region || 'EG').toUpperCase();
  const perSection = Math.min(Math.max(parseInt(req.query.perSection, 10) || 12, 4), 25);

  const cacheKey = `home_${region}_${perSection}`;
  try {
    let data = trendingCache.get(cacheKey);
    if (!data) {
      data = await getHomeFeed(region, perSection);
      trendingCache.set(cacheKey, data);
    }
    log.success(`✅ Home feed done: ${region}`);
    res.json(data);
  } catch (error) {
    log.error(`Error building home feed: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر بناء الصفحة الرئيسية',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /trending
 */
app.get('/trending', async (req, res) => {
  const region = (req.query.region || 'EG').toUpperCase();
  const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 30);
  const needed = pageNum * pageSize;
  const poolSize = Math.min(Math.max(needed, pageSize * 2), 150);

  const cacheKey = `trending_${region}_${poolSize}`;
  try {
    let cached = trendingCache.get(cacheKey);
    if (!cached) {
      const url = `https://www.youtube.com/feed/trending?gl=${encodeURIComponent(region)}`;
      const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(poolSize), url]);
      cached = filterUnwanted(parseFlatItems(stdout));
      trendingCache.set(cacheKey, cached);
    }

    const start = (pageNum - 1) * pageSize;
    const results = cached.slice(start, start + pageSize);
    const hasMore = cached.length > start + pageSize;

    log.success(`✅ Trending done: ${region} page ${pageNum}`);
    res.json({ region, page: pageNum, limit: pageSize, count: results.length, hasMore, results });
  } catch (error) {
    log.error(`Error fetching trending: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الفيديوهات الرائجة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /search?q=QUERY&limit=20&page=1
 */
app.get('/search', async (req, res) => {
  const { q: query } = req.query;

  if (!query || !query.trim()) {
    return res.status(400).json({
      error: 'كلمة البحث مطلوبة',
      example: '/search?q=funny+cats&limit=20&page=1'
    });
  }

  try {
    const { page, limit, results, hasMore } = await getPaginatedPool(
      infoCache, `search_${query}`,
      (poolSize) => searchVideos(query, poolSize),
      req.query.page, req.query.limit
    );
    log.success(`✅ Search done: "${query}" page ${page}`);
    res.json({ query, page, limit, count: results.length, hasMore, results });
  } catch (error) {
    log.error(`Error searching: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر تنفيذ البحث',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /related?v=VIDEO_ID&limit=10&page=1
 */
app.get('/related', async (req, res) => {
  const { v: videoId } = req.query;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({
      error: 'Video ID مطلوب وصحيح (11 حرف)',
      example: '/related?v=dQw4w9WgXcQ&limit=10&page=1'
    });
  }

  try {
    const { page, limit, results, hasMore } = await getPaginatedPool(
      infoCache, `related_${videoId}`,
      (poolSize) => getRelatedVideos(videoId, poolSize),
      req.query.page, req.query.limit, 60
    );
    log.success(`✅ Related done: ${videoId} page ${page}`);
    res.json({ id: videoId, page, limit, count: results.length, hasMore, results });
  } catch (error) {
    log.error(`Error fetching related: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الفيديوهات المقترحة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /channel?id=CHANNEL_ID&limit=20&page=1
 */
app.get('/channel', async (req, res) => {
  const channelId = req.query.id;

  if (!channelId) {
    return res.status(400).json({
      error: 'channel id مطلوب',
      example: '/channel?id=UCxxxxxxxx&limit=20&page=1'
    });
  }

  try {
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 30);
    const needed = pageNum * pageSize;
    const poolSize = Math.min(Math.max(needed, pageSize * 2), 100);

    const dataCacheKey = `channel_${channelId}_${poolSize}`;
    let data = channelCache.get(dataCacheKey);
    if (!data) {
      data = await getChannelVideos(channelId, poolSize);
      channelCache.set(dataCacheKey, data);
    }

    const start = (pageNum - 1) * pageSize;
    const videos = data.videos.slice(start, start + pageSize);
    const hasMore = data.videos.length > start + pageSize;

    log.success(`✅ Channel done: ${channelId} page ${pageNum}`);
    res.json({ channel: data.channel, page: pageNum, limit: pageSize, count: videos.length, hasMore, videos });
  } catch (error) {
    log.error(`Error fetching channel: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب بيانات القناة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==========================================================================
// VIDEO STREAMING — OPTIMIZED FOR FAST STARTUP
// ==========================================================================

/**
 * GET /video?v=VIDEO_ID&quality=144|240|360|480|720|1080|1440|2160|audio
 * 
 * Strategy:
 * 1. Check cache for direct URL
 * 2. Get format metadata (cached)
 * 3. Try Progressive format first (direct stream, no FFmpeg)
 * 4. Fallback to separate video+audio (FFmpeg merge)
 */
app.get('/video', async (req, res) => {
  const startTime = Date.now();
  const { v: videoId, format, quality } = req.query;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({
      error: 'Video ID مطلوب وصحيح (11 حرف)',
      example: '/video?v=dQw4w9WgXcQ&quality=720'
    });
  }

  try {
    const metadata = await getFormatMetadata(videoId);

    if (metadata.isLive) {
      const liveUrl = await getLiveStreamUrl(videoId);
      log.success(`🔴 Live: ${videoId} startup=${Date.now() - startTime}ms`);
      return streamFromUpstream(req, res, liveUrl);
    }

    const resolved = resolveQuality(quality);

    // Explicit quality: exact height only. Never silently downgrade.
    if (resolved?.type === 'video') {
      const heights = availableHeights(metadata);
      if (!heights.includes(resolved.height)) {
        return res.status(404).json({
          error: `الجودة ${resolved.height}p غير متاحة لهذا الفيديو`,
          requestedQuality: resolved.height,
          availableQualities: heights.map(String),
          requestId: req.requestId
        });
      }

      const cacheKey = `stream_q_${videoId}_${resolved.height}`;
      const cached = streamCache.get(cacheKey);
      if (cached) {
        log.info(`⚡ Exact cached quality ${videoId}/${resolved.height}p startup=${Date.now() - startTime}ms`);
        return streamFromUpstream(req, res, cached);
      }

      // Keep 6.0's direct HTTP streaming path for progressive formats.
      const progressive = findExactProgressive(metadata, resolved.height);
      if (progressive?.url) {
        streamCache.set(cacheKey, progressive.url);
        log.info(`⚡ Exact progressive ${videoId}/${resolved.height}p startup=${Date.now() - startTime}ms`);
        return streamFromUpstream(req, res, progressive.url);
      }

      // Adaptive format: exact video height + best audio, remux only when necessary.
      const video = findExactVideoOnly(metadata, resolved.height);
      const audio = findBestAudio(metadata);
      if (!video?.url) {
        return res.status(404).json({
          error: `الجودة ${resolved.height}p موجودة في القائمة لكن رابط الفيديو غير متاح حاليًا`,
          requestedQuality: resolved.height,
          availableQualities: heights.map(String),
          requestId: req.requestId
        });
      }
      log.info(`🎬 Exact adaptive ${videoId}/${resolved.height}p -> FFmpeg startup=${Date.now() - startTime}ms`);
      return streamMergedViaFfmpeg(req, res, video.url, audio?.url || null);
    }

    if (resolved?.type === 'audio') {
      const audio = findBestAudio(metadata);
      if (!audio?.url) return res.status(404).json({ error: 'الصوت غير متاح', requestId: req.requestId });
      return streamFromUpstream(req, res, audio.url);
    }

    // Default playback remains compatible with 6.0: direct progressive stream first.
    if (!resolved && !format) {
      const warmed = streamCache.get(`stream_default_${videoId}`);
      if (warmed) return streamFromUpstream(req, res, warmed);
      const best = pickBestProgressiveUrl(metadata, 720) || pickBestProgressiveUrl(metadata);
      if (best?.url) {
        streamCache.set(`stream_default_${videoId}`, best.url);
        return streamFromUpstream(req, res, best.url);
      }
    }

    // Legacy format parameter. Preserve explicit selector behavior.
    const selector = format || 'best[height<=720]/best';
    const urls = await getFormatUrls(videoId, selector);
    if (!urls.length) throw new Error('Failed to get stream URL');
    return streamFromUpstream(req, res, urls[0]);

  } catch (error) {
    metrics.errors++;
    metrics.lastError = { at: new Date().toISOString(), message: error.message };
    log.error(`Error fetching video ${videoId}: ${error.message}`);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'تعذّر تشغيل الفيديو',
        details: NODE_ENV === 'development' ? error.message : undefined,
        requestId: req.requestId
      });
    }
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
      formats
    });

  } catch (error) {
    log.error(`Error fetching formats: ${error.message}`);
    res.status(500).json({ error: 'تعذّر جلب الـ formats' });
  }
});

/**
 * GET /video/qualities?v=VIDEO_ID
 * Returns available quality options
 */
app.get('/video/qualities', async (req, res) => {
  const videoId = req.query.v;
  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }

  const cacheKey = `qualities_${videoId}`;
  const cached = infoCache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const metadata = await getFormatMetadata(videoId);
    const qualities = getAvailableQualityObjects(metadata, videoId);
    const result = {
      id: videoId,
      title: metadata.title,
      isLive: Boolean(metadata.isLive),
      liveStatus: metadata.liveStatus,
      qualities,
      count: qualities.length
    };
    infoCache.set(cacheKey, result);
    return res.json(result);
  } catch (error) {
    log.error(`Error fetching qualities: ${error.message}`);
    return res.status(500).json({
      error: 'تعذّر جلب الجودات المتاحة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ==
// System endpoints
// ==========================================================================

/** Runtime diagnostics (no secrets/cookies exposed) */
app.get('/video/ready', async (req, res) => {
  const videoId = req.query.v;
  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }
  try {
    const metadata = await getFormatMetadata(videoId);
    if (metadata.isLive) await getLiveStreamUrl(videoId);
    return res.json({
      id: videoId,
      ready: true,
      isLive: Boolean(metadata.isLive),
      title: metadata.title,
      qualities: getAvailableQualityObjects(metadata, videoId),
      stream: `/video?v=${encodeURIComponent(videoId)}`
    });
  } catch (error) {
    return res.status(500).json({
      error: 'تعذّر تجهيز الفيديو',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/api/metrics', (req, res) => {
  res.json({
    ok: true,
    version: SERVER_VERSION,
    uptime: Math.round(process.uptime()),
    requests: metrics.requests,
    errors: metrics.errors,
    ytDlpRuns: metrics.ytDlpRuns,
    inflight: { info: inFlightInfo.size, formats: inFlightFormats.size, urls: inFlightUrls.size },
    caches: {
      info: infoCache.getStats(), format: formatCache.getStats(), stream: streamCache.getStats(),
      trending: trendingCache.getStats(), channel: channelCache.getStats()
    },
    concurrency: { max: YTDLP_CONCURRENCY, current: ytdlpLimiter.current, queued: ytdlpLimiter.queue.length },
    lastError: metrics.lastError
  });
});

app.post('/api/cache/clear', (req, res) => {
  infoCache.flushAll(); trendingCache.flushAll(); streamCache.flushAll(); formatCache.flushAll(); channelCache.flushAll(); failureCache.flushAll();
  res.json({ ok: true, message: 'تم مسح الـcache' });
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'operational',
    version: SERVER_VERSION,
    ytdlpVersion: (() => { try { return require('child_process').execSync('yt-dlp --version', { encoding: 'utf-8' }).trim(); } catch { return 'unknown'; } })(),
    ejsReady: (() => { try { require('child_process').execSync('python3 -c "import yt_dlp_ejs"', { stdio: 'ignore' }); return true; } catch { return false; } })(),
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlpReady: checkYtDlp(),
    ffmpegReady: (() => { try { require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' }); return true; } catch { return false; } })(),
    cookiesReady,
    concurrency: { max: YTDLP_CONCURRENCY, current: ytdlpLimiter.current, queued: ytdlpLimiter.queue.length },
    caches: {
      formatCache: formatCache.getStats(),
      streamCache: streamCache.getStats(),
      infoCache: infoCache.getStats()
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
          await refreshCookies();
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
    status: cookiesReady ? '✅ موجودة' : '❌ فارغة أو غير موجودة'
  });
});

// ==========================================================================
// 404 & Error handling
// ==========================================================================

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint غير موجود', path: req.path });
});

app.use((err, req, res, next) => {
  metrics.errors++;
  metrics.lastError = { at: new Date().toISOString(), message: err?.message || String(err), requestId: req.requestId };
  log.error(`Unhandled error [${req.requestId || 'no-id'}]: ${err?.message || err}`);
  if (res.headersSent) return next(err);
  res.status(500).json({
    error: 'خطأ في السيرفر',
    requestId: req.requestId,
    details: NODE_ENV === 'development' ? err?.message : undefined
  });
});

// ==========================================================================
// Server startup
// ==========================================================================

const server = app.listen(PORT, '0.0.0.0', () => {
  const ytdlpStatus = checkYtDlp() ? '✅' : '❌';
  console.log(`
╔═══════════════════════════════════════════╗
║  🎬 server v${SERVER_VERSION} "جبارة ⚡" شغّال 🔥      ║
║  ═════════════════════════════════════     ║
║  Environment: ${NODE_ENV.padEnd(26, ' ')}║
║  yt-dlp: ${ytdlpStatus}  Firebase Cookies (bg refresh)  ║
║  Concurrency: ${String(YTDLP_CONCURRENCY).padEnd(24, ' ')}║
║  http://0.0.0.0:${PORT}                        ║
╚═══════════════════════════════════════════╝
  `);
  log.success(`✅ Server ready - Optimized video startup`);
  log.info(`📍 Firebase: ${FIREBASE_URL}`);
  log.info(`⚡ Improvements: Progressive format first → Direct stream → FFmpeg fallback`);
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


// v6.3.5: 6.0 HTTP streaming engine + exact quality selector; no implicit downgrade.
