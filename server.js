const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
// (مش محتاجين مكتبة cors تاني، الهيدرز بقت بتتحط يدوي فوق)
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

// ==========================================================================
// تحميل + دمج الجودات العالية — يوتيوب بيفصل الفيديو عن الصوت في ملفين
// منفصلين (DASH) لأي جودة فوق 720p تقريبًا. مفيش رابط واحد يعبّر عنهم مع
// بعض، فلازم نحمّلهم فعليًا وندمجهم بـ ffmpeg (يوتيوب-دي‌إل‌بي بيعمل ده لوحده
// وقت التحميل، بس مش وقت --get-url). الملفات بتتخزّن مؤقتًا في /tmp وبتتنضف
// كل شوية عشان مساحة القرص المحدودة على Railway.
// ==========================================================================
const TEMP_DIR = '/tmp/ytvideos';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
const TEMP_MAX_AGE_MS = 40 * 60 * 1000; // 40 دقيقة

function cleanupTempFiles() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(TEMP_DIR)) {
      const fp = path.join(TEMP_DIR, name);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > TEMP_MAX_AGE_MS) fs.unlinkSync(fp);
      } catch (e) {}
    }
  } catch (e) {}
}
setInterval(cleanupTempFiles, 10 * 60 * 1000);

function safeTempName(videoId, format) {
  const hash = require('crypto').createHash('md5').update(format).digest('hex').slice(0, 10);
  return `${videoId}_${hash}.mp4`;
}

const downloadLocks = new Map(); // بيمنع تحميل نفس الفيديو/الجودة أكتر من مرة في نفس الوقت
async function ensureMergedDownload(videoId, format) {
  const filename = safeTempName(videoId, format);
  const filepath = path.join(TEMP_DIR, filename);
  if (fs.existsSync(filepath)) return filepath;

  if (downloadLocks.has(filename)) return downloadLocks.get(filename);

  const job = (async () => {
    const tmpPath = filepath + '.part';
    await ytdlpLimiter.acquire();
    try {
      const finalArgs = cookiesReady ? ['--cookies', COOKIES_PATH] : [];
      finalArgs.push('--no-warnings', '-f', format, '--merge-output-format', 'mp4', '-o', tmpPath, `https://www.youtube.com/watch?v=${videoId}`);
      await execFileAsync('yt-dlp', finalArgs, { timeout: 240000, maxBuffer: 1024 * 1024 * 20 });
      fs.renameSync(tmpPath, filepath);
      return filepath;
    } finally {
      ytdlpLimiter.release();
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    }
  })();

  downloadLocks.set(filename, job);
  try {
    return await job;
  } finally {
    downloadLocks.delete(filename);
  }
}

function serveLocalFile(req, res, filepath) {
  const stat = fs.statSync(filepath);
  const fileSize = stat.size;
  const range = req.headers.range;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunkSize
    });
    fs.createReadStream(filepath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', fileSize);
    fs.createReadStream(filepath).pipe(res);
  }
}

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
 * جلب كل الجودات الحقيقية المتاحة لفيديو معيّن، وتحديد لكل واحدة منها
 * "طريقة تشغيل" مناسبة:
 * - لو فيه فورمات "progressive" (فيديو+صوت في ملف واحد) عند الطول ده، بنستخدمه
 *   لأنه بيدّي رابط تشغيل مباشر وسريع من غير أي تحميل من عندنا.
 * - لو الطول ده متاح بس كـ DASH (فيديو لوحده + صوت لوحده، وده حال أغلب
 *   الجودات فوق 720p)، بنطلب دمج (video+audio) وده هيحتاج تحميل ودمج فعلي
 *   من سيرفرنا (أبطأ شوية في أول تشغيل، لكن بيدّي الجودة الحقيقية بصوت).
 */
async function getVideoQualities(videoId) {
  const info = await getVideoInfo(videoId);
  const formats = info.formats || [];

  // أفضل تراك صوت منفصل متاح (audio-only)، هنستخدمه مع أي فيديو DASH منفصل
  let bestAudio = null;
  formats.forEach(f => {
    if (f.vcodec === 'none' && f.acodec && f.acodec !== 'none') {
      if (!bestAudio || (f.abr || 0) > bestAudio.abr) {
        bestAudio = { format_id: f.format_id, abr: f.abr || 0 };
      }
    }
  });

  /* لكل طول (height) بنحدد format_id صريح ومحدد — مش وصف مرن زي
     bestvideo[height<=H] لأن ده كان بيفشل بصمت لو مفيش نسخة DASH عند
     الطول ده بالظبط، ويرجع لنفس الفيديو لكل الجودات (وده سبب الباج
     اللي كل الجودات كانت طالعة زي بعض). دلوقتي كل جودة بترتبط بملف
     حقيقي محدد بالاسم، فمينفعش يحصل لبس. */
  const heightMap = new Map();
  formats.forEach(f => {
    if (!f.height || !f.vcodec || f.vcodec === 'none') return;
    const isProgressive = !!(f.acodec && f.acodec !== 'none');
    const entry = heightMap.get(f.height) || {};
    if (isProgressive) {
      if (!entry.progressiveFormatId || (f.tbr || 0) > (entry.progTbr || 0)) {
        entry.progressiveFormatId = f.format_id;
        entry.progTbr = f.tbr || 0;
      }
    } else {
      if (!entry.dashVideoFormatId || (f.tbr || 0) > (entry.dashTbr || 0)) {
        entry.dashVideoFormatId = f.format_id;
        entry.dashTbr = f.tbr || 0;
      }
    }
    heightMap.set(f.height, entry);
  });

  const heights = [...heightMap.keys()].sort((a, b) => b - a);
  const qualities = heights.map(h => {
    const entry = heightMap.get(h);
    if (entry.progressiveFormatId) {
      return { height: h, label: `${h}p`, format: entry.progressiveFormatId, needsMerge: false };
    }
    if (entry.dashVideoFormatId && bestAudio) {
      return { height: h, label: `${h}p`, format: `${entry.dashVideoFormatId}+${bestAudio.format_id}`, needsMerge: true };
    }
    if (entry.dashVideoFormatId) {
      // احتياطي نادر: مفيش صوت منفصل خالص، هنعرض الفيديو من غير صوت بدل ما نلغي الجودة دي
      return { height: h, label: `${h}p`, format: entry.dashVideoFormatId, needsMerge: false };
    }
    return null;
  }).filter(Boolean);

  qualities.unshift({ height: 0, label: 'تلقائي', format: 'best', needsMerge: false });

  return { id: videoId, title: info.title, qualities };
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
 * فلترة محتوى "المقترح" من السياسة/الأخبار الحساسة/المحتوى الرخيص — الموضوع
 * ده مش بيتطبق على نتايج البحث الصريح (لو المستخدم دوّر بنفسه على حاجة
 * سياسية مثلًا نديله ياها)، بس بيتطبق على أي حاجة بتترشّح تلقائيًا
 * (المقترح + المتشابهة) عشان الفيد يفضل نضيف.
 */
const BLOCKED_KEYWORDS = [
  // سياسة وأخبار
  'سياس', 'الرئيس', 'الرئاسة', 'السيسي', 'الانتخابات', 'البرلمان', 'مجلس النواب',
  'الحكومة', 'الوزراء', 'وزير', 'حزب', 'المعارضة', 'دبلوماس', 'قمة', 'اجتماع الأمن',
  'الأمم المتحدة', 'حماس', 'إسرائيل', 'اسرائيل', 'غزة', 'الاحتلال', 'الصراع', 'حرب',
  'قصف', 'عسكري', 'الجيش', 'انقلاب', 'مظاهر', 'احتجاج', 'اعتصام', 'إرهاب', 'ارهاب',
  // محتوى صادم / منخفض الجودة
  'صادم', 'فضيحة', 'مسربة', 'مسرب', 'جريمة', 'مقتل', 'قتل', 'اغتصاب', 'انتحار',
  'حادث مروع', 'عنف', 'دماء', 'جثة', 'مخدرات', 'إعدام', 'تعذيب'
];
function isCleanTitle(title){
  if(!title) return true;
  const t = title.toLowerCase();
  return !BLOCKED_KEYWORDS.some(k => t.includes(k));
}
function filterClean(items){
  return items.filter(v => isCleanTitle(v.title));
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
    const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--yes-playlist', '--playlist-end', String((limit * 2) + 1), url]);
    items = parseFlatItems(stdout, videoId);
  } catch (e) {
    log.warn(`Flat related fetch failed: ${e.message}`);
  }

  if (items.length === 0) {
    log.warn('⚠️  Flat related empty, retrying with full extraction...');
    const stdout = await runYtDlp(['--dump-json', '--yes-playlist', '--playlist-end', String((limit * 2) + 1), '--skip-download', url]);
    items = parseFlatItems(stdout, videoId);
  }

  return filterClean(items).slice(0, limit);
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
    const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--playlist-end', String(limit * 2), url]);
    items = filterClean(parseFlatItems(stdout));
  } catch (e) {
    log.warn(`Trending feed failed (${e.message}), falling back to search-based mix`);
  }

  if (items.length < 5) {
    // تعمّدنا نشيل مواضيع الأخبار والسياسة من هنا خالص
    const topicPool = [
      'أغاني مصرية جديدة', 'كوميدي مصري', 'رياضة مصر أهداف',
      'بودكاست عربي', 'أفلام كوميدي مصرية', 'مسلسلات رمضان', 'تكنولوجيا وتقنية',
      'وصفات طبخ سريعة', 'ألعاب فيديو', 'سيارات ومحركات', 'سفر وسياحة',
      'علوم وتاريخ', 'موسيقى عربي مختلط', 'تمثيليات وكواليس', 'فنون وإبداع'
    ];
    const shuffled = topicPool.sort(() => Math.random() - 0.5).slice(0, 5);
    const perQuery = Math.max(10, Math.ceil(limit / shuffled.length) + 5);
    const pool = [];
    for (const q of shuffled) {
      try {
        const stdout = await runYtDlp([`ytsearch${perQuery}:${q}`, '--dump-json', '--flat-playlist']);
        pool.push(...filterClean(parseFlatItems(stdout)));
      } catch (e) {
        log.warn(`Recommended fallback query failed "${q}": ${e.message}`);
      }
    }
    const seen = new Set();
    items = pool
      .filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; })
      .sort(() => Math.random() - 0.5);
  }

  return { items: items.slice(0, limit), personalized: false };
}

/**
 * جلب فيديوهات قناة معيّنة + بيانات القناة نفسها (الاسم، عدد المشتركين، الصورة، الوصف)
 */
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

    const cacheKey = `recommended_${region}_${poolSize}`;
    let cached = trendingCache.get(cacheKey);
    if (!cached) {
      cached = await getRecommendedVideos(region, poolSize);
      trendingCache.set(cacheKey, cached);
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
      channelCache.set(dataCacheKey, data);
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
 * GET /comments?v=VIDEO_ID&limit=50
 */
app.get('/comments', async (req, res) => {
  const videoId = req.query.v;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }

  const cacheKey = `comments_${videoId}_${limit}`;
  const cached = infoCache.get(cacheKey);
  if (cached) {
    log.info(`📦 Comments from cache: ${videoId}`);
    return res.json(cached);
  }

  try {
    const comments = await getVideoComments(videoId, limit);
    const response = { id: videoId, count: comments.length, results: comments };
    infoCache.set(cacheKey, response, 1800);
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
function streamFromUpstream(req, res, url, redirectCount = 0) {
  if (redirectCount > 5) {
    if (!res.headersSent) res.status(502).json({ error: 'تحويلات كتير أوي من المصدر' });
    return;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  const upstreamReq = https.get(url, { headers, timeout: 20000 }, (upstreamRes) => {
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
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']
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

/**
 * GET /qualities?v=VIDEO_ID
 */
app.get('/qualities', async (req, res) => {
  const videoId = req.query.v;
  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }
  const cacheKey = `qualities_${videoId}`;
  const cached = infoCache.get(cacheKey);
  if (cached) {
    log.info(`📦 Qualities from cache: ${videoId}`);
    return res.json(cached);
  }
  try {
    const data = await getVideoQualities(videoId);
    infoCache.set(cacheKey, data);
    log.success(`✅ Qualities done: ${videoId} (${data.qualities.length} جودة)`);
    res.json(data);
  } catch (error) {
    log.error(`Error fetching qualities: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب الجودات المتاحة',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/video', async (req, res) => {
  const { v: videoId, format = 'best[height<=720]' } = req.query;

  if (!videoId || !isValidVideoId(videoId)) {
    log.error(`Invalid video ID: ${videoId}`);
    return res.status(400).json({
      error: 'Video ID مطلوب وصحيح (11 حرف)',
      example: '/video?v=dQw4w9WgXcQ&format=best[height<=720]'
    });
  }

  // فورمات فيها "+" معناها فيديو وصوت منفصلين (DASH) ولازم دمج فعلي —
  // مش ممكن نعمل get-url ونعديها زي ما هي، لازم نحمّل وندمج بـ ffmpeg
  const needsMerge = format.includes('+');

  if (needsMerge) {
    try {
      log.info(`🎬 Merged download: ${videoId} (${format})`);
      const filepath = await ensureMergedDownload(videoId, format);
      log.success(`▶️  Serving merged file: ${videoId}`);
      return serveLocalFile(req, res, filepath);
    } catch (error) {
      log.error(`Merge download failed: ${error.message}`);
      return res.status(500).json({
        error: 'تعذّر تحميل ودمج الجودة دي، جرب جودة تانية',
        details: NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  const cacheKey = `stream_${videoId}_${format}`;
  const cachedUrl = streamCache.get(cacheKey);

  if (cachedUrl) {
    log.info(`📦 Stream from cache: ${videoId}`);
    return streamFromUpstream(req, res, cachedUrl);
  }

  let attempts = 0;
  let lastError = null;

  while (attempts < MAX_RETRIES) {
    try {
      log.info(`🎬 Fetching video: ${videoId} (attempt ${attempts + 1}/${MAX_RETRIES})`);

      const streamUrl = await getVideoStreamUrl(videoId, format);

      if (!streamUrl) {
        throw new Error('Failed to get stream URL');
      }

      streamCache.set(cacheKey, streamUrl);
      log.success(`▶️  Streaming: ${videoId}`);

      streamFromUpstream(req, res, streamUrl);
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
    name: '🎬 srver v4.0 - YouTube Proxy (بدون اعتماد على YouTube Data API)',
    version: '4.0.0',
    environment: NODE_ENV,
    cookies: {
      source: '🔥 Firebase Realtime Database',
      url: FIREBASE_URL,
      refresh: 'كل 5 دقايق في الخلفية',
      ready: cookiesReady
    },
    concurrency: { max: YTDLP_CONCURRENCY },
    endpoints: {
      trending: '/trending?region=EG&limit=20&page=1',
      video: '/video?v=VIDEO_ID&format=best[height<=720]',
      info: '/info?v=VIDEO_ID',
      formats: '/formats?v=VIDEO_ID',
      search: '/search?q=QUERY&limit=20&page=1',
      related: '/related?v=VIDEO_ID&limit=10&page=1',
      channel: '/channel?id=CHANNEL_ID&limit=20&page=1',
      qualities: '/qualities?v=VIDEO_ID',
      comments: '/comments?v=VIDEO_ID&limit=50',
      health: '/health',
      cookiesStatus: '/api/cookies-status'
    },
    pagination: 'كل endpoints البحث/الترند/related/channel بترجع page و limit و hasMore — استخدمهم لعمل infinite scroll',
    examples: {
      'Trending page 1': '/trending?region=EG&page=1',
      'Trending page 2 (سكرول لاحق)': '/trending?region=EG&page=2',
      'Play video': '/video?v=dQw4w9WgXcQ',
      'Search videos': '/search?q=funny+cats&page=1',
      'Related videos': '/related?v=dQw4w9WgXcQ',
      'Channel videos': '/channel?id=UCuAXFkgsw1L7xaCfnd5JJOw',
      'Video comments': '/comments?v=dQw4w9WgXcQ',
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
