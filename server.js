const express = require('express');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
// (مش محتاجين مكتبة cors تاني، الهيدرز بقت بتتحط يدوي فوق)
const https = require('https');
require('dotenv').config();

// ==========================================================================
// 🔖 srver v5.0.0 "جبارة" — نسخة موسّعة فوق v4.0 الأصلية بدون حذف أي حاجة:
//   • كل جودات الفيديو (144p → 4K) + دمج فيديو/صوت لحظي بـ ffmpeg للجودات
//     العالية اللي معندهاش progressive stream جاهز.
//   • هوم فيد بأقسام (Sections) زي صفحة يوتيوب الرئيسية الحقيقية.
//   • جلب متوازي (Promise.all) بدل التسلسلي → أسرع بشكل ملحوظ.
//   • keep-alive agent لإعادة استخدام الاتصالات مع جوجل.
// ==========================================================================
const SERVER_VERSION = '9.1.0-TITAN';

// Agent واحد بيعيد استخدام نفس اتصالات TCP/TLS بدل ما يفتح اتصال جديد لكل
// طلب لجوجل — ده اللي بيدي إحساس "سريع" فعلي في البث والـ API calls
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 100, keepAliveMsecs: 30000 });

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
app.disable('x-powered-by');
app.set('etag', false);
app.set('trust proxy', true);

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

app.use(express.json());
app.use(express.text({ limit: '10mb' }));

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
const streamCache = new MemoryTTLCache(700);
const channelCache = new MemoryTTLCache(250);
const commentsCache = new MemoryTTLCache(250);
const suggestionCache = new MemoryTTLCache(150);

const CACHE_TTL = {
  info: 30 * 60 * 1000, search: 2 * 60 * 1000, feed: 5 * 60 * 1000,
  related: 10 * 60 * 1000, channel: 10 * 60 * 1000, stream: 2 * 60 * 1000,
  comments: 5 * 60 * 1000, suggestions: 45 * 1000
};

// Never make the browser/CDN serve an old API response; only our RAM cache is used.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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
const META_CONCURRENCY = Math.max(1, parseInt(process.env.YTDLP_META_CONCURRENCY, 10) || 4);
const STREAM_CONCURRENCY = Math.max(1, parseInt(process.env.YTDLP_STREAM_CONCURRENCY, 10) || 2);
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

async function runYtDlp(args, {
  timeout = TIMEOUT,
  maxBuffer = 1024 * 1024 * 12,
  useCookies = false,
  allowCookieFallback = true,
  lane = 'meta'
} = {}) {
  const limiter = lane === 'stream' ? streamLimiter : ytdlpLimiter;
  await limiter.acquire();
  try {
    const base = ['--no-warnings', '--no-call-home', '--geo-bypass'];
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
    FOLLOWED_CREATORS.map(name => runYtDlp([`ytsearchdate${perCreator}:${name}`, '--dump-json', '--flat-playlist']))
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
  'أخبار مصر اليوم', 'ترند مصر اليوم', 'كرة القدم مصر اليوم',
  'تكنولوجيا اليوم مراجعات', 'محتوى مصري جديد'
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
  const seedKey = seedIds.join('_') || 'none';
  const key = `recommended:${region}:${limit}:${seedKey}`;
  return staleWhileRevalidate(feedCache, key, async () => {
    const items = [];

    const seen = new Set();
    const channelCounts = new Map();
    const add = (list, maxPerChannel = 2) => {
      for (const v of filterDiscovery(list)) {
        if (!v?.id || seen.has(v.id)) continue;
        const channel = v.channelId || v.author || 'unknown';
        const count = channelCounts.get(channel) || 0;
        if (count >= maxPerChannel && items.length < limit - 3) continue;
        seen.add(v.id); channelCounts.set(channel, count + 1); items.push(v);
        if (items.length >= limit) break;
      }
    };

    const seeded = await getSeedRecommendations(seedIds, limit);
    add(seeded, 3);

    const discovery = await Promise.allSettled(DISCOVERY_QUERIES.map(q => runYtDlp([
      `ytsearchdate${Math.max(8, Math.ceil(limit / 2))}:${q}`,
      '--dump-json', '--flat-playlist'
    ])));
    for (let i = 0; i < discovery.length && items.length < limit; i++) {
      const r = discovery[i];
      if (r.status === 'fulfilled') add(rankDiscovery(parseFlatItems(r.value), DISCOVERY_QUERIES[i].split(/\s+/)), 2);
    }

    if (items.length < limit) add(await getFollowedCreatorsPool(Math.max(2, Math.ceil(limit / FOLLOWED_CREATORS.length))), 2);

    // Final fill without strict channel cap, still keeping all discovery filters.
    if (items.length < limit) {
      const extra = await Promise.allSettled(['فيديوهات عربية جديدة', 'محتوى مصري اليوم'].map(q => runYtDlp([
        `ytsearchdate${Math.max(10, limit)}:${q}`, '--dump-json', '--flat-playlist'
      ])));
      for (const r of extra) if (r.status === 'fulfilled') add(parseFlatItems(r.value), 5);
    }

    const result = {
      items: items.slice(0, limit),
      personalized: seedIds.length > 0,
      strategy: seedIds.length ? 'watched-related + fresh-discovery + creator-fallback' : 'fresh-discovery + creator-fallback',
      generatedAt: new Date().toISOString()
    };
    return result;
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
  { key: 'trending', title: '🔥 الرائج الآن', query: null },
  { key: 'music', title: '🎵 موسيقى', query: 'أغاني عربي جديد 2026' },
  { key: 'sports', title: '⚽ رياضة', query: 'أهداف وملخصات مباريات' },
  { key: 'news', title: '📰 أخبار', query: 'أخبار عاجلة اليوم' },
  { key: 'tech', title: '💻 تكنولوجيا', query: 'تكنولوجيا مراجعات تقنية' },
  { key: 'gaming', title: '🎮 ألعاب', query: 'ألعاب فيديو جيمنج' }
];

async function getHomeFeed(region = 'EG', perSection = 12) {
  const key = `home_v9_${region}_${perSection}`;
  return staleWhileRevalidate(feedCache, key, async () => {
    return dedupe(`build:${key}`, async () => {
      const again = feedCache.get(key);
      if (again) return again;

    const fetchers = HOME_SECTIONS.map(section => dedupe(
      `home_section_${region}_${section.key}_${perSection}`,
      async () => {
        try {
          let stdout;
          if (section.key === 'trending') {
            stdout = await runYtDlp([
              `ytsearchdate${Math.max(perSection * 3, 30)}:ترند مصر اليوم`,
              '--dump-json', '--flat-playlist'
            ]);
          } else {
            stdout = await runYtDlp([
              `ytsearch${Math.max(perSection * 2, 20)}:${section.query}`,
              '--dump-json', '--flat-playlist'
            ]);
          }
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

    const result = { region, sections, mixed, generatedAt: new Date().toISOString() };
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
    let cached = feedCache.get(cacheKey);
    if (!cached) {
      cached = await getRecommendedVideos(region, poolSize, seedIds);
      feedCache.set(cacheKey, cached, CACHE_TTL.feed);
    }

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
    let data = feedCache.get(cacheKey);
    if (!data) {
      data = await getHomeFeed(region, perSection);
      feedCache.set(cacheKey, data, CACHE_TTL.feed);
    }
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
 * GET /comments?v=VIDEO_ID&limit=50
 */
app.get('/comments', async (req, res) => {
  const videoId = req.query.v;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }

  const cacheKey = `comments_${videoId}_${limit}`;
  const cached = commentsCache.get(cacheKey);
  if (cached) {
    log.info(`📦 Comments from cache: ${videoId}`);
    return res.json(cached);
  }

  try {
    const comments = await getVideoComments(videoId, limit);
    const response = { id: videoId, count: comments.length, results: comments };
    commentsCache.set(cacheKey, response, CACHE_TTL.comments);
    log.success(`✅ Comments done: ${videoId} (${comments.length} تعليق)`);
    res.json(response);
  } catch (error) {
    log.error(`Error fetching comments: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب التعليقات (ممكن تكون التعليقات مقفولة على الفيديو ده)',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
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
function streamFromUpstream(req, res, url, redirectCount = 0, duration = null) {
  if (redirectCount > 5) {
    if (!res.headersSent) res.status(502).json({ error: 'تحويلات كتير أوي من المصدر' });
    return;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  const upstreamReq = https.get(url, { headers, timeout: 20000, agent: keepAliveAgent }, (upstreamRes) => {
    // تتبّع أي redirect إضافي بنفسنا (مش بنسيبه للمتصفح)
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
    if (Number.isFinite(Number(duration)) && Number(duration) > 0) res.setHeader('X-Video-Duration', String(duration));
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']
      .forEach(h => { if (upstreamRes.headers[h]) res.setHeader(h, upstreamRes.headers[h]); });

    upstreamRes.pipe(res);
  });

  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('Upstream timeout')));
  upstreamReq.on('error', (err) => {
    log.error(`Stream proxy error: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: 'تعذّر الاتصال بمصدر الفيديو' });
  });

  req.on('close', () => upstreamReq.destroy());
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
    '-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1',
    '-reconnect_delay_max', '2', '-i', videoUrl
  ];

  if (audioUrl) inputArgs.push(
    '-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1',
    '-reconnect_delay_max', '2', '-i', audioUrl
  );

  const args = [
    '-loglevel', 'error', '-hide_banner',
    ...inputArgs,
    '-map', '0:v:0',
    ...(audioUrl ? ['-map', '1:a:0'] : ['-map', '0:a:0?']),
    '-c', 'copy',
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

app.get('/video', async (req, res) => {
  const { v: videoId, format = 'best', quality } = req.query;

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({
      error: 'Video ID مطلوب وصحيح (11 حرف)',
      example: '/video?v=dQw4w9WgXcQ&quality=1080'
    });
  }

  try {
    const infoForStream = await getVideoInfo(videoId);
    const videoDuration = Number(infoForStream.duration || 0);
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
      return streamMergedViaFfmpeg(req, res, urls[0], urls[1], videoDuration);
    }

    const cacheKey = `default_stream_${videoId}_${format}`;
    const streamUrl = await dedupe(cacheKey, async () => {
      const cached = streamCache.get(cacheKey);
      if (cached) return cached;

      const url = await getVideoStreamUrl(videoId, format);
      if (!url) throw new Error('Failed to get stream URL');
      streamCache.set(cacheKey, url, CACHE_TTL.stream);
      return url;
    });

    return streamFromUpstream(req, res, streamUrl, 0, videoDuration);

  } catch (error) {
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
    cookieUpdateProtected: Boolean(process.env.COOKIE_UPDATE_SECRET),
    concurrency: { metaMax: META_CONCURRENCY, metaCurrent: ytdlpLimiter.current, metaQueued: ytdlpLimiter.queue.length, streamMax: STREAM_CONCURRENCY, streamCurrent: streamLimiter.current, streamQueued: streamLimiter.queue.length }
  });
});

/**
 * POST /api/update-cookies
 */
app.post('/api/update-cookies', async (req, res) => {
  try {
    const secret = process.env.COOKIE_UPDATE_SECRET || '';
    const provided = req.get('x-cookie-update-key') || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!secret) return res.status(503).json({ error: 'COOKIE_UPDATE_SECRET غير مضبوط على السيرفر' });
    if (!provided || provided !== secret) return res.status(401).json({ error: 'غير مصرح' });

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
    name: '🎬 srver v9.0.0 TITAN - YouTube media server',
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
      comments: '/comments?v=VIDEO_ID&limit=50',
      health: '/health',
      performance: '/api/performance',
      prefetch: '/api/prefetch?v=VIDEO_ID',
      suggestions: '/search/suggestions?q=QUERY',
      download: '/download?v=VIDEO_ID&quality=720',
      accountFeed: '/api/account-feed?limit=30',
      cookiesStatus: '/api/cookies-status',
      testAll: '/api/test-all?v=dQw4w9WgXcQ&channel=UCuAXFkgsw1L7xaCfnd5JJOw'
    },
    videoQualityValues: 'يتم اكتشاف كل الارتفاعات الحقيقية تلقائيًا عبر /video/qualities',
    pagination: 'كل endpoints البحث/الترند/related/channel بترجع page و limit و hasMore — استخدمهم لعمل infinite scroll',
    examples: {
      'Home feed (أقسام زي يوتيوب)': '/home?region=EG',
      'Trending page 1': '/trending?region=EG&page=1',
      'Trending page 2 (سكرول لاحق)': '/trending?region=EG&page=2',
      'Play video (جودة تلقائية)': '/video?v=dQw4w9WgXcQ',
      'Play video 1080p (دمج ffmpeg)': '/video?v=dQw4w9WgXcQ&quality=1080',
      'Play video 4K': '/video?v=dQw4w9WgXcQ&quality=2160',
      'Audio only': '/video?v=dQw4w9WgXcQ&quality=audio',
      'كل الجودات المتاحة للفيديو ده': '/video/qualities?v=dQw4w9WgXcQ',
      'Search videos': '/search?q=funny+cats&page=1',
      'Related videos': '/related?v=dQw4w9WgXcQ',
      'Channel videos': '/channel?id=UCuAXFkgsw1L7xaCfnd5JJOw',
      'Channel playlists': '/channel/playlists?id=UCuAXFkgsw1L7xaCfnd5JJOw',
      'Channel live streams': '/channel/streams?id=UCuAXFkgsw1L7xaCfnd5JJOw',
      'Video comments': '/comments?v=dQw4w9WgXcQ',
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
      stream: streamCache.stats(), channel: channelCache.stats(), comments: commentsCache.stats(),
      suggestions: suggestionCache.stats(), accountFeed: feedCache.stats()
    },
    queues: {
      meta: { max: META_CONCURRENCY, current: ytdlpLimiter.current, queued: ytdlpLimiter.queue.length },
      stream: { max: STREAM_CONCURRENCY, current: streamLimiter.current, queued: streamLimiter.queue.length },
      download: { max: downloadLimiter.max, current: downloadLimiter.current, queued: downloadLimiter.queue.length }
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

// ==========================================================================
// 🔥 Background warm-up: makes the first user hit a warm RAM cache.
// Failures are intentionally swallowed; the site still works normally.
// ==========================================================================
let warmupRunning = false;
async function warmHotCaches() {
  if (warmupRunning) return;
  warmupRunning = true;
  try {
    await Promise.allSettled([
      getHomeFeed('EG', 8),
      getRecommendedVideos('EG', 20, [])
    ]);
    log.success('🔥 Hot caches warmed');
  } catch (e) { log.warn(`Warmup failed: ${e.message}`); }
  finally { warmupRunning = false; }
}

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
    ['comments', `/comments?v=${encodeURIComponent(videoId)}&limit=3`],
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
  const ytdlpStatus = commandExists('yt-dlp') ? '✅' : '❌';
  console.log(`
╔═══════════════════════════════════════════╗
║  🎬 srver v${SERVER_VERSION} "جبارة" شغّال 🔥        ║
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

setTimeout(warmHotCaches, 8000);
setInterval(warmHotCaches, 120000);

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
