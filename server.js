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
// 🔖 srver v5.1.0 "جبارة+" — نسخة محسنة فوق v5.0.0 مع دعم الفيديوهات الشخصية:
//   • كل جودات الفيديو (144p → 4K) + دمج فيديو/صوت لحظي بـ ffmpeg للجودات
//     العالية اللي معندهاش progressive stream جاهز.
//   • هوم فيد محسّن يجيب فيديوهات من حسابك الشخصي بدل البحث العام
//   • جلب متوازي (Promise.all) بدل التسلسلي → أسرع بشكل ملحوظ.
//   • keep-alive agent لإعادة استخدام الاتصالات مع جوجل.
// ==========================================================================
const SERVER_VERSION = '5.1.0';

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

// 🆕 USER ACCOUNT CONFIG — لجلب فيديوهات من حسابك الشخصي
const USER_CHANNEL_ID = process.env.USER_CHANNEL_ID || null;  // قنوات المستخدم (قائمة مفصولة بفاصلة)
const USER_PLAYLIST_ID = process.env.USER_PLAYLIST_ID || null; // playlist واحدة إذا كنت عاوز مثلاً

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
const homeCache = new NodeCache({ stdTTL: 600 });           // 🆕 كاش خاص بالهوم فيد: 10 دقايق

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

/**
 * جلب صفحة من نتايج بأي حجم مطلوب، مع كاش لكل "بركة" (pool) بحجمها —
 * عشان السكرول اللانهائي (infinite scroll) يقدر يكمّل يجيب صفحات جديدة
 * من غير ما يعيد طلب yt-dlp لنفس البيانات القديمة تاني.
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

/**
 * 🆕 جلب فيديوهات من قناة المستخدم الشخصية
 * ده بديل أفضل من البحث العام — يجيب الفيديوهات اللي انت صادره فعلاً
 */
async function getUserChannelVideos(channelId, limit = 20) {
  if (!channelId) return [];

  try {
    log.info(`👤 Fetching videos from user channel: ${channelId} (limit ${limit})`);
    const url = `https://www.youtube.com/channel/${channelId}/videos`;
    const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(limit), url]);
    const items = parseFlatItems(stdout);
    log.success(`✅ Got ${items.length} videos from user channel`);
    return items;
  } catch (e) {
    log.warn(`Failed to fetch user channel videos: ${e.message}`);
    return [];
  }
}

/**
 * 🆕 جلب فيديوهات من playlist معين (مثل "المفضلة" أو أي playlist شخصية)
 */
async function getUserPlaylistVideos(playlistId, limit = 20) {
  if (!playlistId) return [];

  try {
    log.info(`📋 Fetching videos from user playlist: ${playlistId} (limit ${limit})`);
    const url = `https://www.youtube.com/playlist?list=${playlistId}`;
    const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(limit), url]);
    const items = parseFlatItems(stdout);
    log.success(`✅ Got ${items.length} videos from user playlist`);
    return items;
  } catch (e) {
    log.warn(`Failed to fetch user playlist videos: ${e.message}`);
    return [];
  }
}

/**
 * جلب محتوى عام متنوع للاستخدام كـ fallback لما مفيش تاريخ مشاهدة كفاية
 * عند المستخدم بعد (مستخدم جديد مثلًا). الشخصنة الحقيقية بتحصل في المتصفح
 * نفسه (client-side) عن طريق جلب "فيديوهات متشابهة" لآخر حاجات المستخدم
 * اتفرج عليها فعليًا — مش هنا في السيرفر، لأن صفحة يوتيوب الرئيسية
 * الشخصية (Home feed) مش endpoint مدعوم بشكل موثوق في yt-dlp، وتبويب
 * "الرائج" (Trending) نفسه ثابت وواحد لكل الناس بغض النظر عن الكوكيز.
 */
async function getRecommendedVideos(region = 'EG', limit = 20) {
  let items = [];

  try {
    const url = `https://www.youtube.com/feed/trending?gl=${encodeURIComponent(region)}`;
    const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(limit), url]);
    items = parseFlatItems(stdout);
  } catch (e) {
    log.warn(`Trending feed failed (${e.message}), falling back to search-based mix`);
  }

  if (items.length < 5) {
    const topicPool = [
      'أخبار مصر اليوم', 'أغاني مصرية جديدة', 'كوميدي مصري', 'رياضة مصر أهداف',
      'بودكاست عربي', 'أفلام كوميدي مصرية', 'مسلسلات رمضان', 'تكنولوجيا وتقنية',
      'وصفات طبخ سريعة', 'ألعاب فيديو', 'سيارات ومحركات', 'سفر وسياحة',
      'علوم وتاريخ', 'موسيقى عربي مختلط', 'تمثيليات وكواليس'
    ];
    const shuffled = topicPool.sort(() => Math.random() - 0.5).slice(0, 5);
    const perQuery = Math.max(10, Math.ceil(limit / shuffled.length) + 5);
    // بنجيب كل الـ queries مع بعض بالتوازي (مش واحد ورا التاني) — بيقلل زمن
    // الانتظار من مجموع كل الطلبات لأطول طلب واحد بس
    const settled = await Promise.allSettled(
      shuffled.map(q => runYtDlp([`ytsearch${perQuery}:${q}`, '--dump-json', '--flat-playlist']))
    );
    const pool = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') pool.push(...parseFlatItems(r.value));
      else log.warn(`Recommended fallback query failed "${shuffled[i]}": ${r.reason?.message}`);
    });
    const seen = new Set();
    items = pool
      .filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; })
      .sort(() => Math.random() - 0.5);
  }

  return { items: items.slice(0, limit), personalized: false };
}

/**
 * ==========================================================================
 * الهوم فيد المحسّن (v5.1.0) — بيحاول أولا جلب فيديوهات من حسابك الشخصي
 * ثم يختلطها مع أقسام مختارة من البحث العام (ترند، موسيقى، رياضة، إلخ)
 * للحصول على تجربة أفضل وأكثر تنوعا.
 * ==========================================================================
 */
const HOME_SECTIONS = [
  { key: 'personal', title: '👤 فيديوهاتي الشخصية', type: 'channel' },  // 🆕 من القناة الشخصية
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

  // 🆕 كاش منفصل للهوم فيد مع إمكانية override من query params
  const cacheKey = `home_${region}_${perSection}`;
  const cachedHome = homeCache.get(cacheKey);
  if (cachedHome) {
    log.info(`📦 Using cached home feed`);
    return cachedHome;
  }

  const fetchers = HOME_SECTIONS.map(async (section) => {
    try {
      let items;
      // 🆕 إذا كانت القسم "personal" وفيه channel ID، استخدمه
      if (section.key === 'personal' && USER_CHANNEL_ID) {
        log.info(`🎯 Attempting to fetch personal channel content...`);
        items = await getUserChannelVideos(USER_CHANNEL_ID, perSection);
      } else if (section.key === 'personal' && USER_PLAYLIST_ID) {
        log.info(`🎯 Attempting to fetch personal playlist content...`);
        items = await getUserPlaylistVideos(USER_PLAYLIST_ID, perSection);
      } else if (section.key === 'trending') {
        const url = `https://www.youtube.com/feed/trending?gl=${encodeURIComponent(region)}`;
        const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(perSection), url]);
        items = parseFlatItems(stdout);
      } else if (section.query) {
        const stdout = await runYtDlp([`ytsearch${perSection}:${section.query}`, '--dump-json', '--flat-playlist']);
        items = parseFlatItems(stdout);
      } else {
        items = [];
      }
      return { key: section.key, title: section.title, items };
    } catch (e) {
      log.warn(`Home section "${section.key}" failed: ${e.message}`);
      return { key: section.key, title: section.title, items: [] };
    }
  });

  // كل الأقسام بتتجاب مع بعض في نفس الوقت
  const sections = (await Promise.all(fetchers)).filter(s => s.items.length > 0);

  // خلطة "mixed" شبه اللي يوتيوب بيعرضها فعلاً في أول سكرول للهوم —
  // شوية من كل قسم متبعثرين مش مجمّعين ورا بعض
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

  const result = { region, sections, mixed };
  homeCache.set(cacheKey, result);
  return result;
}

/**
 * جلب فيديوهات قناة معيّنة + بيانات القناة نفسها (الاسم، عدد المشتركين، الصورة، الوصف)
 */
async function getChannelInfo(channelId) {
  const cacheKey = `channel_info_${channelId}`;
  const cached = channelCache.get(cacheKey);
  if (cached) return cached;

  const url = `https://www.youtube.com/channel/${channelId}`;
  const stdout = await runYtDlp(['--dump-json', url]);
  const info = JSON.parse(stdout);

  const result = {
    id: info.id,
    name: info.uploader || 'Unknown Channel',
    description: info.description || '',
    subscriberCount: info.channel_follower_count || 0,
    thumbnail: info.thumbnails?.length ? info.thumbnails[info.thumbnails.length - 1].url : '',
  };

  channelCache.set(cacheKey, result);
  return result;
}

async function getChannelVideos(channelId, limit = 20, page = 1) {
  return getPaginatedPool(
    channelCache,
    `channel_videos_${channelId}`,
    async (poolSize) => {
      const url = `https://www.youtube.com/channel/${channelId}/videos`;
      const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(poolSize), url]);
      return parseFlatItems(stdout);
    },
    page,
    limit
  );
}

// ==========================================================================
// ROUTES
// ==========================================================================

/**
 * GET /home?region=EG&perSection=12
 * 🆕 محسّن لجلب فيديوهات شخصية أولاً ثم أقسام البحث العام
 */
app.get('/home', async (req, res) => {
  try {
    const region = req.query.region || 'EG';
    const perSection = parseInt(req.query.perSection, 10) || 12;

    const home = await getHomeFeed(region, perSection);
    log.success(`✅ Home feed delivered (${home.sections.length} sections, ${home.mixed.length} mixed)`);
    res.json(home);
  } catch (error) {
    log.error(`Error building home feed: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر بناء صفحة الهوم',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /trending?region=EG&limit=20&page=1
 */
app.get('/trending', async (req, res) => {
  try {
    const region = req.query.region || 'EG';
    const limit = parseInt(req.query.limit, 10) || 20;
    const page = parseInt(req.query.page, 10) || 1;

    const cacheKey = `trending_${region}`;
    let trendingVideos = trendingCache.get(cacheKey);

    if (!trendingVideos) {
      const url = `https://www.youtube.com/feed/trending?gl=${encodeURIComponent(region)}`;
      const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', '100', url]);
      trendingVideos = parseFlatItems(stdout);
      trendingCache.set(cacheKey, trendingVideos);
      log.success(`✅ Trending feed fetched (${trendingVideos.length} videos)`);
    } else {
      log.info(`📦 Using cached trending feed`);
    }

    const start = (page - 1) * limit;
    const results = trendingVideos.slice(start, start + limit);
    const hasMore = trendingVideos.length > start + limit;

    res.json({ region, page, limit, results, hasMore });
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
  try {
    const query = req.query.q || '';
    if (!query.trim()) {
      return res.status(400).json({ error: 'query parameter required' });
    }

    const limit = parseInt(req.query.limit, 10) || 20;
    const page = parseInt(req.query.page, 10) || 1;

    const pool = await getPaginatedPool(
      infoCache,
      `search_${query}`,
      (poolSize) => searchVideos(query, poolSize),
      page,
      limit,
      100
    );

    log.success(`✅ Search for "${query}" returned ${pool.results.length} results (page ${page})`);
    res.json({ query, ...pool });
  } catch (error) {
    log.error(`Error searching: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر إجراء البحث',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /related?v=VIDEO_ID&limit=10&page=1
 */
app.get('/related', async (req, res) => {
  try {
    const videoId = req.query.v || '';
    if (!isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'invalid video ID' });
    }

    const limit = parseInt(req.query.limit, 10) || 10;
    const page = parseInt(req.query.page, 10) || 1;

    const pool = await getPaginatedPool(
      infoCache,
      `related_${videoId}`,
      (poolSize) => getRelatedVideos(videoId, poolSize),
      page,
      limit,
      50
    );

    log.success(`✅ Related videos for ${videoId} returned ${pool.results.length} results`);
    res.json({ videoId, ...pool });
  } catch (error) {
    log.error(`Error fetching related videos: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب فيديوهات ذات صلة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /channel?id=CHANNEL_ID&limit=20&page=1
 */
app.get('/channel', async (req, res) => {
  try {
    const channelId = req.query.id || '';
    if (!channelId.trim()) {
      return res.status(400).json({ error: 'channel id required' });
    }

    const limit = parseInt(req.query.limit, 10) || 20;
    const page = parseInt(req.query.page, 10) || 1;

    const [info, videos] = await Promise.all([
      getChannelInfo(channelId),
      getChannelVideos(channelId, limit, page)
    ]);

    log.success(`✅ Channel ${channelId} returned ${videos.results.length} videos`);
    res.json({ channel: info, videos: videos.results, pagination: { page: videos.page, limit: videos.limit, hasMore: videos.hasMore } });
  } catch (error) {
    log.error(`Error fetching channel: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب بيانات القناة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /info?v=VIDEO_ID
 */
app.get('/info', async (req, res) => {
  try {
    const videoId = req.query.v || '';
    if (!isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'invalid video ID' });
    }

    const cacheKey = `info_${videoId}`;
    let info = infoCache.get(cacheKey);

    if (!info) {
      info = await getVideoInfo(videoId);
      infoCache.set(cacheKey, info);
      log.success(`✅ Video info: ${videoId} (${info.title})`);
    } else {
      log.info(`📦 Using cached video info for ${videoId}`);
    }

    res.json(info);
  } catch (error) {
    log.error(`Error fetching video info: ${error.message}`);
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
  try {
    const videoId = req.query.v || '';
    if (!isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'invalid video ID' });
    }

    const cacheKey = `formats_${videoId}`;
    let info = infoCache.get(cacheKey);

    if (!info) {
      info = await getVideoInfo(videoId);
      infoCache.set(cacheKey, info);
    }

    const formats = (info.formats || []).map(f => ({
      format_id: f.format_id,
      ext: f.ext,
      height: f.height,
      width: f.width,
      fps: f.fps,
      filesize: f.filesize,
    }));

    log.success(`✅ Formats for ${videoId}: ${formats.length} formats`);
    res.json({ videoId, formats });
  } catch (error) {
    log.error(`Error fetching formats: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب صيغ الفيديو',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /comments?v=VIDEO_ID&limit=50
 */
app.get('/comments', async (req, res) => {
  try {
    const videoId = req.query.v || '';
    if (!isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'invalid video ID' });
    }

    const limit = parseInt(req.query.limit, 10) || 50;

    const cacheKey = `comments_${videoId}`;
    let comments = infoCache.get(cacheKey);

    if (!comments) {
      const info = await getVideoInfo(videoId);
      comments = (info.comments || []).slice(0, limit).map(c => ({
        author: c.author,
        text: c.text,
        timestamp: c.timestamp,
      }));
      infoCache.set(cacheKey, comments);
      log.success(`✅ Comments for ${videoId}: ${comments.length} comments`);
    }

    res.json({ videoId, limit, comments });
  } catch (error) {
    log.error(`Error fetching comments: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب التعليقات',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /video?v=VIDEO_ID&quality=1080&format=...
 * 🆕 محسّن مع دعم جودات عالية وصوت فقط
 */
app.get('/video', async (req, res) => {
  try {
    const videoId = req.query.v || '';
    if (!isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'invalid video ID' });
    }

    const quality = req.query.quality || 'best';
    const format = req.query.format || null;

    // تحديد صيغة ffmpeg المناسبة حسب الجودة المطلوبة
    let selectedFormat = format;
    if (!selectedFormat) {
      if (quality === 'audio') {
        selectedFormat = 'bestaudio';
      } else if (quality.match(/^\d+$/)) {
        const height = parseInt(quality, 10);
        selectedFormat = `best[height<=${height}]`;
      } else {
        selectedFormat = quality;
      }
    }

    log.info(`🎬 Streaming ${videoId} with quality=${quality}, format=${selectedFormat}`);

    const cacheKey = `stream_${videoId}_${selectedFormat}`;
    let streamUrl = streamCache.get(cacheKey);

    if (!streamUrl) {
      streamUrl = await getVideoStreamUrl(videoId, selectedFormat);
      streamCache.set(cacheKey, streamUrl);
    } else {
      log.info(`📦 Using cached stream URL`);
    }

    res.json({ videoId, quality, streamUrl });
  } catch (error) {
    log.error(`Error fetching stream: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر الحصول على رابط البث',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /video/qualities?v=VIDEO_ID
 * 🆕 جديد: تحديد كل الجودات المتاحة للفيديو
 */
const PROGRESSIVE_MAX_HEIGHT = 720;
const STANDARD_HEIGHTS = [144, 240, 360, 480, 720, 1080, 1440, 2160];

app.get('/video/qualities', async (req, res) => {
  try {
    const videoId = req.query.v || '';
    if (!isValidVideoId(videoId)) {
      return res.status(400).json({ error: 'invalid video ID' });
    }

    const cacheKey = `qualities_${videoId}`;
    const cached = infoCache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const info = await getVideoInfo(videoId);
    const formats = info.formats || [];
    const heights = [...new Set(
      formats
        .map(f => f.height)
        .filter(h => h && h > 0)
    )].sort((a, b) => b - a);

    const available = STANDARD_HEIGHTS.filter(h => [...heights].some(fh => Math.abs(fh - h) <= 20) || h <= Math.max(...heights, 0));
    const uniqueAvailable = [...new Set(available)].filter(h => h <= Math.max(...heights, 0)).sort((a, b) => b - a);

    const qualities = uniqueAvailable.map(h => ({
      label: h >= 2160 ? '4K' : h >= 1440 ? '1440p' : `${h}p`,
      quality: String(h),
      type: h <= PROGRESSIVE_MAX_HEIGHT ? 'progressive' : 'merged (ffmpeg)',
      url: `/video?v=${videoId}&quality=${h}`
    }));
    qualities.push({ label: '🎧 صوت فقط', quality: 'audio', type: 'audio', url: `/video?v=${videoId}&quality=audio` });

    const result = { id: videoId, title: info.title, qualities };
    infoCache.set(cacheKey, result);
    log.success(`✅ Qualities done: ${videoId} (${qualities.length} جودة)`);
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
    ytdlpReady: checkYtDlp(),
    ffmpegReady: (() => { try { require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' }); return true; } catch { return false; } })(),
    cookiesReady,
    userChannelConfigured: !!USER_CHANNEL_ID,
    userPlaylistConfigured: !!USER_PLAYLIST_ID,
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
    name: '🎬 srver v5.1.0 "جبارة+" - YouTube Proxy (بدون اعتماد على YouTube Data API)',
    version: SERVER_VERSION,
    environment: NODE_ENV,
    cookies: {
      source: '🔥 Firebase Realtime Database',
      url: FIREBASE_URL,
      refresh: 'كل 5 دقايق في الخلفية',
      ready: cookiesReady
    },
    personalContent: {
      userChannelId: USER_CHANNEL_ID || '❌ غير مضبوط',
      userPlaylistId: USER_PLAYLIST_ID || '❌ غير مضبوط',
      note: '🆕 عيّن USER_CHANNEL_ID أو USER_PLAYLIST_ID في .env عشان الفيديوهات الشخصية تظهر في /home'
    },
    concurrency: { max: YTDLP_CONCURRENCY },
    endpoints: {
      home: '/home?region=EG&perSection=12',
      trending: '/trending?region=EG&limit=20&page=1',
      video: '/video?v=VIDEO_ID&quality=1080 (أو &format=best[height<=720] القديم لسه شغال)',
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
    pagination: 'كل endpoints البحث/الترند/related/channel بترجع page و limit و hasMore — استخدمهم لعمل infinite scroll',
    examples: {
      'Home feed (أقسام زي يوتيوب + فيديوهاتك)': '/home?region=EG',
      'Trending page 1': '/trending?region=EG&page=1',
      'Play video (جودة تلقائية)': '/video?v=dQw4w9WgXcQ',
      'Play video 1080p': '/video?v=dQw4w9WgXcQ&quality=1080',
      'Audio only': '/video?v=dQw4w9WgXcQ&quality=audio',
      'Search videos': '/search?q=funny+cats&page=1',
      'Related videos': '/related?v=dQw4w9WgXcQ',
      'Channel videos': '/channel?id=YOUR_CHANNEL_ID',
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
║  🎬 srver v${SERVER_VERSION} "جبارة+" شغّال 🔥      ║
║  ═════════════════════════════════════     ║
║  Environment: ${NODE_ENV.padEnd(26, ' ')}║
║  yt-dlp: ${ytdlpStatus}  Firebase Cookies (bg refresh)  ║
║  Concurrency: ${String(YTDLP_CONCURRENCY).padEnd(24, ' ')}║
║  User Channel: ${(USER_CHANNEL_ID ? '✅' : '❌').padEnd(27, ' ')}║
║  http://0.0.0.0:${PORT}                        ║
╚═══════════════════════════════════════════╝
  `);
  log.success(`✅ Server ready - no YouTube Data API dependency`);
  log.info(`🆕 v5.1.0: تحسينات في /home (فيديوهاتك الشخصية) + cache محسّن`);
  log.info(`📍 Firebase: ${FIREBASE_URL}`);
  if (USER_CHANNEL_ID) log.success(`👤 User Channel ID: ${USER_CHANNEL_ID}`);
  if (USER_PLAYLIST_ID) log.success(`📋 User Playlist ID: ${USER_PLAYLIST_ID}`);
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
