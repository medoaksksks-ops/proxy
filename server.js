const express = require('express'); const { execFile, spawn } =
require('child_process'); const { promisify } = require('util'); const
fs = require('fs'); const path = require('path'); // (مش محتاجين مكتبة cors تاني، الهيدرز بقت بتتحط يدوي فوق)
const NodeCache = require('node-cache'); const https = require('https');
require('dotenv').config();

/*
==========================================================================
🔖 srver v5.0.0 "جبارة" — نسخة موسّعة فوق v4.0 الأصلية بدون حذف أي حاجة:
• كل جودات الفيديو (144p → 4K) + دمج فيديو/صوت لحظي بـ ffmpeg للجودات العالية اللي معندهاش progressive stream جاهز.
• هوم فيد بأقسام (Sections) زي صفحة يوتيوب الرئيسية الحقيقية.
• جلب متوازي (Promise.all) بدل التسلسلي → أسرع بشكل ملحوظ.
• keep-alive agent لإعادة استخدام الاتصالات مع جوجل.
==========================================================================
*/
const SERVER_VERSION = '7.1.0';

/* Agent واحد بيعيد استخدام نفس اتصالات TCP/TLS بدل ما يفتح اتصال جديد لكل طلب لجوجل — ده اللي بيدي إحساس "سريع" فعلي في البث والـ API calls */
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets:
100, keepAliveMsecs: 30000 });

const execFileAsync = promisify(execFile);

const app = express(); const PORT = process.env.PORT || 3000; const
NODE_ENV = process.env.NODE_ENV || 'development';
app.disable('x-powered-by'); app.set('etag', true);

// Firebase config
const FIREBASE_URL = process.env.FIREBASE_URL ||
'https://english-73376-default-rtdb.firebaseio.com'; const
FIREBASE_SECRET = process.env.FIREBASE_SECRET || '';

// CORS intentionally removed: same-origin deployment avoids browser preflight overhead.

app.use(express.json()); app.use(express.text({ limit: '10mb' }));

// ————— Cache —————
const infoCache = new NodeCache({ stdTTL: 10800 }); // معلومات فيديو/بحث/related: ساعتين
const trendingCache = new NodeCache({ stdTTL: 600 }); // الرائج: 20 دقيقة
const streamCache = new NodeCache({ stdTTL: 300 }); // روابط التشغيل المباشرة بتنتهي بسرعة: 4 دقايق بس
const channelCache = new NodeCache({ stdTTL: 7200 }); // بيانات وفيديوهات القنوات: ساعة

const TIMEOUT = 45000; const MAX_RETRIES = 2;

// Logger
const log = { info: (msg) =>
console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`), success: (msg) =>
console.log(`[${new Date().toISOString()}] ✅ ${msg}`), error: (msg) =>
console.error(`[${new Date().toISOString()}] ❌ ${msg}`), warn: (msg) =>
console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`) };

/*
==========================================================================
Concurrency limiter — بيمنع الـ Railway instance من إنه يتحمّل أكتر من طاقته
(كل عملية yt-dlp بتاخد وقت وذاكرة، فمينفعش نسيب عدد لا نهائي يشتغلوا مع بعض)
==========================================================================
*/
class Semaphore { constructor(max) { this.max = max; this.current = 0;
this.queue = []; } acquire() { if (this.current < this.max) {
this.current++; return Promise.resolve(); } return new Promise(resolve =>
this.queue.push(resolve)); } release() { this.current--; const next =
this.queue.shift(); if (next) { this.current++; next(); } } } const
YTDLP_CONCURRENCY = parseInt(process.env.YTDLP_CONCURRENCY, 10) || 6;
const ytdlpLimiter = new Semaphore(YTDLP_CONCURRENCY);

// منع تشغيل نفس yt-dlp أكثر من مرة لو عدة مستخدمين طلبوا نفس الشيء في نفس اللحظة.
const inflight = new Map(); function dedupe(key, fn) { if
(inflight.has(key)) return inflight.get(key); const p =
Promise.resolve().then(fn).finally(() => inflight.delete(key));
inflight.set(key, p); return p; }

/*
==========================================================================
كوكيز يوتيوب — بيتحدّثوا في الخلفية كل 5 دقايق بدل ما كل request يعمل طلب
لـ Firebase لوحده (كان بيسبب race condition وبطء ومكالمات مكررة كتير)
==========================================================================
*/
const COOKIES_PATH = '/tmp/.cookies.txt'; let cookiesReady = false;

function fetchCookiesFromFirebase() { return new Promise((resolve) => {
const url = FIREBASE_SECRET ?
`${FIREBASE_URL}/youtube_cookies.json?auth=${FIREBASE_SECRET}` :
`${FIREBASE_URL}/youtube_cookies.json`;

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

}); }

let lastCookiesContent = ''; async function refreshCookies() { try {
const content = await fetchCookiesFromFirebase(); if (content &&
content.trim() && content !== lastCookiesContent) {
fs.writeFileSync(COOKIES_PATH, content); lastCookiesContent = content;
cookiesReady = true;
log.success(`🍪 Cookies refreshed (${content.length} bytes)`); } else if
(!content) { log.warn('⚠️ No cookies available in Firebase yet'); } }
catch (e) { log.error(`Cookie refresh failed: ${e.message}`); } }
refreshCookies(); setInterval(refreshCookies, 5 * 60 * 1000);

// Check if yt-dlp is installed
function checkYtDlp() { try {
require('child_process').execSync('yt-dlp --version', { stdio: 'ignore'
}); return true; } catch { return false; } }

// Validation
function isValidVideoId(id) { return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function sanitizeFilename(name) { return name.replace(/[^\w\s-]/g,
'').substring(0, 100) || 'video'; }

/** تشغيل yt-dlp بشكل غير متزامن (async) بدون shell — بيستقبل الـ args كمصفوفة
عشان محدّش يقدر يحقن أوامر شل حتى لو query البحث فيه رموز غريبة، وكمان
بيدي كل request مكانه في الطابور (semaphore) بدل ما يبوّظ السيرفر كله. */
function commandExists(command) { try {
require('child_process').execFileSync(command, ['--version'], { stdio:
'ignore' }); return true; } catch { return false; } }

function isRetryableYoutubeError(error) { const text =
String(error?.message || error || '').toLowerCase(); return /page needs to be reloaded|sign in to confirm|confirm you're not a bot|confirm you're not a bot|http error 403|requested format is not available|video unavailable|not available in your country/.test(text); }

async function runYtDlp(args, { timeout = TIMEOUT, maxBuffer = 1024 *
1024 * 10, useCookies = false, allowCookieFallback = true } = {}) {
await ytdlpLimiter.acquire(); try { const base = ['--no-warnings']; if
(commandExists('node')) base.push('--js-runtimes', 'node');

    const attempts = [];
    const pushAttempt = (extra, cookies = false) => {
      attempts.push([...base, ...extra, ...(cookies && cookiesReady ? ['--cookies', COOKIES_PATH] : []), ...args]);
    };

    // Public extraction first: shared server cookies should not poison normal requests.
    pushAttempt([], useCookies);
    if (!useCookies) pushAttempt(['--extractor-args', 'youtube:player_client=default,web_safari']);

    if (allowCookieFallback && cookiesReady && !useCookies) {
      pushAttempt(['--extractor-args', 'youtube:player_client=default,-tv_downgraded,web_embedded'], true);
      pushAttempt(['--extractor-args', 'youtube:player_client=web_embedded'], true);
    }

    let lastError;
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
        if (i < attempts.length - 1) log.warn(`yt-dlp attempt ${i + 1} failed, trying fallback: ${String(error.message || error).split('\n')[0]}`);
      }
    }
    throw lastError;

} finally { ytdlpLimiter.release(); } }

/** بيحوّل ناتج --dump-json (سطر لكل فيديو) لمصفوفة عناصر موحّدة الشكل */
function mapFlatEntry(item, excludeId) { if (!item || !item.id) return
null; if (excludeId && item.id === excludeId) return null; return { id:
item.id, title: item.title || 'بدون عنوان', author: item.uploader ||
item.channel || 'Unknown', channelId: item.channel_id || '', duration:
item.duration || 0, thumbnail: item.thumbnails?.length ?
item.thumbnails[item.thumbnails.length - 1].url :
`https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`, viewCount:
item.view_count || 0 }; }

function parseFlatItems(raw, excludeId) { return raw .trim() .split('\n')
.filter(Boolean) .map(line => { let item; try { item = JSON.parse(line);
} catch (e) { return null; } return mapFlatEntry(item, excludeId); })
.filter(Boolean); }

/** *
========================================================================== *
فلتر محتوى غير مرغوب فيه — بيستبعد فيديوهات الأطفال/الكرتون ومحتوى
الطبخ * من "المقترحات" و"الهوم فيد" و"الترند" بس (مش من البحث الصريح أو
القنوات * أو related لفيديو معيّن اختاره المستخدم بنفسه — لو المستخدم دور
بايده على * "وصفات طبخ" مثلًا من الشيبس، ده اختياره وهيتنفّذ عادي). *
==========================================================================
*/ const UNWANTED_KEYWORDS = [
  // أطفال / كرتون
  'كرتون', 'رسوم متحركة',
  'للأطفال', 'اطفال', 'أطفال', 'بيبي', 'بيبى', 'روضة', 'حضانة', 'قصص اطفال', 'قصص أطفال', 'اغاني اطفال', 'أغاني أطفال', 'العاب اطفال', 'ألعاب أطفال', 'تعليم اطفال', 'تعليم أطفال', 'انمي اطفال', 'مسلسل كرتون',
'cartoon', 'kids', 'for kids', 'nursery rhyme', 'nursery rhymes',
'cocomelon', 'baby shark', 'peppa pig', 'toddler', 'preschool',
'children song',
  // طبخ / وصفات
  'وصفة', 'وصفات', 'طبخ', 'طبخة', 'طريقة عمل', 'حلويات', 'أكلة', 'اكلة', 'مطبخ', 'شيف', 'recipe', 'cooking',
'kitchen']; function isUnwantedContent(title) { if (!title) return
false; const t = title.toLowerCase(); return UNWANTED_KEYWORDS.some(k =>
t.includes(k.toLowerCase())); } function filterUnwanted(items) { return
items.filter(v => !isUnwantedContent(v.title)); }

/** * جلب صفحة من نتايج بأي حجم مطلوب، مع كاش لكل "بركة" (pool) بحجمها
— * عشان السكرول اللانهائي (infinite scroll) يقدر يكمّل يجيب صفحات
جديدة * من غير ما يعيد طلب yt-dlp لنفس البيانات القديمة تاني. */
async function getPaginatedPool(cache, cacheKeyBase, fetchPoolFn, page, limit,
maxPool = 150) { const pageNum = Math.max(1, parseInt(page, 10) || 1);
const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 30);
const needed = pageNum * pageSize; const poolSize =
Math.min(Math.max(needed, pageSize * 2), maxPool);

const cacheKey = `${cacheKeyBase}_${poolSize}`; let pool =
cache.get(cacheKey); if (!pool) { pool = await fetchPoolFn(poolSize);
cache.set(cacheKey, pool); }

const start = (pageNum - 1) * pageSize; const results =
pool.slice(start, start + pageSize); const hasMore = pool.length >
start + pageSize;

return { page: pageNum, limit: pageSize, results, hasMore }; }

/** * الحصول على معلومات الفيديو الكاملة */ async function
getVideoInfo(videoId) { const key = `raw_info_${videoId}`; const cached =
infoCache.get(key); if (cached) return cached;

return dedupe(key, async () => { const again = infoCache.get(key); if
(again) return again;

    const stdout = await runYtDlp([
      '--dump-json', '--no-playlist',
      `https://www.youtube.com/watch?v=${videoId}`
    ]);
    const info = JSON.parse(stdout);
    infoCache.set(key, info, 10800);
    return info;

}); }

async function getFormatUrls(videoId, formatSelector) { const key =
`urls_${videoId}_${formatSelector}`; const cached = streamCache.get(key);
if (cached) return cached;

return dedupe(key, async () => { const again = streamCache.get(key); if
(again) return again;

    const stdout = await runYtDlp([
      '--get-url', '--no-playlist', '-f', formatSelector,
      `https://www.youtube.com/watch?v=${videoId}`
    ], { timeout: 45000 });

    const urls = stdout.trim().split('\n').map(s => s.trim()).filter(Boolean);
    if (!urls.length) throw new Error('No stream URL returned');
    streamCache.set(key, urls, 300);
    return urls;

}); }

async function getVideoStreamUrl(videoId, format = 'best') { const urls
= await getFormatUrls(videoId, format); const streamUrl = urls[0];
log.success(`🎬 Got stream URL (${streamUrl.length} chars)`); return
streamUrl; }

/** * البحث عن فيديوهات على يوتيوب باستخدام yt-dlp (بدون أي اعتماد على
YouTube Data API) */ async function searchVideos(query, limit = 10) {
log.info(`🔎 Searching: "${query}" (limit ${limit})`); const stdout =
await runYtDlp([`ytsearch${limit}:${query}`, '--dump-json',
'--flat-playlist']); return parseFlatItems(stdout); }

/** * جلب الفيديوهات المقترحة/ذات الصلة (related) لفيديو معين * بيستخدم
playlist المكسات التلقائية اللي يوتيوب بيولدها (RD + videoId) */ async
function getRelatedVideos(videoId, limit = 10) { const key =
`related_pool_v7_${videoId}_${limit}`; const cached = infoCache.get(key);
if (cached) return cached;

return dedupe(key, async () => { const again = infoCache.get(key); if
(again) return again;

    let title = '';
    try {
      const info = await getVideoInfo(videoId);
      title = String(info.title || '').replace(/[|]/g, ' ').trim();
    } catch (e) {
      log.warn(`Related info lookup failed (continuing): ${e.message}`);
    }

    const searches = [
      `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`,
      ...(title ? [null] : [])
    ];
    const results = await Promise.allSettled([
      runYtDlp([
        '--dump-json', '--flat-playlist', '--yes-playlist',
        '--playlist-end', String(Math.max(limit * 3, 20)), searches[0]
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
        log.warn(`Related source failed: ${r.reason?.message || r.reason}`);
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

}); }

/** *
========================================================================== *
القنوات/المبدعين المفضّلين — المحتوى المقترح بيدّي لهم أولوية قبل أي *
حاجة تانية (ترند عام أو مواضيع عشوائية). دول أسماء حقيقية اختارها * صاحب
الموقع، فبنبحث باسم كل واحد فيهم على يوتيوب ونجيب أحدث فيديوهاته. *
==========================================================================
*/ const FOLLOWED_CREATORS = [ 'كامل العربي', 'اوشا', 'صلاح القصة وما فيها', 'سامح سند', 'بدر العلوي', 'ابو الصادق', 'مستر محمد ايمن الجوهري',
'مستر محمد صلاح مدرس لغة انجليزية', 'مستر محمد عبدالمعبود', 'مستر رضا الفاروق', 'انجلشاوي', 'عبقري لغة خالد صقر', 'قناة توست', 'كوتش الغلابة'];

const DISCOVERY_BLOCKED = [ 'shorts', '#shorts', 'ميمز', 'مقاطع مضحكة جدا', ...UNWANTED_KEYWORDS];

function normalizeText(value) { return String(value ||
'').toLowerCase().replace(/[ً-ٟ]/g,'').replace(/[أإآ]/g,
'ا').replace(/ة/g, 'ه').trim(); } function hasKeyword(title, keywords) {
const t = normalizeText(title); return keywords.some(k =>
t.includes(normalizeText(k))); } function isDiscoveryBlocked(item) {
return hasKeyword(item?.title, DISCOVERY_BLOCKED); } function
filterDiscovery(items) { return (items || []).filter(v => v?.id &&
!isDiscoveryBlocked(v)); } function relevanceScore(item, queryTerms =
[]) { const title = normalizeText(item?.title); const channel =
normalizeText(item?.author); let score = 0; for (const term of
queryTerms) { const t = normalizeText(term); if (!t) continue; if
(title.includes(t)) score += 5; if (channel.includes(t)) score += 2; }
if (item?.isLive) score += 1; return score; } function
rankDiscovery(items, queryTerms = []) { return
[...filterDiscovery(items)].sort((a, b) => relevanceScore(b, queryTerms) -
relevanceScore(a, queryTerms)); }

async function getFollowedCreatorsPool(perCreator = 4) { const settled =
await Promise.allSettled( FOLLOWED_CREATORS.map(name =>
runYtDlp([`ytsearchdate${perCreator}:${name}`, '--dump-json',
'--flat-playlist'])) ); const pool = []; settled.forEach((r, i) => { if
(r.status === 'fulfilled')
pool.push(...filterDiscovery(parseFlatItems(r.value))); else
log.warn(`Followed creator fetch failed "${FOLLOWED_CREATORS[i]}": ${r.reason?.message}`);
}); return pool; }

const DISCOVERY_QUERIES = [ 'أخبار مصر اليوم', 'ترند مصر اليوم', 'أهم الأخبار اليوم مصر', 'تكنولوجيا اليوم مراجعات', 'كرة القدم مصر اليوم',
'أهداف وملخصات مباريات اليوم', 'بودكاست عربي جديد', 'وثائقي عربي جديد',
'محتوى مصري جديد'];

function parseSeedIds(value) { if (!value) return []; return
String(value).split(',').map(v =>
v.trim()).filter(isValidVideoId).slice(0, 4); }

async function getSeedRecommendations(seedIds, limit) { if
(!seedIds.length) return []; const settled = await
Promise.allSettled(seedIds.map(id => getRelatedVideos(id, Math.min(12,
Math.max(6, Math.ceil(limit / seedIds.length)))))); const pool = [];
const seen = new Set(seedIds); for (const r of settled) { if (r.status
!== 'fulfilled') continue; for (const item of r.value) { if (!item?.id
|| seen.has(item.id)) continue; seen.add(item.id); pool.push(item); if
(pool.length >= limit) return pool; } } return pool; }

async function getRecommendedVideos(region = 'EG', limit = 20, seedIds =
[]) { const seedKey = seedIds.join('_') || 'none'; const key =
`recommended_v7_${region}_${limit}_${seedKey}`; const cached =
trendingCache.get(key); if (cached) return cached;

return dedupe(key, async () => { const items = []; const seen = new
Set(); const channelCounts = new Map(); const add = (list, maxPerChannel
= 2) => { for (const v of filterDiscovery(list)) { if (!v?.id ||
seen.has(v.id)) continue; const channel = v.channelId || v.author ||
'unknown'; const count = channelCounts.get(channel) || 0; if (count >=
maxPerChannel && items.length < limit - 3) continue; seen.add(v.id);
channelCounts.set(channel, count + 1); items.push(v); if
(items.length >= limit) break; } };

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
    trendingCache.set(key, result, 600);
    return result;

}); }

/** *
========================================================================== *
الهوم فيد الكامل — بيحاول يقلّد شكل صفحة يوتيوب الرئيسية الحقيقية: * مش
قايمة واحدة، لكن "أقسام" (Sections) زي: الرائج، موسيقى، رياضة، ألعاب، *
أخبار، تكنولوجيا، أفلام/مسلسلات، بودكاست... كل قسم بيتجاب بالتوازي مع *
الباقي (مش واحد ورا التاني) عشان الاستجابة تكون سريعة حتى مع عدد أقسام
كبير. * فيه كمان "mixed" وهي خلطة من كل الأقسام مبعثرة زي ما يوتيوب
بيعمل بالظبط * في أول تحميل للصفحة الرئيسية. *
==========================================================================
*/ const HOME_SECTIONS = [
  { key: 'trending', title: '🔥 الرائج الآن', query: null }, // بيتجاب من فيد الترند الحقيقي
  { key: 'music', title: '🎵 موسيقى', query: 'أغاني عربي جديد 2026' },
  { key: 'sports', title: '⚽ رياضة', query: 'أهداف وملخصات مباريات' },
  { key: 'gaming', title: '🎮 ألعاب', query: 'ألعاب فيديو جيمنج' },
  { key: 'news', title: '📰 أخبار', query: 'أخبار عاجلة اليوم' },
  { key: 'tech', title: '💻 تكنولوجيا', query: 'تكنولوجيا مراجعات تقنية' },
  { key: 'entertainment', title: '🎬 ترفيه وأفلام', query: 'أفلام ومسلسلات تريلر' },
  { key: 'podcasts', title: '🎙️ بودكاست', query: 'بودكاست عربي حوار' },
  { key: 'comedy', title: '😂 كوميدي', query: 'فيديوهات كوميدي مضحكة' },
  { key: 'live', title: '🔴 مباشر الآن', query: 'بث مباشر live' }];

async function getHomeFeed(region = 'EG', perSection = 12) { const key =
`home_v6_${region}_${perSection}`; const cached = trendingCache.get(key);
if (cached) return cached;

return dedupe(key, async () => { const again = trendingCache.get(key);
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
    trendingCache.set(key, result, 600);
    return result;

}); }

/** * جلب فيديوهات قناة معيّنة + بيانات القناة نفسها (الاسم، عدد
المشتركين، الصورة، الوصف) */ async function getChannelVideos(channelId,
limit = 20) { const url =
`https://www.youtube.com/channel/${channelId}/videos`;
log.info(`📺 Fetching channel: ${channelId} (limit ${limit})`); const
stdout = await runYtDlp(['--flat-playlist', '--dump-single-json',
'--playlist-end', String(limit), url]); const data = JSON.parse(stdout);
const videos = (data.entries || []).map(e =>
mapFlatEntry(e)).filter(Boolean); return { channel: { id:
data.channel_id || channelId, title: data.channel || data.uploader ||
'قناة', followers: data.channel_follower_count || null, avatar:
data.thumbnails?.length ? data.thumbnails[data.thumbnails.length -
1].url : null, description: data.description || '' }, videos }; }

/** * جلب تعليقات حقيقية من يوتيوب لفيديو معيّن */ async function
getVideoComments(videoId, limit = 50) {
log.info(`💬 Fetching comments: ${videoId} (limit ${limit})`); const args
= [ '--skip-download', '--dump-json', '--write-comments',
'--extractor-args',
`youtube:comment_sort=top;max_comments=${limit},all,all,${limit}`,
`https://www.youtube.com/watch?v=${videoId}` ]; const stdout = await
runYtDlp(args, { timeout: 45000 }); const lines =
stdout.trim().split('\n').filter(Boolean); const data =
JSON.parse(lines[lines.length - 1]); return (data.comments ||
[]).slice(0, limit).map(c => ({ id: c.id, author: c.author || 'مستخدم يوتيوب', authorThumbnail: c.author_thumbnail || '', text: c.text ||'',
likeCount: c.like_count || 0, isReply: !!(c.parent && c.parent !==
'root'), timestamp: c.timestamp ? new Date(c.timestamp * 1000).toISOString() : null })); }

/*
==========================================================================
Routes
==========================================================================
*/

/** * GET /trending?region=EG&limit=20&page=1 */ /** * GET
/trending?region=EG&limit=20&page=1 * (بيرجّع محتوى شخصي بناءً على الكوكيز
لو متاحة، وإلا محتوى عام متنوّع) */ app.get('/trending', async (req, res) => {
const region = (req.query.region || 'EG').toUpperCase(); try {
const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1); const
pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1),
30); const needed = pageNum * pageSize; const poolSize =
Math.min(Math.max(needed, pageSize * 2), 150);

    const seedIds = parseSeedIds(req.query.seed || req.query.seeds || req.query.history);
    const cacheKey = `recommended_v7_${region}_${poolSize}_${seedIds.join('_') || 'none'}`;
    let cached = trendingCache.get(cacheKey);
    if (!cached) {
      cached = await getRecommendedVideos(region, poolSize, seedIds);
      trendingCache.set(cacheKey, cached);
    }

    const start = (pageNum - 1) * pageSize;
    const results = cached.items.slice(start, start + pageSize);
    const hasMore = cached.items.length > start + pageSize;

    log.success(`✅ Recommended done: ${region} page ${pageNum} (${results.length} نتيجة, personalized=${cached.personalized})`);
    res.json({ region, page: pageNum, limit: pageSize, count: results.length, hasMore, personalized: cached.personalized, results });

} catch (error) {
log.error(`Error fetching recommended: ${error.message}`);
res.status(500).json({ error: 'تعذّر جلب المحتوى المقترح', details:
NODE_ENV === 'development' ? error.message : undefined }); } });

/** * GET /home?region=EG&perSection=12 * فيد الصفحة الرئيسية الكامل
بأقسام (trending, music, sports, gaming...) * + خلطة "mixed" جاهزة للعرض
المباشر — زي شكل هوم يوتيوب الحقيقي */ app.get('/home', async (req, res) => {
const region = (req.query.region || 'EG').toUpperCase(); const
perSection = Math.min(Math.max(parseInt(req.query.perSection, 10) || 12,
4), 25);

const cacheKey = `home_${region}_${perSection}`; try { let data =
trendingCache.get(cacheKey); if (!data) { data = await
getHomeFeed(region, perSection); trendingCache.set(cacheKey, data); }
log.success(`✅ Home feed done: ${region} (${data.sections.length} قسم, ${data.mixed.length} فيديو)`);
res.json(data); } catch (error) {
log.error(`Error building home feed: ${error.message}`);
res.status(500).json({ error: 'تعذّر بناء الصفحة الرئيسية', details:
NODE_ENV === 'development' ? error.message : undefined }); } });

/** * GET /search?q=QUERY&limit=20&page=1 */ app.get('/search', async (req, res) => { const { q: query } = req.query;

if (!query || !query.trim()) { return res.status(400).json({ error:
'كلمة البحث مطلوبة', example: '/search?q=funny+cats&limit=20&page=1' });
}

try { const { page, limit, results, hasMore } = await getPaginatedPool(
infoCache, `search_${query}`, (poolSize) => searchVideos(query, poolSize),
req.query.page, req.query.limit );
log.success(`✅ Search done: "${query}" page ${page} (${results.length} نتيجة)`);
res.json({ query, page, limit, count: results.length, hasMore, results
}); } catch (error) { log.error(`Error searching: ${error.message}`);
res.status(500).json({ error: 'تعذّر تنفيذ البحث', details: NODE_ENV ===
'development' ? error.message : undefined }); } });

/** * GET /related?v=VIDEO_ID&limit=10&page=1 */ app.get('/related',
async (req, res) => { const { v: videoId } = req.query;

if (!videoId || !isValidVideoId(videoId)) { return
res.status(400).json({ error: 'Video ID مطلوب وصحيح (11 حرف)', example:
'/related?v=dQw4w9WgXcQ&limit=10&page=1' }); }

try { const { page, limit, results, hasMore } = await getPaginatedPool(
infoCache, `related_${videoId}`, (poolSize) => getRelatedVideos(videoId,
poolSize), req.query.page, req.query.limit, 60 );
log.success(`✅ Related done: ${videoId} page ${page} (${results.length} نتيجة)`);
res.json({ id: videoId, page, limit, count: results.length, hasMore,
results }); } catch (error) {
log.error(`Error fetching related: ${error.message}`);
res.status(500).json({ error: 'تعذّر جلب الفيديوهات المقترحة', details:
NODE_ENV === 'development' ? error.message : undefined }); } });

/** * GET /channel?id=CHANNEL_ID&limit=20&page=1 */ app.get('/channel',
async (req, res) => { const channelId = req.query.id;

if (!channelId) { return res.status(400).json({ error: 'channel id مطلوب', example: '/channel?id=UCxxxxxxxx&limit=20&page=1' }); }

try { const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
const pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || 20,
1), 30); const needed = pageNum * pageSize; const poolSize =
Math.min(Math.max(needed, pageSize * 2), 100);

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

} catch (error) { log.error(`Error fetching channel: ${error.message}`);
res.status(500).json({ error: 'تعذّر جلب بيانات القناة', details:
NODE_ENV === 'development' ? error.message : undefined }); } });

/** * GET /comments?v=VIDEO_ID&limit=50 */ app.get('/comments', async (req, res) => { const videoId = req.query.v; const limit =
Math.min(parseInt(req.query.limit, 10) || 50, 100);

if (!videoId || !isValidVideoId(videoId)) { return
res.status(400).json({ error: 'Video ID غير صحيح' }); }

const cacheKey = `comments_${videoId}_${limit}`; const cached =
infoCache.get(cacheKey); if (cached) {
log.info(`📦 Comments from cache: ${videoId}`); return res.json(cached); }

try { const comments = await getVideoComments(videoId, limit); const
response = { id: videoId, count: comments.length, results: comments };
infoCache.set(cacheKey, response, 1800);
log.success(`✅ Comments done: ${videoId} (${comments.length} تعليق)`);
res.json(response); } catch (error) {
log.error(`Error fetching comments: ${error.message}`);
res.status(500).json({ error: 'تعذّر جلب التعليقات (ممكن تكون التعليقات مقفولة على الفيديو ده)', details: NODE_ENV === 'development' ?
error.message : undefined }); } });

/** * GET /video?v=VIDEO_ID */ /** * بيسحب الفيديو من الرابط المباشر
(googlevideo) ويبعته للمتصفح بايت بايت، * بدل عمل redirect. ده بيحل
مشكلة إن رابط يوتيوب مقفول على IP السيرفر: * دلوقتي المتصفح مايكلمش
يوتيوب خالص، بيكلم سيرفرنا بس، وسيرفرنا هو اللي * بيكلم يوتيوب بنفس الـ
IP اللي جاب بيه الرابط أصلاً. */ function streamFromUpstream(req, res,
url, redirectCount = 0) { if (redirectCount > 5) { if (!res.headersSent)
res.status(502).json({ error: 'تحويلات كتير أوي من المصدر' }); return; }

const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept': '*/*',
'Accept-Encoding': 'identity' }; if (req.headers.range) headers['Range']
= req.headers.range;

const upstreamReq = https.get(url, { headers, timeout: 20000, agent:
keepAliveAgent }, (upstreamRes) => {
// تتبّع أي redirect إضافي بنفسنا (مش بنسيبه للمتصفح)
if ([301, 302, 303, 307,
308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
upstreamRes.resume(); return streamFromUpstream(req, res,
upstreamRes.headers.location, redirectCount + 1); }

    if (upstreamRes.statusCode >= 400) {
      log.error(`Upstream video error: ${upstreamRes.statusCode}`);
      if (!res.headersSent) res.status(502).json({ error: 'تعذّر تحميل الفيديو من المصدر' });
      upstreamRes.resume();
      return;
    }

    res.status(upstreamRes.statusCode);
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']
      .forEach(h => { if (upstreamRes.headers[h]) res.setHeader(h, upstreamRes.headers[h]); });

    upstreamRes.pipe(res);

});

upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('Upstream timeout'))); upstreamReq.on('error', (err) => {
log.error(`Stream proxy error: ${err.message}`); if (!res.headersSent)
res.status(502).json({ error: 'تعذّر الاتصال بمصدر الفيديو' }); });

req.on('close', () => upstreamReq.destroy()); }

/*
==========================================================================
نظام الجودات v6:
- نرجع الارتفاعات الموجودة فعليًا فقط.
- progressive بنفس الارتفاع = تشغيل مباشر وأسرع.
- video-only + audio = ffmpeg فقط عند الحاجة.
==========================================================================
*/
const QUALITY_ALIASES = { '2160': 2160, '4k': 2160, '1440': 1440, '2k':
1440, '1080': 1080, '720': 720, '480': 480, '360': 360, '240': 240,
'144': 144 };

function resolveQuality(quality) { if (!quality) return null; const q =
String(quality).toLowerCase().replace(/p$/, ''); if (q === 'audio')
return { type: 'audio' }; const height = QUALITY_ALIASES[q] ||
parseInt(q, 10); if (!height || Number.isNaN(height)) return null;
return { type: 'video', height }; }

function getVideoFormats(info) { return (info.formats || []).filter(f =>
f && f.height && f.vcodec && f.vcodec !== 'none' ); }

function chooseQualityFormats(info, requestedHeight) { const formats =
getVideoFormats(info); if (!formats.length) throw new Error('No video formats available');

const exact = formats.filter(f => Number(f.height) === requestedHeight);
const below = formats.filter(f => Number(f.height) < requestedHeight)
.sort((a, b) => Number(b.height) - Number(a.height)); const above =
formats.filter(f => Number(f.height) > requestedHeight) .sort((a, b) =>
Number(a.height) - Number(b.height));

const same = exact.length ? exact : (below[0] ? formats.filter(f =>
f.height === below[0].height) : formats.filter(f => f.height ===
above[0].height)); const actualHeight = Number(same[0].height);

const progressive = same .filter(f => f.acodec && f.acodec !== 'none')
.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];

if (progressive) { return { mode: 'direct', actualHeight, videoFormatId:
String(progressive.format_id), audioFormatId: null }; }

const video = same.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0]; const
audio = (info.formats || []) .filter(f => f.acodec && f.acodec !==
'none' && (!f.vcodec || f.vcodec === 'none')) .sort((a, b) => (b.abr ||
b.tbr || 0) - (a.abr || a.tbr || 0))[0];

if (!video || !audio) throw new Error('Video/audio format unavailable');

return { mode: 'merge', actualHeight, videoFormatId:
String(video.format_id), audioFormatId: String(audio.format_id) }; }

function getAvailableQualities(info) { return [...new Set(
getVideoFormats(info).map(f => Number(f.height)).filter(Number.isFinite)
)].sort((a, b) => b - a); }

/* بيصلّح الـ duration داخل الـ initial moov atom قبل ما نبعته للمتصفح.
FFmpeg لما يطلع fragmented MP4 على pipe بيحط duration = 0 في الـ moov،
وChrome/Android ساعات يعتبر مدة أول fragment هي مدة الفيديو.
هنا بنستخدم مدة YouTube الحقيقية ونكتبها في mvhd/tkhd/mdhd بدون إعادة ترميز. */
function patchMp4MoovDuration(buffer, durationSeconds) { if
(!Number.isFinite(durationSeconds) || durationSeconds <= 0) return
buffer;

const b = Buffer.from(buffer); const readU32 = (off) =>
b.readUInt32BE(off); const writeDuration = (boxStart, boxEnd) => { if
(boxStart + 12 > boxEnd) return; const type = b.toString('ascii',
boxStart + 4, boxStart + 8); const version = b[boxStart + 8]; let
timescaleOff, durationOff, durationBytes;

    if (type === 'mvhd') {
      if (version === 1) { timescaleOff = boxStart + 28; durationOff = boxStart + 32; durationBytes = 8; }
      else { timescaleOff = boxStart + 20; durationOff = boxStart + 24; durationBytes = 4; }
    } else if (type === 'tkhd') {
      if (version === 1) { timescaleOff = null; durationOff = boxStart + 36; durationBytes = 8; }
      else { timescaleOff = null; durationOff = boxStart + 28; durationBytes = 4; }
    } else if (type === 'mdhd') {
      if (version === 1) { timescaleOff = boxStart + 28; durationOff = boxStart + 32; durationBytes = 8; }
      else { timescaleOff = boxStart + 20; durationOff = boxStart + 24; durationBytes = 4; }
    } else {
      return;
    }

    if (durationOff + durationBytes > boxEnd) return;

    let timescale = 1000;
    if (timescaleOff !== null && timescaleOff + 4 <= boxEnd) {
      timescale = readU32(timescaleOff) || 1000;
    }

    const value = Math.max(0, Math.round(durationSeconds * timescale));
    if (durationBytes === 8) b.writeBigUInt64BE(BigInt(value), durationOff);
    else b.writeUInt32BE(Math.min(0xffffffff, value), durationOff);

};

const walk = (start, end) => { let off = start; while (off + 8 <= end) {
let size = readU32(off); const type = b.toString('ascii', off + 4, off +
8); let header = 8; if (size === 1) { if (off + 16 > end) return; const
big = b.readBigUInt64BE(off + 8); if (big >
BigInt(Number.MAX_SAFE_INTEGER)) return; size = Number(big); header =
16; } else if (size === 0) { size = end - off; } if (size < header ||
off + size > end) return;

      if (type === 'mvhd' || type === 'tkhd' || type === 'mdhd') {
        writeDuration(off, off + size);
      }

      if (['moov','trak','mdia','minf','mvex','edts'].includes(type)) {
        walk(off + header, off + size);
      }
      off += size;
    }

};

// أول box في output هو ftyp وبعده moov.
let off = 0; while (off + 8 <=
b.length) { let size = readU32(off); const type = b.toString('ascii',
off + 4, off + 8); let header = 8; if (size === 1) { if (off + 16 >
b.length) break; size = Number(b.readBigUInt64BE(off + 8)); header = 16;
} else if (size === 0) { size = b.length - off; } if (size < header ||
off + size > b.length) break; if (type === 'moov') { walk(off + header,
off + size); break; } off += size; } return b; }

function streamMergedViaFfmpeg(req, res, videoUrl, audioUrl,
durationSeconds = 0) { const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'; const inputArgs = [
'-user_agent', UA, '-reconnect', '1', '-reconnect_streamed', '1',
'-reconnect_delay_max', '2', '-i', videoUrl ];

if (audioUrl) inputArgs.push( '-user_agent', UA, '-reconnect', '1',
'-reconnect_streamed', '1', '-reconnect_delay_max', '2', '-i', audioUrl
);

const args = [ '-loglevel', 'error', '-hide_banner', ...inputArgs, '-map',
'0:v:0', ...(audioUrl ? ['-map', '1:a:0'] : ['-map', '0:a:0?']), '-c',
'copy',
// dash يضيف sidx للـ fragmented MP4، والـ moov بيتصلّح تحت قبل الإرسال.
'-movflags', 'frag_keyframe+empty_moov+default_base_moof+dash',
'-f', 'mp4', 'pipe:1' ];

res.status(200); res.setHeader('Content-Type', 'video/mp4');
res.setHeader('Cache-Control', 'no-store');
res.setHeader('Accept-Ranges', 'none'); if
(Number.isFinite(durationSeconds) && durationSeconds > 0) {
res.setHeader('X-Video-Duration', String(durationSeconds)); }

const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
let stderrBuf = ''; let headerBuffer = Buffer.alloc(0); let headerReady
= false; const MAX_HEADER_BUFFER = 2 * 1024 * 1024;

const flushPatchedHeader = () => { if (headerReady) return true;
// الـ moov عادة أول atom كبير؛ نستنى لحد ما يبقى كامل.
let off = 0; while
(off + 8 <= headerBuffer.length) { let size =
headerBuffer.readUInt32BE(off); let header = 8; if (size === 1) { if
(off + 16 > headerBuffer.length) return false; const big =
headerBuffer.readBigUInt64BE(off + 8); if (big >
BigInt(Number.MAX_SAFE_INTEGER)) return false; size = Number(big);
header = 16; } else if (size === 0) { return false; } if (size < header)
return false; if (off + size > headerBuffer.length) return false; const
type = headerBuffer.toString('ascii', off + 4, off + 8); if (type ===
'moov') { const patched = patchMp4MoovDuration(headerBuffer,
durationSeconds); res.write(patched); headerReady = true; headerBuffer =
Buffer.alloc(0); return true; } off += size; } return false; };

ff.stderr.on('data', d => { stderrBuf += d.toString(); if
(stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000); });
ff.stdout.on('data', chunk => { if (headerReady) { if
(!res.writableEnded) res.write(chunk); return; } headerBuffer =
Buffer.concat([headerBuffer, chunk]); if (flushPatchedHeader()) return;
if (headerBuffer.length > MAX_HEADER_BUFFER) {
// حماية من تعليق الطلب لو FFmpeg غير شكل الـ MP4.
headerReady = true; res.write(headerBuffer);
headerBuffer = Buffer.alloc(0); } });

ff.stdout.on('end', () => { if (!headerReady && headerBuffer.length) {
res.write(headerBuffer); headerBuffer = Buffer.alloc(0); } if
(!res.writableEnded) res.end(); });

const cleanup = () => { if (!ff.killed) { try { ff.kill('SIGKILL'); }
catch {} } };

ff.on('error', e => { log.error(`ffmpeg spawn error: ${e.message}`);
cleanup(); if (!res.headersSent) res.status(500).json({ error: 'ffmpeg غير متاح على السيرفر' }); }); ff.on('close', code => { if (code !== 0 &&
code !== null && !res.writableEnded) {
log.warn(`ffmpeg exited ${code}: ${stderrBuf.slice(-500)}`); } });
req.on('close', cleanup); }

app.get('/video', async (req, res) => { const { v: videoId, format =
'best', quality } = req.query;

if (!videoId || !isValidVideoId(videoId)) { return
res.status(400).json({ error: 'Video ID مطلوب وصحيح (11 حرف)', example:
'/video?v=dQw4w9WgXcQ&quality=1080' }); }

try { const resolved = resolveQuality(quality);

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
        return streamFromUpstream(req, res, urls[0]);
      }

      const urls = await getFormatUrls(
        videoId,
        `${selected.videoFormatId}+${selected.audioFormatId}`
      );
      if (urls.length < 2) throw new Error('Could not resolve video/audio URLs');

      res.setHeader('X-Video-Quality', `${selected.actualHeight}p`);
      res.setHeader('X-Stream-Mode', 'ffmpeg');
      return streamMergedViaFfmpeg(req, res, urls[0], urls[1], Number(info.duration || 0));
    }

    const cacheKey = `default_stream_${videoId}_${format}`;
    const streamUrl = await dedupe(cacheKey, async () => {
      const cached = streamCache.get(cacheKey);
      if (cached) return cached;

      const url = await getVideoStreamUrl(videoId, format);
      if (!url) throw new Error('Failed to get stream URL');
      streamCache.set(cacheKey, url, 300);
      return url;
    });

    return streamFromUpstream(req, res, streamUrl);

} catch (error) {
log.error(`Error streaming ${videoId}: ${error.message}`); if
(res.headersSent) return;

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

} });

/** * GET /info?v=VIDEO_ID */ app.get('/info', async (req, res) => {
const videoId = req.query.v;

if (!videoId || !isValidVideoId(videoId)) { return
res.status(400).json({ error: 'Video ID غير صحيح' }); }

const cached = infoCache.get(`info_${videoId}`); if (cached) {
log.info(`📋 Info from cache: ${videoId}`); return res.json(cached); }

try { log.info(`📥 Fetching info: ${videoId}`); const info = await
getVideoInfo(videoId);

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

} catch (error) { log.error(`Error fetching info: ${error.message}`);
res.status(500).json({ error: 'تعذّر جلب معلومات الفيديو', details:
NODE_ENV === 'development' ? error.message : undefined }); } });

/** * GET /formats?v=VIDEO_ID */ app.get('/formats', async (req, res) =>
{ const videoId = req.query.v; if (!videoId || !isValidVideoId(videoId))
{ return res.status(400).json({ error: 'Video ID غير صحيح' }); }

try { const info = await getVideoInfo(videoId); const formats =
(info.formats || []) .filter(f => f.vcodec !== 'none' || f.acodec !==
'none') .map(f => ({ formatId: String(f.format_id), format: f.format,
videoCodec: f.vcodec, audioCodec: f.acodec, height: f.height || null,
width: f.width || null, fps: f.fps || null, bitrate: f.tbr || f.vbr ||
f.abr || null, fileSize: f.filesize || f.filesize_approx || null,
hasVideo: f.vcodec && f.vcodec !== 'none', hasAudio: f.acodec &&
f.acodec !== 'none' })) .sort((a, b) => (b.height || 0) - (a.height ||
0) || (b.bitrate || 0) - (a.bitrate || 0));

    res.json({ id: videoId, title: info.title, count: formats.length, formats });

} catch (error) { log.error(`Error fetching formats: ${error.message}`);
res.status(500).json({ error: 'تعذّر جلب الـ formats' }); } });

/** * GET /video/qualities?v=VIDEO_ID * بيرجّع كل الجودات المتاحة فعليًا
لهذا الفيديو بالتحديد (مش قايمة ثابتة) * كل جودة معاها رابط تشغيل جاهز
من نفس السيرفر (/video?v=..&quality=..) */ app.get('/video/qualities',
async (req, res) => { const videoId = req.query.v; if (!videoId ||
!isValidVideoId(videoId)) { return res.status(400).json({ error: 'Video ID غير صحيح' }); }

const cacheKey = `qualities_v6_${videoId}`; const cached =
infoCache.get(cacheKey); if (cached) return res.json(cached);

try { const info = await getVideoInfo(videoId); const heights =
getAvailableQualities(info);

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

    infoCache.set(cacheKey, result, 10800);
    res.json(result);

} catch (error) { log.error(`Error fetching qualities: ${error.message}`);
res.status(500).json({ error: 'تعذّر جلب الجودات المتاحة', details:
NODE_ENV === 'development' ? error.message : undefined }); } });

/** * GET /health */ app.get('/health', (req, res) => { res.json({
status: 'operational', version: SERVER_VERSION, timestamp: new
Date().toISOString(), uptime: process.uptime(), ytdlpReady:
checkYtDlp(), ytdlpVersion: (() => { try { return
require('child_process').execFileSync('yt-dlp', ['--version'], {
encoding: 'utf8' }).trim(); } catch { return null; } })(), nodeVersion:
process.version, jsRuntime: commandExists('node') ? 'node' :
(commandExists('deno') ? 'deno' : (commandExists('bun') ? 'bun' :
null)), ffmpegReady: (() => { try {
require('child_process').execSync('ffmpeg -version', { stdio: 'ignore'
}); return true; } catch { return false; } })(), cookiesReady,
cookieUpdateProtected: Boolean(process.env.COOKIE_UPDATE_SECRET),
concurrency: { max: YTDLP_CONCURRENCY, current: ytdlpLimiter.current,
queued: ytdlpLimiter.queue.length } }); });

/** * POST /api/update-cookies */ app.post('/api/update-cookies', async (req, res) => { try { const secret = process.env.COOKIE_UPDATE_SECRET ||
''; const provided = req.get('x-cookie-update-key') ||
String(req.get('authorization') || '').replace(/^Bearer\s+/i,''); if
(!secret) return res.status(503).json({ error: 'COOKIE_UPDATE_SECRET غير مضبوط على السيرفر' }); if (!provided || provided !== secret) return
res.status(401).json({ error: 'غير مصرح' });

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

} catch (error) { log.error(`Post error: ${error.message}`);
res.status(500).json({ error: 'خطأ في السيرفر', details: error.message
}); } });

/** * GET /api/cookies-status */ app.get('/api/cookies-status', async (req, res) => { res.json({ hasCookies: cookiesReady, length:
lastCookiesContent.length, status: cookiesReady ? '✅ موجودة' : '❌ فارغة أو غير موجودة' }); });

/** * GET / */ app.get('/', (req, res) => { res.json({ name: '🎬 srver v7.0.0 "Turbo" - YouTube media server', version: SERVER_VERSION,
environment: NODE_ENV, recommended: '/trending?region=EG&seed=dQw4w9WgXcQ', cookies: { source: '🔥 Firebase Realtime Database', url: FIREBASE_URL, refresh: 'كل 5 دقايق في الخلفية',
ready: cookiesReady }, concurrency: { max: YTDLP_CONCURRENCY },
endpoints: { home: '/home?region=EG&perSection=12', trending: '/trending?region=EG&limit=20&page=1', video: '/video?v=VIDEO_ID&quality=1080 (أو &format=best للوضع السريع)',
videoQualities: '/video/qualities?v=VIDEO_ID', info: '/info?v=VIDEO_ID',
formats: '/formats?v=VIDEO_ID', search: '/search?q=QUERY&limit=20&page=1', related: '/related?v=VIDEO_ID&limit=10&page=1', channel: '/channel?id=CHANNEL_ID&limit=20&page=1', comments: '/comments?v=VIDEO_ID&limit=50', health: '/health', cookiesStatus: '/api/cookies-status' }, videoQualityValues: 'يتم اكتشاف كل الارتفاعات الحقيقية تلقائيًا عبر /video/qualities', pagination: 'كل endpoints البحث/الترند/related/channel بترجع page و limit و hasMore — استخدمهم لعمل infinite scroll', examples: { 'Home feed (أقسام زي يوتيوب)': '/home?region=EG', 'Trending page 1': '/trending?region=EG&page=1',
'Trending page 2 (سكرول لاحق)': '/trending?region=EG&page=2', 'Play video (جودة تلقائية)': '/video?v=dQw4w9WgXcQ', 'Play video 1080p (دمج ffmpeg)': '/video?v=dQw4w9WgXcQ&quality=1080', 'Play video 4K': '/video?v=dQw4w9WgXcQ&quality=2160', 'Audio only': '/video?v=dQw4w9WgXcQ&quality=audio', 'كل الجودات المتاحة للفيديو ده': '/video/qualities?v=dQw4w9WgXcQ', 'Search videos': '/search?q=funny+cats&page=1', 'Related videos': '/related?v=dQw4w9WgXcQ', 'Channel videos': '/channel?id=UCuAXFkgsw1L7xaCfnd5JJOw', 'Video comments': '/comments?v=dQw4w9WgXcQ', 'Check cookies': '/api/cookies-status' } });
});

// 404
app.use((req, res) => { res.status(404).json({ error: 'Endpoint غير موجود', path: req.path }); });

// Error handler
app.use((err, req, res, next) => {
log.error(`Unhandled error: ${err.message}`); res.status(500).json({
error: 'خطأ في السيرفر', details: NODE_ENV === 'development' ?
err.message : undefined }); });

// Start server
const server = app.listen(PORT, '0.0.0.0', () => { const
ytdlpStatus = checkYtDlp() ? '✅' : '❌';
console.log(`╔═══════════════════════════════════════════╗ ║  🎬 srver v${SERVER_VERSION} "جبارة" شغّال 🔥        ║ ║  ═════════════════════════════════════     ║ ║  Environment: ${NODE_ENV.padEnd(26, ' ')}║ ║  yt-dlp: ${ytdlpStatus}  Firebase Cookies (bg refresh)  ║ ║  Concurrency: ${String(YTDLP_CONCURRENCY).padEnd(24, ' ')}║ ║  http://0.0.0.0:${PORT}                        ║ ╚═══════════════════════════════════════════╝`);
log.success(`✅ Server ready - no YouTube Data API dependency`);
log.info(`🆕 جديد: /home (فيد بأقسام) + /video?quality=1080/1440/2160/audio + /video/qualities`);
log.info(`📍 Firebase: ${FIREBASE_URL}`); });

// Graceful shutdown
process.on('SIGINT', () => { log.warn('Shutting down...'); server.close(() => { log.success('Server stopped');
process.exit(0); }); });

process.on('SIGTERM', () => { log.warn('Terminating...'); server.close(() => { process.exit(0); }); });

process.on('unhandledRejection', (reason) => {
log.error(`Unhandled Rejection: ${reason}`); });

