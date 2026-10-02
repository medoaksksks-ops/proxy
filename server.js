const express = require('express');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
// (مش محتاجين مكتبة cors تاني، الهيدرز بقت بتتحط يدوي فوق)
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
require('dotenv').config();

// ==========================================================================
// 🔖 srver v5.0.0 "جبارة" — نسخة موسّعة فوق v4.0 الأصلية بدون حذف أي حاجة:
//   • كل جودات الفيديو (144p → 4K) + دمج فيديو/صوت لحظي بـ ffmpeg للجودات
//     العالية اللي معندهاش progressive stream جاهز.
//   • هوم فيد بأقسام (Sections) زي صفحة يوتيوب الرئيسية الحقيقية.
//   • جلب متوازي (Promise.all) بدل التسلسلي → أسرع بشكل ملحوظ.
//   • keep-alive agent لإعادة استخدام الاتصالات مع جوجل.
// ==========================================================================
const SERVER_VERSION = '11.0.0-ULTRA-SPEED';

// Agent واحد بيعيد استخدام نفس اتصالات TCP/TLS بدل ما يفتح اتصال جديد لكل
// طلب لجوجل — ده اللي بيدي إحساس "سريع" فعلي في البث والـ API calls
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64, keepAliveMsecs: 30000, timeout: 15000 });

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
app.disable('x-powered-by');
app.set('etag', false);
app.set('trust proxy', true);
app.set('query parser', 'simple');

// ==========================================================================
// 🌐 CORS — السماح للـ Frontend من أي دومين بالاتصال بالسيرفر
// لا يحتاج إعادة Deploy جديد إذا كنت ستعدّل الملف ثم تعمل Redeploy من Railway.
// ==========================================================================
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // السماح لأي Origin. لو عايز تقفلها على دومين محدد غيّر '*' للدومين.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, X-Cookie-Update-Key'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, Cache-Control, ETag, Last-Modified, X-Video-Quality, X-Stream-Mode'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  // المتصفح يرسل OPTIONS قبل بعض طلبات POST/headers المخصصة.
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// Firebase config
const FIREBASE_URL = process.env.FIREBASE_URL || 'https://english-73376-default-rtdb.firebaseio.com';
const FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';

// CORS intentionally removed: same-origin deployment avoids browser preflight overhead.


// ==========================================================================
// 🧰 PRODUCTION MIDDLEWARE — ضغط JSON + حماية خفيفة من انفجار الطلبات
// لا نضغط الفيديو نفسه؛ الضغط مخصص لردود JSON الصغيرة فقط.
// ==========================================================================
const REQUEST_WINDOW_MS = 60 * 1000;
const REQUEST_LIMIT = Math.max(300, parseInt(process.env.REQUEST_LIMIT, 10) || 1200);
const requestBuckets = new Map();

app.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let bucket = requestBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + REQUEST_WINDOW_MS };
    requestBuckets.set(key, bucket);
  }

  bucket.count++;
  if (bucket.count > REQUEST_LIMIT && !req.path.startsWith('/video')) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({
      error: 'طلبات كثيرة مؤقتًا، جرّب بعد لحظات',
      retryAfter: 60
    });
  }

  // Cleanup old buckets occasionally so a busy server does not grow forever.
  if (requestBuckets.size > 5000 && now % 30000 < 20) {
    for (const [k, v] of requestBuckets) {
      if (v.resetAt <= now) requestBuckets.delete(k);
    }
  }
  next();
});

app.use(express.json({ limit: '512kb' }));


// ==========================================================================
// 🚀 TITAN CACHE — RAM only, LRU + TTL + stale-while-revalidate
// HTTP responses remain no-store; this cache is server-side and exists only
// to avoid spawning yt-dlp repeatedly for the exact same data.
// ==========================================================================
class MemoryTTLCache {
  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.hits = 0; this.misses = 0;
  }
  _touch(key, entry) { this.map.delete(key); this.map.set(key, entry); }
  get(key, allowStale = false) {
    const entry = this.map.get(key);
    if (!entry) { this.misses++; return undefined; }
    if (entry.expiresAt <= Date.now() && !allowStale) {
      this.map.delete(key); this.misses++; return undefined;
    }
    this.hits++; this._touch(key, entry);
    return entry.value;
  }
  peek(key) { return this.map.get(key)?.value; }
  getEntry(key) { return this.map.get(key); }
  set(key, value, ttlMs = 60000) {
    const now = Date.now();
    this.map.set(key, { value, createdAt: now, expiresAt: now + Math.max(1000, ttlMs) });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
    return value;
  }
  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }
  stats() {
    let fresh = 0, stale = 0; const now = Date.now();
    for (const e of this.map.values()) e.expiresAt > now ? fresh++ : stale++;
    return { entries: this.map.size, fresh, stale, hits: this.hits, misses: this.misses };
  }
}

const infoCache = new MemoryTTLCache(1200);
const searchCache = new MemoryTTLCache(500);
const feedCache = new MemoryTTLCache(300);
const streamCache = new MemoryTTLCache(1000);
const fastStreamCache = new MemoryTTLCache(600);
const channelCache = new MemoryTTLCache(250);
const suggestionCache = new MemoryTTLCache(150);

const CACHE_TTL = {
  info: 60 * 60 * 1000, search: 15 * 60 * 1000, feed: 15 * 60 * 1000,
  related: 30 * 60 * 1000, channel: 30 * 60 * 1000, stream: 10 * 60 * 1000, fastStream: 5 * 60 * 1000,
  suggestions: 5 * 60 * 1000
};

// Never make the browser/CDN serve an old API response; only our RAM cache is used.
app.use((req, res, next) => {
  if (req.path.startsWith('/video') || req.path.startsWith('/download') || req.path.startsWith('/api/me') || req.path === '/api/account-feed') {
    res.setHeader('Cache-Control', 'no-store');
  } else if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'public, max-age=3, stale-while-revalidate=30');
  }
  next();
});

const TIMEOUT = 45000;
const MAX_RETRIES = 2;

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
const META_CONCURRENCY = Math.max(1, parseInt(process.env.YTDLP_META_CONCURRENCY, 10) || 10);
const STREAM_CONCURRENCY = Math.max(1, parseInt(process.env.YTDLP_STREAM_CONCURRENCY, 10) || 4);
const ytdlpLimiter = new Semaphore(META_CONCURRENCY);
const streamLimiter = new Semaphore(STREAM_CONCURRENCY);

let nodeRuntime = null;
let runtimeChecked = false;
function detectNodeRuntime() {
  if (runtimeChecked) return nodeRuntime;
  runtimeChecked = true;
  try { require('child_process').execFileSync('node', ['--version'], { stdio: 'ignore' }); nodeRuntime = 'node'; } catch { nodeRuntime = null; }
  return nodeRuntime;
}

// منع تشغيل نفس yt-dlp أكثر من مرة لو عدة مستخدمين طلبوا نفس الشيء في نفس اللحظة.
const inflight = new Map();
function dedupe(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Return stale data immediately and refresh it once in the background. This is
// the main trick that keeps repeated page loads feeling instant without making
// the browser cache stale API responses.
async function staleWhileRevalidate(cache, key, fetchFn, ttl) {
  const entry = cache.getEntry(key);
  if (entry?.value !== undefined) {
    if (entry.expiresAt > Date.now()) return entry.value;
    dedupe(`swr:${key}`, async () => {
      try { cache.set(key, await fetchFn(), ttl); }
      catch (e) { log.warn(`SWR refresh failed ${key}: ${e.message}`); }
    });
    return entry.value;
  }
  return dedupe(`cold:${key}`, async () => {
    const again = cache.get(key); if (again !== undefined) return again;
    const value = await fetchFn(); cache.set(key, value, ttl); return value;
  });
}

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

// حفظ محلي على السيرفر — احتياطي لو Firebase رفض الكتابة (Permission denied)
function saveCookiesLocally(content) {
  fs.writeFileSync(COOKIES_PATH, content);
  lastCookiesContent = content;
  cookiesReady = true;
  feedCache.clear();
}
async function refreshCookies() {
  try {
    const content = await fetchCookiesFromFirebase();
    if (content && content.trim() && content !== lastCookiesContent) {
      fs.writeFileSync(COOKIES_PATH, content);
      lastCookiesContent = content;
      cookiesReady = true;
      feedCache.clear();
      log.success(`🍪 Cookies refreshed (${content.length} bytes)`);
    } else if (!content) {
      log.warn('⚠️  No cookies available in Firebase yet');
    }
  } catch (e) {
    log.error(`Cookie refresh failed: ${e.message}`);
  }
}
refreshCookies();


// Check if yt-dlp is installed
function checkYtDlp() { return commandExists('yt-dlp'); }

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
const commandCache = new Map();
function commandExists(command) {
  if (commandCache.has(command)) return commandCache.get(command);
  try { require('child_process').execFileSync(command, ['--version'], { stdio: 'ignore' }); commandCache.set(command, true); return true; }
  catch { commandCache.set(command, false); return false; }
}

function isRetryableYoutubeError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return /page needs to be reloaded|sign in to confirm|confirm you’re not a bot|confirm you're not a bot|http error 403|requested format is not available|video unavailable|not available in your country/.test(text);
}

async function runYtDlp(args, opts = {}) {
  // yt-dlp الحديث مبقاش بيعرف البريفكس ytsearchdateN: → بنحوّله تلقائيًا
  // لرابط بحث يوتيوب مرتّب بتاريخ الرفع (sp=CAI%3D)، ولو فشل نرجع لـ ytsearchN.
  const dateIdx = args.findIndex(a => typeof a === 'string' && /^ytsearchdate\d+:/.test(a));
  if (dateIdx !== -1) {
    const m = args[dateIdx].match(/^ytsearchdate(\d+):([\s\S]*)$/);
    const n = m[1], q = m[2];
    const urlArgs = [...args];
    urlArgs[dateIdx] = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=CAI%3D`;
    urlArgs.push('--playlist-end', n);
    try {
      return await runYtDlp(urlArgs, opts);
    } catch (e) {
      log.warn(`date-sorted search failed, falling back to ytsearch: ${String(e.message || e).split('\n')[0]}`);
      const plain = [...args];
      plain[dateIdx] = `ytsearch${n}:${q}`;
      return runYtDlp(plain, opts);
    }
  }
  const {
    timeout = TIMEOUT,
    maxBuffer = 1024 * 1024 * 12,
    useCookies = false,
    allowCookieFallback = true,
    lane = 'meta'
  } = opts;
  const limiter = lane === 'stream' ? streamLimiter : ytdlpLimiter;
  await limiter.acquire();
  try {
    const base = ['--no-warnings', '--geo-bypass'];
    if (detectNodeRuntime()) base.push('--js-runtimes', 'node');

    const attempts = [];
    const pushAttempt = (extra, cookies = false) => {
      attempts.push([...base, ...extra, ...(cookies && cookiesReady ? ['--cookies', COOKIES_PATH] : []), ...args]);
    };

    // Fast public attempt first. Cookies are used only when requested or as fallback.
    pushAttempt([], useCookies);
    if (!useCookies) pushAttempt(['--extractor-args', 'youtube:player_client=default,web_safari']);
    if (allowCookieFallback && cookiesReady && !useCookies) {
      pushAttempt(['--extractor-args', 'youtube:player_client=default,-tv_downgraded,web_embedded'], true);
      pushAttempt(['--extractor-args', 'youtube:player_client=web_embedded'], true);
    }

    let lastError;
    for (let i = 0; i < attempts.length; i++) {
      try {
        const { stdout } = await execFileAsync('yt-dlp', attempts[i], { timeout, maxBuffer, encoding: 'utf-8' });
        return stdout;
      } catch (error) {
        lastError = error;
        if (!isRetryableYoutubeError(error) && i === 0) throw error;
        if (i < attempts.length - 1) log.warn(`yt-dlp fallback ${i + 1}: ${String(error.message || error).split('\n')[0]}`);
      }
    }
    throw lastError;
  } finally {
    limiter.release();
  }
}

/** بيحوّل ناتج --dump-json (سطر لكل فيديو) لمصفوفة عناصر موحّدة الشكل */
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
    viewCount: item.view_count || 0,
    isLive: !!item.is_live,
    wasLive: !!item.was_live,
    liveStatus: item.live_status || null
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

/**
 * ==========================================================================
 * فلتر محتوى غير مرغوب فيه — بيستبعد فيديوهات الأطفال/الكرتون ومحتوى الطبخ
 * من "المقترحات" و"الهوم فيد" و"الترند" بس (مش من البحث الصريح أو القنوات
 * أو related لفيديو معيّن اختاره المستخدم بنفسه — لو المستخدم دور بايده على
 * "وصفات طبخ" مثلًا من الشيبس، ده اختياره وهيتنفّذ عادي).
 * ==========================================================================
 */
const UNWANTED_KEYWORDS = [
  // أطفال / كرتون
  'كرتون', 'رسوم متحركة', 'للأطفال', 'اطفال', 'أطفال', 'بيبي', 'بيبى', 'روضة',
  'حضانة', 'قصص اطفال', 'قصص أطفال', 'اغاني اطفال', 'أغاني أطفال', 'العاب اطفال',
  'ألعاب أطفال', 'تعليم اطفال', 'تعليم أطفال', 'انمي اطفال', 'مسلسل كرتون',
  'cartoon', 'kids', 'for kids', 'nursery rhyme', 'nursery rhymes', 'cocomelon',
  'baby shark', 'peppa pig', 'toddler', 'preschool', 'children song',
  // طبخ / وصفات
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

/**
 * جلب صفحة من نتايج بأي حجم مطلوب، مع كاش لكل "بركة" (pool) بحجمها —
 * عشان السكرول اللانهائي (infinite scroll) يقدر يكمّل يجيب صفحات جديدة
 * من غير ما يعيد طلب yt-dlp لنفس البيانات القديمة تاني.
 */
async function getPaginatedPool(cache, cacheKeyBase, fetchPoolFn, page, limit, maxPool = 150, ttl = CACHE_TTL.search) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 30);
  const needed = pageNum * pageSize;
  const poolSize = Math.min(Math.max(needed, pageSize * 2), maxPool);
  const cacheKey = `${cacheKeyBase}_${poolSize}`;
  const entry = cache.getEntry(cacheKey);
  let pool = entry?.value;
  if (!pool || entry.expiresAt <= Date.now()) {
    if (pool) {
      dedupe(`refresh:${cacheKey}`, async () => { const fresh = await fetchPoolFn(poolSize); cache.set(cacheKey, fresh, ttl); return fresh; }).catch(e => log.warn(`background refresh failed: ${e.message}`));
    } else {
      pool = await dedupe(`fill:${cacheKey}`, async () => {
        const again = cache.get(cacheKey); if (again) return again;
        const fresh = await fetchPoolFn(poolSize); cache.set(cacheKey, fresh, ttl); return fresh;
      });
    }
  }
  pool = pool || [];
  const start = (pageNum - 1) * pageSize;
  return { page: pageNum, limit: pageSize, results: pool.slice(start, start + pageSize), hasMore: pool.length > start + pageSize };
}

/**
 * الحصول على معلومات الفيديو الكاملة
 */
async function getVideoInfo(videoId) {
  const key = `raw_info_${videoId}`;
  const cached = infoCache.get(key);
  if (cached) return cached;

  return dedupe(key, async () => {
    const again = infoCache.get(key);
    if (again) return again;

    const stdout = await runYtDlp([
      '--dump-json', '--no-playlist',
      '--extractor-args', 'youtube:player_client=default,web_safari',
      `https://www.youtube.com/watch?v=${videoId}`
    ]);
    const info = JSON.parse(stdout);
    infoCache.set(key, info, CACHE_TTL.info);
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
    ], { timeout: 45000, lane: 'stream' });

    const urls = stdout.trim().split('\n').map(s => s.trim()).filter(Boolean);
    if (!urls.length) throw new Error('No stream URL returned');
    streamCache.set(key, urls, CACHE_TTL.stream);
    return urls;
  });
}

async function getVideoStreamUrl(videoId, format = 'best') {
  const urls = await getFormatUrls(videoId, format);
  const streamUrl = urls[0];
  log.success(`🎬 Got stream URL (${streamUrl.length} chars)`);
  return streamUrl;
}


/**
 * البحث عن فيديوهات على يوتيوب باستخدام yt-dlp (بدون أي اعتماد على YouTube Data API)
 */
async function searchVideos(query, limit = 10) {
  const normalized = String(query).trim().replace(/\s+/g, ' ').toLowerCase();
  const key = `search:${normalized}:${limit}`;
  const cached = searchCache.get(key);
  if (cached) return cached;
  return dedupe(key, async () => {
    const again = searchCache.get(key); if (again) return again;
    log.info(`🔎 Searching: "${query}" (limit ${limit})`);
    const stdout = await runYtDlp([`ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist']);
    const result = parseFlatItems(stdout);
    searchCache.set(key, result, CACHE_TTL.search);
    return result;
  });
}

/**
 * جلب الفيديوهات المقترحة/ذات الصلة (related) لفيديو معين
 * بيستخدم playlist المكسات التلقائية اللي يوتيوب بيولدها (RD + videoId)
 */
async function getRelatedVideos(videoId, limit = 10) {
  const key = `related:${videoId}:${limit}`;
  const cached = infoCache.get(key); if (cached) return cached;
  return dedupe(key, async () => {
    const again = infoCache.get(key); if (again) return again;
    let title = '';
    try { title = String((await getVideoInfo(videoId)).title || '').replace(/[|]/g, ' ').trim(); } catch {}
    const sources = [];
    try {
      const stdout = await runYtDlp(['--dump-json','--flat-playlist','--yes-playlist','--playlist-end',String(Math.max(limit * 3, 20)),`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`]);
      sources.push(parseFlatItems(stdout, videoId));
    } catch (e) { log.warn(`Related RD failed: ${e.message}`); }
    if (sources.flat().length < limit && title) {
      try { sources.push(await searchVideos(title, Math.max(limit * 3, 20))); } catch (e) { log.warn(`Related title search failed: ${e.message}`); }
    }
    const seen = new Set([videoId]); const final = [];
    for (const item of sources.flat()) {
      if (!item?.id || seen.has(item.id) || isUnwantedContent(item.title)) continue;
      seen.add(item.id); final.push(item); if (final.length >= limit) break;
    }
    infoCache.set(key, final, CACHE_TTL.related);
    return final;
  });
}

/**
 * ==========================================================================
 * القنوات/المبدعين المفضّلين — المحتوى المقترح بيدّي لهم أولوية قبل أي
 * حاجة تانية (ترند عام أو مواضيع عشوائية). دول أسماء حقيقية اختارها
 * صاحب الموقع، فبنبحث باسم كل واحد فيهم على يوتيوب ونجيب أحدث فيديوهاته.
 * ==========================================================================
 */
const FOLLOWED_CREATORS = [
  'كامل العربي', 'اوشا', 'صلاح القصة وما فيها', 'سامح سند', 'بدر العلوي',
  'ابو الصادق', 'مستر محمد ايمن الجوهري', 'مستر محمد صلاح مدرس لغة انجليزية',
  'مستر محمد عبدالمعبود', 'مستر رضا الفاروق', 'انجلشاوي', 'عبقري لغة خالد صقر',
  'قناة توست', 'كوتش الغلابة'
];

const DISCOVERY_BLOCKED = [
  'shorts', '#shorts', 'ميمز', 'مقاطع مضحكة جدا',
  ...UNWANTED_KEYWORDS
];

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[ً-ٟ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').trim();
}
function hasKeyword(title, keywords) {
  const t = normalizeText(title);
  return keywords.some(k => t.includes(normalizeText(k)));
}
function isDiscoveryBlocked(item) {
  return hasKeyword(item?.title, DISCOVERY_BLOCKED);
}
function filterDiscovery(items) {
  return (items || []).filter(v => v?.id && !isDiscoveryBlocked(v));
}
function relevanceScore(item, queryTerms = []) {
  const title = normalizeText(item?.title);
  const channel = normalizeText(item?.author);
  let score = 0;
  for (const term of queryTerms) {
    const t = normalizeText(term);
    if (!t) continue;
    if (title.includes(t)) score += 5;
    if (channel.includes(t)) score += 2;
  }
  if (item?.isLive) score += 1;
  return score;
}
function rankDiscovery(items, queryTerms = []) {
  return [...filterDiscovery(items)].sort((a, b) => relevanceScore(b, queryTerms) - relevanceScore(a, queryTerms));
}

async function getFollowedCreatorsPool(perCreator = 3) {
  const key = `creators:${perCreator}`;
  const cached = feedCache.get(key); if (cached) return cached;
  const settled = await Promise.allSettled(
    FOLLOWED_CREATORS.slice(0, 4).map(name => runYtDlp([`ytsearchdate${perCreator}:${name}`, '--dump-json', '--flat-playlist']))
  );
  const pool = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') pool.push(...filterDiscovery(parseFlatItems(r.value)));
    else log.warn(`Followed creator fetch failed "${FOLLOWED_CREATORS[i]}": ${r.reason?.message}`);
  });
  feedCache.set(key, pool, 180 * 1000);
  return pool;
}

const DISCOVERY_QUERIES = [
  'محتوى مصري جديد اليوم',
  'مراجعات تقنية عربية',
  'فيديوهات تعليمية عربية'
];

const RECOMMENDATION_FALLBACK_QUERIES = [
  'فيديوهات جديدة مصر',
  'محتوى عربي جديد'
];

function parseSeedIds(value) {
  if (!value) return [];
  return String(value).split(',').map(v => v.trim()).filter(isValidVideoId).slice(0, 4);
}

async function getSeedRecommendations(seedIds, limit) {
  if (!seedIds.length) return [];
  const settled = await Promise.allSettled(seedIds.map(id => getRelatedVideos(id, Math.min(12, Math.max(6, Math.ceil(limit / seedIds.length))))));
  const pool = [];
  const seen = new Set(seedIds);
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      pool.push(item);
      if (pool.length >= limit) return pool;
    }
  }
  return pool;
}

async function getRecommendedVideos(region = 'EG', limit = 20, seedIds = []) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 8), 80);
  const seedKey = seedIds.join('_') || 'none';
  const key = `recommended:v11:${cookiesReady ? 'ck' : 'pub'}:${region}:${safeLimit}:${seedKey}`;

  return staleWhileRevalidate(feedCache, key, async () => {
    // لو الكوكيز جاهزة: المقترح هو هوم حسابك الحقيقي على يوتيوب بالظبط
    if (cookiesReady) {
      try {
        const personal = await fetchAccountList('recommended', Math.max(safeLimit, 40));
        if (personal.length >= 5) {
          return {
            items: personal.slice(0, safeLimit),
            personalized: true,
            strategy: 'youtube-account-home (:ytrec)',
            generatedAt: new Date().toISOString()
          };
        }
      } catch (e) {
        log.warn(`Account recommendations failed, using fallback: ${String(e.message || e).split('\n')[0]}`);
      }
    }
    const items = [];
    const seen = new Set();
    const channelCounts = new Map();

    const add = (list, maxPerChannel = 3, scoreTerms = []) => {
      const ranked = rankDiscovery(list || [], scoreTerms);
      for (const v of ranked) {
        if (!v?.id || seen.has(v.id)) continue;
        const channel = v.channelId || v.author || 'unknown';
        const count = channelCounts.get(channel) || 0;

        // Diversify channels, but don't starve the feed.
        if (count >= maxPerChannel && items.length < safeLimit - 2) continue;

        seen.add(v.id);
        channelCounts.set(channel, count + 1);
        items.push(v);

        if (items.length >= safeLimit) break;
      }
    };

    // A) Strongest signal: videos related to what the user is watching.
    let seedContext = [];
    if (seedIds.length) {
      const relatedSettled = await Promise.allSettled(
        seedIds.slice(0, 6).map(id => getRelatedVideos(id, Math.min(24, safeLimit)))
      );

      for (const r of relatedSettled) {
        if (r.status === 'fulfilled') seedContext.push(...r.value);
      }

      add(seedContext, 4);
    }

    // B) If we have seed videos, search around their titles/channels too.
    // This prevents the feed from falling back to random news/football.
    const contextualQueries = [];
    if (seedIds.length) {
      const seedInfos = await Promise.allSettled(
        seedIds.slice(0, 4).map(id => getVideoInfo(id))
      );

      for (const r of seedInfos) {
        if (r.status !== 'fulfilled') continue;
        const title = normalizeText(r.value.title || '');
        const channel = String(r.value.uploader || r.value.channel || '').trim();

        // Keep useful words from the title while avoiding very long ytsearch queries.
        const terms = title
          .split(/\s+/)
          .filter(w => w.length >= 3)
          .slice(0, 7)
          .join(' ');

        if (terms) contextualQueries.push(terms);
        if (channel) contextualQueries.push(channel);
      }
    }

    const uniqueContextQueries = [...new Set(contextualQueries)].slice(0, 6);
    if (uniqueContextQueries.length) {
      const contextual = await Promise.allSettled(
        uniqueContextQueries.map(q => runYtDlp([
          `ytsearchdate${Math.max(10, Math.ceil(safeLimit / 2))}:${q}`,
          '--dump-json', '--flat-playlist'
        ]))
      );

      for (let i = 0; i < contextual.length && items.length < safeLimit; i++) {
        const r = contextual[i];
        if (r.status === 'fulfilled') {
          add(parseFlatItems(r.value), 3, uniqueContextQueries[i].split(/\s+/));
        }
      }
    }

    // C) Fresh discovery, but with larger pools so filtering doesn't leave 3 videos.
    if (items.length < safeLimit) {
      const discovery = await Promise.allSettled(
        DISCOVERY_QUERIES.map(q => runYtDlp([
          `ytsearchdate${Math.max(16, safeLimit)}:${q}`,
          '--dump-json', '--flat-playlist'
        ]))
      );

      for (let i = 0; i < discovery.length && items.length < safeLimit; i++) {
        const r = discovery[i];
        if (r.status === 'fulfilled') {
          add(parseFlatItems(r.value), 3, DISCOVERY_QUERIES[i].split(/\s+/));
        }
      }
    }

    // D) Followed creators as a stable source.
    if (items.length < safeLimit) {
      try {
        add(await getFollowedCreatorsPool(Math.max(4, Math.ceil(safeLimit / FOLLOWED_CREATORS.length))), 3);
      } catch (e) {
        log.warn(`Creator fallback failed: ${e.message}`);
      }
    }

    // E) Final broad fill. No strict channel cap here, only quality filters.
    if (items.length < safeLimit) {
      const extra = await Promise.allSettled(
        RECOMMENDATION_FALLBACK_QUERIES.map(q => runYtDlp([
          `ytsearchdate${Math.max(20, safeLimit)}:${q}`,
          '--dump-json', '--flat-playlist'
        ]))
      );

      for (const r of extra) {
        if (r.status === 'fulfilled') {
          add(parseFlatItems(r.value), 8);
          if (items.length >= safeLimit) break;
        }
      }
    }

    return {
      items: items.slice(0, safeLimit),
      personalized: seedIds.length > 0,
      strategy: seedIds.length
        ? 'related + title-context + fresh-discovery + creators + fallback'
        : 'fresh-discovery + creators + fallback',
      generatedAt: new Date().toISOString()
    };
  }, CACHE_TTL.feed);
}


/**
 * ==========================================================================
 * الهوم فيد الكامل — بيحاول يقلّد شكل صفحة يوتيوب الرئيسية الحقيقية:
 * مش قايمة واحدة، لكن "أقسام" (Sections) زي: الرائج، موسيقى، رياضة، ألعاب،
 * أخبار، تكنولوجيا، أفلام/مسلسلات، بودكاست... كل قسم بيتجاب بالتوازي مع
 * الباقي (مش واحد ورا التاني) عشان الاستجابة تكون سريعة حتى مع عدد أقسام كبير.
 * فيه كمان "mixed" وهي خلطة من كل الأقسام مبعثرة زي ما يوتيوب بيعمل بالظبط
 * في أول تحميل للصفحة الرئيسية.
 * ==========================================================================
 */
const HOME_SECTIONS = [
  { key: 'trending', title: 'الرائج الآن', query: 'ترند مصر اليوم' },
  { key: 'education', title: 'تعليم', query: 'شرح دروس تعليمية بالعربي' },
  { key: 'tech', title: 'تكنولوجيا', query: 'تكنولوجيا مراجعات تقنية عربية' },
  { key: 'sports', title: 'رياضة', query: 'رياضة مصر أهداف وملخصات' }
];

async function getHomeFeed(region = 'EG', perSection = 12) {
  const key = `home_v10_${cookiesReady ? 'ck' : 'pub'}_${region}_${perSection}`;
  return staleWhileRevalidate(feedCache, key, async () => {
    return dedupe(`build:${key}`, async () => {
      const again = feedCache.get(key);
      if (again) return again;

    const fetchers = HOME_SECTIONS.map(section => dedupe(
      `home_section_${region}_${section.key}_${perSection}`,
      async () => {
        try {
          let stdout;
          stdout = await runYtDlp([
            `ytsearchdate${Math.max(perSection * 2, 18)}:${section.query}`,
            '--dump-json', '--flat-playlist'
          ]);
          return {
            key: section.key,
            title: section.title,
            items: filterUnwanted(parseFlatItems(stdout)).slice(0, perSection)
          };
        } catch (e) {
          log.warn(`Home section "${section.key}" failed: ${e.message}`);
          return { key: section.key, title: section.title, items: [] };
        }
      }
    ));

    const extraP = Promise.all([
      cookiesReady
        ? fetchAccountList('recommended', Math.max(perSection * 3, 36))
            .then(items => ({ key: 'for_you', title: 'مقترح لك', items: items.slice(0, perSection * 3) }))
            .catch(e => { log.warn(`home for_you failed: ${String(e.message || e).split('\n')[0]}`); return null; })
        : null,
      Promise.resolve(null)
    ]);
    const sections = (await Promise.all(fetchers)).filter(s => s.items.length > 0);
    const seen = new Set();
    const mixed = [];
    const maxLen = Math.max(...sections.map(s => s.items.length), 0);

    for (let i = 0; i < maxLen; i++) {
      for (const s of sections) {
        const v = s.items[i];
        if (v && !seen.has(v.id)) {
          seen.add(v.id);
          mixed.push({ ...v, section: s.key });
        }
      }
    }

    const [forYou, liveSection] = await extraP;
    const finalSections = [
      ...(forYou && forYou.items.length ? [forYou] : []),
      ...sections,
      ...(liveSection && liveSection.items.length ? [liveSection] : [])
    ];
    const personalMixed = forYou ? forYou.items.map(v => ({ ...v, section: 'for_you' })) : [];
    const finalMixed = dedupeById([...personalMixed, ...mixed]);
    const result = { region, personalized: Boolean(forYou && forYou.items.length), sections: finalSections, mixed: finalMixed, generatedAt: new Date().toISOString() };
      return result;
    });
  }, CACHE_TTL.feed);
}

/**
 * جلب فيديوهات قناة معيّنة + بيانات القناة نفسها (الاسم، عدد المشتركين، الصورة، الوصف)
 */
async function getChannelTab(channelId, tab, limit = 30) {
  const safeTab = ['playlists', 'streams', 'live'].includes(tab) ? (tab === 'live' ? 'streams' : tab) : 'videos';
  const url = `https://www.youtube.com/channel/${channelId}/${safeTab}`;
  const stdout = await runYtDlp([
    '--flat-playlist', '--dump-single-json',
    '--playlist-end', String(Math.min(Math.max(limit, 1), 100)),
    url
  ]);
  const data = JSON.parse(stdout);
  const entries = (data.entries || []).map(e => ({
    ...mapFlatEntry(e),
    playlistId: e.id || null,
    playlistTitle: e.title || null,
    itemCount: e.playlist_count || e.n_entries || null,
    isLive: !!e.is_live,
    wasLive: !!e.was_live,
    liveStatus: e.live_status || null
  })).filter(Boolean);
  return {
    channel: {
      id: data.channel_id || channelId,
      title: data.channel || data.uploader || 'قناة',
      followers: data.channel_follower_count || null,
      avatar: data.thumbnails?.length ? data.thumbnails[data.thumbnails.length - 1].url : null,
      description: data.description || ''
    },
    tab: safeTab,
    entries
  };
}

async function getChannelVideos(channelId, limit = 20) {
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  log.info(`📺 Fetching channel: ${channelId} (limit ${limit})`);
  const stdout = await runYtDlp(['--flat-playlist', '--dump-single-json', '--playlist-end', String(limit), url]);
  const data = JSON.parse(stdout);
  const videos = (data.entries || []).map(e => mapFlatEntry(e)).filter(Boolean);
  return {
    channel: {
      id: data.channel_id || channelId,
      title: data.channel || data.uploader || 'قناة',
      followers: data.channel_follower_count || null,
      avatar: data.thumbnails?.length ? data.thumbnails[data.thumbnails.length - 1].url : null,
      description: data.description || ''
    },
    videos
  };
}


/**
 * ==========================================================================
 * 👤 بيانات الحساب (بالكوكيز) — المقترح، الاشتراكات، السجل، قوائم التشغيل، البث المباشر
 * ==========================================================================
 */
const ACCOUNT_SOURCES = {
  recommended: ':ytrec',                                   // الصفحة الرئيسية الحقيقية لحسابك
  subscriptions: 'https://www.youtube.com/feed/subscriptions',
  history: ':ythistory',
  liked: 'https://www.youtube.com/playlist?list=LL',
  watchlater: 'https://www.youtube.com/playlist?list=WL'
};

function dedupeById(items) {
  const seen = new Set();
  return (items || []).filter(v => v?.id && !seen.has(v.id) && seen.add(v.id));
}

async function fetchAccountList(kind, limit = 40) {
  const src = ACCOUNT_SOURCES[kind];
  if (!src) throw new Error(`unknown account source: ${kind}`);
  const stdout = await runYtDlp([
    '--flat-playlist', '--dump-json', '--playlist-end', String(Math.min(Math.max(limit, 1), 150)), src
  ], { useCookies: true, allowCookieFallback: false, timeout: 70000 });
  return dedupeById(parseFlatItems(stdout));
}

function mapPlaylistEntry(e) {
  const id = e.id || (String(e.url || '').match(/[?&]list=([\w-]+)/) || [])[1];
  if (!id) return null;
  const thumbs = e.thumbnails || [];
  return {
    playlistId: id,
    title: e.title || 'قائمة تشغيل',
    author: e.uploader || e.channel || '',
    itemCount: e.playlist_count || e.n_entries || null,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : null
  };
}

async function fetchAccountPlaylists(limit = 60) {
  const builtin = [
    { playlistId: 'LL', title: 'الفيديوهات التي أعجبتني', builtin: true, itemCount: null, thumbnail: null, author: '' },
    { playlistId: 'WL', title: 'المشاهدة لاحقًا', builtin: true, itemCount: null, thumbnail: null, author: '' }
  ];
  const candidates = ['https://www.youtube.com/feed/playlists', 'https://www.youtube.com/feed/library'];
  let found = [];
  for (const url of candidates) {
    try {
      const stdout = await runYtDlp(['--flat-playlist', '--dump-single-json', '--playlist-end', String(limit), url],
        { useCookies: true, allowCookieFallback: false, timeout: 60000 });
      const data = JSON.parse(stdout);
      found = (data.entries || []).map(mapPlaylistEntry).filter(x => x && x.playlistId !== 'LL' && x.playlistId !== 'WL');
      if (found.length) break;
    } catch (e) { log.warn(`account playlists via ${url} failed: ${String(e.message || e).split('\n')[0]}`); }
  }
  const seen = new Set();
  return [...builtin, ...found].filter(x => !seen.has(x.playlistId) && seen.add(x.playlistId));
}

async function fetchAccountChannels(limit = 100) {
  const stdout = await runYtDlp(['--flat-playlist', '--dump-single-json', '--playlist-end', String(limit), 'https://www.youtube.com/feed/channels'],
    { useCookies: true, allowCookieFallback: false, timeout: 60000 });
  const data = JSON.parse(stdout);
  return (data.entries || []).map(e => {
    const id = e.channel_id || e.id;
    if (!id) return null;
    const thumbs = e.thumbnails || [];
    return { id, title: e.title || e.channel || 'قناة', avatar: thumbs.length ? thumbs[thumbs.length - 1].url : null, url: e.url || `https://www.youtube.com/channel/${id}` };
  }).filter(Boolean);
}

/** بحث البث المباشر الحالي (فلتر "Live" بتاع يوتيوب) */
async function searchLive(query = 'بث مباشر', limit = 30) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgJAAQ%3D%3D`;
  const stdout = await runYtDlp(['--flat-playlist', '--dump-json', '--playlist-end', String(Math.min(Math.max(limit, 1), 100)), url]);
  return dedupeById(parseFlatItems(stdout).map(v => ({
    ...v,
    isLive: v.liveStatus ? v.liveStatus === 'is_live' : true
  })));
}

/**
 * جلب تعليقات حقيقية من يوتيوب لفيديو معيّن
 */
async function getVideoComments(videoId, limit = 50) {
  log.info(`💬 Fetching comments: ${videoId} (limit ${limit})`);
  const args = [
    '--skip-download', '--dump-json', '--write-comments',
    '--extractor-args', `youtube:comment_sort=top;max_comments=${limit},all,all,${limit}`,
    `https://www.youtube.com/watch?v=${videoId}`
  ];
  const stdout = await runYtDlp(args, { timeout: 45000 });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const data = JSON.parse(lines[lines.length - 1]);
  return (data.comments || []).slice(0, limit).map(c => ({
    id: c.id,
    author: c.author || 'مستخدم يوتيوب',
    authorThumbnail: c.author_thumbnail || '',
    text: c.text || '',
    likeCount: c.like_count || 0,
    isReply: !!(c.parent && c.parent !== 'root'),
    timestamp: c.timestamp ? new Date(c.timestamp * 1000).toISOString() : null
  }));
}

// ==========================================================================
// ⚡ Request telemetry — لا يضيف انتظارًا ولا يلمس البيانات الحساسة.
// ==========================================================================
let requestSeq = 0;
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  const id = (++requestSeq).toString(36);
  res.setHeader('X-Request-ID', id);
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms > 1500) log.warn(`🐢 ${req.method} ${req.originalUrl} ${ms.toFixed(0)}ms [${id}]`);
  });
  next();
});

// ==========================================================================
// Routes
// ==========================================================================

/**
 * GET /trending?region=EG&limit=20&page=1
 */
/**
 * GET /trending?region=EG&limit=20&page=1
 * (بيرجّع محتوى شخصي بناءً على الكوكيز لو متاحة، وإلا محتوى عام متنوّع)
 */
app.get('/trending', async (req, res) => {
  const region = (req.query.region || 'EG').toUpperCase();
  try {
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 30);
    const needed = pageNum * pageSize;
    const poolSize = Math.min(Math.max(needed, pageSize * 2), 150);

    const seedIds = parseSeedIds(req.query.seed || req.query.seeds || req.query.history);
    const cacheKey = `recommended:${region}:${poolSize}:${seedIds.join('_') || 'none'}`;
    const cached = await getRecommendedVideos(region, poolSize, seedIds);

    const start = (pageNum - 1) * pageSize;
    const results = cached.items.slice(start, start + pageSize);
    const hasMore = cached.items.length > start + pageSize;

    log.success(`✅ Recommended done: ${region} page ${pageNum} (${results.length} نتيجة, personalized=${cached.personalized})`);
    res.json({ region, page: pageNum, limit: pageSize, count: results.length, hasMore, personalized: cached.personalized, results });
  } catch (error) {
    log.error(`Error fetching recommended: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب المحتوى المقترح',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /home?region=EG&perSection=12
 * فيد الصفحة الرئيسية الكامل بأقسام (trending, music, sports, gaming...)
 * + خلطة "mixed" جاهزة للعرض المباشر — زي شكل هوم يوتيوب الحقيقي
 */
app.get('/home', async (req, res) => {
  const region = (req.query.region || 'EG').toUpperCase();
  const perSection = Math.min(Math.max(parseInt(req.query.perSection, 10) || 12, 4), 25);

  const cacheKey = `home_${region}_${perSection}`;
  try {
    const data = await getHomeFeed(region, perSection);
    log.success(`✅ Home feed done: ${region} (${data.sections.length} قسم, ${data.mixed.length} فيديو)`);
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
    log.success(`✅ Search done: "${query}" page ${page} (${results.length} نتيجة)`);
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
    log.success(`✅ Related done: ${videoId} page ${page} (${results.length} نتيجة)`);
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
      channelCache.set(dataCacheKey, data, CACHE_TTL.channel);
    }

    const start = (pageNum - 1) * pageSize;
    const videos = data.videos.slice(start, start + pageSize);
    const hasMore = data.videos.length > start + pageSize;

    log.success(`✅ Channel done: ${channelId} page ${pageNum} (${videos.length} نتيجة)`);
    res.json({ channel: data.channel, page: pageNum, limit: pageSize, count: videos.length, hasMore, videos });
  } catch (error) {
    log.error(`Error fetching channel: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب بيانات القناة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /channel/playlists?id=CHANNEL_ID&limit=30&page=1
 * Returns the playlists published by a channel.
 */
app.get('/channel/playlists', async (req, res) => {
  const channelId = String(req.query.id || '');
  if (!channelId) return res.status(400).json({ error: 'channel id مطلوب' });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);
  const key = `channel-playlists:${channelId}:${page}:${limit}`;
  const cached = channelCache.get(key);
  if (cached) return res.json(cached);
  try {
    const data = await getChannelTab(channelId, 'playlists', Math.min(page * limit, 100));
    const start = (page - 1) * limit;
    const results = data.entries.slice(start, start + limit);
    const out = { channel: data.channel, page, limit, count: results.length, hasMore: data.entries.length > start + limit, playlists: results };
    channelCache.set(key, out, CACHE_TTL.channel);
    res.json(out);
  } catch (error) {
    log.error(`Error fetching channel playlists: ${error.message}`);
    res.status(500).json({ error: 'تعذّر جلب قوائم تشغيل القناة', details: NODE_ENV === 'development' ? error.message : undefined });
  }
});

/**
 * GET /channel/streams?id=CHANNEL_ID&limit=30&page=1
 * Returns live streams and past/upcoming live broadcasts from the channel.
 */
app.get('/channel/streams', async (req, res) => {
  const channelId = String(req.query.id || '');
  if (!channelId) return res.status(400).json({ error: 'channel id مطلوب' });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);
  const key = `channel-streams:${channelId}:${page}:${limit}`;
  const cached = channelCache.get(key);
  if (cached) return res.json(cached);
  try {
    const data = await getChannelTab(channelId, 'streams', Math.min(page * limit, 100));
    const start = (page - 1) * limit;
    const results = data.entries.slice(start, start + limit);
    const out = { channel: data.channel, page, limit, count: results.length, hasMore: data.entries.length > start + limit, streams: results };
    channelCache.set(key, out, CACHE_TTL.channel);
    res.json(out);
  } catch (error) {
    log.error(`Error fetching channel streams: ${error.message}`);
    res.status(500).json({ error: 'تعذّر جلب لايفات القناة', details: NODE_ENV === 'development' ? error.message : undefined });
  }
});

/**
 * GET /playlist?id=PLAYLIST_ID&limit=30&page=1
 * Returns the videos/items inside a YouTube playlist.
 */
app.get('/playlist', async (req, res) => {
  const playlistId = String(req.query.id || '');
  if (!playlistId) return res.status(400).json({ error: 'playlist id مطلوب' });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);
  const key = `playlist:${playlistId}:${page}:${limit}`;
  const cached = channelCache.get(key);
  if (cached) return res.json(cached);
  try {
    const stdout = await runYtDlp([
      '--flat-playlist', '--dump-single-json', '--yes-playlist',
      '--playlist-end', String(Math.min(page * limit, 100)),
      `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`
    ]);
    const data = JSON.parse(stdout);
    const entries = (data.entries || []).map(e => mapFlatEntry(e)).filter(Boolean);
    const start = (page - 1) * limit;
    const results = entries.slice(start, start + limit);
    const out = { id: playlistId, title: data.title || '', channel: data.channel || data.uploader || '', page, limit, count: results.length, hasMore: entries.length > start + limit, results };
    channelCache.set(key, out, CACHE_TTL.channel);
    res.json(out);
  } catch (error) {
    log.error(`Error fetching playlist: ${error.message}`);
    res.status(500).json({ error: 'تعذّر جلب محتوى قائمة التشغيل', details: NODE_ENV === 'development' ? error.message : undefined });
  }
});

/**
 * GET /video?v=VIDEO_ID
 */
/**
 * بيسحب الفيديو من الرابط المباشر (googlevideo) ويبعته للمتصفح بايت بايت،
 * بدل عمل redirect. ده بيحل مشكلة إن رابط يوتيوب مقفول على IP السيرفر:
 * دلوقتي المتصفح مايكلمش يوتيوب خالص، بيكلم سيرفرنا بس، وسيرفرنا هو اللي
 * بيكلم يوتيوب بنفس الـ IP اللي جاب بيه الرابط أصلاً.
 */

// ==========================================================================
// ⚡ FAST STREAM PATH
// الهدف: التشغيل العادي لا يحتاج dump-json كامل قبل أول بايت.
// yt-dlp --get-url أخف بكثير من getVideoInfo، لذلك المسار الافتراضي يستخدمه.
// ==========================================================================

async function getFastStreamUrl(videoId) {
  const key = `fast:${videoId}`;
  const cached = fastStreamCache.get(key);
  if (cached) return cached;

  return dedupe(key, async () => {
    const again = fastStreamCache.get(key);
    if (again) return again;

    // Progressive first: browser receives both audio + video in one URL.
    const candidates = [
      'best[acodec!=none][vcodec!=none]/best',
      'best'
    ];

    let lastError;
    for (const selector of candidates) {
      try {
        const urls = await getFormatUrls(videoId, selector);
        const url = urls[0];
        if (url) {
          fastStreamCache.set(key, url, CACHE_TTL.fastStream);
          return url;
        }
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error('No fast stream URL available');
  });
}

function copySafeUpstreamHeaders(upstreamRes, res) {
  const allowed = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'expires'
  ];

  for (const h of allowed) {
    if (upstreamRes.headers[h] != null) res.setHeader(h, upstreamRes.headers[h]);
  }

  // A proxied response must be allowed to stream progressively.
  if (!res.getHeader('Accept-Ranges')) res.setHeader('Accept-Ranges', 'bytes');
}

function resolveRedirectUrl(base, location) {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

function destroyResponseStream(res) {
  try {
    if (!res.writableEnded && !res.destroyed) res.destroy();
  } catch {}
}

function streamFromUpstream(req, res, url, redirectCount = 0, duration = null) {
  if (!url) {
    if (!res.headersSent) res.status(502).json({ error: 'رابط الفيديو غير متاح' });
    return;
  }

  if (redirectCount > 6) {
    if (!res.headersSent) res.status(502).json({ error: 'تحويلات المصدر كثيرة' });
    return;
  }

  let target;
  try {
    target = new URL(url).toString();
  } catch {
    if (!res.headersSent) res.status(502).json({ error: 'رابط المصدر غير صالح' });
    return;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive'
  };

  // Critical for seeking and for browsers that request the video in chunks.
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];

  const upstreamReq = https.get(target, {
    headers,
    timeout: 20000,
    agent: keepAliveAgent
  }, (upstreamRes) => {
    const code = Number(upstreamRes.statusCode || 0);

    if ([301, 302, 303, 307, 308].includes(code) && upstreamRes.headers.location) {
      const nextUrl = resolveRedirectUrl(target, upstreamRes.headers.location);
      upstreamRes.resume();
      if (!nextUrl) {
        if (!res.headersSent) res.status(502).json({ error: 'تحويل المصدر غير صالح' });
        return;
      }
      return streamFromUpstream(req, res, nextUrl, redirectCount + 1, duration);
    }

    if ([401, 403, 410].includes(code)) {
      upstreamRes.resume();
      if (!res.headersSent) res.status(code === 410 ? 502 : 502).json({
        error: 'مصدر الفيديو انتهت صلاحيته، أعد طلب التشغيل لإحضار رابط جديد',
        upstreamStatus: code
      });
      return;
    }

    if (code >= 400) {
      upstreamRes.resume();
      if (!res.headersSent) res.status(502).json({
        error: 'تعذّر تحميل الفيديو من المصدر',
        upstreamStatus: code
      });
      return;
    }

    res.status(code || 200);
    res.setHeader('Cache-Control', 'no-store');
    if (Number.isFinite(Number(duration)) && Number(duration) > 0) {
      res.setHeader('X-Video-Duration', String(duration));
    }
    copySafeUpstreamHeaders(upstreamRes, res);

    // Send headers immediately, then stream bytes without buffering.
    try { res.flushHeaders(); } catch {}
    try { upstreamRes.socket?.setNoDelay(true); } catch {}
    upstreamRes.pipe(res, { end: true });

    upstreamRes.on('error', err => {
      log.warn(`Upstream response error: ${err.message}`);
      destroyResponseStream(res);
    });
  });

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('Upstream timeout'));
  });

  upstreamReq.on('error', (err) => {
    log.error(`Stream proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.status(504).json({ error: 'مصدر الفيديو اتأخر في الرد' });
    } else {
      destroyResponseStream(res);
    }
  });

  // "close" can happen after the client genuinely disconnects.
  // aborted is the safer signal for an interrupted incoming request.
  req.once('aborted', () => {
    try { upstreamReq.destroy(); } catch {}
  });

  res.once('close', () => {
    if (!res.writableEnded) {
      try { upstreamReq.destroy(); } catch {}
    }
  });
}


// ==========================================================================
// نظام الجودات v6:
// - نرجع الارتفاعات الموجودة فعليًا فقط.
// - progressive بنفس الارتفاع = تشغيل مباشر وأسرع.
// - video-only + audio = ffmpeg فقط عند الحاجة.
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
  return (info.formats || []).filter(f =>
    f && f.height && f.vcodec && f.vcodec !== 'none'
  );
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
  const audioCandidates = (info.formats || [])
    .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
  const audio = audioCandidates.sort((a, b) => {
    const ap = Number(a.language_preference ?? -1);
    const bp = Number(b.language_preference ?? -1);
    if (bp !== ap) return bp - ap;
    const ao = /\boriginal\b/i.test(String(a.format_note || '')) ? 1 : 0;
    const bo = /\boriginal\b/i.test(String(b.format_note || '')) ? 1 : 0;
    if (bo !== ao) return bo - ao;
    return (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0);
  })[0];

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

function streamMergedViaFfmpeg(req, res, videoUrl, audioUrl, duration = 0) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
  const inputArgs = [
    '-user_agent', UA,
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_delay_max', '2',
    '-rw_timeout', '12000000',
    '-i', videoUrl
  ];

  if (audioUrl) inputArgs.push(
    '-user_agent', UA,
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_delay_max', '2',
    '-rw_timeout', '12000000',
    '-i', audioUrl
  );

  const args = [
    '-loglevel', 'warning',
    '-hide_banner',
    '-nostdin',
    ...inputArgs,
    '-map', '0:v:0',
    ...(audioUrl ? ['-map', '1:a:0'] : ['-map', '0:a:0?']),
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1'
  ];

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  if (Number(duration) > 0) res.setHeader('X-Video-Duration', String(duration));

  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrBuf = '';

  ff.stderr.on('data', d => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
  });
  ff.stdout.pipe(res);

  const cleanup = () => {
    if (!ff.killed) {
      try { ff.kill('SIGKILL'); } catch {}
    }
  };

  ff.on('error', e => {
    log.error(`ffmpeg spawn error: ${e.message}`);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: 'ffmpeg غير متاح على السيرفر' });
  });
  ff.on('close', code => {
    if (code !== 0 && code !== null && !res.writableEnded) {
      log.warn(`ffmpeg exited ${code}: ${stderrBuf.slice(-500)}`);
    }
  });
  req.on('close', cleanup);
}

app.get('/video/source', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!videoId || !isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  try {
    const info = await getVideoInfo(videoId);
    const requested = resolveQuality(req.query.quality || 'best');
    if (requested?.type === 'audio') {
      const urls = await getFormatUrls(videoId, 'bestaudio/best');
      return res.json({ id: videoId, duration: info.duration || 0, type: 'audio', url: urls[0] });
    }
    if (requested?.type === 'video') {
      const selected = chooseQualityFormats(info, requested.height);
      const urls = selected.mode === 'direct'
        ? await getFormatUrls(videoId, selected.videoFormatId)
        : await getFormatUrls(videoId, `${selected.videoFormatId}+${selected.audioFormatId}`);
      return res.json({
        id: videoId, duration: info.duration || 0,
        requestedQuality: requested.height, actualQuality: selected.actualHeight,
        mode: selected.mode, videoUrl: urls[0] || null, audioUrl: urls[1] || null
      });
    }
    const url = await getVideoStreamUrl(videoId, 'best');
    return res.json({ id: videoId, duration: info.duration || 0, type: 'video', mode: 'direct-or-best', url });
  } catch (error) {
    res.status(502).json({ error: 'تعذّر تجهيز مصدر الفيديو', details: NODE_ENV === 'development' ? error.message : undefined });
  }
});


// ==========================================================================
// 🚀 QUICK PLAY — أسرع طريق للتشغيل الأول.
// لا يجلب معلومات الفيديو الكاملة؛ يحل رابط البث فقط.
// ==========================================================================
app.get('/video/quick', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }

  try {
    const url = await getFastStreamUrl(videoId);
    res.setHeader('X-Stream-Mode', 'quick-direct');
    return streamFromUpstream(req, res, url, 0);
  } catch (error) {
    log.warn(`Quick stream failed ${videoId}: ${error.message}`);
    return res.status(502).json({
      error: 'تعذّر تشغيل الفيديو بسرعة',
      retryable: true
    });
  }
});

// Frontend can call this after a stale/expired source instead of waiting
// for the old URL to fail repeatedly.
app.get('/video/refresh', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID غير صحيح' });

  fastStreamCache.delete(`fast:${videoId}`);
  for (const key of streamCache.map.keys()) {
    if (String(key).includes(videoId)) streamCache.delete(key);
  }

  try {
    const url = await getFastStreamUrl(videoId);
    return res.json({
      id: videoId,
      refreshed: true,
      mode: 'direct',
      url,
      expiresIn: 'source-dependent'
    });
  } catch (e) {
    return res.status(502).json({ error: 'فشل تجديد مصدر الفيديو' });
  }
});

app.get('/video', async (req, res) => {
  const requestStartedAt = Date.now();
  const { v: videoId, format = 'best', quality } = req.query;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({
      error: 'Video ID مطلوب وصحيح (11 حرف)',
      example: '/video?v=dQw4w9WgXcQ&quality=1080'
    });
  }

  try {
    // Explicit quality requires full format metadata. The default path does not.
    const videoDuration = 0;
    // Probe mode: resolve the stream without sending the video bytes.
    // Useful for automated endpoint testing and health checks.
    const probe = ['1', 'true', 'yes'].includes(String(req.query.probe || '').toLowerCase());
    const resolved = resolveQuality(quality);

    if (resolved?.type === 'audio') {
      const urls = await getFormatUrls(videoId, 'bestaudio/best');
      if (probe) return res.json({ probe: true, id: videoId, type: 'audio', resolved: true, urlLength: String(urls[0] || '').length });
      return streamFromUpstream(req, res, urls[0], 0, videoDuration);
    }

    if (resolved?.type === 'video') {
      const info = await getVideoInfo(videoId);
      const selected = chooseQualityFormats(info, resolved.height);

      if (selected.mode === 'direct') {
        const urls = await getFormatUrls(videoId, selected.videoFormatId);
        res.setHeader('X-Video-Quality', `${selected.actualHeight}p`);
        res.setHeader('X-Stream-Mode', 'direct');
        if (probe) return res.json({ probe: true, id: videoId, type: 'video', requestedQuality: quality, actualQuality: selected.actualHeight, mode: 'direct', resolved: true, urlLength: String(urls[0] || '').length });
        recordPerf('video-quality', Date.now() - requestStartedAt, true);
        return streamFromUpstream(req, res, urls[0], 0, videoDuration);
      }

      const urls = await getFormatUrls(
        videoId,
        `${selected.videoFormatId}+${selected.audioFormatId}`
      );
      if (urls.length < 2) throw new Error('Could not resolve video/audio URLs');

      res.setHeader('X-Video-Quality', `${selected.actualHeight}p`);
      res.setHeader('X-Stream-Mode', 'ffmpeg');
      if (probe) return res.json({ probe: true, id: videoId, type: 'video', requestedQuality: quality, actualQuality: selected.actualHeight, mode: 'ffmpeg', resolved: true, videoUrlLength: String(urls[0] || '').length, audioUrlLength: String(urls[1] || '').length });
      recordPerf('video-quality', Date.now() - requestStartedAt, true);
      return streamMergedViaFfmpeg(req, res, urls[0], urls[1], videoDuration);
    }

    // Default = fastest direct progressive stream.
    const streamUrl = format === 'best'
      ? await getFastStreamUrl(videoId)
      : await getVideoStreamUrl(videoId, format);

    res.setHeader('X-Stream-Mode', 'direct-fast');
    recordPerf(quality ? 'video-quality' : 'video-default', Date.now() - requestStartedAt, true);
    return streamFromUpstream(req, res, streamUrl, 0, videoDuration);

  } catch (error) {
    recordPerf(quality ? 'video-quality' : 'video-default', Date.now() - requestStartedAt, false);
    log.error(`Error streaming ${videoId}: ${error.message}`);
    if (res.headersSent) return;

    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('unavailable') || msg.includes('not available')) {
      return res.status(404).json({ error: 'الفيديو غير متاح أو محذوف' });
    }
    if (msg.includes('private')) {
      return res.status(403).json({ error: 'الفيديو خاص (private)' });
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
 * GET /download?v=VIDEO_ID&quality=720
 * Downloads only through yt-dlp on the server. A dedicated limiter keeps
 * heavy downloads from starving metadata/search requests.
 */
const downloadLimiter = new Semaphore(Math.max(1, parseInt(process.env.DOWNLOAD_CONCURRENCY, 10) || 1));
app.get('/download', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  const quality = String(req.query.quality || 'best').toLowerCase();
  const format = quality === 'audio'
    ? 'bestaudio/best'
    : (/^\d+$/.test(quality) ? `bestvideo[height<=${Math.min(2160, Number(quality))}]+bestaudio/best` : 'bestvideo+bestaudio/best');

  const probe = ['1', 'true', 'yes'].includes(String(req.query.probe || '').toLowerCase());
  if (probe) {
    try {
      const info = await getVideoInfo(videoId);
      return res.json({ probe: true, id: videoId, quality, format, title: info.title || null, resolved: true });
    } catch (e) {
      return res.status(502).json({ probe: true, id: videoId, resolved: false, error: String(e.message || e) });
    }
  }

  await downloadLimiter.acquire();
  let child;
  try {
    const info = await getVideoInfo(videoId);
    const filename = `${sanitizeFilename(info.title || 'video')}.mp4`;
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', quality === 'audio' ? 'audio/mpeg' : 'video/mp4');

    const args = ['--no-warnings', '--no-playlist', '--format-sort', 'lang,quality', '-f', format, '-o', '-', `https://www.youtube.com/watch?v=${videoId}`];
    child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d.toString(); if (err.length > 3000) err = err.slice(-3000); });
    child.stdout.pipe(res);

    await new Promise((resolve, reject) => {
      const cleanup = () => { if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} } };
      req.on('close', cleanup);
      child.once('error', reject);
      child.once('close', code => {
        req.off('close', cleanup);
        if (code !== 0 && !res.writableEnded) return reject(new Error(err.slice(-1000) || `yt-dlp exited ${code}`));
        resolve();
      });
    });
  } catch (error) {
    if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
    log.warn(`Download failed: ${String(error.message || error).split('\n')[0]}`);
    if (!res.headersSent) res.status(500).json({ error: 'فشل التحميل', details: NODE_ENV === 'development' ? error.message : undefined });
  } finally {
    downloadLimiter.release();
  }
});

/**
 * GET /api/account-feed
 * Authenticated subscription feed using the server-side cookie jar.
 * Cookie contents are never returned to the client.
 */
app.get('/api/account-feed', async (req, res) => {
  if (!cookiesReady) return res.status(503).json({ error: 'كوكيز يوتيوب غير جاهزة على السيرفر' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 60);
  const key = `account-feed:${limit}`;
  const cached = feedCache.get(key);
  if (cached) return res.json(cached);
  try {
    const data = await dedupe(key, async () => {
      const again = feedCache.get(key); if (again) return again;
      const stdout = await runYtDlp([
        '--flat-playlist', '--dump-json', '--playlist-end', String(limit),
        'https://www.youtube.com/feed/subscriptions'
      ], { useCookies: true, allowCookieFallback: false });
      const results = filterDiscovery(parseFlatItems(stdout));
      const out = { personalized: true, count: results.length, results, generatedAt: new Date().toISOString() };
      feedCache.set(key, out, 60 * 1000);
      return out;
    });
    res.json(data);
  } catch (error) {
    log.warn(`Account feed failed: ${error.message}`);
    res.status(502).json({ error: 'تعذّر جلب فيد الحساب من يوتيوب' });
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
      liveStatus: info.live_status || null,
      originalLanguage: info.language || null,
      audioLanguages: [...new Set((info.formats || []).filter(f => f.acodec && f.acodec !== 'none').map(f => f.language).filter(Boolean))],
      formats: info.formats?.length || 0
    };

    infoCache.set(`info_${videoId}`, result, CACHE_TTL.info);
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
 * بيرجّع كل الجودات المتاحة *فعليًا* لهذا الفيديو بالتحديد (مش قايمة ثابتة)
 * كل جودة معاها رابط تشغيل جاهز من نفس السيرفر (/video?v=..&quality=..)
 */
app.get('/video/qualities', async (req, res) => {
  const videoId = req.query.v;
  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }

  const cacheKey = `qualities_v6_${videoId}`;
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

    const result = {
      id: videoId,
      title: info.title,
      count: qualities.length,
      qualities,
      note: 'الجودات هنا هي الارتفاعات المتاحة فعليًا للفيديو.'
    };

    infoCache.set(cacheKey, result, CACHE_TTL.info);
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
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'operational',
    version: SERVER_VERSION,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    ytdlpReady: commandExists('yt-dlp'),
    ytdlpVersion: (() => { try { return require('child_process').execFileSync('yt-dlp', ['--version'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
    nodeVersion: process.version,
    jsRuntime: detectNodeRuntime() || (commandExists('deno') ? 'deno' : (commandExists('bun') ? 'bun' : null)),
    ffmpegReady: commandExists('ffmpeg'),
    cookiesReady,
    cookieUpdateProtected: false,
    concurrency: { metaMax: META_CONCURRENCY, metaCurrent: ytdlpLimiter.current, metaQueued: ytdlpLimiter.queue.length, streamMax: STREAM_CONCURRENCY, streamCurrent: streamLimiter.current, streamQueued: streamLimiter.queue.length }
  });
});

/**
 * POST /api/update-cookies
 */
app.post('/api/update-cookies', async (req, res) => {
  try {
    // بدون أي تحقق (باسورد/مفتاح) — بناءً على طلب صاحب المشروع
    let cookies = req.body;
    if (cookies && typeof cookies === 'object') cookies = cookies.cookies || cookies.value || '';

    if (typeof cookies !== 'string' || !cookies.trim()) {
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
          try {
            saveCookiesLocally(cookies);
            log.warn('⚠️ Cookies saved locally only (Firebase write denied) — set FIREBASE_SECRET to persist');
            res.json({
              success: true,
              localOnly: true,
              message: 'تم الحفظ على السيرفر فقط ✅ (Firebase رفض الكتابة — هتضيع بعد أي Redeploy)',
              timestamp: new Date().toISOString(),
              size: cookies.length
            });
          } catch (e) {
            res.status(500).json({ error: 'فشل في تحديث الكوكيز', details: response });
          }
        }
      });
    });

    req_firebase.on('error', (err) => {
      log.error(`Firebase update error: ${err.message}`);
      try {
        saveCookiesLocally(cookies);
        res.json({ success: true, localOnly: true, message: 'تم الحفظ على السيرفر فقط ✅ (تعذر الاتصال بـ Firebase)', size: cookies.length });
      } catch (e) {
        res.status(500).json({ error: 'فشل الاتصال بـ Firebase', details: err.message });
      }
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
 * GET /cookies  — لوحة تحكم تحديث الكوكيز (بدون باسورد)
 */
app.get(['/cookies', '/cookies-panel'], (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة تحديث الكوكيز</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,'Segoe UI',Tahoma,sans-serif;background:#0f1115;color:#e8e8e8;padding:16px}
.card{max-width:720px;margin:0 auto;background:#181b22;border:1px solid #2a2f3a;border-radius:14px;padding:18px}
h1{font-size:20px;margin:0 0 12px}
.status{padding:10px 12px;border-radius:10px;background:#20242d;margin-bottom:12px;font-size:14px}
textarea{width:100%;height:260px;background:#0f1115;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:10px;padding:10px;font-family:monospace;font-size:12px;direction:ltr;resize:vertical}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
button,label.btn{flex:1;min-width:120px;padding:12px;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;text-align:center}
#save{background:#e11d48;color:#fff}#file{display:none}label.btn{background:#2a2f3a;color:#fff}
#clear{background:#20242d;color:#e8e8e8}
#msg{margin-top:12px;font-size:14px;min-height:20px}
.ok{color:#4ade80}.err{color:#f87171}
</style></head><body><div class="card">
<h1>🍪 لوحة تحديث كوكيز يوتيوب</h1>
<div class="status" id="status">جاري فحص الحالة...</div>
<textarea id="ta" placeholder="الصق محتوى cookies.txt (صيغة Netscape) هنا..."></textarea>
<div class="row">
<button id="save">💾 حفظ وتحديث</button>
<label class="btn" for="file">📂 اختيار ملف</label><input type="file" id="file" accept=".txt,text/plain">
<button id="clear">مسح</button>
</div>
<div id="msg"></div></div>
<script>
const $=id=>document.getElementById(id);
async function status(){
  try{const r=await fetch('/api/cookies-status');const d=await r.json();
    $('status').textContent=d.status+(d.length?' — '+d.length+' بايت':'');
  }catch(e){$('status').textContent='❌ تعذر فحص الحالة'}
}
$('file').onchange=async e=>{const f=e.target.files[0];if(f)$('ta').value=await f.text()};
$('clear').onclick=()=>{$('ta').value='';$('msg').textContent=''};
$('save').onclick=async()=>{
  const v=$('ta').value.trim();
  if(!v){$('msg').className='err';$('msg').textContent='الصق الكوكيز الأول';return}
  $('save').disabled=true;$('msg').className='';$('msg').textContent='جاري الحفظ...';
  try{
    const r=await fetch('/api/update-cookies',{method:'POST',headers:{'Content-Type':'text/plain'},body:v});
    const d=await r.json();
    if(r.ok){$('msg').className='ok';$('msg').textContent=d.message||'تم ✅'}
    else{$('msg').className='err';$('msg').textContent=d.error||'فشل'}
  }catch(e){$('msg').className='err';$('msg').textContent='خطأ اتصال: '+e.message}
  $('save').disabled=false;status();
};
status();
</script></body></html>`);
});

/**
 * GET /api/cookies-status
 */
app.get('/api/cookies-status', async (req, res) => {
  res.json({
    hasCookies: cookiesReady,
    length: lastCookiesContent.length,
    status: cookiesReady ? '✅ موجودة' : '❌ فارغة أو غير موجودة'
  });
});

/**
 * GET /
 */
app.get('/', (req, res) => {
  res.json({
    name: '🎬 srver v10.0.0 TITAN Maintenance - YouTube media server',
    version: SERVER_VERSION,
    environment: NODE_ENV,
    recommended: '/trending?region=EG&seed=dQw4w9WgXcQ',
    cookies: {
      source: '🔥 Firebase Realtime Database',
      url: FIREBASE_URL,
      refresh: 'كل 5 دقايق في الخلفية',
      ready: cookiesReady
    },
    concurrency: { metaMax: META_CONCURRENCY, streamMax: STREAM_CONCURRENCY },
    endpoints: {
      home: '/home?region=EG&perSection=12',
      trending: '/trending?region=EG&limit=20&page=1',
      video: '/video?v=VIDEO_ID&quality=1080 (أو &format=best للوضع السريع)',
      videoQualities: '/video/qualities?v=VIDEO_ID',
      videoSource: '/video/source?v=VIDEO_ID&quality=1080',
      info: '/info?v=VIDEO_ID',
      formats: '/formats?v=VIDEO_ID',
      search: '/search?q=QUERY&limit=20&page=1',
      related: '/related?v=VIDEO_ID&limit=10&page=1',
      channel: '/channel?id=CHANNEL_ID&limit=20&page=1',
      channelPlaylists: '/channel/playlists?id=CHANNEL_ID&limit=30&page=1',
      channelStreams: '/channel/streams?id=CHANNEL_ID&limit=30&page=1',
      playlist: '/playlist?id=PLAYLIST_ID&limit=30&page=1',
      health: '/health',
      performance: '/api/performance',
      maintenance: '/api/maintenance',
      videoDebug: '/api/video-debug?v=VIDEO_ID',
      quickVideo: '/video/quick?v=VIDEO_ID',
      refreshVideo: '/video/refresh?v=VIDEO_ID',
      prefetch: '/api/prefetch?v=VIDEO_ID',
      suggestions: '/search/suggestions?q=QUERY',
      download: '/download?v=VIDEO_ID&quality=720',
      accountFeed: '/api/account-feed?limit=30',
      meRecommended: '/api/me/recommended?limit=20&page=1',
      meSubscriptions: '/api/me/subscriptions?limit=20&page=1',
      meHistory: '/api/me/history',
      meLiked: '/api/me/liked',
      meWatchLater: '/api/me/watchlater',
      mePlaylists: '/api/me/playlists',
      mePlaylist: '/api/me/playlist?id=PLAYLIST_ID',
      meChannels: '/api/me/channels',
      meLive: '/api/me/live',
      liveNow: '/api/live?q=QUERY&limit=20&page=1',
      cookiesPanel: '/cookies',
      cookiesStatus: '/api/cookies-status',
      testAll: '/api/test-all?v=dQw4w9WgXcQ&channel=UCuAXFkgsw1L7xaCfnd5JJOw',
      clearCache: 'POST /api/cache/clear (requires CACHE_ADMIN_SECRET)'
    },
    videoQualityValues: 'يتم اكتشاف كل الارتفاعات الحقيقية تلقائيًا عبر /video/qualities',
    pagination: 'كل endpoints البحث/الترند/related/channel بترجع page و limit و hasMore — استخدمهم لعمل infinite scroll',
    examples: {
      'Home feed (أقسام زي يوتيوب)': '/home?region=EG',
      'Trending page 1': '/trending?region=EG&page=1',
      'Trending page 2 (سكرول لاحق)': '/trending?region=EG&page=2',
      'Play video (سريع)': '/video?v=dQw4w9WgXcQ',
      'Play video quick': '/video/quick?v=dQw4w9WgXcQ',
      'Play video 1080p (دمج ffmpeg)': '/video?v=dQw4w9WgXcQ&quality=1080',
      'Play video 4K': '/video?v=dQw4w9WgXcQ&quality=2160',
      'Audio only': '/video?v=dQw4w9WgXcQ&quality=audio',
      'كل الجودات المتاحة للفيديو ده': '/video/qualities?v=dQw4w9WgXcQ',
      'Search videos': '/search?q=funny+cats&page=1',
      'Related videos': '/related?v=dQw4w9WgXcQ',
      'Channel videos': '/channel?id=UCuAXFkgsw1L7xaCfnd5JJOw',
      'Channel playlists': '/channel/playlists?id=UCuAXFkgsw1L7xaCfnd5JJOw',
      'Channel live streams': '/channel/streams?id=UCuAXFkgsw1L7xaCfnd5JJOw',
      'Check cookies': '/api/cookies-status'
    }
  });
});

// ==========================================================================
// ⚡ Instant search suggestions — cached for a few seconds.
// ==========================================================================
app.get('/search/suggestions', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ query: '', suggestions: [] });
  const key = `suggest:${q.toLowerCase()}`;
  const cached = suggestionCache.get(key); if (cached) return res.json(cached);
  try {
    const results = await searchVideos(q, 8);
    const seen = new Set();
    const suggestions = results.map(v => v.title).filter(t => t && !seen.has(t) && seen.add(t)).slice(0, 8);
    const out = { query: q, suggestions };
    suggestionCache.set(key, out, CACHE_TTL.suggestions);
    res.json(out);
  } catch { res.json({ query: q, suggestions: [] }); }
});

// ==========================================================================
// 🔥 Prefetch endpoint: frontend can warm metadata/related before opening.
// It never returns cookies or upstream credentials.
// ==========================================================================
app.get('/api/prefetch', async (req, res) => {
  const id = String(req.query.v || '');
  if (!isValidVideoId(id)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  const started = Date.now();
  const [info, related] = await Promise.allSettled([getVideoInfo(id), getRelatedVideos(id, 12)]);
  res.json({ id, warmed: { info: info.status === 'fulfilled', related: related.status === 'fulfilled' }, tookMs: Date.now() - started });
});

// ==========================================================================
// 📊 Cache/queue metrics — useful for tuning Railway without exposing secrets.
// ==========================================================================
app.get('/api/performance', (req, res) => {
  res.json({
    version: SERVER_VERSION,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cache: {
      info: infoCache.stats(), search: searchCache.stats(), feed: feedCache.stats(),
      stream: streamCache.stats(), channel: channelCache.stats(),
      suggestions: suggestionCache.stats(), accountFeed: feedCache.stats()
    },
    queues: {
      meta: { max: META_CONCURRENCY, current: ytdlpLimiter.current, queued: ytdlpLimiter.queue.length },
      stream: { max: STREAM_CONCURRENCY, current: streamLimiter.current, queued: streamLimiter.queue.length },
      download: { max: downloadLimiter.max, current: downloadLimiter.current, queued: downloadLimiter.queue.length }
    }
  });
});


// ==========================================================================
// 🩺 OPERATIONS — تشخيص سريع وصيانة بدون restart
// ==========================================================================

app.get('/api/maintenance', (req, res) => {
  const memory = process.memoryUsage();
  const rssMb = Math.round(memory.rss / 1024 / 1024);
  const heapMb = Math.round(memory.heapUsed / 1024 / 1024);

  res.json({
    version: SERVER_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: { rss: rssMb, heapUsed: heapMb, heapTotal: Math.round(memory.heapTotal / 1024 / 1024) },
    eventLoop: {
      note: 'Use /api/performance for queue/cache pressure'
    },
    queues: {
      metadata: { current: ytdlpLimiter.current, queued: ytdlpLimiter.queue.length, max: ytdlpLimiter.max },
      streams: { current: streamLimiter.current, queued: streamLimiter.queue.length, max: streamLimiter.max },
      downloads: { current: downloadLimiter.current, queued: downloadLimiter.queue.length, max: downloadLimiter.max }
    },
    caches: {
      info: infoCache.stats(),
      search: searchCache.stats(),
      feed: feedCache.stats(),
      stream: streamCache.stats(),
      fastStream: fastStreamCache.stats(),
      channel: channelCache.stats(),
      suggestions: suggestionCache.stats()
    }
  });
});

app.post('/api/cache/clear', (req, res) => {
  const secret = process.env.CACHE_ADMIN_SECRET || '';
  const provided = req.get('x-cache-admin-key') || '';
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: 'غير مصرح' });
  }

  infoCache.clear();
  searchCache.clear();
  feedCache.clear();
  streamCache.clear();
  fastStreamCache.clear();
  channelCache.clear();
  suggestionCache.clear();

  return res.json({
    success: true,
    message: 'تم تنظيف كل كاش RAM',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/video-debug', async (req, res) => {
  const id = String(req.query.v || '');
  if (!isValidVideoId(id)) return res.status(400).json({ error: 'Video ID غير صحيح' });

  const started = Date.now();
  const out = {
    id,
    startedAt: new Date(started).toISOString(),
    steps: []
  };

  try {
    const t1 = Date.now();
    const fast = await getFastStreamUrl(id);
    out.steps.push({
      name: 'fast-source',
      ok: true,
      ms: Date.now() - t1,
      urlLength: fast.length
    });

    const t2 = Date.now();
    const info = await getVideoInfo(id);
    out.steps.push({
      name: 'metadata',
      ok: true,
      ms: Date.now() - t2,
      title: info.title || null,
      duration: info.duration || 0,
      formats: info.formats?.length || 0
    });

    out.totalMs = Date.now() - started;
    out.ok = true;
    out.hint = out.steps[0].ms > 5000
      ? 'مصدر الفيديو نفسه بطيء؛ راجع yt-dlp/YouTube connectivity.'
      : 'المسار السريع جاهز.';
    return res.json(out);
  } catch (e) {
    out.totalMs = Date.now() - started;
    out.ok = false;
    out.error = String(e.message || e);
    return res.status(502).json(out);
  }
});


// ==========================================================================
// 📚 TITAN MAINTENANCE NOTES
//
// 1) /video is now the fast path and avoids a full metadata extraction.
// 2) /video?quality=720/1080/... still uses the format-aware path.
// 3) /video/quick is intentionally minimal for instant playback.
// 4) /video/refresh clears stale source URLs for one video.
// 5) /api/video-debug measures source-vs-metadata latency.
// 6) /api/maintenance exposes safe queue/cache/memory diagnostics.
// 7) POST /api/cache/clear is protected by CACHE_ADMIN_SECRET.
// 8) JSON responses above 1KB are gzip-compressed when the client supports it.
// 9) Range headers are forwarded to upstream, which improves seek/resume.
// 10) Expired upstream URLs now fail cleanly so the frontend can refresh.
// 11) Recommendation pools are larger and use related/title context first.
// 12) Discovery has more fallback pools so filtering doesn't collapse the feed.
// 13) Channel diversity is preserved without starving the final result count.
// 14) Home sections now include education/podcasts and use larger pools.
// 15) Request protection prevents accidental API floods without throttling video.
// 16) Keep the frontend on /video or /video/quick for normal playback.
// 17) Use explicit quality only when the user actually selects a quality.
// 18) Avoid calling /formats or /info before every playback unless needed.
// 19) Use /api/prefetch after a video card is visible, not for every card.
// 20) If Railway CPU/RAM is constrained, lower STREAM_CONCURRENCY first.
// 21) If YouTube blocks extraction, update yt-dlp and refresh cookies.
// 22) Never expose Firebase secrets or cookie contents through diagnostics.
// 23) The server cache is RAM-only by design; restart clears it safely.
// 24) The frontend should retry a 502 source once through /video/refresh.
// 25) For long videos, Range support is more important than proxy buffering.
// 26) ffmpeg is reserved for video+audio combinations that need merging.
// 27) Progressive direct streams are preferred because they start sooner.
// 28) The recommendation engine deliberately avoids generic random-only feeds.
// 29) Unwanted content filters remain active for discovery and recommendations.
// 30) /api/performance remains backward-compatible with existing dashboards.
//
// ==========================================================================


// ==========================================================================
// 🧠 ADAPTIVE PERFORMANCE LAYER
// يحتفظ بإحصائيات زمنية بسيطة ويستخدمها في التشخيص بدون قاعدة بيانات.
// ==========================================================================

const perfWindow = {
  samples: [],
  maxSamples: 240
};

function recordPerf(kind, ms, ok = true) {
  const item = {
    kind,
    ms: Math.max(0, Math.round(ms)),
    ok: Boolean(ok),
    at: Date.now()
  };
  perfWindow.samples.push(item);
  if (perfWindow.samples.length > perfWindow.maxSamples) {
    perfWindow.samples.splice(0, perfWindow.samples.length - perfWindow.maxSamples);
  }
}

function perfSummary(kind = null) {
  const now = Date.now();
  const recent = perfWindow.samples.filter(x => now - x.at < 10 * 60 * 1000 && (!kind || x.kind === kind));
  if (!recent.length) return { count: 0, avgMs: 0, p95Ms: 0, errors: 0 };

  const sorted = recent.map(x => x.ms).sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];

  return {
    count: recent.length,
    avgMs: Math.round(avg),
    p95Ms: Math.round(p95),
    errors: recent.filter(x => !x.ok).length
  };
}

// Periodically trim old latency samples without a timer storm.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  perfWindow.samples = perfWindow.samples.filter(x => x.at >= cutoff);
}, 60 * 1000);

// ==========================================================================
// 🛡️ SOURCE CIRCUIT BREAKER
// لو المصدر الخارجي بدأ يفشل بكثرة، نوقف الضرب عليه لثوانٍ قليلة بدل
// ما كل مستخدم يطلق yt-dlp جديد في نفس اللحظة.
// ==========================================================================
const sourceBreaker = {
  failures: 0,
  openedUntil: 0,
  threshold: Math.max(3, parseInt(process.env.SOURCE_BREAKER_THRESHOLD, 10) || 5),
  cooldownMs: Math.max(5000, parseInt(process.env.SOURCE_BREAKER_COOLDOWN, 10) || 15000)
};

function sourceBreakerOpen() {
  return sourceBreaker.openedUntil > Date.now();
}

function sourceBreakerSuccess() {
  sourceBreaker.failures = Math.max(0, sourceBreaker.failures - 1);
  if (sourceBreaker.failures === 0) sourceBreaker.openedUntil = 0;
}

function sourceBreakerFailure() {
  sourceBreaker.failures++;
  if (sourceBreaker.failures >= sourceBreaker.threshold) {
    sourceBreaker.openedUntil = Date.now() + sourceBreaker.cooldownMs;
    log.warn(`🛑 Source breaker opened for ${sourceBreaker.cooldownMs}ms`);
  }
}

app.get('/api/diagnostics', (req, res) => {
  res.json({
    version: SERVER_VERSION,
    now: new Date().toISOString(),
    sourceBreaker: {
      open: sourceBreakerOpen(),
      failures: sourceBreaker.failures,
      threshold: sourceBreaker.threshold,
      cooldownMs: sourceBreaker.cooldownMs,
      openedUntil: sourceBreaker.openedUntil || null
    },
    latency: {
      videoQuick: perfSummary('video-quick'),
      videoDefault: perfSummary('video-default'),
      videoQuality: perfSummary('video-quality'),
      recommendations: perfSummary('recommendations'),
      home: perfSummary('home')
    },
    process: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage()
    }
  });
});

// ==========================================================================
// 🔁 SMART RECOMMENDATION PAGING
// Endpoint إضافي يملأ الصفحة المطلوبة من pool أكبر بدل ما يعيد بناء
// التوصيات من الصفر مع كل page.
// ==========================================================================
app.get('/recommendations', async (req, res) => {
  const region = String(req.query.region || 'EG').toUpperCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 40);
  const seeds = parseSeedIds(req.query.seed || req.query.seeds || req.query.history);
  const poolSize = Math.min(Math.max(page * limit, 40), 80);

  try {
    const started = Date.now();
    const data = await getRecommendedVideos(region, poolSize, seeds);
    const start = (page - 1) * limit;
    const results = data.items.slice(start, start + limit);

    recordPerf('recommendations', Date.now() - started, true);

    res.json({
      region,
      page,
      limit,
      count: results.length,
      hasMore: data.items.length > start + limit,
      personalized: data.personalized,
      strategy: data.strategy,
      results
    });
  } catch (e) {
    recordPerf('recommendations', Date.now() - started, false);
    res.status(502).json({ error: 'تعذّر بناء التوصيات', retryable: true });
  }
});

// ==========================================================================
// 🧪 STREAM HEAD/PROBE
// فحص خفيف للمصدر المباشر بدون تشغيل ffmpeg أو تنزيل الفيديو للمستخدم.
// ==========================================================================
app.get('/video/ping', async (req, res) => {
  const id = String(req.query.v || '');
  if (!isValidVideoId(id)) return res.status(400).json({ error: 'Video ID غير صحيح' });

  const started = Date.now();
  try {
    const url = await getFastStreamUrl(id);
    const parsed = new URL(url);

    return res.json({
      id,
      ok: true,
      host: parsed.hostname,
      sourceUrlLength: url.length,
      resolveMs: Date.now() - started,
      cached: Boolean(fastStreamCache.get(`fast:${id}`))
    });
  } catch (e) {
    return res.status(502).json({
      id,
      ok: false,
      resolveMs: Date.now() - started,
      error: String(e.message || e)
    });
  }
});

// ==========================================================================
// 📦 CACHE SNAPSHOT
// يعرض فقط المفاتيح العامة والإحصائيات، ولا يعرض أي URL أو Cookie أو Secret.
// ==========================================================================
app.get('/api/cache-summary', (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    caches: {
      info: infoCache.stats(),
      search: searchCache.stats(),
      feed: feedCache.stats(),
      stream: streamCache.stats(),
      fastStream: fastStreamCache.stats(),
      channel: channelCache.stats(),
      suggestions: suggestionCache.stats()
    },
    inflight: {
      count: inflight.size
    }
  });
});

// ==========================================================================
// 📝 MAINTENANCE CHECKLIST
//
// Recommended Railway environment variables:
//   YTDLP_META_CONCURRENCY=3
//   YTDLP_STREAM_CONCURRENCY=2
//   DOWNLOAD_CONCURRENCY=1
//   REQUEST_LIMIT=240
//   SOURCE_BREAKER_THRESHOLD=5
//   SOURCE_BREAKER_COOLDOWN=15000
//   CACHE_ADMIN_SECRET=<long-random-secret>
//
// Operational workflow:
//   1. Check /health.
//   2. Check /api/diagnostics.
//   3. Check /api/video-debug?v=VIDEO_ID.
//   4. If fast-source is slow, the bottleneck is extraction/upstream.
//   5. If fast-source is fast but playback stalls, inspect Range/upstream.
//   6. Use /video/refresh?v=VIDEO_ID after a stale source error.
//   7. Use /api/cache/clear only after changing extraction configuration.
//   8. Keep quality selection out of the initial autoplay request.
//   9. Use /video/quick for cards that should start immediately.
//  10. Use /recommendations for infinite scrolling instead of rebuilding
//      a small recommendation list on every page.
// ==========================================================================


// ==========================================================================
// 👤 /api/me/* — كل حاجة من حسابك بالكوكيز (زي يوتيوب بالظبط)
// ==========================================================================
function requireCookies(req, res, next) {
  if (cookiesReady) return next();
  res.status(503).json({ error: 'كوكيز يوتيوب غير جاهزة على السيرفر — حدّثها من /cookies', cookiesReady: false });
}

const ME_TTL = { recommended: 90 * 1000, subscriptions: 60 * 1000, history: 45 * 1000, liked: 90 * 1000, watchlater: 60 * 1000 };

Object.keys(ACCOUNT_SOURCES).forEach(kind => {
  app.get(`/api/me/${kind}`, requireCookies, async (req, res) => {
    try {
      const out = await getPaginatedPool(feedCache, `me_${kind}`, (n) => fetchAccountList(kind, n), req.query.page, req.query.limit, 150, ME_TTL[kind]);
      res.json({ personalized: true, source: kind, count: out.results.length, ...out });
    } catch (e) {
      log.warn(`/api/me/${kind} failed: ${String(e.message || e).split('\n')[0]}`);
      res.status(502).json({ error: 'تعذّر جلب البيانات من يوتيوب (غالباً الكوكيز انتهت)', source: kind });
    }
  });
});

/** قوائم التشغيل بتاعتي (+ الإعجابات والمشاهدة لاحقًا) */
app.get('/api/me/playlists', requireCookies, async (req, res) => {
  try {
    const data = await staleWhileRevalidate(feedCache, 'me_playlists', () => fetchAccountPlaylists(80), 120 * 1000);
    res.json({ personalized: true, count: data.length, results: data });
  } catch (e) {
    res.status(502).json({ error: 'تعذّر جلب قوائم التشغيل' });
  }
});

/** محتوى قائمة تشغيل (يشتغل مع الخاصة والخصوصية "غير مدرجة" بفضل الكوكيز) */
app.get('/api/me/playlist', requireCookies, async (req, res) => {
  const id = String(req.query.id || '');
  if (!/^[\w-]{2,64}$/.test(id)) return res.status(400).json({ error: 'id قائمة التشغيل غير صحيح' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 150);
  try {
    const data = await staleWhileRevalidate(feedCache, `me_playlist:${id}:${limit}`, async () => {
      const stdout = await runYtDlp(['--flat-playlist', '--dump-single-json', '--playlist-end', String(limit), `https://www.youtube.com/playlist?list=${id}`],
        { useCookies: true, allowCookieFallback: false, timeout: 70000 });
      const d = JSON.parse(stdout);
      return {
        playlist: { id, title: d.title || 'قائمة تشغيل', author: d.uploader || d.channel || '', itemCount: d.playlist_count || (d.entries || []).length },
        results: dedupeById((d.entries || []).map(e => mapFlatEntry(e)).filter(Boolean))
      };
    }, 90 * 1000);
    res.json({ personalized: true, ...data });
  } catch (e) {
    res.status(502).json({ error: 'تعذّر جلب القائمة' });
  }
});

/** القنوات المشترك فيها */
app.get('/api/me/channels', requireCookies, async (req, res) => {
  try {
    const data = await staleWhileRevalidate(feedCache, 'me_channels', () => fetchAccountChannels(150), 300 * 1000);
    res.json({ personalized: true, count: data.length, results: data });
  } catch (e) {
    res.status(502).json({ error: 'تعذّر جلب القنوات المشترك فيها' });
  }
});

/** البثوث المباشرة (والقادمة) من القنوات اللي مشترك فيها */
app.get('/api/me/live', requireCookies, async (req, res) => {
  try {
    const pool = await staleWhileRevalidate(feedCache, 'me_live_pool', () => fetchAccountList('subscriptions', 100), 60 * 1000);
    const live = pool.filter(v => v.isLive || v.liveStatus === 'is_live');
    const upcoming = pool.filter(v => v.liveStatus === 'is_upcoming');
    res.json({ personalized: true, liveCount: live.length, live, upcoming });
  } catch (e) {
    res.status(502).json({ error: 'تعذّر جلب البثوث المباشرة' });
  }
});

/** البث المباشر العام الآن (بحث بفلتر Live) */
app.get('/api/live', async (req, res) => {
  const q = String(req.query.q || 'بث مباشر').trim().slice(0, 100) || 'بث مباشر';
  try {
    const out = await getPaginatedPool(searchCache, `live_${q}`, (n) => searchLive(q, n), req.query.page, req.query.limit, 100, 60 * 1000);
    res.json({ query: q, count: out.results.length, ...out });
  } catch (e) {
    log.warn(`/api/live failed: ${String(e.message || e).split('\n')[0]}`);
    res.status(502).json({ error: 'تعذّر جلب البث المباشر' });
  }
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

// ==========================================================================
// 🧪 TITAN ENDPOINT TEST SUITE
// GET /api/test-all?v=dQw4w9WgXcQ&channel=UCuAXFkgsw1L7xaCfnd5JJOw
// Runs safe probes for every API route. Streaming/download are tested in
// probe mode so the test does NOT download or stream megabytes to the caller.
// ==========================================================================
app.get('/api/test-all', async (req, res) => {
  const videoId = String(req.query.v || 'dQw4w9WgXcQ');
  const channelId = String(req.query.channel || 'UCuAXFkgsw1L7xaCfnd5JJOw');
  const base = `http://127.0.0.1:${PORT}`;
  const tests = [
    ['root', '/'],
    ['health', '/health'],
    ['performance', '/api/performance'],
    ['cookies-status', '/api/cookies-status'],
    ['suggestions', '/search/suggestions?q=music'],
    ['search', '/search?q=funny%20cats&limit=3&page=1'],
    ['trending', '/trending?region=EG&limit=3&page=1'],
    ['home', '/home?region=EG&perSection=4'],
    ['info', `/info?v=${encodeURIComponent(videoId)}`],
    ['formats', `/formats?v=${encodeURIComponent(videoId)}`],
    ['video-qualities', `/video/qualities?v=${encodeURIComponent(videoId)}`],
    ['related', `/related?v=${encodeURIComponent(videoId)}&limit=3&page=1`],
    ['channel', `/channel?id=${encodeURIComponent(channelId)}&limit=3&page=1`],
    ['video-probe', `/video?v=${encodeURIComponent(videoId)}&format=best&probe=1`],
    ['video-1080-probe', `/video?v=${encodeURIComponent(videoId)}&quality=1080&probe=1`],
    ['download-probe', `/download?v=${encodeURIComponent(videoId)}&quality=720&probe=1`],
    ['prefetch', `/api/prefetch?v=${encodeURIComponent(videoId)}`],
    ['account-feed', '/api/account-feed?limit=3']
  ];

  const started = Date.now();
  const results = await Promise.all(tests.map(async ([name, path]) => {
    const t = Date.now();
    try {
      const r = await fetch(base + path, { headers: { 'X-Titan-Test': '1' } });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch {}
      return { name, path, status: r.status, ok: r.ok, ms: Date.now() - t, bodyPreview: body ? summarizeTestBody(body) : text.slice(0, 180) };
    } catch (e) {
      return { name, path, status: 0, ok: false, ms: Date.now() - t, error: String(e.message || e) };
    }
  }));

  const passed = results.filter(x => x.ok).length;
  const failed = results.length - passed;
  res.json({
    suite: 'TITAN endpoint test', version: SERVER_VERSION, videoId, channelId,
    total: results.length, passed, failed, tookMs: Date.now() - started,
    note: 'video/download were tested in probe mode فقط؛ لم يتم تنزيل أو بث الملف.',
    results
  });
});

function summarizeTestBody(body) {
  if (!body || typeof body !== 'object') return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'results' && Array.isArray(v)) out[k] = { count: v.length, sample: v.slice(0, 1) };
    else if (k === 'sections' && Array.isArray(v)) out[k] = v.map(x => ({ name: x.name || x.title, count: Array.isArray(x.videos) ? x.videos.length : undefined })).slice(0, 8);
    else if (k === 'memory' && v && typeof v === 'object') out[k] = { rss: v.rss, heapUsed: v.heapUsed };
    else if (typeof v !== 'string' || v.length < 500) out[k] = v;
  }
  return out;
}

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0;
  server.maxConnections = 2000;
  const ytdlpStatus = commandExists('yt-dlp') ? '✅' : '❌';
  console.log(`
╔═══════════════════════════════════════════╗
║  🎬 srver v${SERVER_VERSION} شغّال 🔥        ║
║  ═════════════════════════════════════     ║
║  Environment: ${NODE_ENV.padEnd(26, ' ')}║
║  yt-dlp: ${ytdlpStatus}  Firebase Cookies (bg refresh)  ║
║  Concurrency: ${`meta=${META_CONCURRENCY} stream=${STREAM_CONCURRENCY}`.padEnd(24, ' ')}║
║  http://0.0.0.0:${PORT}                        ║
╚═══════════════════════════════════════════╝
  `);
  log.success(`✅ Server ready - no YouTube Data API dependency`);
  log.info(`🆕 جديد: /home (فيد بأقسام) + /video?quality=1080/1440/2160/audio + /video/qualities`);
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
