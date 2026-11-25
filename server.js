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
// v13.4.0 — AUTO PO TOKEN: السيرفر بيولّد PO Token + Visitor Data لوحده
// (bgutils-js + jsdom) ويجدده كل 4 ساعات، من غير أي توكن يدوي.
// v13.7.0 — DIAG-FIX: لوحة مشاكل + سجل عمليات + تقرير للنسخ، إصلاح تنزيل ffmpeg (كان بيتكرر بالتوازي),
// كاش الجودات/المعلومات المتدهورة، الترجمة/الصوت بدون انتظار طويل، سقف عمليات yt-dlp حسب الرام/المعالج.
const SERVER_VERSION = '13.8.0-SEEKABLE-MUX';

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
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, Cache-Control, ETag, Last-Modified, X-Video-Quality, X-Stream-Mode, X-Seekable, X-Merge-Mode, X-Video-Duration'
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
  if (bucket.count > REQUEST_LIMIT && !req.path.startsWith('/video') && !req.path.startsWith('/hls')) {
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

// Accept both the JSON API payloads and raw Netscape cookies.txt uploads.
// The cookies panel sends text/plain, so express.json() alone would leave
// req.body undefined and the server would incorrectly report "الكوكيز فارغة".
app.use(express.text({ type: ['text/plain', 'text/*'], limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// ضغط ردود JSON فقط (مش الفيديو) — يقلل وقت التحميل على الموبايل بوضوح
app.use((req, res, next) => {
  if (req.path.startsWith('/video') || req.path.startsWith('/download')) return next();
  const accept = String(req.headers['accept-encoding'] || '');
  if (!accept.includes('gzip')) return next();
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      const raw = Buffer.from(JSON.stringify(body));
      if (raw.length < 800) return originalJson(body);
      const gz = zlib.gzipSync(raw, { level: 5 });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', gz.length);
      return res.end(gz);
    } catch {
      return originalJson(body);
    }
  };
  next();
});


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

const infoCache = new MemoryTTLCache(500);
const searchCache = new MemoryTTLCache(500);
const feedCache = new MemoryTTLCache(300);
const streamCache = new MemoryTTLCache(1000);
const fastStreamCache = new MemoryTTLCache(600);
const channelCache = new MemoryTTLCache(250);
const channelMetaCache = new MemoryTTLCache(300);
// URL → { fmt: http_headers من yt-dlp, ok/cookies: نتيجة التحقق } (v13.6)
const urlMeta = new MemoryTTLCache(3000);
// فيديوهات القناة (flat) مبتجيبش اسم القناة → كان بيظهر Unknown. نملاها من بيانات القناة نفسها.
function fillChannelOwner(list, channel) {
  const title = channel && channel.title && channel.title !== 'قناة' ? channel.title : '';
  return (list || []).map(v => ({
    ...v,
    author: (!v.author || v.author === 'Unknown') ? (title || v.author) : v.author,
    channelId: v.channelId || (channel && channel.id) || ''
  }));
}
const suggestionCache = new MemoryTTLCache(150);
// كاش لنصوص الترجمة الجاهزة (ملفات صغيرة) + أي فيديو شفناه بث مباشر
const subtitleCache = new MemoryTTLCache(300);
const liveIdHints = new Set();
function noteLiveHint(id, isLive) {
  if (!id) return;
  if (isLive) { if (liveIdHints.size > 5000) liveIdHints.clear(); liveIdHints.add(id); }
  else liveIdHints.delete(id);
}

const CACHE_TTL = {
  info: 2 * 60 * 60 * 1000,
  search: 45 * 60 * 1000,
  feed: 20 * 60 * 1000,
  related: 45 * 60 * 1000,
  channel: 45 * 60 * 1000,
  stream: 45 * 60 * 1000,
  fastStream: 40 * 60 * 1000,
  suggestions: 30 * 60 * 1000
};

// Never make the browser/CDN serve an old API response; only our RAM cache is used.
app.use((req, res, next) => {
  if (req.path.startsWith('/video') || req.path.startsWith('/download') || req.path.startsWith('/hls') || req.path.startsWith('/api/me') || req.path === '/api/account-feed') {
    res.setHeader('Cache-Control', 'no-store');
  } else if (req.method === 'GET') {
    // كاش متصفح أطول للبحث/الاقتراحات/الهوم — الإحساس يبقى أسرع جدًا
    if (req.path.startsWith('/search') || req.path.startsWith('/related') || req.path === '/home' || req.path === '/trending') {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=120');
    }
  }
  next();
});

const TIMEOUT = 45000;
const MAX_RETRIES = 2;

// ==========================================================================
// 🚨 INCIDENTS + OPS LOG (v13.7)
// كل مشكلة بتحصل في السيرفر (أخطاء / تحذيرات / بطء) بتتسجّل هنا وتظهر في لوحة /admin،
// ومعاها زرار "نسخ كل المشاكل" عشان تبعت التقرير كامل. بتتنضّف من التوكنات/الكوكيز قبل التخزين.
// ==========================================================================
const os = require('os');
const INC_FILE = process.env.INCIDENTS_FILE || '/tmp/titan-incidents.json';
const INC_MAX_EVENTS = 500;
const OPS_MAX = 400;
const incStore = { events: [], groups: new Map(), ops: [], seq: 0, startedAt: Date.now(), dirty: false, lastSelfTest: null };

function redactSecrets(s) {
  return String(s == null ? '' : s)
    .replace(/https?:\/\/[^\s"'<>]*googlevideo\.com[^\s"'<>]*/gi, 'https://<googlevideo-url>')
    .replace(/https?:\/\/[^\s"'<>]*timedtext[^\s"'<>]*/gi, 'https://<timedtext-url>')
    .replace(/(po_token=)[^\s'"]+/gi, '$1<redacted>')
    .replace(/(visitor_data=)[^\s'"]+/gi, '$1<redacted>')
    .replace(/([?&](?:auth|key|token|pot|secret)=)[^&\s'"]+/gi, '$1<redacted>')
    .replace(/(cookie:\s*)[^\r\n]+/gi, '$1<redacted>')
    .replace(/(authorization:\s*)[^\r\n]+/gi, '$1<redacted>')
    .replace(/(x-admin-key:\s*)[^\r\n]+/gi, '$1<redacted>');
}

// بيطلّع نص الخطأ المفيد (stderr بتاع yt-dlp) من غير سطر الأمر (اللي فيه PO Token وبيزحم الرسالة)
function cleanErr(e, max = 700) {
  if (e == null) return '';
  let txt = '';
  if (typeof e === 'string') txt = e;
  else {
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    let msg = String(e.message || e).replace(/^Command failed:[^\n]*\n?/, '').trim();
    const killed = e.killed || e.signal === 'SIGTERM' ? '[TIMEOUT/killed] ' : '';
    txt = killed + [msg, stderr].filter(Boolean).join('\n');
    if (!txt.trim() && e.code != null) txt = `exit code ${e.code}`;
  }
  const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
  const important = lines.filter(l => /error|sign in|403|429|po.?token|not available|unavailable|private|timeout|timed out|killed/i.test(l));
  const picked = (important.length ? important.slice(-4) : lines.slice(-6)).join('\n');
  return redactSecrets(picked).slice(0, max);
}

function inferCat(msg) {
  const m = String(msg).toLowerCase();
  if (/ffmpeg|دمج/.test(m)) return 'ffmpeg';
  if (/po token|🔑/.test(m)) return 'potoken';
  if (/cookie|كوكيز|firebase/.test(m)) return 'cookies';
  if (/subs|caption|ترجمة|subtitle|transcript/.test(m)) return 'captions';
  if (/audio|صوت|dub/.test(m)) return 'audio';
  if (/quality|جودة|merge|progressive|\b\d{3,4}p\b/.test(m)) return 'quality';
  if (/yt-dlp|info client|extract/.test(m)) return 'ytdlp';
  if (/innertube/.test(m)) return 'innertube';
  if (/hls|live|بث/.test(m)) return 'live';
  if (/memory|rss|🧠/.test(m)) return 'memory';
  if (/upstream|stream|proxy|googlevideo/.test(m)) return 'stream';
  return 'system';
}

function normalizeFp(s) {
  return String(s).toLowerCase()
    .replace(/\b(?=[\w-]*\d)[\w-]{11}\b/g, '<id>')
    .replace(/\/tmp\/[^\s]+/g, '<tmp>')
    .replace(/\d+(\.\d+)?/g, '#')
    .slice(0, 160);
}

function addOp(level, msg) {
  try {
    incStore.ops.push({ t: Date.now(), level, msg: redactSecrets(msg).slice(0, 300) });
    if (incStore.ops.length > OPS_MAX) incStore.ops.splice(0, incStore.ops.length - OPS_MAX);
    incStore.dirty = true;
  } catch {}
}

function addIncident(level, msg, ctx = {}) {
  try {
    const now = Date.now();
    const cat = ctx.cat || inferCat(msg);
    const text = redactSecrets(msg).slice(0, 500);
    const detail = ctx.detail ? redactSecrets(ctx.detail).slice(0, 1400) : '';
    const ev = {
      id: ++incStore.seq, t: now, level, cat, msg: text, detail,
      videoId: ctx.videoId || null, route: ctx.route ? redactSecrets(ctx.route).slice(0, 200) : null,
      status: ctx.status || null, ms: ctx.ms != null ? Math.round(ctx.ms) : null, reqId: ctx.reqId || null
    };
    incStore.events.push(ev);
    if (incStore.events.length > INC_MAX_EVENTS) incStore.events.splice(0, incStore.events.length - INC_MAX_EVENTS);
    const fp = `${level}|${cat}|${normalizeFp(text)}`;
    let g = incStore.groups.get(fp);
    if (!g) {
      g = { fp, level, cat, msg: text, detail: '', count: 0, first: now, last: now, videos: [], maxMs: 0 };
      incStore.groups.set(fp, g);
      if (incStore.groups.size > 300) {
        const oldest = [...incStore.groups.values()].sort((a, b) => a.last - b.last)[0];
        if (oldest) incStore.groups.delete(oldest.fp);
      }
    }
    g.count++; g.last = now;
    if (detail) g.detail = detail;
    if (ev.videoId && !g.videos.includes(ev.videoId) && g.videos.length < 5) g.videos.push(ev.videoId);
    if (ev.ms != null) g.maxMs = Math.max(g.maxMs || 0, ev.ms);
    incStore.dirty = true;
    return ev;
  } catch { return null; }
}

function loadIncidents() {
  try {
    if (!fs.existsSync(INC_FILE)) return;
    const j = JSON.parse(fs.readFileSync(INC_FILE, 'utf8'));
    if (Array.isArray(j.events)) incStore.events = j.events.slice(-INC_MAX_EVENTS);
    if (Array.isArray(j.groups)) for (const g of j.groups) if (g && g.fp) incStore.groups.set(g.fp, g);
    if (Array.isArray(j.ops)) incStore.ops = j.ops.slice(-OPS_MAX);
    incStore.seq = incStore.events.reduce((m, e) => Math.max(m, e.id || 0), 0);
  } catch {}
}
function saveIncidents() {
  if (!incStore.dirty) return;
  incStore.dirty = false;
  try {
    const tmp = `${INC_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), events: incStore.events, groups: [...incStore.groups.values()], ops: incStore.ops }));
    fs.renameSync(tmp, INC_FILE);
  } catch {}
}
loadIncidents();
setInterval(saveIncidents, 15000).unref();
process.on('exit', saveIncidents);

// Logger — كل سطر بيتسجّل في "سجل العمليات"، والـ warn/error بيتسجّلوا كمان كـ "مشاكل" (مجمّعة ومعدودة)
const log = {
  info: (msg) => { console.log(`[${new Date().toISOString()}] ℹ️  ${msg}`); addOp('info', msg); },
  success: (msg) => { console.log(`[${new Date().toISOString()}] ✅ ${msg}`); addOp('ok', msg); },
  error: (msg, ctx) => { console.error(`[${new Date().toISOString()}] ❌ ${msg}`); addOp('error', msg); addIncident('error', msg, ctx); },
  warn: (msg, ctx) => { console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`); addOp('warn', msg); addIncident('warn', msg, ctx); }
};

// ---- حدود العمليات المتزامنة (yt-dlp + node) حسب رام/معالج الحاوية ----
class PrioritySemaphore {
  constructor(max, reserveForHigh = 0) { this.max = max; this.current = 0; this.q = [[], []]; this.reserve = reserveForHigh; }
  _can(p) { return this.current < (p === 0 ? this.max : this.max - this.reserve); }
  acquire(p = 1) {
    if (this.q[0].length === 0 && (p === 0 || this.q[1].length === 0) && this._can(p)) { this.current++; return Promise.resolve(); }
    return new Promise(resolve => this.q[p].push(resolve));
  }
  release() { this.current = Math.max(0, this.current - 1); this._drain(); }
  _drain() {
    for (const p of [0, 1]) {
      while (this.q[p].length && this._can(p)) { this.current++; this.q[p].shift()(); }
    }
  }
  get queued() { return this.q[0].length + this.q[1].length; }
}
function readCgroupNum(f) {
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t === 'max') return null; const n = Number(t); return Number.isFinite(n) ? n : null; } catch { return null; }
}
function containerMemMb() {
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    const n = readCgroupNum(f);
    if (n && n > 0 && n < 64 * 1024 ** 3) return Math.round(n / 1048576);
  }
  return Math.round(os.totalmem() / 1048576);
}
function containerCpus() {
  try {
    const t = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (t[0] !== 'max') { const q = Number(t[0]), p = Number(t[1]) || 100000; if (q > 0) return q / p; }
  } catch {}
  try {
    const q = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8')), p = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8'));
    if (q > 0 && p > 0) return q / p;
  } catch {}
  return os.cpus().length || 1;
}
// كل عملية yt-dlp (+ node للـ n/sig) بتاخد ~150-300MB ومعالج. قبل كده كان ممكن 14 عملية مع بعض → السيرفر يتخنق.
const PROC_MAX = (() => {
  const env = parseInt(process.env.YTDLP_MAX_PROCS, 10);
  if (env > 0) return env;
  const byMem = Math.floor(containerMemMb() / 220);
  const byCpu = Math.ceil(containerCpus() * 4);
  return Math.max(2, Math.min(10, byMem, byCpu));
})();
const procLimiter = new PrioritySemaphore(PROC_MAX, PROC_MAX >= 3 ? 1 : 0);   // "stream" بياخد أولوية، و"meta" مبياخدش آخر خانة
const spawnStats = { stream: { d: [], fails: 0, n: 0 }, meta: { d: [], fails: 0, n: 0 } };
function noteSpawn(lane, ms, ok) {
  const s = spawnStats[lane] || spawnStats.meta;
  s.n++; if (!ok) s.fails++;
  s.d.push(Math.round(ms)); if (s.d.length > 60) s.d.shift();
}
function spawnSummary(lane) {
  const s = spawnStats[lane]; const d = [...s.d].sort((a, b) => a - b);
  return { runs: s.n, fails: s.fails, avgMs: d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : 0, p95Ms: d.length ? d[Math.min(d.length - 1, Math.floor(d.length * 0.95))] : 0 };
}
function attemptLabel(cmd) {
  const i = cmd.indexOf('--extractor-args');
  const m = i >= 0 ? String(cmd[i + 1] || '').match(/player_client=([\w,]+)/) : null;
  const ck = cmd.includes('--cookies') ? '+cookies' : '';
  return `${m ? m[1] : 'default'}${ck}`;
}
const sleepMs = (ms) => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });


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
const META_CONCURRENCY = Math.max(1, parseInt(process.env.YTDLP_META_CONCURRENCY, 10) || 8);
// طابور التشغيل (getVideoInfo + روابط الفيديو) منفصل عن طابور الهوم/البحث عشان الخلفية متخنقش التشغيل
const STREAM_CONCURRENCY = Math.max(1, parseInt(process.env.YTDLP_STREAM_CONCURRENCY, 10) || 6);
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


// ==========================================================================
// 🧰 yt-dlp binary management (v13.6)
// أكتر سبب بيخلّي "كل الفيديوهات تقف مرة واحدة" هو إن يوتيوب غيّر حاجة ونسخة yt-dlp قديمة.
// السيرفر دلوقتي بيحدّث yt-dlp لوحده (نسخة standalone من GitHub في /tmp/.bin) عند التشغيل وكل 6 ساعات.
// تعطيل: YTDLP_AUTO_UPDATE=0  |  نسخة nightly: YTDLP_CHANNEL=nightly  |  مسار ثابت: YTDLP_PATH=/path/yt-dlp
// ==========================================================================
const YTDLP_DIR = '/tmp/.bin';
const YTDLP_LOCAL = `${YTDLP_DIR}/yt-dlp`;
let ytdlpBin = process.env.YTDLP_PATH || (fs.existsSync(YTDLP_LOCAL) ? YTDLP_LOCAL : 'yt-dlp');
const ytdlpState = { version: null, remoteComponents: false, lastCheck: 0, lastError: null, updatedAt: 0, bin: ytdlpBin };
async function refreshYtdlpInfo() {
  const tryVersion = async (bin) => (await execFileAsync(bin, ['--version'], { timeout: 20000 })).stdout.trim();
  try { ytdlpState.version = await tryVersion(ytdlpBin); }
  catch (e) {
    if (ytdlpBin !== 'yt-dlp' && !process.env.YTDLP_PATH) {
      log.warn(`yt-dlp المحلي مش شغال (${String(e.message || e).split('\n')[0]}) → رجوع للنسخة اللي في النظام`);
      ytdlpBin = 'yt-dlp';
      try { ytdlpState.version = await tryVersion(ytdlpBin); } catch { ytdlpState.version = null; }
    } else ytdlpState.version = null;
  }
  ytdlpState.bin = ytdlpBin;
  try {
    const { stdout } = await execFileAsync(ytdlpBin, ['--help'], { timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
    ytdlpState.remoteComponents = /--remote-components/.test(stdout);
  } catch { ytdlpState.remoteComponents = false; }
  return ytdlpState.version;
}
function ytdlpBaseArgs() {
  const a = ['--no-warnings', '--geo-bypass', '--cache-dir', process.env.YTDLP_CACHE_DIR || '/tmp/yt-dlp-cache',
    // أي فشل بيحصل بسرعة بدل ما ياخد دقايق في إعادة المحاولات → الـ fallback التالي يشتغل فورًا
    '--retries', '2', '--extractor-retries', '1', '--socket-timeout', '20'];
  if (detectNodeRuntime()) a.push('--js-runtimes', 'node');
  // حل تحديات n/sig الجديدة (لو النسخة بتدعمه) — من غيره روابط الـ web client بترجع 403
  if (ytdlpState.remoteComponents && process.env.YTDLP_REMOTE_COMPONENTS !== '0') a.push('--remote-components', 'ejs:github');
  return a;
}
let pythonOkMemo = null;
function pythonOk() {
  if (pythonOkMemo !== null) return pythonOkMemo;
  try { pythonOkMemo = require('child_process').execFileSync('python3', ['-c', 'import sys;print(int(sys.version_info>=(3,10)))'], { timeout: 8000 }).toString().trim() === '1'; }
  catch { pythonOkMemo = false; }
  return pythonOkMemo;
}
async function updateYtDlp(force = false) {
  if (process.env.YTDLP_AUTO_UPDATE === '0' || process.env.YTDLP_PATH) return;
  if (!force && Date.now() - ytdlpState.lastCheck < 5 * 3600 * 1000) return;
  ytdlpState.lastCheck = Date.now();
  const nightly = process.env.YTDLP_CHANNEL === 'nightly';
  const repo = nightly ? 'yt-dlp/yt-dlp-nightly-builds' : 'yt-dlp/yt-dlp';
  const tmp = `${YTDLP_LOCAL}.new`;
  try {
    let tag = null;
    try {
      const r = await httpGetText(`https://api.github.com/repos/${repo}/releases/latest`, { timeout: 15000, headers: { Accept: 'application/vnd.github+json' } });
      if (r.status === 200) tag = String(JSON.parse(r.body).tag_name || '').replace(/^v/, '') || null;
    } catch {}
    if (tag && ytdlpState.version && tag === ytdlpState.version) { ytdlpState.lastError = null; return; }
    if (!fs.existsSync(YTDLP_DIR)) fs.mkdirSync(YTDLP_DIR, { recursive: true });
    log.info(`⬇️  تحديث yt-dlp (${ytdlpState.version || 'غير معروف'} → ${tag || 'latest'})`);
    // zipapp (python) بيبدأ أسرع بكتير من نسخة PyInstaller (اللي بتفك نفسها في /tmp مع كل تشغيل) → نفضّله لو python>=3.10 موجود
    const assets = process.env.YTDLP_ASSET ? [process.env.YTDLP_ASSET] : (pythonOk() ? ['yt-dlp', 'yt-dlp_linux'] : ['yt-dlp_linux', 'yt-dlp']);
    let v = '', lastAssetErr = null;
    for (const asset of assets) {
      try {
        await httpDownloadToFile(`https://github.com/${repo}/releases/latest/download/${asset}`, tmp);
        fs.chmodSync(tmp, 0o755);
        v = (await execFileAsync(tmp, ['--version'], { timeout: 30000 })).stdout.trim();
        if (v) { log.info(`yt-dlp asset المستخدم: ${asset}`); break; }
      } catch (e) { lastAssetErr = e; try { fs.unlinkSync(tmp); } catch {} }
    }
    if (!v) throw lastAssetErr || new Error('النسخة الجديدة مش بترد على --version');
    fs.renameSync(tmp, YTDLP_LOCAL);
    ytdlpBin = YTDLP_LOCAL;
    await refreshYtdlpInfo();
    ytdlpState.updatedAt = Date.now(); ytdlpState.lastError = null;
    infoCache.clear(); streamCache.clear(); fastStreamCache.clear();
    log.success(`✅ yt-dlp اتحدّث لـ ${ytdlpState.version}`);
  } catch (e) {
    ytdlpState.lastError = String(e.message || e).split('\n')[0];
    log.warn(`yt-dlp update failed: ${ytdlpState.lastError}`);
    try { fs.unlinkSync(tmp); } catch {}
  }
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

/** يتحقق إن المحتوى صيغة Netscape حقيقية (مش هيدرز HTTP) */

/** يبني Cookie header من ملف Netscape لتمريره لـ googlevideo (بدونها كتير 403) */
let ckHeaderMemo = { src: null, val: '' };   // كاش: كان بيقرا الملف ويحلله مع كل طلب (حتى كل segment)
function buildYoutubeCookieHeader() {
  try {
    if (!cookiesReady || !fs.existsSync(COOKIES_PATH)) return '';
    if (ckHeaderMemo.src !== null && ckHeaderMemo.src === lastCookiesContent) return ckHeaderMemo.val;
    const text = fs.readFileSync(COOKIES_PATH, 'utf8');
    const pairs = [];
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      const parts = l.split('\t');
      if (parts.length < 7) continue;
      const domain = parts[0].replace(/^\./, '').toLowerCase();
      if (!domain.includes('youtube.com') && !domain.includes('google.com') && !domain.includes('googlevideo.com')) continue;
      const name = parts[5];
      const value = parts[6];
      if (name && value != null) pairs.push(`${name}=${value}`);
    }
    // unique by name (last wins)
    const map = new Map();
    for (const p of pairs) {
      const i = p.indexOf('=');
      map.set(p.slice(0, i), p.slice(i + 1));
    }
    const joined = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    ckHeaderMemo = { src: lastCookiesContent, val: joined };
    return joined;
  } catch {
    return '';
  }
}

function isNetscapeCookies(content) {
  if (!content || typeof content !== 'string') return false;
  const text = content.trim();
  if (text.length < 40) return false;
  // رفض واضح لهيدرز الطلبات
  if (/^GET\s+https?:\/\//im.test(text) || /^cookie:\s+/im.test(text) || /sec-ch-ua:/i.test(text)) {
    return false;
  }
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return false;
  // سطر Netscape: domain \t flag \t path \t secure \t expiry \t name \t value
  const ok = lines.filter(l => {
    const parts = l.split('\t');
    return parts.length >= 7 && parts[0].includes('.');
  }).length;
  return ok >= Math.min(3, lines.length) && ok > 0;
}

// حفظ محلي على السيرفر — احتياطي لو Firebase رفض الكتابة (Permission denied)
function saveCookiesLocally(content) {
  if (!isNetscapeCookies(content)) {
    throw new Error('الكوكيز مش بصيغة Netscape — صدّر cookies.txt من إضافة المتصفح');
  }
  fs.writeFileSync(COOKIES_PATH, content);
  lastCookiesContent = content;
  cookiesReady = true;
  feedCache.clear();
  streamCache.clear();
  fastStreamCache.clear();
}
async function refreshCookies() {
  try {
    const content = await fetchCookiesFromFirebase();
    if (content && content.trim() && content !== lastCookiesContent) {
      if (!isNetscapeCookies(content)) {
        cookiesReady = false;
        log.warn('⚠️  Cookies in Firebase are NOT Netscape format — ignored');
        return;
      }
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
// تحديث الكوكيز من Firebase كل 5 دقايق في الخلفية
setInterval(() => { refreshCookies().catch(() => {}); }, 5 * 60 * 1000);


// Check if yt-dlp is installed
function checkYtDlp() { return commandExists(ytdlpBin); }

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
  // ffmpeg/ffprobe بيفهموا -version بس (--version بيرجّع exit 8 حتى لو متثبّت) → كان بيتعامل
  // معاه كأنه مش موجود ويحاول ينزّل نسخة static من GitHub، ولو فشل التنزيل تختفي كل الجودات غير 360p.
  const probes = /^(ffmpeg|ffprobe|ffplay)$/.test(command) ? [['-version'], ['--version']] : [['--version'], ['-version']];
  for (const a of probes) {
    try { require('child_process').execFileSync(command, a, { stdio: 'ignore', timeout: 8000 }); commandCache.set(command, true); return true; }
    catch {}
  }
  commandCache.set(command, false);
  return false;
}

function isRetryableYoutubeError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return /page needs to be reloaded|sign in to confirm|confirm you’re not a bot|confirm you're not a bot|http error 403|requested format is not available|video unavailable|not available in your country/.test(text);
}

// ==========================================================================
// ⚡ InnerTube fast path — بحث / مقترحات (related) بطلب HTTP مباشر ليوتيوب (≈ 0.2–0.6 ثانية)
// بدل تشغيل عملية yt-dlp كاملة (2–6 ثواني). بيرجّع نفس شكل سطور yt-dlp --flat-playlist
// فكل الكود الموجود (parseFlatItems, الفلاتر، الكاش) بيشتغل زي ما هو.
// أي فشل/نتيجة ناقصة → رجوع تلقائي لـ yt-dlp. تعطيله: INNERTUBE_FAST=0
// ==========================================================================
const IT_ENABLED = process.env.INNERTUBE_FAST !== '0';
const IT_BASE = process.env.INNERTUBE_BASE || 'https://www.youtube.com';
// نسخة ثابتة قديمة ممكن يوتيوب يرفضها → بنستخدم تاريخ حديث تلقائي (تقدر تثبّتها بـ INNERTUBE_CLIENT_VERSION)
const IT_VERSION = process.env.INNERTUBE_CLIENT_VERSION || `2.${new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10).replace(/-/g, '')}.01.00`;
const IT_KEY = process.env.INNERTUBE_API_KEY || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const itBreaker = { fails: 0, until: 0 };

function innertubeCall(endpoint, body, timeout = 4500) {
  return new Promise((resolve, reject) => {
    const base = new URL(IT_BASE);
    const payload = JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: IT_VERSION, hl: 'en', gl: 'EG' } },
      ...body
    });
    const mod = base.protocol === 'http:' ? require('http') : https;
    const req = mod.request({
      hostname: base.hostname,
      port: base.port || (base.protocol === 'http:' ? 80 : 443),
      path: `/youtubei/v1/${endpoint}?key=${IT_KEY}&prettyPrint=false`,
      method: 'POST',
      agent: base.protocol === 'https:' ? keepAliveAgent : undefined,
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': SUB_UA,
        'Origin': 'https://www.youtube.com',
        'X-Youtube-Client-Name': '1',
        'X-Youtube-Client-Version': IT_VERSION,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip'
      }
    }, (r) => {
      if ((r.statusCode || 0) >= 400) { r.resume(); return reject(new Error(`innertube HTTP ${r.statusCode}`)); }
      const stream = String(r.headers['content-encoding'] || '').toLowerCase() === 'gzip' ? r.pipe(zlib.createGunzip()) : r;
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('innertube timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

// ---- أدوات parsing مرنة (بتدوّر على الـ renderers في أي مكان — بتتحمّل تغيّر الهيكل) ----
const itText = (o) => {
  if (!o) return '';
  if (typeof o === 'string') return o;
  if (o.simpleText) return o.simpleText;
  if (Array.isArray(o.runs)) return o.runs.map(r => r.text || '').join('');
  return o.content || '';
};
function itDuration(str) {
  const p = String(str || '').trim().split(':').map(Number);
  if (!p.length || p.some(n => Number.isNaN(n))) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
}
function itViews(str) {
  const m = String(str || '').toLowerCase().replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2] === 'k') n *= 1e3; else if (m[2] === 'm') n *= 1e6; else if (m[2] === 'b') n *= 1e9;
  return Math.round(n) || 0;
}
function itFindAll(root, key, out = [], depth = 0) {
  if (!root || typeof root !== 'object' || depth > 45) return out;
  if (Array.isArray(root)) { for (const x of root) itFindAll(x, key, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(root)) {
    if (k === key) out.push(v);
    if (v && typeof v === 'object') itFindAll(v, key, out, depth + 1);
  }
  return out;
}
const VIDEO_RENDERER_KEYS = ['videoRenderer', 'compactVideoRenderer', 'gridVideoRenderer', 'playlistPanelVideoRenderer'];
function itCollect(root, out = [], depth = 0) {
  if (!root || typeof root !== 'object' || depth > 45) return out;
  if (Array.isArray(root)) { for (const x of root) itCollect(x, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(root)) {
    if (VIDEO_RENDERER_KEYS.includes(k) && v && v.videoId) out.push({ kind: 'r', n: v });
    else if (k === 'lockupViewModel' && v && v.contentId && String(v.contentType || '').includes('VIDEO')) out.push({ kind: 'l', n: v });
    else if (v && typeof v === 'object') itCollect(v, out, depth + 1);
  }
  return out;
}
function itBuild(id, title, author, channelId, duration, views, isLive, publishedText) {
  if (!id || !title) return null;
  return {
    id, title, uploader: author, channel: author, channel_id: channelId || '',
    duration: isLive ? 0 : duration, view_count: views,
    thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, height: 360, id: 'hqdefault' }],
    is_live: !!isLive, live_status: isLive ? 'is_live' : 'not_live',
    published_text: publishedText || null
  };
}
function itFromRenderer(r) {
  const owner = r.ownerText || r.longBylineText || r.shortBylineText;
  const overlay = (r.thumbnailOverlays || []).map(o => o.thumbnailOverlayTimeStatusRenderer).find(Boolean);
  const isLive = (overlay && overlay.style === 'LIVE') ||
    (r.badges || []).some(b => b.metadataBadgeRenderer && b.metadataBadgeRenderer.style === 'BADGE_STYLE_TYPE_LIVE_NOW');
  let dur = itDuration(itText(r.lengthText));
  if (!dur && overlay) dur = itDuration(itText(overlay.text));
  return itBuild(
    r.videoId, itText(r.title),
    itText(owner), owner && owner.runs && owner.runs[0] && owner.runs[0].navigationEndpoint && owner.runs[0].navigationEndpoint.browseEndpoint && owner.runs[0].navigationEndpoint.browseEndpoint.browseId,
    dur, itViews(itText(r.viewCountText || r.shortViewCountText)), isLive, itText(r.publishedTimeText)
  );
}
function itFromLockup(l) {
  const md = l.metadata && l.metadata.lockupMetadataViewModel;
  const title = itText(md && md.title);
  const parts = itFindAll(md && md.metadata, 'metadataParts').flat().map(p => itText(p && p.text));
  const author = parts[0] || '';
  const viewsText = parts.find(p => /view|watching|مشاهد/i.test(p)) || '';
  const badges = itFindAll(l.contentImage, 'thumbnailBadgeViewModel').map(b => itText(b && b.text));
  const durText = badges.find(b => /^\d+(:\d+)+$/.test(String(b).trim()));
  const isLive = badges.some(b => /^(live|مباشر)$/i.test(String(b).trim())) || /watching/i.test(viewsText);
  const browseId = (itFindAll(md, 'browseId')[0]) || '';
  const ago = parts.find(p => /\bago\b|منذ|streamed|premiere/i.test(p)) || '';
  return itBuild(l.contentId, title, author, browseId, itDuration(durText), itViews(viewsText), isLive, ago);
}
function itItems(data) {
  const seen = new Set(); const out = [];
  for (const c of itCollect(data)) {
    const item = c.kind === 'r' ? itFromRenderer(c.n) : itFromLockup(c.n);
    if (item && !seen.has(item.id)) { seen.add(item.id); out.push(item); }
  }
  return out;
}
function itContinuation(data) {
  const c = itFindAll(data, 'continuationItemRenderer')[0];
  return c && c.continuationEndpoint && c.continuationEndpoint.continuationCommand && c.continuationEndpoint.continuationCommand.token || null;
}

async function innertubeSearch(query, count, params) {
  let data = await innertubeCall('search', { query, params });
  const items = itItems(data);
  const seen = new Set(items.map(i => i.id));
  let token = itContinuation(data);
  for (let page = 1; items.length < count && token && page < 8; page++) {
    data = await innertubeCall('search', { continuation: token });
    for (const it of itItems(data)) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    token = itContinuation(data);
  }
  return items.slice(0, count);
}
async function innertubeRelated(videoId, count) {
  let data = await innertubeCall('next', { videoId });
  const items = itItems(data).filter(i => i.id !== videoId);
  const seen = new Set(items.map(i => i.id));
  let token = itContinuation(data);
  for (let page = 1; items.length < count && token && page < 3; page++) {
    data = await innertubeCall('next', { continuation: token });
    for (const it of itItems(data)) if (!seen.has(it.id) && it.id !== videoId) { seen.add(it.id); items.push(it); }
    token = itContinuation(data);
  }
  return items.slice(0, count);
}

// بيرجّع stdout بنفس شكل yt-dlp (سطر JSON لكل فيديو) أو null لو لازم نرجع لـ yt-dlp
async function innertubeFastPath(args) {
  if (!IT_ENABLED || itBreaker.until > Date.now()) return null;
  const a = args.map(String);
  const endIdx = a.indexOf('--playlist-end');
  const endN = endIdx >= 0 ? parseInt(a[endIdx + 1], 10) : 0;
  let count = 0, run = null;

  const sm = a.map(x => x.match(/^ytsearch(date)?(\d+):([\s\S]+)$/)).find(Boolean);
  if (sm) {
    count = Math.min(parseInt(sm[2], 10) || 20, 150);
    run = () => innertubeSearch(sm[3], count, sm[1] ? 'CAISAhAB' : 'EgIQAQ==');
  } else {
    const resUrl = a.find(x => /^https:\/\/www\.youtube\.com\/results\?/.test(x));
    const relUrl = a.find(x => /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}&list=RD/.test(x));
    if (resUrl) {
      const sp = new URL(resUrl).searchParams;
      const q = sp.get('search_query');
      if (!q) return null;
      count = Math.min(endN || 30, 100);
      run = () => innertubeSearch(q, count, sp.get('sp') || 'EgIQAQ==');
    } else if (relUrl) {
      const id = relUrl.match(/v=([\w-]{11})/)[1];
      count = Math.min(endN || 30, 60);
      run = () => innertubeRelated(id, count);
    }
  }
  if (!run) return null;

  try {
    const items = await run();
    // نتيجة قليلة بشكل مريب (حظر/تغيّر هيكل) → خلي yt-dlp يتولى
    if (items.length < Math.min(count, 8)) { log.warn(`innertube thin result (${items.length}/${count}) → yt-dlp`); return null; }
    itBreaker.fails = 0;
    return items.map(i => JSON.stringify(i)).join('\n');
  } catch (e) {
    itBreaker.fails++;
    if (itBreaker.fails >= 3) { itBreaker.until = Date.now() + 60 * 1000; itBreaker.fails = 0; log.warn('innertube paused 60s after repeated failures'); }
    log.warn(`innertube fail → yt-dlp: ${String(e.message || e).split('\n')[0]}`);
    return null;
  }
}

const ytFailFast = new Map();
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
    lane = 'meta',
    raw = false,
    playerClient = null
  } = opts;
  // بحث/related: HTTP مباشر بدل عملية yt-dlp (من غير ما نستنى في طابور العمليات)
  if (!raw && args.includes('--flat-playlist')) {
    const fast = await innertubeFastPath(args);
    if (fast) return fast;
  }

  const limiter = lane === 'stream' ? streamLimiter : ytdlpLimiter;
  // الطابور بيتاخد لكل محاولة لوحدها (مش للطلب كله) — قبل كده طلب واحد فاشل كان
  // بيحجز مكان لحد 8 محاولات ورا بعض ويخنق باقي المستخدمين.
  const execOnce = async (cmd, execOpts) => {
    const tq = Date.now();
    await limiter.acquire();
    let gotProc = false;
    try {
      // سقف عام لكل عمليات yt-dlp (حسب الرام/المعالج) والـ stream ليه أولوية
      await procLimiter.acquire(lane === 'stream' ? 0 : 1); gotProc = true;
      const waited = Date.now() - tq;
      if (waited > 8000) addIncident('slow', `طابور yt-dlp مزدحم: العملية استنت ${Math.round(waited / 1000)}ث قبل ما تشتغل (${lane})`, { cat: 'queue', ms: waited });
      const t1 = Date.now();
      try { const r = await execFileAsync(ytdlpBin, cmd, execOpts); noteSpawn(lane, Date.now() - t1, true); return r; }
      catch (err) {
        noteSpawn(lane, Date.now() - t1, false);
        // رسالة execFile الأصلية سطرها الأول هو سطر الأمر كله (مفيهوش السبب!) → نخلي الرسالة = سبب الفشل الحقيقي من stderr
        try { err.fullMessage = err.message; err.message = cleanErr(err, 900) || err.message; } catch {}
        throw err;
      }
    } finally { if (gotProc) procLimiter.release(); limiter.release(); }
  };

  const base = ytdlpBaseArgs();

  // raw: نفّذ args زي ما هي (مفيد لاستخراج formats/ترجمة كاملة)
  if (raw) {
    const cmd = [
      ...base,
      ...(useCookies && cookiesReady ? ['--cookies', COOKIES_PATH] : []),
      ...(playerClient ? ['--extractor-args', `youtube:${buildYoutubeExtractorArgs(playerClient)}`] : []),
      ...args
    ];
    const { stdout } = await execOnce(cmd, { timeout, maxBuffer, encoding: 'utf-8' });
    return stdout;
  }

  const attempts = [];
  const seenAttempts = new Set();
  const pushAttempt = (extra, cookies = false) => {
    const cmd = [...base, ...extra, ...(cookies && cookiesReady ? ['--cookies', COOKIES_PATH] : []), ...args];
    const sig = cmd.join('\u0001');
    if (seenAttempts.has(sig)) return;   // متكررش نفس المحاولة مرتين
    seenAttempts.add(sig);
    attempts.push(cmd);
  };
  const withClient = (c) => ['--extractor-args', `youtube:${buildYoutubeExtractorArgs(c)}`];

  if (args.includes('--flat-playlist')) {
    // بحث/قوائم (flat): مفيش player request، فتبديل الـ clients ملوش أي لازمة
    // (كان بيكرر نفس الفشل 5-8 مرات). محاولة عادية + محاولة بالكوكيز بس.
    pushAttempt([], useCookies && cookiesReady);
    if (cookiesReady) pushAttempt([], true);
  } else {
    // الأول من غير كوكيز (android_vr/tv/ios): أسرع وأضمن للروابط، وبعدها نجرّب الكوكيز للفيديوهات اللي محتاجة تسجيل دخول
    // (قبل كده الكوكيز كانت الأولى: android_vr/ios مبيدعموش الكوكيز فكانت المحاولة الأولى بتضيع وقت)
    const cookieOk = cookiesReady && (useCookies || allowCookieFallback);
    pushAttempt(withClient('android_vr,tv,ios'));
    if (cookieOk) { pushAttempt(withClient('tv,web'), true); pushAttempt(withClient('web,mweb'), true); }
    pushAttempt(withClient('web,mweb'));
    pushAttempt([]);
    if (cookieOk) pushAttempt([], true);
  }

  // كل محاولة ليها سقف وقت، والطلب كله ليه ميزانية — بدل 45 ثانية × 8 محاولات
  const attemptTimeout = Math.min(timeout, opts.attemptTimeout || 35000);
  const deadline = Date.now() + (opts.budget || Math.max(timeout, 60000));

  // نفس الفيديو لو فشل بـ bot-check/reload من شوية، منكرّرش 6 محاولات × 4 جولات (كان بيطلّع لحد 24 عملية yt-dlp للفيديو الواحد)
  const vidKey = (args.map(String).join(' ').match(/watch\?v=([\w-]{11})/) || [])[1];
  if (vidKey) {
    const ff = ytFailFast.get(vidKey);
    if (ff && ff.until > Date.now()) { const e = new Error(ff.msg); e.failFast = true; throw e; }
  }
  let lastError;
  const startIdx = Math.min(Math.max(0, opts.skip | 0), Math.max(0, attempts.length - 1));
  for (let i = startIdx; i < attempts.length; i++) {
    if (i > startIdx && Date.now() > deadline) break;
    try {
      const { stdout } = await execOnce(attempts[i], { timeout: attemptTimeout, maxBuffer, encoding: 'utf-8' });
      return stdout;
    } catch (error) {
      lastError = error;
      const msg = String(error.message || error).toLowerCase();
      {
        const vArg = attempts[i].find(a => /watch\?v=[\w-]{11}/.test(String(a)));
        addIncident('warn', `yt-dlp فشل (${attemptLabel(attempts[i])}) محاولة ${i + 1}/${attempts.length}`, { cat: 'ytdlp', videoId: vArg ? String(vArg).match(/v=([\w-]{11})/)[1] : null, detail: cleanErr(error) });
      }
      if (/po.?token|sign in to confirm|not a bot/.test(msg)) poManager.invalidateSoon();
      const keepTrying = isRetryableYoutubeError(error)
        || msg.includes('private')
        || msg.includes('unlisted')
        || msg.includes('sign in')
        || msg.includes('login required')
        || msg.includes('confirm your age')
        || msg.includes('age')
        || msg.includes('not available')
        || msg.includes('requested format is not available');
      if (!keepTrying && i === startIdx) throw error;
      if (i < attempts.length - 1) log.warn(`yt-dlp fallback ${i + 1}: ${String(error.message || error).split('\n')[0]}`);
    }
  }
  if (vidKey && lastError && /sign in to confirm|not a bot|page needs to be reloaded/i.test(String(lastError.message || ''))) {
    if (ytFailFast.size > 500) ytFailFast.clear();
    ytFailFast.set(vidKey, { until: Date.now() + 60000, msg: String(lastError.message).slice(0, 400) });
  }
  throw lastError;
}

/** بيحوّل ناتج --dump-json (سطر لكل فيديو) لمصفوفة عناصر موحّدة الشكل */
function mapFlatEntry(item, excludeId) {
  if (!item || !item.id) return null;
  if (excludeId && item.id === excludeId) return null;
  if (item.is_live || item.live_status === 'is_live') noteLiveHint(item.id, true);
  const thumbs = item.thumbnails || [];
  const bestThumb = thumbs.length
    ? (thumbs.find(t => t.id === 'hqdefault' || (t.height || 0) >= 360) || thumbs[thumbs.length - 1]).url
    : `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
  return {
    id: item.id,
    title: item.title || 'بدون عنوان',
    author: item.uploader || item.channel || 'Unknown',
    channelId: item.channel_id || '',
    duration: item.duration || 0,
    durationString: item.duration_string || null,
    thumbnail: bestThumb,
    thumbnails: {
      default: `https://i.ytimg.com/vi/${item.id}/default.jpg`,
      medium: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
      high: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      max: `https://i.ytimg.com/vi/${item.id}/maxresdefault.jpg`
    },
    viewCount: item.view_count || 0,
    publishedAt: item.upload_date
      ? `${item.upload_date.slice(0, 4)}-${item.upload_date.slice(4, 6)}-${item.upload_date.slice(6, 8)}`
      : (item.release_timestamp ? new Date(item.release_timestamp * 1000).toISOString() : null),
    description: item.description ? String(item.description).slice(0, 280) : null,
    publishedText: item.published_text || null,
    isLive: !!item.is_live,
    wasLive: !!item.was_live,
    liveStatus: item.live_status || null,
    isShort: !!(item.duration && item.duration > 0 && item.duration <= 60) || /#shorts/i.test(item.title || ''),
    url: `https://www.youtube.com/watch?v=${item.id}`
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
// بيستنى الخطة التانية (اللي فيها الترجمة)، ولو الفيديو لسه من غير ترجمة بيجرّب خطتين بديلتين مرة واحدة.
// قبل كده: لو الخطة اللي فيها الترجمة اتأخرت أو فشلت مرة، السيرفر كان يقول "مفيش ترجمة" للأبد.
async function ensureSubtitles(videoId, info) {
  const count = () => Object.keys(info.subtitles || {}).length + Object.keys(info.automatic_captions || {}).length;
  await waitSettled(info, 15000);   // قبل كده كان بيستنى الخطة التانية بلا حد (لحد 40ث+) فالترجمة كانت بتتعلّق
  if (count() || info.__subsRetried) return info;
  return dedupe(`ensure-subs:${videoId}`, async () => {
    if (count() || info.__subsRetried) return info;
    Object.defineProperty(info, '__subsRetried', { value: true, enumerable: false, writable: true, configurable: true });
    // أول خطة = clients الافتراضية بتاعة yt-dlp نفسه (بتتحدّث مع yt-dlp) ثم بدائل
    for (const plan of [{ playerClient: null, useCookies: true }, { playerClient: 'tv,web,mweb', useCookies: true }, { playerClient: 'web,mweb', useCookies: false }]) {
      try {
        const stdout = await runYtDlp(['--dump-json', '--no-playlist', '--skip-download', '--ignore-no-formats-error', `https://www.youtube.com/watch?v=${videoId}`], {
          timeout: 30000, raw: true, useCookies: plan.useCookies && cookiesReady, playerClient: plan.playerClient, maxBuffer: 1024 * 1024 * 20
        });
        const p = JSON.parse(stdout);
        if (Object.keys(p.subtitles || {}).length || Object.keys(p.automatic_captions || {}).length) {
          info.subtitles = p.subtitles || {};
          info.automatic_captions = p.automatic_captions || {};
          log.info(`subs recovered for ${videoId} via ${plan.playerClient || 'default'}`);
          break;
        }
      } catch (e) { log.warn(`ensureSubtitles ${plan.playerClient || 'default'}: ${cleanErr(e, 200).split('\n')[0]}`, { cat: 'captions', videoId, detail: cleanErr(e) }); }
    }
    return info;
  });
}

// الخطة التانية (جودات أعلى + دبلجات + ترجمة) بتكمّل في الخلفية؛ دي بتستناها بسقف وقت
async function waitSettled(info, ms) {
  if (!info || !info.__pending || !info.__settle) return;
  await Promise.race([info.__settle.catch(() => {}), new Promise(r => setTimeout(r, ms))]);
}

async function getVideoInfo(videoId) {
  const key = `raw_info_v4_${videoId}`;
  const cached = infoCache.get(key);
  if (cached) return cached;

  return dedupe(key, async () => {
    const again = infoCache.get(key);
    if (again) return again;

    // خطتين بيشتغلوا في نفس اللحظة بدل ما يتجرّبوا ورا بعض (ده كان أكبر سبب للبطء):
    //  A) android_vr/tv/ios من غير كوكيز → formats مضمونة + جودات عالية + HLS للبث المباشر.
    //  B) tv/web/mweb بالكوكيز + PO Token → الترجمات + المقاطع الصوتية بلغات تانية.
    // الأساسي = clients الافتراضية بتاعة yt-dlp نفسه (التقرير أثبت إنها بترجّع 2160p..240p بينما android_vr/tv/ios رجّعوا 360p بس)
    const planA = { playerClient: null, useCookies: cookiesReady };
    const planB = { playerClient: 'tv,web,mweb', useCookies: true };
    const fallbackPlans = [
      { playerClient: 'android_vr,tv,ios', useCookies: false },
      { playerClient: 'tv,ios,web', useCookies: true },
      { playerClient: 'web', useCookies: true }
    ];

    const runPlan = async (plan, timeout = 40000) => {
      const stdout = await runYtDlp([
        '--dump-json',
        '--no-playlist',
        '--no-check-certificates',
        `https://www.youtube.com/watch?v=${videoId}`
      ], {
        timeout,
        useCookies: plan.useCookies && cookiesReady,
        allowCookieFallback: false,
        raw: true,
        lane: 'stream',
        playerClient: plan.playerClient,
        maxBuffer: 1024 * 1024 * 20
      });
      const parsed = slimInfo(JSON.parse(stdout));
      const formats = Array.isArray(parsed.formats) ? parsed.formats : [];
      const heights = new Set(formats.filter(f => f.vcodec && f.vcodec !== 'none').map(f => Number(f.height)).filter(h => h > 0));   // من غير storyboards (144/90/45p دي صور مصغّرة)
      const subs =
        Object.keys(parsed.subtitles || {}).length +
        Object.keys(parsed.automatic_captions || {}).length;
      const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')).length;
      const score = formats.length * 2 + heights.size * 10 + subs * 5 + audioOnly * 3 + (parsed.is_live ? 1000 : 0);
      log.info(`info client=${plan.playerClient || "default"} formats=${formats.length} heights=${[...heights].sort((a,b)=>b-a).slice(0,8).join(',')} subs=${subs} score=${score}`);
      return { parsed, score, heights, subs, audioOnly, client: plan.playerClient };
    };

    let lastErr = null;
    const results = [];
    const track = (p, plan) => p.then(
      r => { if (r && !r.skipped) results.push(r); return r; },
      e => { lastErr = e; log.warn(`info client ${plan.playerClient || 'default'} fail: ${cleanErr(e, 200).split('\n')[0]}`, { cat: 'info', videoId, detail: cleanErr(e) }); return null; }
    );
    const pA = track(runPlan(planA), planA);
    // B بتبدأ بعد ما A تخلص (أو بعد 4ث) بدل ما الاتنين يضربوا المعالج في نفس اللحظة
    // الخطة التانية (tv,web,mweb) بترجّع 360p بس في التقارير، فبنشغّلها بس لو الأساسية فشلت أو مفيهاش ترجمة/صوت (بدل ما تضاعف حمل yt-dlp مع كل /info)
    const pB = track(pA.then(async () => {
      const a = results.find(r => r.client === planA.playerClient);
      if (a && a.subs > 0 && a.audioOnly > 0) return { skipped: true };
      return runPlan(planB);
    }), planB);
    await Promise.race([pA, pB]);
    if (!results.length) {
      await Promise.all([pA, pB]);                       // الأول فشل → استنى التاني
    } else if (results[0].client !== planA.playerClient) {
      // B خلّصت الأول: لحظة قصيرة لـ A لأن روابطها أضمن
      await Promise.race([pA, new Promise(r => setTimeout(r, 1500))]);
    }

    if (!results.length) {
      const fbDeadline = Date.now() + 60000;
      for (const plan of fallbackPlans) {
        if (Date.now() > fbDeadline) break;
        try { results.push(await runPlan(plan, 40000)); break; }
        catch (e) { lastErr = e; log.warn(`info client ${plan.playerClient || 'default'} fail: ${cleanErr(e, 200).split('\n')[0]}`, { cat: 'info', videoId, detail: cleanErr(e) }); }
      }
    }
    if (!results.length) throw lastErr || new Error('Failed to extract video info');

    // كمّل الناقص من نتيجة تانية: ترجمات + جودات أعلى + لغات صوت إضافية
    const mergeInto = (best, r) => {
      const p = r.parsed;
      if (!Object.keys(best.subtitles || {}).length && Object.keys(p.subtitles || {}).length) best.subtitles = p.subtitles;
      if (!Object.keys(best.automatic_captions || {}).length && Object.keys(p.automatic_captions || {}).length) best.automatic_captions = p.automatic_captions;
      if (!best.chapters && p.chapters) best.chapters = p.chapters;
      if (!Array.isArray(best.formats)) best.formats = [];
      const haveIds = new Set(best.formats.map(f => String(f.format_id)));
      const haveHeights = new Set(best.formats.filter(f => f.vcodec && f.vcodec !== 'none').map(f => Number(f.height)).filter(Boolean));
      const haveAudioLangs = new Set(best.formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')).map(f => f.language || 'und'));
      for (const f of (p.formats || [])) {
        if (!f || !f.url || haveIds.has(String(f.format_id)) || isHlsUrl(f.url)) continue;
        const isVideo = f.vcodec && f.vcodec !== 'none';
        const isAudioOnly = f.acodec && f.acodec !== 'none' && !isVideo;
        if ((isVideo && Number(f.height) && !haveHeights.has(Number(f.height))) ||
            (isAudioOnly && !haveAudioLangs.has(f.language || 'und'))) {
          best.formats.push(f);
          haveIds.add(String(f.format_id));
        }
      }
    };

    // الأساس: خطة A لو طلّعت جودات كفاية (روابطها أضمن)، وإلا أعلى score
    results.sort((x, y) => y.score - x.score);
    const primary = results.find(r => r.client === planA.playerClient && r.heights.size >= 3 && r.audioOnly > 0) || results[0];
    const best = primary.parsed;
    const merged = new Set([primary]);
    for (const r of results) if (!merged.has(r)) { mergeInto(best, r); merged.add(r); }

    const liveNow = !!(best.is_live || best.live_status === 'is_live');
    const maxHeightOf = (o) => { const hs = (o.formats || []).filter(f => f && f.vcodec && f.vcodec !== 'none').map(f => fmtH(f)).filter(h => h > 0); return hs.length ? Math.max(...hs) : 0; };
    const planSummary = () => results.map(r => `${r.client || 'default'}: formats=${(r.parsed.formats || []).length} heights=${[...r.heights].sort((a, b) => b - a).slice(0, 6).join('/') || '-'} subs=${r.subs} audioOnly=${r.audioOnly}`).join('\n') + (lastErr ? `\nlast error: ${cleanErr(lastErr, 300)}` : '');
    // أعلى جودة <=360 غالبًا = استخراج ناقص (client اتحجب/محتاج PO Token) مش فيديو واطي الجودة → مش هنكاشه ساعتين، ونجرّب clients الافتراضية بتاعة yt-dlp
    const degradedNow = !liveNow && best.live_status !== 'is_upcoming' && maxHeightOf(best) <= 360;

    // الخطة التانية لسه شغّالة؟ بنرد دلوقتي وهي بتكمّل في الخلفية (بتعدّل نفس الكائن المتكاشّ).
    // /captions و/transcript بيستنوها عبر ensureSubtitles، و/info مبيستناهاش (عشان الوصف يطلع بسرعة).
    const pending = [pA, pB];
    if (degradedNow) { const planC = { playerClient: 'android_vr,tv,ios', useCookies: false }; pending.push(track(runPlan(planC), planC)); }
    const settle = Promise.allSettled(pending).then(() => {
      for (const r of results) if (!merged.has(r)) { mergeInto(best, r); merged.add(r); }
      if (degradedNow) {
        if (maxHeightOf(best) > 360) infoCache.set(key, best, CACHE_TTL.info);
        else addIncident('warn', `info degraded ${videoId}: كل الـ clients رجّعوا أعلى جودة ${maxHeightOf(best)}p (ممكن الفيديو نفسه جودته واطية)`, { cat: 'info', videoId, detail: planSummary() });
      }
    });
    Object.defineProperty(best, '__settle', { value: settle, enumerable: false, configurable: true });
    Object.defineProperty(best, '__pending', { value: true, enumerable: false, writable: true, configurable: true });
    settle.then(() => { best.__pending = false; });

    noteLiveHint(videoId, liveNow);
    // البث المباشر: كاش قصير عشان روابط الـ HLS تتجدد | استخراج ناقص: 3 دقايق بس
    infoCache.set(key, best, (liveNow || best.live_status === 'is_upcoming') ? 5 * 60 * 1000 : (degradedNow ? 3 * 60 * 1000 : CACHE_TTL.info));
    return best;
  });
}


// ==========================================================================
// 🔑 AUTO PO TOKEN MANAGER (v13.4.0)
// بيولّد PO Token حقيقي تلقائيًا جوه السيرفر (من غير متصفح ولا Docker):
//   1) بيجيب Visitor Data من يوتيوب.
//   2) بيشغّل BotGuard جوه jsdom عن طريق bgutils-js ويطلع التوكن.
//   3) بيجدده كل PO_REFRESH_MIN دقيقة (الافتراضي 240) وفي الخلفية.
// المتطلبات:  npm i bgutils-js jsdom
// لو YOUTUBE_PO_TOKEN مظبوط يدويًا في الـ env، بيتقدّم على التوليد التلقائي.
// لو الحزم مش منصّبة السيرفر بيكمّل عادي بدون توكن (مفيش كراش).
// ==========================================================================
const poManager = (() => {
  const REFRESH_MS = Math.max(30, parseInt(process.env.PO_REFRESH_MIN, 10) || 240) * 60 * 1000;
  const MIN_GAP_MS = 5 * 60 * 1000; // أقل فاصل بين محاولتين
  const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const st = { token: null, visitorData: null, generatedAt: 0, lastError: null, lastAttempt: 0, busy: null };

  async function fetchVisitorData() {
    const r = await fetch('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Origin': 'https://www.youtube.com' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } },
        browseId: 'FEwhat_to_watch'
      })
    });
    if (!r.ok) throw new Error(`visitorData HTTP ${r.status}`);
    const j = await r.json();
    const vd = j?.responseContext?.visitorData;
    if (!vd) throw new Error('visitorData missing in response');
    return vd;
  }

  async function generateOnce() {
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); }
    catch (e) { throw new Error('حزمة jsdom مش متحمّلة: ' + String(e.message || e).split('\n')[0]); }
    let BG;
    {
      let mod = null, impErr = null;
      try { mod = await import('bgutils-js'); } catch (e) { impErr = e; }
      if (!mod) { try { mod = require('bgutils-js'); } catch (e) { impErr = impErr || e; } }
      const pickBG = (m) => m && (m.BG || (m.default && m.default.BG));
      if (!pickBG(mod)) {
        // exports بتاعة الحزمة مش بتسمح بالـ import من الجذر → نجرّب كل ملفات js جواها بالمسار المباشر لحد ما نلاقي BG
        const path = require('path');
        const tried = [];
        mod = null;
        for (const base of [path.join(process.cwd(), 'node_modules', 'bgutils-js'), path.join(__dirname, 'node_modules', 'bgutils-js')]) {
          let pkg = null; try { pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')); } catch { continue; }
          const cands = [];
          const addStr = (v) => { if (typeof v === 'string') { if (!/\.d\.ts$/.test(v)) cands.push(v); } else if (v && typeof v === 'object') Object.values(v).forEach(addStr); };
          addStr(pkg.exports); cands.push(pkg.module, pkg.main);
          const files = [];
          (function walk(d, depth) {
            if (depth > 4) return;
            let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const e of ents) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, depth + 1); }
              else if (/\.(m?js|cjs)$/.test(e.name) && !/\.d\.|\.min\./.test(e.name)) files.push(path.relative(base, p));
            }
          })(base, 0);
          files.sort((x, y) => ((/esm|\.mjs/.test(y) ? 2 : 0) + (/index/.test(y) ? 1 : 0)) - ((/esm|\.mjs/.test(x) ? 2 : 0) + (/index/.test(x) ? 1 : 0)));
          cands.push(...files);
          tried.push(`version=${pkg.version || '?'} ${/^[3-9]\./.test(String(pkg.version || '')) ? '← النسخة دي API مختلف عن اللي السيرفر مبني عليه: نزّل bgutils-js@2 (npm i bgutils-js@2)' : ''} exports=${JSON.stringify(pkg.exports || null).slice(0, 100)}`);
          for (const rel of [...new Set(cands.filter(Boolean))]) {
            const f = path.join(base, rel);
            if (!fs.existsSync(f)) continue;
            try { const m = await import(require('url').pathToFileURL(f).href); if (pickBG(m)) { mod = m; break; } } catch (e) { impErr = e; }
          }
          if (mod) break;
        }
        if (!mod) impErr = new Error(`${impErr && impErr.message} | ${tried.join(' || ')}`);
      }
      BG = mod && (mod.BG || (mod.default && mod.default.BG));
      if (!BG) throw new Error('حزمة bgutils-js مش متحمّلة: ' + String((impErr && impErr.message) || 'BG مش موجود في الحزمة').split('\n')[0]);
    }

    const visitorData = await fetchVisitorData();
    const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
      url: 'https://www.youtube.com/', referrer: 'https://www.youtube.com/', userAgent: UA
    });
    // bgutils محتاج window/document عالميين أثناء التوليد بس — بنشيلهم بعدها
    const prevWindow = globalThis.window, prevDocument = globalThis.document;
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    try {
      const bgConfig = { fetch: (u, o) => fetch(u, o), globalObj: globalThis, identifier: visitorData, requestKey: REQUEST_KEY };
      const challenge = await BG.Challenge.create(bgConfig);
      if (!challenge) throw new Error('BotGuard challenge unavailable');
      const js = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
      if (!js) throw new Error('BotGuard interpreter script missing');
      new Function(js)();
      const result = await BG.PoToken.generate({ program: challenge.program, globalName: challenge.globalName, bgConfig });
      if (!result?.poToken) throw new Error('PoToken generation returned empty');
      return { token: result.poToken, visitorData };
    } finally {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
      if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
      try { dom.window.close(); } catch {}
    }
  }

  async function refresh(force = false) {
    if (st.busy) return st.busy;
    if (!force && Date.now() - st.lastAttempt < MIN_GAP_MS) return null;
    st.lastAttempt = Date.now();
    st.busy = (async () => {
      try {
        const out = await generateOnce();
        st.token = out.token; st.visitorData = out.visitorData;
        st.generatedAt = Date.now(); st.lastError = null;
        streamCache.clear(); fastStreamCache.clear(); infoCache.clear();
        log.success(`🔑 PO Token generated (${out.token.length} chars) — valid ~${Math.round(REFRESH_MS / 60000)}min`);
      } catch (e) {
        st.lastError = String(e.message || e);
        log.warn(`🔑 PO Token generation failed: ${st.lastError}`);
      } finally { st.busy = null; }
    })();
    return st.busy;
  }

  const manual = () => String(process.env.YOUTUBE_PO_TOKEN || process.env.PO_TOKEN || '').trim();
  const fresh = () => Boolean(st.token && st.visitorData && Date.now() - st.generatedAt < REFRESH_MS * 1.5);

  return {
    refresh,
    manual,
    ready: () => Boolean(manual()) || fresh(),
    isAuto: () => !manual() && fresh(),
    get token() { return st.token; },
    get visitorData() { return st.visitorData; },
    // اتنادي لما يوتيوب يرفض بسبب التوكن — تجديد بحد أدنى 5 دقايق بين المحاولات
    invalidateSoon() { if (!manual()) refresh(false).catch(() => {}); },
    status() {
      return {
        mode: manual() ? 'manual-env' : (fresh() ? 'auto' : 'none'),
        hasToken: Boolean(manual()) || fresh(),
        generatedAt: st.generatedAt ? new Date(st.generatedAt).toISOString() : null,
        ageMin: st.generatedAt ? Math.round((Date.now() - st.generatedAt) / 60000) : null,
        refreshEveryMin: Math.round(REFRESH_MS / 60000),
        lastError: st.lastError
      };
    },
    start() {
      if (manual()) { log.info('🔑 PO Token: manual env في الاستخدام — التوليد التلقائي متوقف'); return; }
      refresh(true).catch(() => {});
      setInterval(() => { refresh(true).catch(() => {}); }, REFRESH_MS).unref();
    }
  };
})();
poManager.start();

// تجديد التوكن يدويًا (محمي بـ ADMIN_SECRET لو موجود)
app.post('/api/po-token/refresh', async (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'غير مصرح — أرسل X-Admin-Key أو ?key=' });
  if (poManager.manual()) return res.json({ ok: true, note: 'YOUTUBE_PO_TOKEN يدوي مظبوط — شيله من الـ env لتفعيل التوليد التلقائي', ...poManager.status() });
  await poManager.refresh(true);
  res.json({ ok: poManager.ready(), ...poManager.status() });
});
app.get('/api/po-token/status', (req, res) => res.json(poManager.status()));

/** PO Token — يدوي من الـ env (أولوية)، وإلا التلقائي من poManager */
function buildYoutubeExtractorArgs(playerClient) {
  const parts = [];
  if (playerClient) parts.push(`player_client=${playerClient}`);
  // formats=missing_pot بتعرض روابط محتاجة PO Token وبترجع 403 وقت التشغيل → اختيارية فقط (YTDLP_MISSING_POT=1)
  if (process.env.YTDLP_MISSING_POT === '1') parts.push('formats=missing_pot');
  const usesWeb = !playerClient || /\b(web|mweb)\b/.test(String(playerClient));
  const manualPot = poManager.manual();
  if (manualPot) {
    // يقبل: web.gvs+XXX أو قائمة مفصولة بفاصلة
    parts.push(`po_token=${manualPot}`);
  } else if (usesWeb && poManager.isAuto()) {
    // التوكن/الزائر التلقائي للـ web فقط — إرسال visitor_data بتاع web لـ android_vr/tv/ios كان ممكن يبوّظ الاستخراج
    const t = poManager.token;
    parts.push(`po_token=web.gvs+${t},web.player+${t},web.subs+${t},mweb.gvs+${t},mweb.subs+${t}`);
    parts.push(`visitor_data=${poManager.visitorData}`);
  }
  return parts.join(';');
}

function isHlsUrl(url) {
  const u = String(url || '').toLowerCase();
  return u.includes('.m3u8') || u.includes('/manifest/hls') || u.includes('playlist/index.m3u8');
}

const PROGRESSIVE_FALLBACK_SELECTOR =
  '18/22/best[ext=mp4][acodec!=none][vcodec!=none][protocol^=http]/' +
  'best[acodec!=none][vcodec!=none][protocol^=http]/best[protocol^=http]';

async function getFormatUrls(videoId, formatSelector, opts = {}) {
  // strict: من غير أي fallback لـ progressive 360 — مهم عشان جودة معيّنة متتبدلش بصمت بغيرها
  // fresh: تجاهل الكاش (بنستخدمه بعد ما رابط مكاشّ يفشل في التحقق)
  const strict = !!opts.strict;
  const skip = Math.max(0, opts.skip | 0);   // تخطّي أول N محاولات (clients) بعد ما رابطها فشل في التحقق
  const key = `urls_${videoId}_${formatSelector}${strict ? '_strict' : ''}${skip ? `_s${skip}` : ''}`;
  if (!opts.fresh) {
    const cached = streamCache.get(key);
    if (cached && Array.isArray(cached) && !cached.some(isHlsUrl)) return cached;
  } else streamCache.delete(key);

  return dedupe(key + (opts.fresh ? ':fresh' : ''), async () => {
    if (!opts.fresh) {
      const again = streamCache.get(key);
      if (again && Array.isArray(again) && !again.some(isHlsUrl)) return again;
    }

    // --dump-json بدل --get-url: نفس التكلفة لكن بيرجّع كمان الـ http_headers الصح لكل رابط
    const trySelector = async (selector) => {
      const stdout = await runYtDlp([
        '--dump-json', '--no-playlist',
        '-f', selector,
        '--format-sort', 'proto:https,proto:http,res,br',
        `https://www.youtube.com/watch?v=${videoId}`
      ], {
        timeout: 40000,
        lane: 'stream',
        skip,
        useCookies: true,
        allowCookieFallback: true
      });
      return extractUrlsFromDump(stdout);
    };

    let urls = [];
    try { urls = await trySelector(formatSelector); }
    catch (e) {
      if (strict) throw e;
      log.warn(`get-url primary fail: ${String(e.message || e).split('\n')[0]}`);
    }

    if (!strict && (!urls.length || urls.some(isHlsUrl))) {
      log.warn(`HLS/empty for ${videoId} — forcing progressive MP4`);
      try { urls = await trySelector(PROGRESSIVE_FALLBACK_SELECTOR); }
      catch (e) { log.warn(`progressive force fail: ${String(e.message || e).split('\n')[0]}`); }
    }

    if (!strict && (!urls.length || urls.some(isHlsUrl))) {
      try { urls = await trySelector('18'); } catch {}
    }

    urls = (urls || []).filter(u => u && !isHlsUrl(u));
    if (!urls.length) throw new Error('No progressive (non-HLS) stream URL returned');
    streamCache.set(key, urls, CACHE_TTL.stream);
    return urls;
  });
}


// بيجيب روابط ويتحقق منها فعليًا؛ لو رفضها يوتيوب (403) بيجرّب client/كوكيز مختلف بدل ما يرجّع نفس الرابط الفاشل
async function getVerifiedUrls(videoId, selector, { strict = false, minCount = 1, rounds = 4 } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  for (let skip = 0; skip < rounds; skip++) {
    if (skip > 0 && Date.now() - t0 > 40000) break;
    try {
      const urls = await getFormatUrls(videoId, selector, { strict, fresh: skip > 0, skip });
      if (urls.length >= minCount && await verifyAll(urls)) return urls;
      lastErr = new Error('upstream rejected the stream URL (403)');
    } catch (e) { lastErr = e; if (strict === false && /No progressive/.test(String(e.message))) break; }
  }
  throw lastErr || new Error('no verified stream url');
}

async function getVideoStreamUrl(videoId, format = 'best') {
  const urls = await getFormatUrls(videoId, format);
  const streamUrl = urls[0];
  log.success(`🎬 Got stream URL (${streamUrl.length} chars)`);
  return streamUrl;
}


/**
 * البحث عن فيديوهات على يوتيوب باستخدام yt-dlp (بدون أي اعتماد على YouTube Data API)
 * options: { sort: 'relevance'|'date', type: 'video'|'live' }
 */
async function searchVideos(query, limit = 10, options = {}) {
  const sort = options.sort === 'date' ? 'date' : 'relevance';
  const type = options.type === 'live' ? 'live' : 'video';
  const normalized = String(query).trim().replace(/\s+/g, ' ').toLowerCase();
  const key = `search:${normalized}:${limit}:${sort}:${type}`;
  const cached = searchCache.get(key);
  if (cached) return cached;
  return dedupe(key, async () => {
    const again = searchCache.get(key); if (again) return again;
    log.info(`🔎 Searching: "${query}" (limit ${limit}, sort=${sort}, type=${type})`);

    let stdout;
    if (type === 'live') {
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgJAAQ%3D%3D`;
      stdout = await runYtDlp(['--flat-playlist', '--dump-json', '--playlist-end', String(limit), url]);
    } else if (sort === 'date') {
      stdout = await runYtDlp([`ytsearchdate${limit}:${query}`, '--dump-json', '--flat-playlist']);
    } else {
      stdout = await runYtDlp([`ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist']);
    }
    let result = parseFlatItems(stdout);
    if (options.duration === 'short') result = result.filter(v => v.duration > 0 && v.duration <= 240);
    if (options.duration === 'medium') result = result.filter(v => v.duration > 240 && v.duration <= 1200);
    if (options.duration === 'long') result = result.filter(v => v.duration > 1200);
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
    const sources = [];
    try {
      const stdout = await runYtDlp(['--dump-json','--flat-playlist','--yes-playlist','--playlist-end',String(Math.max(limit * 3, 20)),`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`]);
      sources.push(parseFlatItems(stdout, videoId));
    } catch (e) { log.warn(`Related RD failed: ${e.message}`); }
    if (sources.flat().length < limit) {
      // العنوان مطلوب بس لو المقترحات المباشرة مكفتش (قبل كده كنا بنستنى ميتاداتا الفيديو كاملة الأول)
      try { title = String((await getVideoInfo(videoId)).title || '').replace(/[|]/g, ' ').trim(); } catch {}
    }
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
  'محتوى مصري جديد اليوم',
  'فيديوهات تعليمية مصر',
  'علوم وتكنولوجيا بالعربي',
  'رياضة مصر اليوم',
  'أخبار مصر اليوم',
  'مراجعات تقنية عربية',
  'بودكاست عربي جديد',
  'ترند عربي اليوم'
];

const RECOMMENDATION_FALLBACK_QUERIES = [
  'فيديوهات جديدة مصر',
  'أفضل فيديوهات عربية اليوم',
  'محتوى عربي مفيد',
  'فيديوهات تعليمية عربية',
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
  { key: 'for_you_mix', title: 'مزيج لك', query: 'فيديوهات عربية رائجة' },
  { key: 'education', title: 'تعليم', query: 'شرح دروس تعليمية بالعربي' },
  { key: 'tech', title: 'تكنولوجيا', query: 'تكنولوجيا مراجعات تقنية عربية' },
  { key: 'sports', title: 'رياضة', query: 'رياضة مصر أهداف وملخصات' },
  { key: 'news', title: 'أخبار', query: 'أخبار مصر اليوم' },
  { key: 'podcasts', title: 'بودكاست', query: 'بودكاست عربي جديد' },
  { key: 'gaming', title: 'ألعاب', query: 'ألعاب فيديو عربية' },
  { key: 'music', title: 'موسيقى', query: 'أغاني عربية جديدة' },
  { key: 'movies', title: 'أفلام ومسلسلات', query: 'أفلام عربية ومسلسلات' },
  { key: 'comedy', title: 'كوميدي', query: 'كوميدي مصري مقاطع مضحكة' },
  { key: 'science', title: 'علوم', query: 'علوم وتكنولوجيا بالعربي' }
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
            `ytsearchdate${Math.max(perSection * 3, 36)}:${section.query}`,
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
      searchLive('بث مباشر', perSection)
        .then(items => ({ key: 'live', title: 'بث مباشر الآن', items: items.slice(0, perSection) }))
        .catch(e => { log.warn(`home live failed: ${String(e.message || e).split('\n')[0]}`); return null; })
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
  // يدعم UC... أو @handle
  const base = String(channelId).startsWith('UC')
    ? `https://www.youtube.com/channel/${channelId}`
    : (String(channelId).startsWith('@')
      ? `https://www.youtube.com/${channelId}`
      : `https://www.youtube.com/channel/${channelId}`);
  const url = `${base}/${safeTab}`;
  const stdout = await runYtDlp([
    '--flat-playlist', '--dump-single-json',
    '--playlist-end', String(Math.min(Math.max(limit, 1), 100)),
    url
  ], { useCookies: cookiesReady, allowCookieFallback: true, timeout: 60000 });
  const data = JSON.parse(stdout);
  const chInfo = {
    id: data.channel_id || channelId,
    title: data.channel || data.uploader || 'قناة',
    followers: data.channel_follower_count || null,
    avatar: data.thumbnails?.length ? data.thumbnails[data.thumbnails.length - 1].url : null,
    description: data.description || ''
  };
  channelMetaCache.set(String(channelId), chInfo, 60 * 60 * 1000);
  const entries = (data.entries || []).map(e => {
    const mapped = mapFlatEntry(e);
    if (!mapped) return null;
    return {
      ...mapped,
      playlistId: e.id || null,
      playlistTitle: e.title || null,
      itemCount: e.playlist_count || e.n_entries || null,
      isLive: !!e.is_live || e.live_status === 'is_live',
      wasLive: !!e.was_live || e.live_status === 'was_live',
      liveStatus: e.live_status || (e.is_live ? 'is_live' : null),
      concurrentViewers: e.concurrent_view_count || e.view_count || null
    };
  }).filter(Boolean);
  return {
    channel: chInfo,
    tab: safeTab,
    entries: fillChannelOwner(entries, chInfo)
  };
}


// ترتيب فيديوهات القناة زي يوتيوب (الأحدث / الأكثر رواجًا / الأقدم) عبر chips بتاعة تبويب الفيديوهات
async function innertubeChannelSorted(channelId, sort, count) {
  let data = await innertubeCall('browse', { browseId: channelId, params: 'EgZ2aWRlb3PyBgQKAjoA' }, 6000);
  const chips = itFindAll(data, 'chipCloudChipRenderer');
  const want = sort === 'popular' ? /popular|رائج|رواج|الأكثر/i : /oldest|الأقدم|قديم/i;
  const chip = chips.find(c => want.test(itText(c.text))) || chips[sort === 'popular' ? 1 : 2];
  const token = chip && chip.navigationEndpoint && chip.navigationEndpoint.continuationCommand && chip.navigationEndpoint.continuationCommand.token;
  if (!token) return null;
  data = await innertubeCall('browse', { continuation: token }, 6000);
  const items = itItems(data);
  const seen = new Set(items.map(i => i.id));
  let next = itContinuation(data);
  for (let page = 1; items.length < count && next && page < 6; page++) {
    data = await innertubeCall('browse', { continuation: next }, 6000);
    for (const it of itItems(data)) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    next = itContinuation(data);
  }
  return items.slice(0, count);
}

async function getChannelSorted(channelId, sort, count) {
  const cached = channelMetaCache.get(String(channelId));
  const metaP = cached ? Promise.resolve(cached) : getChannelVideos(channelId, 1).then(d => d.channel);
  let videos = null, approximate = false;
  if (IT_ENABLED && String(channelId).startsWith('UC') && itBreaker.until <= Date.now()) {
    try {
      const items = await innertubeChannelSorted(channelId, sort, count);
      if (items && items.length >= Math.min(count, 6)) videos = items.map(i => mapFlatEntry(i)).filter(Boolean);
    } catch (e) { log.warn(`channel sort via innertube failed: ${String(e.message || e).split('\n')[0]}`); }
  }
  const channel = await metaP.catch(() => ({ id: channelId, title: 'قناة' }));
  if (!videos) {
    // رجوع: الأحدث من yt-dlp ويترتّب محليًا (تقريبي: على اللي اتجاب بس)
    const base = await getChannelVideos(channelId, Math.min(100, Math.max(count, 60)));
    videos = base.videos.slice();
    if (sort === 'popular') videos.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0)); else videos.reverse();
    approximate = true;
  }
  return { channel, videos: fillChannelOwner(videos, channel), approximate };
}

async function getChannelVideos(channelId, limit = 20) {
  const url = `https://www.youtube.com/channel/${channelId}/videos`;
  log.info(`📺 Fetching channel: ${channelId} (limit ${limit})`);
  const stdout = await runYtDlp(['--flat-playlist', '--dump-single-json', '--playlist-end', String(limit), url]);
  const data = JSON.parse(stdout);
  const chInfo = {
    id: data.channel_id || channelId,
    title: data.channel || data.uploader || 'قناة',
    followers: data.channel_follower_count || null,
    avatar: data.thumbnails?.length ? data.thumbnails[data.thumbnails.length - 1].url : null,
    description: data.description || ''
  };
  channelMetaCache.set(String(channelId), chInfo, 60 * 60 * 1000);
  const videos = fillChannelOwner((data.entries || []).map(e => mapFlatEntry(e)).filter(Boolean), chInfo);
  return { channel: chInfo, videos };
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
    // max-comments,max-parents,max-replies,max-replies-per-thread: بدون ردود = أسرع بكتير
    '--extractor-args', `youtube:comment_sort=top;max_comments=${limit},${limit},0,0`,
    `https://www.youtube.com/watch?v=${videoId}`
  ];
  const stdout = await runYtDlp(args, { timeout: 45000, attemptTimeout: 30000 });
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
const STREAMY = /^\/(video|download|hls)(?!\/qualities)/;
function catFromPath(p) {
  if (/^\/(captions|transcript)/.test(p)) return 'captions';
  if (/^\/audio-tracks/.test(p)) return 'audio';
  if (/^\/(video\/qualities|formats)/.test(p)) return 'quality';
  if (/^\/(video|download|hls)/.test(p)) return 'stream';
  if (/^\/(info|chapters)/.test(p)) return 'info';
  if (/^\/(search|home|trending|related|recommendations|channel|playlist|comments|api\/me|api\/account-feed|api\/live)/.test(p)) return 'feed';
  return 'system';
}
function reportRouteError(req, res, cat, e, extra = {}) {
  try {
    if (res && res.locals) res.locals.__reported = true;
    addIncident('error', `${req.method} ${req.path} فشل${extra.lang ? ' (' + extra.lang + ')' : ''}`, {
      cat, videoId: typeof req.query.v === 'string' ? req.query.v.slice(0, 11) : null, route: req.originalUrl, detail: cleanErr(e),
      reqId: res && res.getHeader ? res.getHeader('X-Request-ID') : null
    });
  } catch {}
}
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  const id = (++requestSeq).toString(36);
  res.setHeader('X-Request-ID', id);
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  let ttfb = null;
  const origWriteHead = res.writeHead;
  res.writeHead = function (...a) { if (ttfb === null) ttfb = elapsed(); return origWriteHead.apply(this, a); };
  const ctx = (extra) => ({ cat: catFromPath(req.path), videoId: typeof req.query.v === 'string' ? req.query.v.slice(0, 11) : null, route: req.originalUrl, reqId: id, ...extra });
  res.on('finish', () => {
    const total = elapsed();
    const streamy = STREAMY.test(req.path);
    const waited = streamy ? (ttfb != null ? ttfb : total) : total;   // للستريم بنقيس أول بايت مش مدة التشغيل كلها
    const code = res.statusCode;
    const reported = res.locals && res.locals.__reported;
    if (code >= 500 && !reported) addIncident('error', `${req.method} ${req.path} → ${code}`, ctx({ status: code, ms: total }));
    else if (streamy && [401, 403, 410, 503].includes(code) && !reported) addIncident('warn', `${req.method} ${req.path} → ${code}`, ctx({ status: code, ms: total }));
    if (waited > (streamy ? 6000 : 4000)) addIncident('slow', `${streamy ? 'أول بايت اتأخر' : 'رد بطيء'}: ${req.method} ${req.path}`, ctx({ status: code, ms: waited }));
  });
  res.on('close', () => {
    const t = elapsed();
    if (!res.writableFinished && !res.headersSent && t > 2000) addIncident('warn', `العميل قفل قبل ما السيرفر يرد (استنى ${Math.round(t / 1000)}ث): ${req.method} ${req.path}`, ctx({ ms: t }));
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
      example: '/search?q=funny+cats&limit=20&page=1&sort=date&type=video&duration=long'
    });
  }

  const sort = String(req.query.sort || 'relevance').toLowerCase() === 'date' ? 'date' : 'relevance';
  const type = String(req.query.type || 'video').toLowerCase() === 'live' ? 'live' : 'video';
  const duration = ['short', 'medium', 'long'].includes(String(req.query.duration || '').toLowerCase())
    ? String(req.query.duration).toLowerCase()
    : null;

  try {
    const { page, limit, results, hasMore } = await getPaginatedPool(
      searchCache, `search_${query}_${sort}_${type}_${duration || 'any'}`,
      (poolSize) => searchVideos(query, poolSize, { sort, type, duration }),
      req.query.page, req.query.limit
    );
    log.success(`✅ Search done: "${query}" page ${page} (${results.length} نتيجة)`);
    res.json({ query, page, limit, count: results.length, hasMore, sort, type, duration, results });
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
 * GET /comments?v=VIDEO_ID&limit=50
 * تعليقات حقيقية من يوتيوب (Top comments)
 */
app.get('/comments', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!videoId || !isValidVideoId(videoId)) {
    return res.status(400).json({
      error: 'Video ID مطلوب وصحيح (11 حرف)',
      example: '/comments?v=dQw4w9WgXcQ&limit=50'
    });
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const key = `comments_v2:${videoId}`;
  const cached = infoCache.get(key);
  // لو عندنا كاش بعدد أكبر أو مساوي نرد منه فورًا
  if (cached && cached.fetchedLimit >= limit) {
    const list = cached.comments.slice(0, limit);
    return res.json({ id: videoId, count: list.length, comments: list });
  }
  try {
    const comments = await dedupe(`comments:${videoId}:${limit}`, () => getVideoComments(videoId, limit));
    const out = { id: videoId, count: comments.length, comments };
    infoCache.set(key, { fetchedLimit: limit, comments }, comments.length ? 30 * 60 * 1000 : 2 * 60 * 1000);
    log.success(`✅ Comments done: ${videoId} (${comments.length})`);
    res.json(out);
  } catch (error) {
    log.error(`Error fetching comments: ${error.message}`);
    res.status(500).json({
      error: 'تعذّر جلب التعليقات',
      details: NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * GET /captions?v=VIDEO_ID
 * قائمة اللغات للترجمة (يدوي + تلقائي) + روابط عبر السيرفر
 */
app.get('/captions', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  const key = `captions_v3:${videoId}`;
  const cached = infoCache.get(key);
  if (cached) return res.json(cached);
  try {
    const info = await ensureSubtitles(videoId, await getVideoInfo(videoId));
    const manual = info.subtitles || {};
    const auto = info.automatic_captions || {};
    const languages = [];
    const seen = new Set();

    const pushLang = (lang, list, autoGenerated) => {
      if (!list?.length || seen.has(lang) || lang === 'live_chat') return;   // live_chat مش ترجمة (شات البث)
      seen.add(lang);
      const preferred =
        list.find(s => s.ext === 'vtt') ||
        list.find(s => s.ext === 'srv3') ||
        list.find(s => s.ext === 'json3') ||
        list[0];
      languages.push({
        lang,
        name: list[0]?.name || lang,
        autoGenerated,
        preferredExt: preferred?.ext || null,
        // روابط عبر سيرفرنا (CORS-friendly)
        trackUrl: `/captions/file?v=${videoId}&lang=${encodeURIComponent(lang)}&ext=vtt`,
        transcriptUrl: `/transcript?v=${videoId}&lang=${encodeURIComponent(lang)}`,
        formats: list.map(s => ({
          ext: s.ext,
          proxyUrl: `/captions/file?v=${videoId}&lang=${encodeURIComponent(lang)}&ext=${encodeURIComponent(s.ext || 'vtt')}`,
          sourceUrl: s.url || null
        }))
      });
    };

    for (const [lang, list] of Object.entries(manual)) pushLang(lang, list, false);
    for (const [lang, list] of Object.entries(auto)) pushLang(lang, list, true);

    languages.sort((a, b) => Number(a.autoGenerated) - Number(b.autoGenerated) || String(a.lang).localeCompare(String(b.lang)));

    const out = {
      id: videoId,
      title: info.title || null,
      count: languages.length,
      manualCount: languages.filter(l => !l.autoGenerated).length,
      autoCount: languages.filter(l => l.autoGenerated).length,
      languages
    };
    infoCache.set(key, out, languages.length ? CACHE_TTL.info : 60 * 1000);
    res.json(out);
  } catch (e) {
    reportRouteError(req, res, 'captions', e);
    res.status(502).json({ error: 'تعذّر جلب الكابشنز', details: NODE_ENV === 'development' ? e.message : undefined });
  }
});

// ==========================================================================
// 💬 الترجمة — جلب موثوق: مباشر من يوتيوب (مع redirects/gzip/تحقق من الرد)، ولو رجّع
// فاضي أو اتحجب (ده بيحصل لما الرابط يحتاج PO Token) → yt-dlp نفسه يحمّل الترجمة.
// ==========================================================================
const SUB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpGetText(url, opts = {}) {
  const { timeout = 20000, headers = {}, redirects = 0 } = opts;
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    let u;
    try { u = new URL(url); } catch { return reject(new Error('bad url')); }
    const mod = u.protocol === 'http:' ? require('http') : https;
    const req = mod.get(u, {
      agent: u.protocol === 'https:' ? keepAliveAgent : undefined,
      timeout,
      headers: { 'User-Agent': SUB_UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate', ...headers }
    }, (r) => {
      const code = r.statusCode || 0;
      if (code >= 300 && code < 400 && r.headers.location) {
        r.resume();
        return resolve(httpGetText(new URL(r.headers.location, u).toString(), { ...opts, redirects: redirects + 1 }));
      }
      const enc = String(r.headers['content-encoding'] || '').toLowerCase();
      let stream = r;
      if (enc === 'gzip') stream = r.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = r.pipe(zlib.createInflate());
      const chunks = [];
      let size = 0;
      stream.on('data', c => {
        size += c.length;
        if (size > 8 * 1024 * 1024) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status: code, body: Buffer.concat(chunks).toString('utf8'), type: r.headers['content-type'] || '' }));
      stream.on('error', reject);
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function findSubtitleList(info, lang) {
  const want = String(lang || '').toLowerCase();
  const base = want.split('-')[0];
  const pools = [info.subtitles || {}, info.automatic_captions || {}];
  for (let i = 0; i < pools.length; i++) {
    const entries = Object.entries(pools[i]).filter(([, v]) => Array.isArray(v) && v.length);
    const hit = entries.find(([k]) => k.toLowerCase() === want) || entries.find(([k]) => k.toLowerCase() === base);
    if (hit) return { lang: hit[0], list: hit[1], auto: i === 1 };
  }
  return null;
}

async function fetchSubsViaYtDlp(videoId, lang) {
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(lang)) throw new Error('bad lang');
  const dir = `/tmp/subs-${videoId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  fs.mkdirSync(dir, { recursive: true });
  try {
    let subErr = null;
    for (const pc of [null, 'tv,web,mweb']) {
      try {
        await runYtDlp([
          '--skip-download', '--no-playlist', '--ignore-no-formats-error',
          '--write-subs', '--write-auto-subs',
          '--sub-langs', lang,
          '--sub-format', 'vtt/srv3/json3/best',
          '-o', `${dir}/%(id)s.%(ext)s`,
          `https://www.youtube.com/watch?v=${videoId}`
        ], { raw: true, useCookies: true, playerClient: pc, timeout: 45000 });
        subErr = null;
        break;
      } catch (e) { subErr = e; }
    }
    const files = fs.readdirSync(dir).filter(f => /\.(vtt|srt|srv3|json3|ttml|srv1|srv2)$/i.test(f));
    const pick = files.find(f => f.toLowerCase().endsWith('.vtt')) || files[0];
    if (!pick) throw subErr || new Error('yt-dlp لم يُنتج ملف ترجمة');
    return { body: fs.readFileSync(`${dir}/${pick}`, 'utf8'), ext: pick.split('.').pop().toLowerCase() };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function getSubtitleBody(videoId, info, lang, wantExt) {
  const ckey = `${videoId}:${String(lang).toLowerCase()}:${wantExt}`;
  const hit = subtitleCache.get(ckey);
  if (hit) return hit;
  return dedupe(`sub:${ckey}`, async () => {
    const again = subtitleCache.get(ckey);
    if (again) return again;
    const found = findSubtitleList(info, lang);
    if (!found) { const e = new Error('NO_SUBS'); e.code = 'NO_SUBS'; throw e; }
    const list = found.list;
    const pick =
      list.find(x => String(x.ext).toLowerCase() === wantExt) ||
      list.find(x => x.ext === 'vtt') ||
      list.find(x => x.ext === 'srv3') ||
      list.find(x => x.ext === 'json3') ||
      list[0];
    let out = null;
    if (pick && pick.url) {
      try {
        const r = await httpGetText(pick.url, { timeout: 15000, headers: { Referer: 'https://www.youtube.com/' } });
        const ok = r.status === 200 && r.body && r.body.trim().length > 10 && !/^\s*<(!doctype|html)/i.test(r.body);
        if (ok) out = { body: r.body, ext: String(pick.ext || wantExt).toLowerCase(), via: 'direct' };
        else log.warn(`subs direct empty/blocked (${r.status}) ${videoId}/${found.lang} — fallback to yt-dlp`);
      } catch (e) {
        log.warn(`subs direct failed ${videoId}/${found.lang}: ${e.message}`);
      }
    }
    if (!out) out = { ...(await fetchSubsViaYtDlp(videoId, found.lang)), via: 'yt-dlp' };
    subtitleCache.set(ckey, out, 60 * 60 * 1000);
    return out;
  });
}

function msToVttTs(ms) {
  const t = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(t / 3600000))}:${p(Math.floor((t % 3600000) / 60000))}:${p(Math.floor((t % 60000) / 1000))}.${p(t % 1000, 3)}`;
}
function decodeXmlText(t) {
  return String(t).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
// json3 / srv3 → WebVTT (عشان <track> في المتصفح ياخد vtt دايمًا)
function subtitleToVtt(body, ext) {
  try {
    const cues = [];
    if (ext === 'json3') {
      const j = JSON.parse(body);
      for (const ev of (j.events || [])) {
        if (!ev.segs) continue;
        const text = ev.segs.map(sg => sg.utf8 || '').join('').replace(/\n+/g, '\n').trim();
        if (!text) continue;
        const st = ev.tStartMs || 0;
        cues.push([st, st + (ev.dDurationMs || 2000), text]);
      }
    } else if (ext === 'srv3') {
      const re = /<p\b[^>]*\bt="(\d+)"[^>]*\bd="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
      let m;
      while ((m = re.exec(body))) {
        const text = decodeXmlText(m[3].replace(/<[^>]+>/g, '')).trim();
        if (text) cues.push([Number(m[1]), Number(m[1]) + Number(m[2]), text]);
      }
    } else {
      return null;
    }
    if (!cues.length) return null;
    return 'WEBVTT\n\n' + cues.map(([a, b, t]) => `${msToVttTs(a)} --> ${msToVttTs(b)}\n${t}`).join('\n\n') + '\n';
  } catch { return null; }
}
// الترجمة التلقائية (ASR) في يوتيوب "متدحرجة": كل cue بيكرر سطر الـ cue اللي قبله ويضيف الجديد جنبه، وفيه cues مدتها 10ms للانتقال.
// الدالة دي بتشيل السطور المكررة فكل cue يبدأ بالكلام الجديد بس، وبتشيل tags التوقيت الداخلية وإعدادات المكان. بتتطبق بس لو الملف فعلًا متدحرج.
function cleanRollingVtt(body) {
  try {
    const tsRe = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/;
    const toS = (h, m, sec, ms) => Number(h || 0) * 3600 + Number(m) * 60 + Number(sec) + Number(ms) / 1000;
    const cues = [];
    for (const block of String(body).split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/);
      const i = lines.findIndex(l => tsRe.test(l));
      if (i < 0) continue;
      const m = lines[i].match(tsRe);
      const text = lines.slice(i + 1).map(l => l.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      cues.push({ a: toS(m[1], m[2], m[3], m[4]), b: toS(m[5], m[6], m[7], m[8]), lines: text });
    }
    if (cues.length < 4) return body;
    let rolling = 0;
    for (let k = 1; k < cues.length; k++) {
      const p = cues[k - 1].lines, c = cues[k].lines;
      if (c.length && p.length && (c[0] === p[p.length - 1] || (c.length === p.length && c.every((x, j) => x === p[j])))) rolling++;
    }
    if (rolling / cues.length < 0.15) return body;   // ترجمة عادية (مش متدحرجة) → منلمسهاش
    const out = [];
    let prev = [];
    for (const c of cues) {
      let fresh = c.lines;
      // شيل السطور اللي كانت في آخر cue (بالترتيب من الأول)
      while (fresh.length && prev.includes(fresh[0])) fresh = fresh.slice(1);
      fresh = fresh.filter(l => !prev.includes(l));
      prev = c.lines.length ? c.lines : prev;
      if (!fresh.length) continue;
      out.push({ a: c.a, b: c.b, text: fresh.join('\n') });
    }
    for (let k = 0; k < out.length - 1; k++) if (out[k].b > out[k + 1].a) out[k].b = Math.max(out[k].a + 0.2, out[k + 1].a);   // من غير تداخل في الوقت
    const fmt = (t) => msToVttTs(t * 1000);
    return 'WEBVTT\n\n' + out.map(o => `${fmt(o.a)} --> ${fmt(o.b)}\n${o.text}`).join('\n\n') + '\n';
  } catch { return body; }
}
function parseVttSegments(body) {
  const out = [];
  let start = null, last = '';
  const tsRe = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->/;
  for (const line of String(body).split(/\r?\n/)) {
    const t = line.trim();
    const m = t.match(tsRe);
    if (m) { start = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000; continue; }
    if (!t || t.startsWith('WEBVTT') || t.startsWith('NOTE') || t.startsWith('Kind:') || t.startsWith('Language:') || /^\d+$/.test(t)) continue;
    const text = t.replace(/<[^>]+>/g, '').trim();
    if (!text || text === last) continue;   // الترجمة التلقائية بتكرر نفس السطر
    last = text;
    out.push({ start, text });
  }
  return out;
}

/**
 * GET /captions/file?v=ID&lang=ar&ext=vtt
 * يمرّر ملف الترجمة (VTT/SRT/JSON3) من يوتيوب عبر السيرفر
 */
app.get('/captions/file', async (req, res) => {
  const videoId = String(req.query.v || '');
  const lang = String(req.query.lang || 'ar');
  const wantExt = String(req.query.ext || 'vtt').toLowerCase();
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  try {
    const info = await ensureSubtitles(videoId, await getVideoInfo(videoId));
    const sub = await getSubtitleBody(videoId, info, lang, wantExt);
    let body = sub.body;
    let ext = sub.ext;
    if (wantExt === 'vtt' && ext !== 'vtt') {
      const conv = subtitleToVtt(body, ext);
      if (conv) { body = conv; ext = 'vtt'; }
    }
    if (ext === 'vtt') body = cleanRollingVtt(body);
    const type =
      ext === 'vtt' ? 'text/vtt; charset=utf-8' :
      ext === 'srt' ? 'application/x-subrip; charset=utf-8' :
      ext === 'json3' ? 'application/json; charset=utf-8' :
      'text/plain; charset=utf-8';
    res.status(200);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Subtitle-Source', sub.via || 'direct');
    return res.end(body);
  } catch (e) {
    if (e && e.code === 'NO_SUBS') return res.status(404).json({ error: 'لا توجد ترجمة لهذه اللغة' });
    reportRouteError(req, res, 'captions', e, { lang });
    res.status(502).json({ error: 'تعذّر تحميل ملف الترجمة', details: NODE_ENV === 'development' ? e.message : undefined });
  }
});

/**
 * GET /audio-tracks?v=VIDEO_ID
 * كل المقاطع/المسارات الصوتية المتاحة (لغات + صيغ + روابط تشغيل عبر السيرفر)
 */
app.get('/audio-tracks', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  const key = `audio_tracks:${videoId}`;
  const cached = infoCache.get(key);
  if (cached) return res.json(cached);
  try {
    const info = await getVideoInfo(videoId);
    await waitSettled(info, 12000);   // الدبلجات بتيجي من الخطة التانية (قبل كده 4ث كانت بتطلّع قايمة ناقصة)
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const audioOnly = formats.filter(f =>
      f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && !isManifestFormat(f)
    );

    const tracks = audioOnly.map(f => {
      const lang = f.language || f.lang || null;
      const note = String(f.format_note || f.format || '');
      const isOriginal = /\boriginal\b/i.test(note) || f.language_preference === 10;
      return {
        formatId: String(f.format_id),
        language: lang,
        languagePreference: f.language_preference ?? null,
        isOriginal: Boolean(isOriginal),
        codec: f.acodec || null,
        ext: f.ext || null,
        bitrate: f.abr || f.tbr || null,
        sampleRate: f.asr || null,
        channels: f.audio_channels || null,
        note: note || null,
        label: [lang || 'und', isOriginal ? '(الأصلي)' : '', (f.abr || f.tbr) ? `${Math.round(f.abr || f.tbr)}kbps` : '', f.ext || ''].filter(Boolean).join(' · '),
        filesize: f.filesize || f.filesize_approx || null,
        // تشغيل الصوت فقط عبر السيرفر
        playUrl: `/video?v=${videoId}&quality=audio&audioFormat=${encodeURIComponent(String(f.format_id))}`,
        sourceHasUrl: Boolean(f.url)
      };
    }).sort((a, b) => {
      if (a.isOriginal !== b.isOriginal) return a.isOriginal ? -1 : 1;
      const lp = Number(b.languagePreference ?? -1) - Number(a.languagePreference ?? -1);
      if (lp) return lp;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    // تجميع حسب اللغة
    const byLanguage = {};
    for (const t of tracks) {
      const k = t.language || 'und';
      if (!byLanguage[k]) byLanguage[k] = [];
      byLanguage[k].push(t);
    }

    const out = {
      id: videoId,
      title: info.title || null,
      count: tracks.length,
      languages: Object.keys(byLanguage),
      tracks,
      byLanguage,
      // اختصار سريع: أفضل مسار لكل لغة
      bestByLanguage: Object.fromEntries(
        Object.entries(byLanguage).map(([lang, list]) => [lang, list[0]])
      ),
      defaultPlay: `/video?v=${videoId}&quality=audio`
    };
    infoCache.set(key, out, info.__pending ? 20 * 1000 : CACHE_TTL.info);
    res.json(out);
  } catch (e) {
    reportRouteError(req, res, 'audio', e);
    res.status(502).json({ error: 'تعذّر جلب المقاطع الصوتية', details: NODE_ENV === 'development' ? e.message : undefined });
  }
});

/**
 * GET /chapters?v=VIDEO_ID
 */
app.get('/chapters', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  try {
    const info = await getVideoInfo(videoId);
    const chapters = (info.chapters || []).map((c, i) => ({
      index: i,
      title: c.title || `فصل ${i + 1}`,
      start: c.start_time || 0,
      end: c.end_time ?? null
    }));
    res.json({ id: videoId, count: chapters.length, chapters });
  } catch (e) {
    res.status(502).json({ error: 'تعذّر جلب الفصول' });
  }
});

/**
 * GET /transcript?v=VIDEO_ID&lang=ar
 * يحاول يجيب نص الترجمة (VTT/SRT/JSON3) كـ نص مقروء
 */
app.get('/transcript', async (req, res) => {
  const videoId = String(req.query.v || '');
  const lang = String(req.query.lang || 'ar').toLowerCase();
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  const key = `transcript_v3:${videoId}:${lang}`;
  const cached = infoCache.get(key);
  if (cached) return res.json(cached);
  try {
    const info = await ensureSubtitles(videoId, await getVideoInfo(videoId));
    let found = findSubtitleList(info, lang);
    if (!found) {
      // أي لغة متاحة (اليدوي أولًا)
      for (const pool of [info.subtitles || {}, info.automatic_captions || {}]) {
        const first = Object.entries(pool).find(([, v]) => Array.isArray(v) && v.length);
        if (first) { found = { lang: first[0], list: first[1] }; break; }
      }
    }
    if (!found) return res.status(404).json({ error: 'لا توجد ترجمة لهذا الفيديو' });

    const sub = await getSubtitleBody(videoId, info, found.lang, 'json3');
    let segments = [];
    if (sub.ext === 'json3') {
      try {
        const j = JSON.parse(sub.body);
        for (const ev of (j.events || [])) {
          if (!ev.segs) continue;
          const text = ev.segs.map(sg => sg.utf8 || '').join('').trim();
          if (!text) continue;
          segments.push({ start: (ev.tStartMs || 0) / 1000, text });
        }
      } catch {}
    } else {
      const vtt = sub.ext === 'vtt' ? sub.body : (subtitleToVtt(sub.body, sub.ext) || sub.body);
      segments = parseVttSegments(vtt);
    }

    const out = {
      id: videoId,
      lang: found.lang,
      requestedLang: lang,
      format: sub.ext,
      count: segments.length,
      text: segments.map(sg => sg.text).join('\n'),
      segments: segments.slice(0, 2000)
    };
    infoCache.set(key, out, CACHE_TTL.info);
    res.json(out);
  } catch (e) {
    log.warn(`transcript failed ${videoId}/${lang}: ${String(e.message || e).split('\n')[0]}`);
    res.status(502).json({ error: 'تعذّر جلب النص', details: NODE_ENV === 'development' ? e.message : undefined });
  }
});

/**
 * GET /thumb?v=VIDEO_ID&q=hq|mq|max|sd
 * بروكسي صورة مصغّرة (مفيد لو الفرونت على دومين مختلف)
 */
app.get('/thumb', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  const q = String(req.query.q || 'hq').toLowerCase();
  const map = { default: 'default', mq: 'mqdefault', hq: 'hqdefault', sd: 'sddefault', max: 'maxresdefault' };
  const name = map[q] || 'hqdefault';
  const url = `https://i.ytimg.com/vi/${videoId}/${name}.jpg`;
  return streamFromUpstream(req, res, url, 0, 0);
});

/**
 * GET /embed?v=VIDEO_ID
 * صفحة مشغّل بسيطة للاختبار (الفيديو من السيرفر proxy)
 */
app.get('/embed', (req, res) => {
  const videoId = String(req.query.v || '');
  if (!isValidVideoId(videoId)) {
    return res.status(400).send('Video ID غير صحيح');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>مشغّل — ${videoId}</title>
<style>
html,body{margin:0;height:100%;background:#000;color:#fff;font-family:system-ui}
.wrap{display:flex;flex-direction:column;height:100%}
video{width:100%;height:100%;max-height:100vh;background:#000}
.bar{padding:8px 12px;background:#111;font-size:13px;display:flex;gap:10px;flex-wrap:wrap}
a{color:#60a5fa}
</style></head><body><div class="wrap">
<video controls autoplay playsinline src="/video/quick?v=${encodeURIComponent(videoId)}"></video>
<div class="bar">
<span>id: ${videoId}</span>
<a href="/info?v=${encodeURIComponent(videoId)}" target="_blank">info</a>
<a href="/video/qualities?v=${encodeURIComponent(videoId)}" target="_blank">qualities</a>
<a href="/comments?v=${encodeURIComponent(videoId)}" target="_blank">comments</a>
<a href="/related?v=${encodeURIComponent(videoId)}" target="_blank">related</a>
</div></div></body></html>`);
});

/**
 * GET /channel?id=CHANNEL_ID&limit=20&page=1
 */
app.get('/channel', async (req, res) => {
  const channelId = req.query.id;

  if (!channelId) {
    return res.status(400).json({
      error: 'channel id مطلوب',
      example: '/channel?id=UCxxxxxxxx&limit=20&page=1&tab=videos|streams|playlists'
    });
  }

  try {
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 30);
    const tab = String(req.query.tab || 'videos').toLowerCase();
    const needed = pageNum * pageSize;
    const poolSize = Math.min(Math.max(needed, pageSize * 2), 100);

    // تبويب البث المباشر / القوائم
    if (tab === 'streams' || tab === 'live' || tab === 'playlists') {
      const dataCacheKey = `channel_tab_${channelId}_${tab}_${poolSize}`;
      let data = channelCache.get(dataCacheKey);
      if (!data) {
        data = await getChannelTab(channelId, tab === 'live' ? 'streams' : tab, poolSize);
        channelCache.set(dataCacheKey, data, tab === 'streams' || tab === 'live' ? 60 * 1000 : CACHE_TTL.channel);
      }
      const start = (pageNum - 1) * pageSize;
      const items = (data.entries || []).slice(start, start + pageSize);
      return res.json({
        channel: data.channel,
        tab: tab === 'live' ? 'streams' : tab,
        page: pageNum,
        limit: pageSize,
        count: items.length,
        hasMore: (data.entries || []).length > start + pageSize,
        videos: items,
        streams: tab === 'streams' || tab === 'live' ? items : undefined
      });
    }

    const sortRaw = String(req.query.sort || 'latest').toLowerCase();
    const sort = ['popular', 'oldest'].includes(sortRaw) ? sortRaw : 'latest';
    // حجم موحّد (30 على الأقل) عشان limit=1 و limit=20 يشاركوا نفس الكاش، + dedupe للطلبات المتزامنة لنفس القناة
    // (التقرير: /channel?limit=1 اتطلب لعشرات القنوات مع بعض وكل واحد شغّل yt-dlp لحد 53ث)
    const ps = Math.max(poolSize, 30);
    const dataCacheKey = sort === 'latest' ? `channel_${channelId}_${ps}` : `channel_${channelId}_${sort}_${ps}`;
    let data = channelCache.get(dataCacheKey);
    if (!data) {
      data = await dedupe(`chan:${dataCacheKey}`, async () => {
        const again = channelCache.get(dataCacheKey); if (again) return again;
        const d = sort === 'latest' ? await getChannelVideos(channelId, ps) : await getChannelSorted(channelId, sort, ps);
        channelCache.set(dataCacheKey, d, CACHE_TTL.channel);
        return d;
      });
    }

    const start = (pageNum - 1) * pageSize;
    const videos = data.videos.slice(start, start + pageSize);
    const hasMore = data.videos.length > start + pageSize;

    log.success(`✅ Channel done: ${channelId} page ${pageNum} (${videos.length} نتيجة)`);
    res.json({ channel: data.channel, tab: 'videos', sort, approximate: data.approximate || undefined, page: pageNum, limit: pageSize, count: videos.length, hasMore, videos });
  } catch (error) {
    if (/does not have a videos tab/i.test(String(error.message))) {
      // قناة من غير تبويب فيديوهات (مثلاً قناة موسيقى/موضوع) → مش خطأ سيرفر
      return res.json({ channel: { id: channelId, title: 'قناة', followers: null, avatar: null, description: '' }, tab: 'videos', page: 1, limit: 0, count: 0, hasMore: false, videos: [] });
    }
    log.error(`Error fetching channel: ${cleanErr(error, 200).split('\n')[0]}`, { cat: 'feed', route: req.originalUrl, detail: cleanErr(error) });
    res.locals.__reported = true;
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
 * GET /channel/streams?id=CHANNEL_ID&limit=30&page=1&status=all|live|upcoming|past
 * بثوث القناة: مباشر الآن / قادم / سابق
 */
app.get('/channel/streams', async (req, res) => {
  const channelId = String(req.query.id || '');
  if (!channelId) {
    return res.status(400).json({
      error: 'channel id مطلوب',
      example: '/channel/streams?id=UCxxxxx&status=live'
    });
  }
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 50);
  const status = String(req.query.status || 'all').toLowerCase();
  const key = `channel-streams:${channelId}:${page}:${limit}:${status}`;
  const cached = channelCache.get(key);
  if (cached) return res.json(cached);
  try {
    const data = await getChannelTab(channelId, 'streams', Math.min(Math.max(page * limit, 40), 100));
    let list = data.entries || [];
    if (status === 'live') {
      list = list.filter(v => v.isLive || v.liveStatus === 'is_live');
    } else if (status === 'upcoming') {
      list = list.filter(v => v.liveStatus === 'is_upcoming');
    } else if (status === 'past') {
      list = list.filter(v => v.wasLive || v.liveStatus === 'was_live' || (!v.isLive && v.liveStatus !== 'is_upcoming'));
    }
    const rank = v => (v.isLive || v.liveStatus === 'is_live') ? 0 : (v.liveStatus === 'is_upcoming' ? 1 : 2);
    list = list.map((v, i) => [v, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
    const start = (page - 1) * limit;
    const results = list.slice(start, start + limit);
    const out = {
      channel: data.channel,
      page,
      limit,
      status,
      count: results.length,
      liveNow: list.filter(v => v.isLive || v.liveStatus === 'is_live').length,
      hasMore: list.length > start + limit,
      streams: results
    };
    channelCache.set(key, out, 60 * 1000); // لايفات: كاش دقيقة
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

// تحويل مباشر (302) لرابط جوجل — السيرفر مبيمرّرش أي بايت فيديو.
function redirectToCdn(res, url, { mode = 'direct-cdn', quality = null } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Stream-Mode', mode);
  if (quality) res.setHeader('X-Video-Quality', typeof quality === 'number' ? `${quality}p` : String(quality));
  return res.redirect(302, url);
}

async function getDirectStreamRedirect(req, res, videoId, format = 'best') {
  try {
    const url = format === 'best'
      ? await getFastStreamUrl(videoId)
      : await getVideoStreamUrl(videoId, format);
    return redirectToCdn(res, url, { mode: 'direct-cdn' });
  } catch (e) {
    log.warn(`Direct CDN redirect failed: ${String(e.message || e).split('\n')[0]}`);
    if (!res.headersSent) return res.status(502).json({ error: 'تعذر الحصول على مصدر الفيديو' });
  }
}

async function getFastStreamUrl(videoId) {
  const key = `fast:${videoId}`;
  const cached = fastStreamCache.get(key);
  if (cached) return typeof cached === 'string' ? cached : cached.url;

  return dedupe(key, async () => {
    const again = fastStreamCache.get(key);
    if (again) return typeof again === 'string' ? again : again.url;

    // كل رابط بنجرّبه الأول بطلب صغير: لو 403 (PO Token / headers / IP) بنروح للمصدر اللي بعده بدل ما نبعته للمتصفح ويفشل.
    const tried = new Set();
    const accept = async (u) => {
      if (!u || tried.has(u) || isHlsUrl(u)) return null;
      tried.add(u);
      if (!(await verifyUrl(u))) return null;
      fastStreamCache.set(key, u, CACHE_TTL.fastStream);
      return u;
    };

    // لو الميتاداتا الكاملة جاهزة في الكاش → روابط progressive منها فورًا من غير عملية yt-dlp تانية.
    let info = infoCache.get(`raw_info_v4_${videoId}`), infoFailed = false;
    if (!info) {
      // الميتاداتا الأول (عمليتين بالتوازي وبتتكاش وبتفيد الجودات/الترجمة بعدين)
      try { info = await getVideoInfo(videoId); } catch (e) { infoFailed = true; }
    }
    if (info) {
      for (const u of progressiveCandidates(info)) { const ok = await accept(u); if (ok) return ok; }
      if (isLiveInfo(info)) throw new Error('Live stream: no progressive URL');
    }

    // مفيش progressive شغال في الميتاداتا: بنسأل yt-dlp من جديد ونجرّب client/كوكيز مختلف لحد ما نلاقي رابط يوتيوب بيقبله
    try {
      const urls = await getVerifiedUrls(videoId, infoFailed ? '18' : '18/22/best[height<=360][ext=mp4][protocol^=http]', { minCount: 1 });
      const ok = await accept(urls[0]);
      if (ok) return ok;
    } catch (e) { var lastErr = e; }
    throw lastErr || new Error('No playable progressive stream');
  });
}

/**
 * رابط بث لجودة محددة — progressive أولًا (صوت+صورة)،
 * ولو مفيش: نختار format_id من الميتاداتا لنفس الارتفاع.
 */
async function getQualityStreamUrl(videoId, height) {
  const h = clampQualityHeight(height);
  const key = `qurl:${videoId}:${h}`;
  const cached = streamCache.get(key);
  if (cached) return cached;

  return dedupe(key, async () => {
    const again = streamCache.get(key);
    if (again) return again;

    let infoLoaded = false;
    try {
      const info = await getVideoInfo(videoId);
      infoLoaded = true;
      const prog = chooseProgressiveFormat(info, h);
      if (prog?.formatId && Math.abs(Number(prog.actualHeight) - h) <= 8) {
        const urls = prog.url ? [prog.url] : await getFormatUrls(videoId, prog.formatId, { strict: true });
        if (urls[0] && !isHlsUrl(urls[0]) && await verifyUrl(urls[0])) {
          const out = {
            url: urls[0],
            actualHeight: prog.actualHeight,
            requestedHeight: h,
            mode: 'progressive',
            formatId: prog.formatId
          };
          streamCache.set(key, out, CACHE_TTL.stream);
          return out;
        }
      }
    } catch (e) {
      log.warn(`quality meta ${h}p: ${String(e.message || e).split('\n')[0]}`);
    }

    // الميتاداتا هي المرجع: لو اتحمّلت ومفيش progressive بالارتفاع ده، نروح لدمج ffmpeg فورًا.
    // (قبل كده كان بيشغّل yt-dlp بـ selector بديل فيرجّع 360p ويسمّيه بالجودة المطلوبة = جودة وهمية)
    if (infoLoaded) throw new Error(`No progressive stream for ${h}p`);

    const selector =
      `best[height=${h}][ext=mp4][acodec!=none][vcodec!=none][protocol^=http]/` +
      `best[height=${h}][acodec!=none][vcodec!=none][protocol^=http]`;
    try {
      const urls = await getFormatUrls(videoId, selector, { strict: true });
      if (urls[0] && !isHlsUrl(urls[0]) && await verifyUrl(urls[0])) {
        const out = { url: urls[0], actualHeight: h, requestedHeight: h, mode: 'progressive-exact' };
        streamCache.set(key, out, CACHE_TTL.stream);
        return out;
      }
    } catch (e) {
      log.warn(`exact progressive ${h}p: ${String(e.message || e).split('\n')[0]}`);
    }

    throw new Error(`No exact progressive stream for ${h}p`);
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

// ==========================================================================
// 🔗 Upstream headers + التحقق من الروابط قبل ما نبعتها للمتصفح (v13.6)
// yt-dlp بيرجّع مع كل format الـ http_headers اللازمة (User-Agent بتاع الـ client اللي طلّع الرابط).
// السيرفر القديم كان بيبعت دايمًا User-Agent بتاع Chrome + كوكيز الحساب → روابط كتير بترجع 403.
// دلوقتي: بنستخدم نفس الـ headers، وبنجرّب الرابط بطلب صغير (Range 0-1) الأول — ولو 403 بنجرّب مصدر تاني.
// ==========================================================================
const UP_DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
function rememberFormatHeaders(url, h) {
  if (!url || !h || typeof h !== 'object') return;
  const cur = urlMeta.peek(url);
  if (cur && cur.fmt) return;
  urlMeta.set(url, { ...(cur || {}), fmt: h }, 6 * 3600 * 1000);
}
function buildUpstreamHeaders(url, { withCookies } = {}) {
  const meta = urlMeta.peek(url) || {};
  const h = { 'user-agent': UP_DEFAULT_UA, accept: '*/*', 'accept-encoding': 'identity', connection: 'keep-alive' };
  if (meta.fmt) {
    for (const [k, v] of Object.entries(meta.fmt)) {
      const lk = String(k).toLowerCase();
      if (typeof v === 'string' && !['host', 'range', 'content-length', 'accept-encoding', 'connection', 'cookie'].includes(lk)) h[lk] = v;
    }
  }
  const browserLike = /^Mozilla\//.test(h['user-agent']);
  if (!meta.fmt || browserLike) { h.referer = 'https://www.youtube.com/'; h.origin = 'https://www.youtube.com'; }
  let host = ''; try { host = new URL(url).hostname; } catch {}
  const useCookies = withCookies !== undefined ? withCookies : (meta.cookies !== undefined ? meta.cookies : true);
  if (useCookies && /googlevideo\.com$/i.test(host)) { const ck = buildYoutubeCookieHeader(); if (ck) h.cookie = ck; }
  return h;
}
function probeOnce(url, headers, hop = 0) {
  return new Promise((resolve, reject) => {
    let target; try { target = new URL(url); } catch (e) { return reject(e); }
    const req = https.get(target, { headers: { ...headers, range: 'bytes=0-1' }, timeout: 7000, agent: keepAliveAgent }, (r) => {
      const code = Number(r.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(code) && r.headers.location && hop < 4) {
        r.resume();
        return resolve(probeOnce(new URL(r.headers.location, target).toString(), headers, hop + 1));
      }
      if (code === 206) r.resume(); else r.destroy();
      resolve({ status: code });
    });
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', reject);
  });
}
// بيرجّع true لو الرابط شغال فعلًا (200/206). لو رد 401/403/404/410 بنجرّب بكوكيز كمان، ولو لسه بايظ → false.
// أخطاء الشبكة المؤقتة مش بتمنع التشغيل (بنفترض إنه شغال).
async function verifyUrl(url) {
  if (!url) return false;
  const meta = urlMeta.peek(url) || {};
  const now = Date.now();
  if (meta.ok && now - (meta.verifiedAt || 0) < 20 * 60 * 1000) return true;
  if (meta.bad && now - (meta.badAt || 0) < 2 * 60 * 1000) return false;
  const variants = [false];
  if (buildYoutubeCookieHeader()) variants.push(true);
  let definiteBad = false;
  for (const withCookies of variants) {
    try {
      const r = await probeOnce(url, buildUpstreamHeaders(url, { withCookies }));
      if (r.status === 200 || r.status === 206) {
        urlMeta.set(url, { ...(urlMeta.peek(url) || {}), ok: true, bad: false, cookies: withCookies, verifiedAt: Date.now() }, 6 * 3600 * 1000);
        return true;
      }
      if ([400, 401, 403, 404, 410].includes(r.status)) definiteBad = true;
    } catch { /* مؤقت */ }
  }
  if (definiteBad) {
    urlMeta.set(url, { ...(urlMeta.peek(url) || {}), ok: false, bad: true, badAt: Date.now() }, 6 * 3600 * 1000);
    return false;
  }
  return true;
}
const verifyAll = async (arr) => (await Promise.all((arr || []).map(verifyUrl))).every(Boolean);
function forgetVideo(videoId) {
  fastStreamCache.delete(`fast:${videoId}`);
  infoCache.delete(`raw_info_v4_${videoId}`);
  for (const k of [...streamCache.map.keys()]) if (String(k).includes(videoId)) streamCache.delete(k);
}

// ---- تخفيف الميتاداتا في الذاكرة: dump-json كامل بيوصل 1-2MB للفيديو (ترجمات تلقائية بمئات اللغات + fragments) ----
function slimInfo(p) {
  if (!p || typeof p !== 'object') return p;
  for (const k of ['thumbnails', 'heatmap', 'requested_formats', 'requested_downloads', 'requested_subtitles', '_format_sort_fields', 'storyboards', 'comments']) delete p[k];
  if (Array.isArray(p.formats)) for (const f of p.formats) { if (f) { delete f.fragments; delete f.downloader_options; delete f.fragment_base_url; delete f.manifest_stream_number; } }
  if (p.automatic_captions && typeof p.automatic_captions === 'object') {
    for (const [lang, list] of Object.entries(p.automatic_captions)) {
      if (!Array.isArray(list)) continue;
      const keep = list.filter(s => s && ['vtt', 'srv3', 'json3'].includes(s.ext));
      p.automatic_captions[lang] = (keep.length ? keep : list.slice(0, 1)).map(s => ({ ext: s.ext, url: s.url, name: s.name }));
    }
  }
  return p;
}
function progressiveCandidates(info) {
  if (!info) return [];
  const prog = (info.formats || []).filter(f => f && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' &&
    /^https?$/.test(String(f.protocol || 'https')) && typeof f.url === 'string' && !isHlsUrl(f.url));
  const score = f => String(f.format_id) === '18' ? -1 : Math.abs((Number(f.height) || 360) - 360) + (Number(f.height) > 720 ? 1000 : 0);
  return prog.sort((a, b) => score(a) - score(b)).slice(0, 4).map(f => usableDirectUrl(f)).filter(Boolean);
}
function extractUrlsFromDump(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  const j = JSON.parse(lines[lines.length - 1]);
  const fmts = Array.isArray(j.requested_formats) && j.requested_formats.length ? j.requested_formats : [j];
  return fmts.map(f => { const u = f && typeof f.url === 'string' ? f.url : ''; if (u) rememberFormatHeaders(u, f.http_headers || j.http_headers); return u; }).filter(Boolean);
}

function streamFromUpstream(req, res, url, redirectCount = 0, duration = null, opts = {}) {
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

  // الـ headers بتتحدد من الرابط الأصلي (حتى بعد الـ redirects): User-Agent الصح + كوكيز بس لو التحقق احتاجها
  const metaUrl = opts.metaUrl || target;
  const headers = buildUpstreamHeaders(metaUrl);
  let host = ''; try { host = new URL(target).hostname; } catch {}
  if (!/googlevideo\.com$/i.test(host)) delete headers.cookie;

  // Critical for seeking and for browsers that request the video in chunks.
  if (req.headers.range) headers.range = req.headers.range;
  if (req.headers['if-range']) headers['if-range'] = req.headers['if-range'];

  const upstreamReq = https.get(target, {
    headers,
    timeout: 45000,
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
      return streamFromUpstream(req, res, nextUrl, redirectCount + 1, duration, { ...opts, metaUrl });
    }

    if ([401, 403, 410].includes(code)) {
      upstreamRes.resume();
      const failForbidden = () => {
        if (!res.headersSent) res.status(502).json({
          error: 'مصدر الفيديو انتهت صلاحيته، أعد طلب التشغيل لإحضار رابط جديد',
          upstreamStatus: code
        });
      };
      // رابط اتحرق/انتهى قبل ما أي بايت يتبعت → نجيب رابط جديد ونكمّل في نفس الطلب (مرة واحدة)
      if (opts.onForbidden && !res.headersSent) {
        const retry = opts.onForbidden;
        Promise.resolve().then(() => retry()).then(nu => {
          if (res.headersSent || res.destroyed) return;
          if (nu) return streamFromUpstream(req, res, nu, 0, duration, { ...opts, onForbidden: null, metaUrl: undefined });
          failForbidden();
        }).catch(() => failForbidden());
        return;
      }
      failForbidden();
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
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // يمنع nginx/railway من تجميع البايتات
    if (Number.isFinite(Number(duration)) && Number(duration) > 0) {
      res.setHeader('X-Video-Duration', String(duration));
    }
    copySafeUpstreamHeaders(upstreamRes, res);

    // Send headers immediately, then stream bytes without buffering.
    try { res.flushHeaders(); } catch {}
    try { upstreamRes.socket?.setNoDelay(true); } catch {}
    try { res.socket?.setNoDelay(true); } catch {}
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
// كل الجودات الشائعة — التشغيل الحقيقي يعتمد على اللي متاح progressive أو ffmpeg
const SUPPORTED_QUALITIES = [144, 240, 360, 480, 720, 1080, 1440, 2160];
const QUALITY_ALIASES = {
  '144': 144, '240': 240, '360': 360, '480': 480, '720': 720, '1080': 1080,
  '1440': 1440, '2160': 2160, '4k': 2160, '2k': 1440, 'uhd': 2160,
  'low': 240, 'medium': 360, 'high': 720, 'hd': 720, 'fullhd': 1080
};

function clampQualityHeight(height) {
  const h = Number(height);
  if (!h || Number.isNaN(h)) return 360;
  // قرّب لأقرب جودة مدعومة
  let best = SUPPORTED_QUALITIES[0];
  let bestDiff = Math.abs(h - best);
  for (const q of SUPPORTED_QUALITIES) {
    const d = Math.abs(h - q);
    if (d < bestDiff) { best = q; bestDiff = d; }
  }
  return best;
}

function resolveQuality(quality) {
  if (!quality) return null;
  const q = String(quality).toLowerCase().replace(/p$/, '');
  if (q === 'audio') return { type: 'audio' };
  const raw = QUALITY_ALIASES[q] || parseInt(q, 10);
  if (!raw || Number.isNaN(raw)) return null;
  return { type: 'video', height: clampQualityHeight(raw) };
}

// الارتفاع الحقيقي للجودة: الفيديو الطولي (Shorts) جودته = الضلع القصير
function fmtH(f) {
  const h = Number(f && f.height) || 0;
  const w = Number(f && f.width) || 0;
  return (w && h > w) ? w : h;
}
// أقرب جودة قياسية (1072 → 1080) أو null لو بعيد عن أي جودة معروفة
function nearestStandardHeight(h) {
  if (!h) return null;
  let best = null, diff = Infinity;
  for (const q of SUPPORTED_QUALITIES) {
    const d = Math.abs(h - q);
    if (d < diff) { diff = d; best = q; }
  }
  return diff <= Math.max(16, best * 0.04) ? best : null;
}
function qH(f) { const h = fmtH(f); return nearestStandardHeight(h) || h; }
// formats HLS/DASH مش بتتشغّل كملف مباشر ولا بتتدمج بـ ffmpeg عندنا → مبتدخلش في اختيار الجودات
function isManifestFormat(f) {
  const p = String(f && f.protocol || '');
  return p.includes('m3u8') || p.includes('dash') || isHlsUrl(f && f.url);
}

function getVideoFormats(info) {
  return (info.formats || []).filter(f =>
    f && f.height && f.vcodec && f.vcodec !== 'none' && !isManifestFormat(f)
  );
}

function chooseQualityFormats(info, requestedHeight) {
  const formats = getVideoFormats(info);
  if (!formats.length) throw new Error('No video formats available');

  const exact = formats.filter(f => qH(f) === requestedHeight);
  const below = formats.filter(f => qH(f) < requestedHeight)
    .sort((a, b) => qH(b) - qH(a));
  const above = formats.filter(f => qH(f) > requestedHeight)
    .sort((a, b) => qH(a) - qH(b));

  const same = exact.length ? exact : (below[0] ? formats.filter(f => qH(f) === qH(below[0])) : formats.filter(f => qH(f) === qH(above[0])));
  const actualHeight = qH(same[0]);

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

  // H.264 (avc1) أولًا لأنه بيتشغّل على كل الأجهزة؛ AV1/VP9 ممكن يطلع فيديو أسود أو صوت بس
  const video = same.sort((a, b) => {
    const ah = String(a.vcodec || '').startsWith('avc1') ? 1 : 0;
    const bh = String(b.vcodec || '').startsWith('avc1') ? 1 : 0;
    if (bh !== ah) return bh - ah;
    return (b.tbr || 0) - (a.tbr || 0);
  })[0];
  const audioCandidates = (info.formats || [])
    .filter(f => f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && !isManifestFormat(f));
  const audio = audioCandidates.sort((a, b) => {
    const ap = Number(a.language_preference ?? -1);
    const bp = Number(b.language_preference ?? -1);
    if (bp !== ap) return bp - ap;
    const ao = /\boriginal\b/i.test(String(a.format_note || '')) ? 1 : 0;
    const bo = /\boriginal\b/i.test(String(b.format_note || '')) ? 1 : 0;
    if (bo !== ao) return bo - ao;
    // AAC/m4a أولًا: بيتنسخ جوه MP4 مباشرة من غير ترميز → بداية أسرع وCPU أقل
    const am = String(a.acodec || '').startsWith('mp4a') ? 1 : 0;
    const bm = String(b.acodec || '').startsWith('mp4a') ? 1 : 0;
    if (bm !== am) return bm - am;
    return (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0);
  })[0];

  if (!video || !audio) throw new Error('Video/audio format unavailable');

  return {
    mode: 'merge',
    actualHeight,
    videoFormatId: String(video.format_id),
    audioFormatId: String(audio.format_id),
    audioCodec: audio.acodec || null
  };
}

// أعلى جودة فيها صوت+فيديو في ملف واحد (يعني ينفع redirect مباشر) <= الجودة المطلوبة
// رابط مباشر من ميتاداتا الاستخراج الواحدة (dump-json) — بيلغي استدعاءات get-url الإضافية
function usableDirectUrl(f) {
  const u = f && typeof f.url === 'string' ? f.url : '';
  if (u && !isHlsUrl(u)) { rememberFormatHeaders(u, f.http_headers); return u; }
  return null;
}

function pickFastProgressiveUrl(info) {
  if (!info) return null;
  const prog = (info.formats || []).filter(f =>
    f && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' &&
    /^https?$/.test(String(f.protocol || 'https')) && usableDirectUrl(f)
  );
  if (!prog.length) return null;
  const f18 = prog.find(f => String(f.format_id) === '18');
  if (f18) return f18.url;
  const near = prog
    .filter(f => Number(f.height) > 0 && Number(f.height) <= 720)
    .sort((a, b) => Math.abs(Number(a.height) - 360) - Math.abs(Number(b.height) - 360));
  return near[0] ? near[0].url : null;
}

function pickBestAudioUrl(info) {
  const audio = (info.formats || [])
    .filter(f => f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && usableDirectUrl(f))
    .sort((a, b) => {
      // المسار الأصلي (مش الدبلجة) أولًا، وبعدين m4a/AAC (يشتغل على كل المتصفحات)، وبعدين الأعلى جودة
      const lp = Number(b.language_preference ?? -1) - Number(a.language_preference ?? -1);
      if (lp) return lp;
      const am = String(a.acodec || '').startsWith('mp4a') ? 1 : 0;
      const bm = String(b.acodec || '').startsWith('mp4a') ? 1 : 0;
      if (am !== bm) return bm - am;
      return (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0);
    });
  return audio[0] ? audio[0].url : null;
}

// يختار رابط صوت شغّال: المسار المطلوب → نفس اللغة → المسار الأصلي → أي مسار → yt-dlp من جديد
async function resolveAudioSource(videoId, audioFormat) {
  const info = await getVideoInfo(videoId).catch(() => null);
  if (info && audioFormat && !(info.formats || []).some(f => String(f.format_id) === audioFormat)) await waitSettled(info, 12000);
  const byRate = (a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0);
  const audioFmts = info ? (info.formats || []).filter(f => f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && !isManifestFormat(f) && usableDirectUrl(f)) : [];
  const cands = [];
  const seen = new Set();
  const push = (f, fallback) => { if (!f || !f.url || seen.has(f.url)) return; seen.add(f.url); cands.push({ url: f.url, formatId: String(f.format_id || ''), fallback }); };
  if (audioFormat) {
    const want = audioFmts.find(f => String(f.format_id) === audioFormat);
    if (want) {
      push(want, null);
      audioFmts.filter(f => (f.language || 'und') === (want.language || 'und')).sort(byRate).forEach(f => push(f, 'same-language'));
    }
  }
  const bestUrl = info ? pickBestAudioUrl(info) : null;
  if (bestUrl) push(audioFmts.find(f => f.url === bestUrl) || { url: bestUrl, format_id: '' }, audioFormat ? 'original-track' : null);
  audioFmts.slice().sort(byRate).forEach(f => push(f, audioFormat ? 'original-track' : null));
  for (const c of cands.slice(0, 4)) if (await verifyUrl(c.url)) return c;
  const selector = audioFormat ? `${audioFormat}/bestaudio[acodec!=none]/bestaudio/best` : 'bestaudio[acodec!=none]/bestaudio/best';
  const urls = await getVerifiedUrls(videoId, selector, { minCount: 1 });
  return { url: urls[0], formatId: null, fallback: 'yt-dlp' };
}

function chooseProgressiveFormat(info, requestedHeight) {
  const h = Number(requestedHeight);
  const prog = getVideoFormats(info).filter(f => f.acodec && f.acodec !== 'none');
  if (!prog.length) return null;
  // exact height only — never silently serve 360 for 144/1080
  const exact = prog.filter(f => Math.abs(qH(f) - h) <= 8)
    .sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
  if (!exact.length) return null;
  const pick = exact[0];
  return { actualHeight: qH(pick), formatId: String(pick.format_id), url: usableDirectUrl(pick) };
}

function getAvailableQualities(info) {
  return [...new Set(
    getVideoFormats(info).map(f => qH(f)).filter(Number.isFinite)
  )].sort((a, b) => b - a);
}

let ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
let ffmpegReadyFlag = null;

function httpDownloadToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('too many redirects'));
    const mod = url.startsWith('http://') ? require('http') : https;
    const req = mod.get(url, { timeout: 180000, headers: { 'User-Agent': 'titan-ffmpeg-bootstrap/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpDownloadToFile(next, dest, redirects + 1));
      }
      if ((res.statusCode || 500) >= 400) {
        res.resume();
        return reject(new Error(`download HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(err => err ? reject(err) : resolve(dest)));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
  });
}

const ffmpegProbeCache = new Map();
function testFfmpegBinary(bin) {
  const hit = ffmpegProbeCache.get(bin);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false;
  try {
    require('child_process').execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 8000 });
    ok = true;
  } catch { ok = false; }
  ffmpegProbeCache.set(bin, { ok, until: Date.now() + (ok ? 60 * 60 * 1000 : 60 * 1000) });
  return ok;
}

// ==========================================================================
// 🎞️ ffmpeg bootstrap (v13.7)
// المشاكل اللي كانت موجودة: (1) كل request كان بيبدأ تنزيل ffmpeg (70MB) من جديد بالتوازي ويكتبوا على نفس الملف
// → ملف بايظ + بطء، (2) /video/qualities كان بيستنى التنزيل (لحد 3 دقايق!)، (3) نتيجة "مفيش ffmpeg" كانت بتتكاش ساعتين
// فتفضل الجودات 360 بس. دلوقتي: تنزيل واحد بس (deduped) لملف مؤقت ثم rename، مصادر متعددة (gz أصغر)، backoff، وحالة ظاهرة في اللوحة.
// ==========================================================================
const ffmpegState = { status: 'unknown', bin: null, source: null, lastError: null, attempts: 0, retryAt: 0, lastOkAt: 0 };
let ffmpegInflight = null;

function ffmpegMarkReady(bin, source) {
  ffmpegBin = bin; ffmpegReadyFlag = true; commandCache.set('ffmpeg', true);
  Object.assign(ffmpegState, { status: 'ready', bin, source, lastError: null, lastOkAt: Date.now() });
  return true;
}

function downloadStream(url, dest, { gunzip = false, redirects = 0, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error('too many redirects'));
    const mod = url.startsWith('http://') ? require('http') : https;
    const req = mod.get(url, { timeout, headers: { 'User-Agent': 'titan-bootstrap/1.0' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadStream(new URL(res.headers.location, url).toString(), dest, { gunzip, redirects: redirects + 1, timeout }));
      }
      if (code >= 400) { res.resume(); return reject(new Error(`download HTTP ${code}`)); }
      const out = fs.createWriteStream(dest);
      const src = gunzip ? res.pipe(zlib.createGunzip()) : res;
      let bytes = 0;
      src.on('data', c => { bytes += c.length; });
      src.on('error', e => { out.destroy(); reject(e); });
      res.on('error', e => { out.destroy(); reject(e); });
      out.on('error', reject);
      out.on('finish', () => out.close(() => (bytes > 1000000 ? resolve(bytes) : reject(new Error(`file too small (${bytes}B)`)))));
      src.pipe(out);
    });
    req.on('timeout', () => req.destroy(new Error('download timeout')));
    req.on('error', reject);
  });
}

async function ensureFfmpegInner() {
  if (testFfmpegBinary('ffmpeg')) return ffmpegMarkReady('ffmpeg', 'system');
  if (process.env.FFMPEG_PATH && testFfmpegBinary(process.env.FFMPEG_PATH)) return ffmpegMarkReady(process.env.FFMPEG_PATH, 'env');
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath && testFfmpegBinary(staticPath)) return ffmpegMarkReady(staticPath, 'ffmpeg-static');
  } catch {}

  const dir = '/tmp/.bin';
  const dest = `${dir}/ffmpeg`;
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
  if (fs.existsSync(dest)) {
    try { fs.chmodSync(dest, 0o755); } catch {}
    if (testFfmpegBinary(dest)) return ffmpegMarkReady(dest, 'cached');
    try { fs.unlinkSync(dest); } catch {}
  }

  ffmpegState.status = 'downloading';
  ffmpegState.attempts++;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const gh = 'https://github.com/eugeneware/ffmpeg-static/releases/download';
  const sources = [
    { name: 'eugeneware b6.1.1 (gz)', url: `${gh}/b6.1.1/ffmpeg-linux-${arch}.gz`, gunzip: true },
    { name: 'eugeneware b6.0 (gz)', url: `${gh}/b6.0/ffmpeg-linux-${arch}.gz`, gunzip: true },
    { name: 'eugeneware b6.0 (raw)', url: `${gh}/b6.0/ffmpeg-linux-${arch}` },
    { name: 'eugeneware b5.2.0 (raw)', url: `${gh}/b5.2.0/ffmpeg-linux-${arch}` },
    { name: 'yt-dlp FFmpeg-Builds (tar.xz)', tar: true, url: `https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux${arch === 'arm64' ? 'arm64' : '64'}-gpl.tar.xz` }
  ];
  const errors = [];
  const stamp = `${process.pid}.${Date.now()}`;
  for (const s of sources) {
    const tmp = `${dest}.${stamp}.part`;
    try {
      log.info(`⬇️  ffmpeg: تنزيل من ${s.name}`);
      if (s.tar) {
        const tarFile = `${dir}/ffmpeg-${stamp}.tar.xz`;
        const outDir = `${dir}/ffx-${stamp}`;
        try {
          await downloadStream(s.url, tarFile);
          fs.mkdirSync(outDir, { recursive: true });
          await execFileAsync('tar', ['-xJf', tarFile, '-C', outDir, '--wildcards', '*/bin/ffmpeg', '--strip-components=2'], { timeout: 120000 });
          fs.copyFileSync(`${outDir}/ffmpeg`, tmp);
        } finally {
          try { fs.unlinkSync(tarFile); } catch {}
          try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
        }
      } else {
        await downloadStream(s.url, tmp, { gunzip: !!s.gunzip });
      }
      fs.chmodSync(tmp, 0o755);
      if (!testFfmpegBinary(tmp)) throw new Error('الملف اتنزّل بس مش بيشتغل (-version فشل)');
      fs.renameSync(tmp, dest);
      testFfmpegBinary(dest);
      log.success(`✅ ffmpeg جاهز (${s.name})`);
      return ffmpegMarkReady(dest, s.name);
    } catch (e) {
      errors.push(`${s.name}: ${String(e.message || e).split('\n')[0]}`);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  const mins = Math.min(15, 2 * Math.pow(2, Math.max(0, ffmpegState.attempts - 1)));
  Object.assign(ffmpegState, { status: 'missing', lastError: errors.join(' | ').slice(0, 700), retryAt: Date.now() + mins * 60 * 1000 });
  log.warn(`ffmpeg مش متاح — كل المصادر فشلت (إعادة المحاولة بعد ${mins}د)`, { cat: 'ffmpeg', detail: ffmpegState.lastError });
  return false;
}

// تنزيل/فحص واحد بس في نفس الوقت مهما كان عدد الـ requests
function ensureFfmpeg() {
  if (ffmpegState.status === 'ready' && testFfmpegBinary(ffmpegBin)) return Promise.resolve(true);
  if (ffmpegInflight) return ffmpegInflight;
  if (ffmpegState.status === 'missing' && Date.now() < ffmpegState.retryAt) return Promise.resolve(false);
  ffmpegInflight = ensureFfmpegInner()
    .catch(e => { ffmpegState.status = 'missing'; ffmpegState.lastError = String(e.message || e); ffmpegState.retryAt = Date.now() + 120000; return false; })
    .finally(() => { ffmpegInflight = null; });
  return ffmpegInflight;
}

// للـ requests: لو ffmpeg جاهز يرجّع فورًا، لو بيتنزّل يستنى بحد أقصى waitMs (مش 3 دقايق زي قبل)
async function hasFfmpegNow(waitMs = 8000) {
  if (ffmpegState.status === 'ready' && testFfmpegBinary(ffmpegBin)) return true;
  return Promise.race([ensureFfmpeg(), sleepMs(waitMs).then(() => false)]);
}

function streamMergedLive(req, res, videoUrl, audioUrl, duration = 0, audioCopy = false, startSec = 0) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  // نفس الـ User-Agent/headers اللي yt-dlp طلّع بيها الرابط (ده اللي بيمنع 403)
  const ffIn = (u) => {
    const h = buildUpstreamHeaders(u);
    const extra = Object.entries(h)
      .filter(([k]) => !['user-agent', 'range', 'accept-encoding', 'connection', 'host'].includes(k))
      .map(([k, v]) => `${k}: ${v}\r\n`).join('');
    return [
      '-user_agent', h['user-agent'] || UA,
      ...(extra ? ['-headers', extra] : []),
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '5',
      '-rw_timeout', '30000000',
      // تحليل أقصر للمدخلات = أول بايت يوصل أسرع
      '-probesize', '600000',
      '-analyzeduration', '600000',
      '-fflags', '+nobuffer+genpts',
      ...(startSec > 0 ? ['-ss', String(startSec)] : []),
      '-i', u
    ];
  };
  const inputArgs = [...ffIn(videoUrl)];
  if (audioUrl) inputArgs.push(...ffIn(audioUrl));

  const args = [
    '-loglevel', 'warning',
    '-hide_banner',
    '-nostdin',
    ...inputArgs,
    '-map', '0:v:0',
    ...(audioUrl ? ['-map', '1:a:0'] : ['-map', '0:a:0?']),
    '-c:v', 'copy',
    // AAC بيتنسخ زي ما هو؛ غير كده (Opus مثلًا) بنحوّله لـ AAC عشان MP4
    ...(audioCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']),
    ...(audioCopy ? [] : ['-af', 'aresample=async=1:first_pts=0']),
    '-avoid_negative_ts', 'make_zero',
    '-max_interleave_delta', '2000000',
    '-flush_packets', '1',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1'
  ];

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Accept-Ranges', 'none');          // البث ده مش قابل للـ byte-range → الفرونت يستخدم ?start=ثواني
  res.setHeader('X-Seekable', 'start');
  res.setHeader('X-Merge-Mode', 'live');
  if (Number(duration) > 0) res.setHeader('X-Video-Duration', String(duration));

  const ff = spawn(ffmpegBin || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrBuf = '';
  let gotData = false;

  ff.stderr.on('data', d => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
  });
  ff.stdout.once('data', () => { gotData = true; });
  // end:false → لو ffmpeg فشل قبل أي بايت نرد بخطأ واضح بدل 200 فاضي
  ff.stdout.pipe(res, { end: false });

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
    if (!gotData && !res.headersSent && !res.writableEnded) {
      return res.status(502).json({ error: 'فشل دمج الفيديو والصوت — المصدر رفض الاتصال أو انتهت صلاحيته', retryable: true });
    }
    if (!res.writableEnded) res.end();
  });
  req.on('close', cleanup);
}

// ==========================================================================
// 🎞️ MUX CACHE v13.8 — دمج فيديو+صوت لملف MP4 حقيقي قابل للتقديم/التأخير
// المشكلة القديمة: الدمج كان pipe حي (fragmented MP4) من ffmpeg → مفيش Range، مفيش مدة،
// فالمتصفح لما تقدّم/تأخّر كان بيطلب من الأول (الفيديو بيبدأ من 0 وشريط التقدم بيكبر).
// الحل: تنزيل الفيديو والصوت بالتوازي (chunks متوازية من جوجل) ثم دمج copy بدون ترميز
// بـ +faststart → ملف كامل بمدة صح وRange صح + سينك صوت/صورة ثابت. الملفات بتتكاش وبتتمسح لوحدها.
// فيديوهات أكبر من MUX_CACHE_MAX_MB (افتراضي 120) بتفضل بث حي، ويدعم ?start=ثواني للتقديم.
// ==========================================================================
const nodeCrypto = require('crypto');
const nodePath = require('path');
const MUX_DIR = process.env.MUX_CACHE_DIR || '/tmp/mux-cache';
const MUX_MAX_FILE_BYTES = (parseInt(process.env.MUX_CACHE_MAX_MB, 10) || 120) * 1048576;
const MUX_CACHE_TOTAL_BYTES = (parseInt(process.env.MUX_CACHE_TOTAL_MB, 10) || 1000) * 1048576;
const MUX_TTL_MS = (parseInt(process.env.MUX_CACHE_TTL_MIN, 10) || 90) * 60000;
const MUX_CHUNK = 3 * 1048576;
const MUX_PARALLEL = Math.max(2, parseInt(process.env.MUX_PARALLEL, 10) || 6);
const MUX_BUILD_TIMEOUT_MS = (parseInt(process.env.MUX_BUILD_TIMEOUT_SEC, 10) || 60) * 1000;
const muxFiles = new Map();   // key -> { path, size, type, lastUsed, inUse }
const muxJobs = new Map();    // key -> Promise
const muxLimiter = new Semaphore(Math.max(1, parseInt(process.env.MUX_CONCURRENCY, 10) || 3));
try { fs.mkdirSync(MUX_DIR, { recursive: true }); for (const f of fs.readdirSync(MUX_DIR)) { try { fs.unlinkSync(nodePath.join(MUX_DIR, f)); } catch {} } } catch {}

function muxUrlIdentity(u) {
  try { const q = new URL(u).searchParams; const id = q.get('id'), itag = q.get('itag'); if (id && itag) return `${id}.${itag}`; } catch {}
  return nodeCrypto.createHash('sha1').update(String(u)).digest('hex').slice(0, 16);
}
function muxClen(u) { try { return Number(new URL(u).searchParams.get('clen')) || 0; } catch { return 0; } }
function muxKey(videoUrl, audioUrl, audioCopy) { return `${muxUrlIdentity(videoUrl)}+${muxUrlIdentity(audioUrl)}${audioCopy ? 'c' : 't'}`; }

function muxFetchRange(url, metaUrl, start, end, hop = 0) {
  return new Promise((resolve, reject) => {
    let target; try { target = new URL(url); } catch (e) { return reject(e); }
    const headers = buildUpstreamHeaders(metaUrl);
    if (!/googlevideo\.com$/i.test(target.hostname)) delete headers.cookie;
    headers.range = `bytes=${start}-${end}`;
    const want = end - start + 1;
    const req = https.get(target, { headers, timeout: 20000, agent: keepAliveAgent }, (r) => {
      const code = Number(r.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(code) && r.headers.location && hop < 4) {
        r.resume();
        return resolve(muxFetchRange(new URL(r.headers.location, target).toString(), metaUrl, start, end, hop + 1));
      }
      if (code !== 206 && !(code === 200 && start === 0)) { r.resume(); const e = new Error(`upstream ${code}`); e.status = code; return reject(e); }
      const chunks = []; let got = 0, done = false;
      const finish = () => {
        if (done) return; done = true;
        let buf = Buffer.concat(chunks, got);
        if (buf.length > want) buf = buf.subarray(0, want);
        const cr = /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(r.headers['content-range'] || '');
        const total = cr && cr[1] !== '*' ? Number(cr[1]) : (code === 200 ? Number(r.headers['content-length']) || 0 : 0);
        resolve({ buf, total, url });
      };
      r.on('data', d => { chunks.push(d); got += d.length; if (code === 200 && got >= want) { finish(); r.destroy(); } });
      r.on('end', finish);
      r.on('error', e => { if (!done) { done = true; reject(e); } });
      r.on('aborted', () => { if (!done) { done = true; reject(new Error('aborted')); } });
    });
    req.on('timeout', () => req.destroy(new Error('chunk timeout')));
    req.on('error', reject);
  });
}
async function muxRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; if ([400, 401, 403, 404, 410].includes(e.status)) throw e; await sleepMs(150 * (i + 1)); }
  }
  throw last;
}
async function muxDownload(url, dest, expectTotal, state) {
  const fh = await fs.promises.open(dest, 'w');
  try {
    const first = await muxRetry(() => muxFetchRange(url, url, 0, MUX_CHUNK - 1));
    const total = first.total || expectTotal;
    if (!total) throw new Error('حجم الملف مجهول');
    if (total > MUX_MAX_FILE_BYTES) { const e = new Error('too big'); e.tooBig = true; throw e; }
    await fh.write(first.buf, 0, first.buf.length, 0);
    let cursor = first.buf.length;
    const finalUrl = first.url;
    const worker = async () => {
      while (!state.aborted) {
        const s0 = cursor; if (s0 >= total) return;
        cursor = s0 + MUX_CHUNK;
        const e0 = Math.min(s0 + MUX_CHUNK, total) - 1;
        const r = await muxRetry(() => muxFetchRange(finalUrl, url, s0, e0));
        if (r.buf.length !== e0 - s0 + 1) throw new Error('chunk ناقص');
        await fh.write(r.buf, 0, r.buf.length, s0);
      }
    };
    const n = Math.min(MUX_PARALLEL, Math.max(1, Math.ceil((total - cursor) / MUX_CHUNK)));
    if (cursor < total) await Promise.all(Array.from({ length: n }, worker));
    return total;
  } catch (e) { state.aborted = true; throw e; }
  finally { await fh.close().catch(() => {}); }
}
function muxRunFfmpeg(vPath, aPath, out, audioCopy) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', vPath, '-i', aPath,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    ...(audioCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-af', 'aresample=async=1:first_pts=0']),
    '-movflags', '+faststart', '-f', 'mp4', out];
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegBin || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; ff.stderr.on('data', d => { err = (err + d).slice(-1500); });
    const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 90000);
    ff.on('error', e => { clearTimeout(t); reject(e); });
    ff.on('close', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`ffmpeg mux ${code}: ${err.slice(-400)}`)); });
  });
}
async function muxBuild(key, videoUrl, audioUrl, audioCopy) {
  const base = nodePath.join(MUX_DIR, nodeCrypto.createHash('sha1').update(key).digest('hex').slice(0, 20));
  const vp = `${base}.v.part`, ap = `${base}.a.part`, tmp = `${base}.tmp.mp4`, out = `${base}.mp4`;
  const state = { aborted: false };
  const timer = setTimeout(() => { state.aborted = true; }, MUX_BUILD_TIMEOUT_MS);
  try {
    await Promise.all([muxDownload(videoUrl, vp, muxClen(videoUrl), state), muxDownload(audioUrl, ap, muxClen(audioUrl), state)]);
    if (state.aborted) throw new Error('انتهت مهلة تجهيز الملف');
    await muxRunFfmpeg(vp, ap, tmp, audioCopy);
    fs.renameSync(tmp, out);
    const entry = { path: out, size: fs.statSync(out).size, type: 'video/mp4', lastUsed: Date.now(), inUse: 0 };
    muxFiles.set(key, entry);
    return entry;
  } finally {
    clearTimeout(timer); state.aborted = true;
    for (const f of [vp, ap, tmp]) { try { fs.unlinkSync(f); } catch {} }
  }
}
function ensureMergedFile(key, videoUrl, audioUrl, audioCopy) {
  const hit = muxFiles.get(key);
  if (hit && fs.existsSync(hit.path)) { hit.lastUsed = Date.now(); return Promise.resolve(hit); }
  if (hit) muxFiles.delete(key);
  const running = muxJobs.get(key); if (running) return running;
  const job = (async () => {
    await muxLimiter.acquire();
    try { return await muxBuild(key, videoUrl, audioUrl, audioCopy); }
    finally { muxLimiter.release(); }
  })().finally(() => { muxJobs.delete(key); muxEvict(); });
  muxJobs.set(key, job);
  return job;
}
function muxEvict() {
  const now = Date.now();
  let total = 0; const list = [];
  for (const [k, e] of muxFiles) {
    if (!e.inUse && (now - e.lastUsed > MUX_TTL_MS || !fs.existsSync(e.path))) { try { fs.unlinkSync(e.path); } catch {} muxFiles.delete(k); continue; }
    total += e.size; list.push([k, e]);
  }
  list.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [k, e] of list) {
    if (total <= MUX_CACHE_TOTAL_BYTES) break;
    if (e.inUse) continue;
    try { fs.unlinkSync(e.path); } catch {}
    muxFiles.delete(k); total -= e.size;
  }
}
setInterval(muxEvict, 5 * 60 * 1000).unref();

function serveMuxFile(req, res, entry) {
  const size = entry.size;
  let start = 0, end = size - 1, status = 200;
  const m = req.headers.range ? /^bytes=(\d*)-(\d*)$/i.exec(String(req.headers.range).trim()) : null;
  if (m && (m[1] !== '' || m[2] !== '')) {
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
    if (start >= size || start > end) { res.status(416).setHeader('Content-Range', `bytes */${size}`); return res.end(); }
    status = 206;
  }
  res.status(status);
  res.setHeader('Content-Type', entry.type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(end - start + 1));
  if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Seekable', 'bytes');
  res.setHeader('X-Merge-Mode', 'file');
  if (req.method === 'HEAD') return res.end();
  entry.inUse++; entry.lastUsed = Date.now();
  const rs = fs.createReadStream(entry.path, { start, end, highWaterMark: 256 * 1024 });
  const release = () => { if (!rs.__rel) { rs.__rel = true; entry.inUse = Math.max(0, entry.inUse - 1); entry.lastUsed = Date.now(); } };
  rs.on('error', () => { release(); destroyResponseStream(res); });
  res.once('close', () => { release(); rs.destroy(); });
  rs.pipe(res);
}

// نقطة الدخول (نفس التوقيع القديم). opts: { videoId } — لو اتحدد بنبعت المدة في X-Video-Duration
async function streamMergedViaFfmpeg(req, res, videoUrl, audioUrl, duration = 0, audioCopy = false, opts = {}) {
  let dur = Number(duration) || 0;
  if (!dur && opts.videoId) { const inf = infoCache.get(`raw_info_v4_${opts.videoId}`); dur = Number(inf && inf.duration) || 0; }
  const startSec = Math.max(0, Math.min(Number(req.query.start ?? req.query.t) || 0, dur > 0 ? dur - 1 : 1e7));
  const forceLive = ['1', 'true'].includes(String(req.query.live || ''));
  const vLen = muxClen(videoUrl), aLen = muxClen(audioUrl);
  const knownTooBig = vLen && aLen && (vLen + aLen) > MUX_MAX_FILE_BYTES;
  if (audioUrl && !forceLive && !knownTooBig) {
    try {
      const entry = await ensureMergedFile(muxKey(videoUrl, audioUrl, audioCopy), videoUrl, audioUrl, audioCopy);
      if (res.destroyed || res.headersSent) return;
      if (dur) res.setHeader('X-Video-Duration', String(dur));
      return serveMuxFile(req, res, entry);
    } catch (e) {
      if (!e.tooBig) log.warn(`mux cache فشل → بث حي: ${String(e.message || e).split('\n')[0]}`);
      if (res.destroyed || res.headersSent) return;
    }
  }
  return streamMergedLive(req, res, videoUrl, audioUrl, dur, audioCopy, startSec);
}

// ==========================================================================
// 🔴 البث المباشر (HLS)
// قبل كده السيرفر كان بيرفض أي رابط HLS (isHlsUrl) فالبث المباشر مكانش بيشتغل خالص.
// دلوقتي: /hls/master بيبني master playlist من variants الـ HLS الحقيقية للبث،
// و/hls/proxy بيمرّر الـ playlists والـ segments عبر السيرفر (CORS + ربط الـ IP).
// الاستخدام: /video?v=ID بيكتشف البث لوحده، أو مباشرة /hls/master?v=ID[&quality=720]
// ==========================================================================
function isLiveInfo(info) {
  return !!(info && (info.is_live || info.live_status === 'is_live'));
}

const HLS_ALLOWED_HOST = /(^|\.)(googlevideo\.com|youtube\.com|ytimg\.com)$/i;

function hlsProxyUrl(u) {
  return `/hls/proxy?u=${Buffer.from(String(u)).toString('base64url')}`;
}

function rewriteM3u8(text, baseUrl) {
  const abs = (u) => { try { return new URL(u, baseUrl).toString(); } catch { return null; } };
  return String(text).split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        const a = abs(uri);
        return a ? `URI="${hlsProxyUrl(a)}"` : m;
      });
    }
    const a = abs(t);
    return a ? hlsProxyUrl(a) : line;
  }).join('\n');
}

function getLiveVariants(info) {
  return (info.formats || [])
    .filter(f => f && f.url && f.vcodec && f.vcodec !== 'none' && (String(f.protocol || '').includes('m3u8') || isHlsUrl(f.url)))
    .map(f => ({
      formatId: String(f.format_id),
      height: qH(f),
      width: Number(f.width) || 0,
      fps: Number(f.fps) || 0,
      bandwidth: Math.round((Number(f.tbr) || 0) * 1000),
      url: f.url,
      manifestUrl: f.manifest_url || null,
      muxed: Boolean(f.acodec && f.acodec !== 'none')
    }))
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

// بيرجّع true لو رد بالـ master، و false لو الفيديو مش بث مباشر (عشان المتصل يكمّل عادي)
async function serveLiveMaster(req, res, videoId, quality) {
  const info = await getVideoInfo(videoId);
  if (!isLiveInfo(info)) {
    noteLiveHint(videoId, false);
    if (info.live_status === 'is_upcoming') {
      res.status(409).json({
        error: 'البث لسه ما بدأش',
        liveStatus: 'is_upcoming',
        startsAt: info.release_timestamp ? new Date(info.release_timestamp * 1000).toISOString() : null
      });
      return true;
    }
    return false;
  }

  const all = getLiveVariants(info);
  const muxed = all.filter(v => v.muxed && v.height);
  const wantedQ = resolveQuality(quality);
  const want = wantedQ && wantedQ.type === 'video' ? wantedQ.height : 0;

  res.status(200);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Stream-Mode', 'hls-live');

  if (muxed.length) {
    // variant واحد لكل ارتفاع (الأعلى bitrate)
    const byH = new Map();
    for (const v of muxed) {
      const cur = byH.get(v.height);
      if (!cur || v.bandwidth > cur.bandwidth) byH.set(v.height, v);
    }
    let list = [...byH.values()].sort((a, b) => b.height - a.height);
    if (want) {
      const le = list.filter(v => v.height <= want);
      list = [le.length ? le[0] : list[list.length - 1]];
    }
    res.setHeader('X-Video-Quality', want ? `${list[0].height}p` : 'auto');
    const lines = ['#EXTM3U', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (const v of list) {
      const bw = v.bandwidth > 0 ? v.bandwidth : Math.max(150000, v.height * 4500);
      let attr = `BANDWIDTH=${bw}`;
      if (v.width && v.height) attr += `,RESOLUTION=${v.width}x${v.height}`;
      if (v.fps) attr += `,FRAME-RATE=${v.fps.toFixed(3)}`;
      lines.push(`#EXT-X-STREAM-INF:${attr}`, hlsProxyUrl(v.url));
    }
    res.end(lines.join('\n') + '\n');
    return true;
  }

  // مفيش variants مدموجة (صوت+صورة) → نستخدم الـ master الرسمي من يوتيوب مع إعادة كتابة الروابط
  const mu = (all.find(v => v.manifestUrl) || {}).manifestUrl;
  if (mu) {
    const r = await httpGetText(mu, { timeout: 15000, headers: { Referer: 'https://www.youtube.com/', Origin: 'https://www.youtube.com' } });
    if (r.status < 400 && r.body.includes('#EXTM3U')) {
      res.end(rewriteM3u8(r.body, mu));
      return true;
    }
  }
  res.removeHeader('Content-Type');
  throw new Error('No HLS variants for live stream');
}

app.get('/hls/master', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!isValidVideoId(videoId)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  try {
    const handled = await serveLiveMaster(req, res, videoId, req.query.quality || req.query.height || null);
    if (!handled) res.status(409).json({ error: 'الفيديو ده مش بث مباشر', live: false });
  } catch (e) {
    log.warn(`hls/master failed ${videoId}: ${String(e.message || e).split('\n')[0]}`);
    if (!res.headersSent) res.status(502).json({ error: 'تعذّر تجهيز البث المباشر', details: NODE_ENV === 'development' ? e.message : undefined });
  }
});

app.get('/hls/proxy', async (req, res) => {
  let target;
  try {
    target = Buffer.from(String(req.query.u || ''), 'base64url').toString('utf8');
    const u = new URL(target);
    if (u.protocol !== 'https:' || !HLS_ALLOWED_HOST.test(u.hostname)) throw new Error('blocked host');
  } catch {
    return res.status(400).json({ error: 'رابط HLS غير مسموح' });
  }

  // playlist → نعيد كتابة الروابط اللي جواه عشان تعدّي علينا
  if (/\.m3u8(?:$|[?#])|\/api\/manifest\//i.test(target)) {
    try {
      const r = await httpGetText(target, { timeout: 15000, headers: { Referer: 'https://www.youtube.com/', Origin: 'https://www.youtube.com' } });
      if (r.status >= 400 || !r.body.includes('#EXTM3U')) {
        return res.status(502).json({ error: 'تعذّر جلب قائمة التشغيل', upstreamStatus: r.status });
      }
      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(rewriteM3u8(r.body, target));
    } catch (e) {
      return res.status(502).json({ error: 'تعذّر جلب قائمة التشغيل' });
    }
  }

  // segment (ts / fmp4 / aac) → تمرير مباشر بالـ streaming
  res.setHeader('X-Stream-Mode', 'hls-segment');
  return streamFromUpstream(req, res, target, 0, 0);
});

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
// 🚀 QUICK PLAY — أسرع طريق للتشغيل الأول عبر السيرفر (proxy).
// لا يجلب معلومات الفيديو الكاملة؛ يحل رابط البث فقط ثم يمرّر البايتات.
// ?direct=1 لو عايز redirect لجوجل بدل الـ proxy.
// ==========================================================================
app.get('/video/quick', async (req, res) => {
  const videoId = String(req.query.v || '');
  if (!isValidVideoId(videoId)) {
    return res.status(400).json({ error: 'Video ID غير صحيح' });
  }

  try {
    if (liveIdHints.has(videoId) && await serveLiveMaster(req, res, videoId, null)) return;
    const wantDirect = ['1', 'true', 'yes'].includes(String(req.query.direct || '').toLowerCase());
    if (wantDirect) return getDirectStreamRedirect(req, res, videoId);

    const url = await getFastStreamUrl(videoId);
    res.setHeader('X-Stream-Mode', 'proxy-fast');
    res.setHeader('X-Video-Quality', '360p');
    return streamFromUpstream(req, res, url, 0, 0, { onForbidden: async () => { forgetVideo(videoId); return getFastStreamUrl(videoId); } });
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
    const probe = ['1', 'true', 'yes'].includes(String(req.query.probe || '').toLowerCase());
    // الافتراضي الآن: السيرفر يعمل proxy للفيديو (مش redirect لجوجل).
    // ?direct=1 يرجع redirect لـ CDN جوجل لو حابب.
    const wantDirect = ['1', 'true', 'yes'].includes(String(req.query.direct || '').toLowerCase());
    let resolved = resolveQuality(quality);
    let fastErr = null, defaultFallback = false;
    let tol = 8;   // سماحية فرق الارتفاع (بتتوسّع بس لو بنعمل fallback للتشغيل الافتراضي)

    // بث مباشر معروف (من نتايج البحث/الكاش) → HLS مباشرة
    if (liveIdHints.has(videoId) || isLiveInfo(infoCache.get(`raw_info_v4_${videoId}`))) {
      if (probe) return res.json({ probe: true, id: videoId, type: 'live', live: true, resolved: true, hls: `/hls/master?v=${videoId}` });
      if (await serveLiveMaster(req, res, videoId, quality)) return;
    }

    // المسار الافتراضي السريع: proxy عبر السيرفر بجودة ~360p progressive.
    if (!probe && !resolved) {
      if (wantDirect) return getDirectStreamRedirect(req, res, videoId);
      let streamUrl = null;
      try { streamUrl = await getFastStreamUrl(videoId); }
      catch (e) { fastErr = e; log.warn(`fast stream failed ${videoId}: ${String(e.message || e).split('\n')[0]}`); }
      if (streamUrl) {
        res.setHeader('X-Stream-Mode', 'proxy-fast');
        res.setHeader('X-Video-Quality', '360p');
        recordPerf('video-default', Date.now() - requestStartedAt, true);
        return streamFromUpstream(req, res, streamUrl, 0, videoDuration, { onForbidden: async () => { forgetVideo(videoId); return getFastStreamUrl(videoId); } });
      }
      // مفيش progressive: يا بث مباشر (HLS)، يا فيديو ملوش غير adaptive → نشغّله بدمج ffmpeg
      try {
        const liveCheck = await getVideoInfo(videoId);
        if (isLiveInfo(liveCheck) && await serveLiveMaster(req, res, videoId, null)) return;
      } catch {}
      resolved = { type: 'video', height: 360 };
      tol = 480;
      defaultFallback = true;
    }

    if (resolved?.type === 'audio') {
      const audioFormat = String(req.query.audioFormat || req.query.af || '').trim();
      // لو المسار المطلوب (دبلجة) رابطه مرفوض/مش موجود بنرجع لنفس اللغة ثم المسار الأصلي بدل ما الطلب كله يفشل
      const src = await resolveAudioSource(videoId, /^[\w.-]+$/.test(audioFormat) ? audioFormat : '');
      if (probe) return res.json({ probe: true, id: videoId, type: 'audio', formatId: audioFormat || null, servedFormatId: src.formatId, fallback: src.fallback, resolved: true, urlLength: String(src.url || '').length });
      if (wantDirect) return redirectToCdn(res, src.url, { mode: 'direct-cdn', quality: 'audio' });
      res.setHeader('X-Stream-Mode', 'proxy-audio');
      if (audioFormat) res.setHeader('X-Audio-Format', audioFormat);
      if (src.formatId) res.setHeader('X-Audio-Served-Format', src.formatId);
      if (src.fallback) res.setHeader('X-Audio-Fallback', src.fallback);
      return streamFromUpstream(req, res, src.url, 0, videoDuration, { onForbidden: async () => { forgetVideo(videoId); const s2 = await resolveAudioSource(videoId, ''); return s2.url; } });
    }

    if (resolved?.type === 'video') {
      const h = resolved.height;
      const hasFfmpeg = await hasFfmpegNow(8000);

      // 1) progressive بنفس الارتفاع فقط (لو موجود)
      try {
        const q = await getQualityStreamUrl(videoId, h);
        if (q && Math.abs(Number(q.actualHeight || h) - h) <= tol) {
          res.setHeader('X-Video-Quality', `${q.actualHeight || h}p`);
          res.setHeader('X-Requested-Quality', `${h}p`);
          res.setHeader('X-Stream-Mode', wantDirect ? 'direct-cdn' : 'proxy-quality');
          if (probe) {
            return res.json({
              probe: true, id: videoId, type: 'video',
              requestedQuality: h, actualQuality: q.actualHeight || h,
              mode: q.mode || 'progressive', resolved: true,
              urlLength: String(q.url || '').length
            });
          }
          recordPerf('video-quality', Date.now() - requestStartedAt, true);
          if (wantDirect) return redirectToCdn(res, q.url, { mode: 'direct-cdn', quality: q.actualHeight || h });
          return streamFromUpstream(req, res, q.url, 0, videoDuration, { onForbidden: async () => { forgetVideo(videoId); const nq = await getQualityStreamUrl(videoId, h); return nq && nq.url; } });
        }
      } catch (e) {
        log.warn(`quality ${h}p progressive fail: ${String(e.message || e).split('\n')[0]}`);
      }

      // 2) دمج video+audio للارتفاع المطلوب (ده اللي بيخلي 144 ≠ 360 ≠ 720)
      if (hasFfmpeg) {
        try {
          const info = await getVideoInfo(videoId);
          if (info.__pending && !getAvailableQualities(info).includes(h)) await waitSettled(info, 10000);
          const selected = chooseQualityFormats(info, h);
          if (selected.mode === 'direct' && Math.abs(Number(selected.actualHeight) - h) <= tol) {
            const dUrl = usableDirectUrl((info.formats || []).find(f => String(f.format_id) === selected.videoFormatId));
            const urls = dUrl ? [dUrl] : await getFormatUrls(videoId, selected.videoFormatId, { strict: true });
            if (!(await verifyUrl(urls[0]))) throw new Error('direct stream rejected by upstream (403)');
            if (probe) return res.json({ probe: true, id: videoId, requestedQuality: h, actualQuality: selected.actualHeight, mode: 'direct', resolved: true });
            if (wantDirect) return redirectToCdn(res, urls[0], { mode: 'direct-cdn', quality: selected.actualHeight });
            res.setHeader('X-Video-Quality', `${selected.actualHeight}p`);
            res.setHeader('X-Requested-Quality', `${h}p`);
            res.setHeader('X-Stream-Mode', 'proxy-quality');
            return streamFromUpstream(req, res, urls[0], 0, videoDuration);
          }
          // أسرع مسار: روابط الفيديو والصوت موجودة في نفس ميتاداتا الاستخراج
          const vUrl = usableDirectUrl((info.formats || []).find(f => String(f.format_id) === selected.videoFormatId));
          const aUrl = usableDirectUrl((info.formats || []).find(f => String(f.format_id) === selected.audioFormatId));
          const pairOk = vUrl && aUrl ? await verifyAll([vUrl, aUrl]) : false;
          if (selected.mode === 'merge' && vUrl && aUrl && pairOk) {
            if (probe) return res.json({ probe: true, id: videoId, requestedQuality: h, actualQuality: selected.actualHeight, mode: 'ffmpeg', resolved: true });
            res.setHeader('X-Video-Quality', `${selected.actualHeight}p`);
            res.setHeader('X-Requested-Quality', `${h}p`);
            res.setHeader('X-Stream-Mode', 'ffmpeg');
            recordPerf('video-quality', Date.now() - requestStartedAt, true);
            return streamMergedViaFfmpeg(req, res, vUrl, aUrl, videoDuration, /^mp4a/.test(String(selected.audioCodec || '')), { videoId });
          }
          // adaptive: video-only + audio at target height
          const heightSelector =
            `bv*[height=${h}]+ba/bv*[height<=${h}][height>=${Math.max(144, h - 40)}]+ba/` +
            `b[height=${h}]/bestvideo[height<=${h}]+bestaudio`;
          let urls = [];
          try { urls = await getVerifiedUrls(videoId, heightSelector, { strict: true, minCount: 2 }); } catch {}
          if (urls.length >= 2) {
            if (probe) return res.json({ probe: true, id: videoId, requestedQuality: h, actualQuality: h, mode: 'ffmpeg', resolved: true });
            res.setHeader('X-Video-Quality', `${h}p`);
            res.setHeader('X-Requested-Quality', `${h}p`);
            res.setHeader('X-Stream-Mode', 'ffmpeg');
            recordPerf('video-quality', Date.now() - requestStartedAt, true);
            return streamMergedViaFfmpeg(req, res, urls[0], urls[1], videoDuration, false, { videoId });
          }
          if (selected.mode === 'merge') {
            const u2 = await getVerifiedUrls(videoId, `${selected.videoFormatId}+${selected.audioFormatId}`, { strict: true, minCount: 2 }).catch(() => []);
            if (u2.length >= 2) {
              if (probe) return res.json({ probe: true, id: videoId, requestedQuality: h, actualQuality: selected.actualHeight, mode: 'ffmpeg', resolved: true });
              res.setHeader('X-Video-Quality', `${selected.actualHeight}p`);
              res.setHeader('X-Requested-Quality', `${h}p`);
              res.setHeader('X-Stream-Mode', 'ffmpeg');
              return streamMergedViaFfmpeg(req, res, u2[0], u2[1], videoDuration, false, { videoId });
            }
          }
        } catch (e) {
          log.warn(`merge ${h}p fail: ${String(e.message || e).split('\n')[0]}`);
        }
      } else {
        log.warn('ffmpeg missing — cannot deliver non-progressive qualities accurately');
      }

      // التشغيل الافتراضي فشل بالكامل → نرجّع السبب الحقيقي (يوتيوب رفض/خاص/محذوف) مش رسالة جودة مضللة
      if (defaultFallback) throw (fastErr || new Error('Video unavailable'));
      // 3) مفيش مصدر حقيقي للجودة دي → خطأ واضح بدل ما نرجّع 360 بصمت
      res.setHeader('X-Requested-Quality', `${h}p`);
      return res.status(503).json({
        error: `جودة ${h}p مش متاحة دلوقتي`,
        requestedQuality: h,
        ffmpegReady: Boolean(hasFfmpeg),
        hint: hasFfmpeg ? 'المصدر مش متاح لهذه الجودة من يوتيوب' : 'ffmpeg مش متثبت على السيرفر (npm i ffmpeg-static)'
      });
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
    res.locals.__reported = true;
    log.error(`Error streaming ${videoId}: ${cleanErr(error, 200).split('\n')[0]}`, { cat: 'stream', videoId, detail: cleanErr(error), route: req.originalUrl });
    if (res.headersSent) return;

    const msg = String(error.message || '').toLowerCase();
    if (/upstream rejected|rejected by upstream/.test(msg)) {
      return res.status(502).json({ error: 'يوتيوب رفض مصدر الفيديو (403) — حدّث yt-dlp أو جدّد الكوكيز', retryable: true, debug: `/api/video-debug?v=${videoId}` });
    }
    if (msg.includes('unavailable') || msg.includes('not available')) {

      return res.status(404).json({ error: 'الفيديو غير متاح أو محذوف' });
    }
    if (msg.includes('private')) {
      return res.status(403).json({ error: 'الفيديو خاص (private)' });
    }
    if (/confirm your age|age.?restrict|age verification|inappropriate for some/.test(msg)) {
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

    const args = [...ytdlpBaseArgs(), '--no-playlist', '--format-sort', 'lang,quality', '-f', format, '-o', '-', `https://www.youtube.com/watch?v=${videoId}`];
    child = spawn(ytdlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

  let cached = infoCache.get(`info_full_${videoId}`);
  // لقطة قديمة كانت لسه مستنية الترجمة، والترجمة جهزت دلوقتي → أعد البناء
  if (cached && cached.subtitlesPending) {
    const rawNow = infoCache.get(`raw_info_v4_${videoId}`);
    if (rawNow && !rawNow.__pending) cached = null;
  }
  if (cached) {
    log.info(`📋 Info from cache: ${videoId}`);
    return res.json(cached);
  }

  try {
    log.info(`📥 Fetching info: ${videoId}`);
    const info = await getVideoInfo(videoId);

    const chapters = (info.chapters || []).map(c => ({
      title: c.title || '',
      start: c.start_time || 0,
      end: c.end_time || null
    }));

    const subtitles = {};
    const rawSubs = { ...(info.automatic_captions || {}), ...(info.subtitles || {}) };
    const selfOrigin = `${req.protocol}://${req.get('host')}`;
    for (const [lang, list] of Object.entries(rawSubs)) {
      if (!Array.isArray(list) || !list.length) continue;
      subtitles[lang] = list.map(s => ({
        ext: s.ext || null,
        // الرابط بقى عبر السيرفر (مفيش CORS ولا مشاكل PO Token) — الأصلي في sourceUrl
        url: `${selfOrigin}/captions/file?v=${videoId}&lang=${encodeURIComponent(lang)}&ext=${encodeURIComponent(s.ext || 'vtt')}`,
        sourceUrl: s.url || null,
        name: s.name || lang
      }));
    }

    const heights = getAvailableQualities(info);

    const result = {
      id: videoId,
      title: info.title,
      fulltitle: info.fulltitle || info.title,
      duration: info.duration || 0,
      durationString: info.duration_string || null,
      author: info.uploader || info.channel || 'Unknown',
      channelId: info.channel_id || '',
      channelUrl: info.channel_url || (info.channel_id ? `https://www.youtube.com/channel/${info.channel_id}` : null),
      channelFollowerCount: info.channel_follower_count || null,
      description: info.description || '',
      descriptionHtml: info.description ? String(info.description).replace(/\n/g, '<br>') : '',
      thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      thumbnails: {
        default: `https://i.ytimg.com/vi/${videoId}/default.jpg`,
        medium: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        high: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        standard: `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
        max: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`
      },
      publishedAt: info.upload_date ? new Date(
        `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`
      ).toISOString() : null,
      uploadDate: info.upload_date || null,
      viewCount: info.view_count || 0,
      likeCount: info.like_count || 0,
      commentCount: info.comment_count || null,
      ageRestricted: info.age_limit ? info.age_limit > 0 : false,
      ageLimit: info.age_limit || 0,
      isLive: info.is_live || false,
      wasLive: info.was_live || false,
      liveStatus: info.live_status || null,
      isUpcoming: info.live_status === 'is_upcoming',
      originalLanguage: info.language || null,
      audioLanguages: [...new Set((info.formats || []).filter(f => f.acodec && f.acodec !== 'none').map(f => f.language).filter(Boolean))],
      categories: info.categories || [],
      tags: (info.tags || []).slice(0, 40),
      chapters,
      hasChapters: chapters.length > 0,
      subtitles,
      subtitleLanguages: Object.keys(subtitles),
      subtitlesPending: !!info.__pending && !Object.keys(subtitles).length,   // الترجمة لسه بتتجمّع → اسأل /captions
      availableHeights: heights,
      formatsCount: info.formats?.length || 0,
      webpageUrl: info.webpage_url || `https://www.youtube.com/watch?v=${videoId}`,
      playability: {
        isLive: !!info.is_live,
        ageRestricted: !!(info.age_limit && info.age_limit > 0),
        availability: info.availability || null
      },
      // روابط جاهزة من نفس السيرفر
      links: {
        watch: `/video?v=${videoId}`,
        quick: `/video/quick?v=${videoId}`,
        qualities: `/video/qualities?v=${videoId}`,
        comments: `/comments?v=${videoId}`,
        related: `/related?v=${videoId}`,
        captions: `/captions?v=${videoId}`,
        embed: `/embed?v=${videoId}`
      }
    };

    // لو الترجمة/الصوتيات لسه بتكمّل في الخلفية منكاشيش النتيجة كتير
    infoCache.set(`info_full_${videoId}`, result, result.subtitlesPending ? 15 * 1000 : CACHE_TTL.info);
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
    await waitSettled(info, 4000);
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

  const cacheKey = `qualities_v14_${videoId}`;
  const cached = infoCache.get(cacheKey);
  // نتيجة اتحسبت وffmpeg مش جاهز مبقاش ينفع تفضل مكاشّة بعد ما ffmpeg يشتغل (ده كان بيثبّت 360p بس)
  if (cached && !(cached.ffmpegReady === false && ffmpegState.status === 'ready')) return res.json(cached);

  try {
    const info = await getVideoInfo(videoId);
    await waitSettled(info, 7000);   // عشان الجودات العالية (1080/4K) تظهر في القايمة

    // بث مباشر: الجودات الحقيقية من variants الـ HLS
    if (isLiveInfo(info)) {
      const heights = [...new Set(getLiveVariants(info).filter(v => v.muxed && v.height).map(v => v.height))].sort((a, b) => b - a);
      const qualities = [
        { label: 'Auto', quality: 'auto', type: 'hls', playable: true, available: true, url: `/hls/master?v=${encodeURIComponent(videoId)}` },
        ...heights.map(h => ({
          label: `${h}p`, quality: String(h), height: h, type: 'hls', playable: true, available: true,
          url: `/hls/master?v=${encodeURIComponent(videoId)}&quality=${h}`
        }))
      ];
      const liveResult = { id: videoId, title: info.title, live: true, hls: `/hls/master?v=${encodeURIComponent(videoId)}`, count: qualities.length, allHeights: heights, qualities };
      infoCache.set(cacheKey, liveResult, 2 * 60 * 1000);
      return res.json(liveResult);
    }

    const hasFfmpeg = await hasFfmpegNow(8000);

    // بنعرض بس الارتفاعات اللي موجودة فعلًا في الفيديو ده (مفيش جودات وهمية)
    const buckets = new Map();
    for (const f of getVideoFormats(info)) {
      const h = qH(f);
      if (!h) continue;
      const b = buckets.get(h) || { progressive: false, fps: 0 };
      if (f.acodec && f.acodec !== 'none') b.progressive = true;
      b.fps = Math.max(b.fps, Number(f.fps) || 0);
      buckets.set(h, b);
    }
    const heightsDesc = [...buckets.keys()].sort((a, b) => b - a);
    const progressiveHeights = heightsDesc.filter(h => buckets.get(h).progressive);

    const qualities = heightsDesc.map(h => {
      const b = buckets.get(h);
      const playable = b.progressive || hasFfmpeg;
      return {
        label: `${h}p`,
        quality: String(h),
        height: h,
        fps: b.fps || null,
        type: b.progressive ? 'progressive' : (hasFfmpeg ? 'adaptive+ffmpeg' : 'needs-ffmpeg'),
        playable,
        available: playable,
        actualProgressive: b.progressive ? h : null,
        url: `/video?v=${encodeURIComponent(videoId)}&quality=${h}`
      };
    });

    qualities.push({
      label: '🎧 صوت فقط',
      quality: 'audio',
      type: 'audio',
      playable: true,
      available: true,
      url: `/video?v=${encodeURIComponent(videoId)}&quality=audio`
    });

    const result = {
      id: videoId,
      title: info.title,
      count: qualities.length,
      supported: SUPPORTED_QUALITIES,
      progressiveHeights,
      allHeights: heightsDesc,
      ffmpegReady: hasFfmpeg,
      qualities,
      note: hasFfmpeg
        ? 'الجودات دي موجودة فعليًا في الفيديو (progressive أو دمج ffmpeg).'
        : 'الجودات progressive تشتغل فورًا. باقي الجودات تحتاج ffmpeg على السيرفر.'
    };

    const topQ = heightsDesc[0] || 0;
    infoCache.set(cacheKey, result, info.__pending ? 20 * 1000 : (!hasFfmpeg ? 30 * 1000 : (topQ <= 360 ? 3 * 60 * 1000 : CACHE_TTL.info)));
    res.json(result);
  } catch (error) {
    res.locals.__reported = true;
    log.error(`Error fetching qualities: ${cleanErr(error, 200).split('\n')[0]}`, { cat: 'quality', videoId, detail: cleanErr(error), route: req.originalUrl });
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
    ytdlpReady: Boolean(ytdlpState.version),
    ytdlp: { bin: ytdlpState.bin, version: ytdlpState.version, remoteComponents: ytdlpState.remoteComponents, lastError: ytdlpState.lastError, updatedAt: ytdlpState.updatedAt ? new Date(ytdlpState.updatedAt).toISOString() : null },
    ytdlpVersion: ytdlpState.version,   // مكاشّة: execFileSync كان بيقفّل الـ event loop (وبيبطّأ الستريمنج) مع كل /health
    nodeVersion: process.version,
    jsRuntime: detectNodeRuntime() || (commandExists('deno') ? 'deno' : (commandExists('bun') ? 'bun' : null)),
    ffmpegReady: ffmpegState.status === 'ready' || (ffmpegState.status === 'unknown' && commandExists('ffmpeg')),
    ffmpegState: { status: ffmpegState.status, source: ffmpegState.source, lastError: ffmpegState.lastError, attempts: ffmpegState.attempts },
    ffmpegBin: ffmpegBin || null,
    poTokenConfigured: poManager.ready(),
    poToken: poManager.status(),
    cookiesReady,
    cookieUpdateProtected: false,
    concurrency: { metaMax: META_CONCURRENCY, metaCurrent: ytdlpLimiter.current, metaQueued: ytdlpLimiter.queue.length, streamMax: STREAM_CONCURRENCY, streamCurrent: streamLimiter.current, streamQueued: streamLimiter.queue.length }
  });
});

/**
 * POST /api/update-cookies
 * محمي بـ ADMIN_SECRET لو موجود
 */
app.post('/api/update-cookies', async (req, res) => {
  try {
    if (!isAdminAuthorized(req)) {
      return res.status(401).json({ error: 'غير مصرح — أرسل X-Admin-Key أو ?key=' });
    }
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
 * GET /admin  /cookies  /cookies-panel
 * لوحة أدمن كاملة: تحديث الكوكيز + حالة السيرفر + تنظيف الكاش
 * الحماية: لو ADMIN_SECRET موجود في الـ env لازم تبعتها في ?key= أو header X-Admin-Key
 */
const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.CACHE_ADMIN_SECRET || '';

function isAdminAuthorized(req) {
  if (!ADMIN_SECRET) return true; // مفتوح لو مفيش سر
  const key = req.query.key || req.get('x-admin-key') || req.get('x-cache-admin-key') || '';
  return key === ADMIN_SECRET;
}

app.get(['/admin', '/cookies', '/cookies-panel'], (req, res) => {
  if (!isAdminAuthorized(req)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>دخول الأدمن</title>
<style>body{margin:0;font-family:system-ui;background:#0f1115;color:#e8e8e8;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#181b22;border:1px solid #2a2f3a;border-radius:14px;padding:24px;max-width:360px;width:90%}
input{width:100%;padding:12px;border-radius:10px;border:1px solid #2a2f3a;background:#0f1115;color:#fff;margin:12px 0}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#e11d48;color:#fff;font-weight:600;cursor:pointer}</style></head>
<body><div class="card"><h2>🔒 لوحة الأدمن</h2><p style="opacity:.8;font-size:14px">أدخل مفتاح ADMIN_SECRET</p>
<form method="GET"><input name="key" type="password" placeholder="المفتاح السري" autofocus required>
<button type="submit">دخول</button></form></div></body></html>`);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const keyQ = ADMIN_SECRET ? `?key=${encodeURIComponent(req.query.key || '')}` : '';
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة أدمن السيرفر — TITAN</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,'Segoe UI',Tahoma,sans-serif;background:#0b0d12;color:#e8e8e8;padding:16px}
.wrap{max-width:900px;margin:0 auto}
.card{background:#151821;border:1px solid #2a2f3a;border-radius:14px;padding:18px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px;color:#94a3b8}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px}
.stat{background:#0f1115;border-radius:10px;padding:12px;text-align:center}
.stat b{display:block;font-size:18px;color:#4ade80}.stat span{font-size:12px;opacity:.7}
.status{padding:10px 12px;border-radius:10px;background:#20242d;margin-bottom:12px;font-size:14px}
textarea{width:100%;height:220px;background:#0f1115;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:10px;padding:10px;font-family:monospace;font-size:12px;direction:ltr;resize:vertical}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
button,label.btn{flex:1;min-width:110px;padding:12px;border:0;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;text-align:center}
#save{background:#e11d48;color:#fff}#file{display:none}label.btn{background:#2a2f3a;color:#fff}
#clear,#refresh,#clearCache{background:#20242d;color:#e8e8e8}
#msg{margin-top:12px;font-size:14px;min-height:20px}
.ok{color:#4ade80}.err{color:#f87171}
a{color:#60a5fa;text-decoration:none}
.links a{display:inline-block;margin:4px 8px 4px 0;padding:6px 10px;background:#20242d;border-radius:8px;font-size:13px}
</style></head><body><div class="wrap">
<div class="card">
<h1>🛡️ لوحة أدمن TITAN v${SERVER_VERSION}</h1>
<p style="opacity:.7;margin:0 0 12px;font-size:13px">إدارة الكوكيز • حالة السيرفر • تنظيف الكاش</p>
<div class="grid" id="stats">
  <div class="stat"><b id="s-cookies">…</b><span>الكوكيز</span></div>
  <div class="stat"><b id="s-ytdlp">…</b><span>yt-dlp</span></div>
  <div class="stat"><b id="s-ffmpeg">…</b><span>ffmpeg</span></div>
  <div class="stat"><b id="s-uptime">…</b><span>Uptime</span></div>
</div>
<div class="status" id="status">جاري تحميل الحالة...</div>
</div>

<div class="card">
<h2>🍪 تحديث كوكيز يوتيوب (Netscape cookies.txt)</h2>
<textarea id="ta" placeholder="الصق محتوى cookies.txt هنا أو ارفع الملف..."></textarea>
<div class="row">
<button id="save">💾 حفظ وتحديث</button>
<label class="btn" for="file">📂 اختيار ملف</label><input type="file" id="file" accept=".txt,text/plain">
<button id="clear">مسح</button>
<button id="refresh">🔄 تحديث الحالة</button>
</div>
<div id="msg"></div>
</div>

<div class="card" id="incCard">
<style>
.inc-bar{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.inc-bar button{flex:1;min-width:120px;padding:11px;border:0;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;background:#20242d;color:#e8e8e8}
.inc-bar button.primary{background:#e11d48;color:#fff}
.inc-bar button.on{outline:2px solid #60a5fa}
.hint{padding:9px 12px;border-radius:10px;margin:6px 0;font-size:13px;line-height:1.6;background:#20242d}
.hint.bad{border-right:4px solid #f87171}.hint.warn{border-right:4px solid #fbbf24}.hint.ok{border-right:4px solid #4ade80}
.g{background:#0f1115;border:1px solid #2a2f3a;border-radius:10px;padding:10px 12px;margin:8px 0;font-size:13px}
.g .top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.badge{padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700}
.b-error{background:#7f1d1d;color:#fecaca}.b-warn{background:#78350f;color:#fde68a}.b-slow{background:#1e3a8a;color:#bfdbfe}.b-cat{background:#2a2f3a;color:#cbd5e1}
.g pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;direction:ltr;text-align:left;font-size:11.5px;color:#9ca3af;background:#0b0d12;padding:8px;border-radius:8px;max-height:160px;overflow:auto}
.opsline{font-family:monospace;font-size:11.5px;direction:ltr;text-align:left;padding:2px 0;border-bottom:1px solid #1b1f29;word-break:break-word}
.st-row{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid #1b1f29;font-size:13px}
#incList{max-height:560px;overflow:auto}
</style>
<h2>🚨 مشاكل السيرفر وسجل العمليات</h2>
<div class="grid">
  <div class="stat"><b id="i-err">…</b><span>أخطاء (آخر ساعة)</span></div>
  <div class="stat"><b id="i-warn">…</b><span>تحذيرات (آخر ساعة)</span></div>
  <div class="stat"><b id="i-slow">…</b><span>بطء (آخر ساعة)</span></div>
  <div class="stat"><b id="i-q">…</b><span>طابور yt-dlp</span></div>
</div>
<div id="hints"></div>
<div class="inc-bar">
  <button class="primary" id="copyAll">📋 نسخ كل المشاكل</button>
  <button id="selftest">🩺 فحص شامل الآن</button>
  <button id="incRefresh">🔄 تحديث</button>
  <button id="incClear">🗑️ مسح السجل</button>
</div>
<div class="inc-bar">
  <button data-f="all" class="fbtn on">كله</button>
  <button data-f="error" class="fbtn">أخطاء</button>
  <button data-f="warn" class="fbtn">تحذيرات</button>
  <button data-f="slow" class="fbtn">بطء</button>
  <button data-f="ops" class="fbtn">📜 سجل العمليات</button>
</div>
<div id="incMsg" style="min-height:20px;font-size:13px;margin:6px 0"></div>
<div id="stBox"></div>
<div id="incList">جاري التحميل...</div>
<textarea id="copyFallback" style="display:none;height:160px;margin-top:10px" readonly></textarea>
</div>

<div class="card">
<h2>🧰 صيانة</h2>
<div class="row">
<button id="clearCache">🧹 تنظيف كل الكاش</button>
</div>
<div class="links" style="margin-top:14px">
<a href="/health" target="_blank">/health</a>
<a href="/api/performance" target="_blank">/api/performance</a>
<a href="/api/maintenance" target="_blank">/api/maintenance</a>
<a href="/api/diagnostics" target="_blank">/api/diagnostics</a>
<a href="/" target="_blank">قائمة الـ Endpoints</a>
</div>
</div>
</div>
<script>
const KEY = ${JSON.stringify(req.query.key || '')};
const authHeaders = KEY ? {'X-Admin-Key': KEY} : {};
const $=id=>document.getElementById(id);
function fmtUptime(s){const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h+'س '+m+'د'}
async function loadHealth(){
  try{
    const [h,c] = await Promise.all([
      fetch('/health').then(r=>r.json()),
      fetch('/api/cookies-status').then(r=>r.json())
    ]);
    $('s-cookies').textContent = c.hasCookies ? '✅' : '❌';
    $('s-ytdlp').textContent = h.ytdlpReady ? '✅' : '❌';
    $('s-ffmpeg').textContent = h.ffmpegReady ? '✅' : '❌';
    $('s-uptime').textContent = fmtUptime(h.uptime||0);
    $('status').textContent = (c.status||'') + (c.length ? ' — '+c.length+' بايت' : '') + ' | v'+ (h.version||'');
  }catch(e){$('status').textContent='❌ تعذر فحص الحالة: '+e.message}
}
$('file').onchange=async e=>{const f=e.target.files[0];if(f)$('ta').value=await f.text()};
$('clear').onclick=()=>{$('ta').value='';$('msg').textContent=''};
$('refresh').onclick=loadHealth;
$('save').onclick=async()=>{
  const v=$('ta').value.trim();
  if(!v){$('msg').className='err';$('msg').textContent='الصق الكوكيز الأول';return}
  $('save').disabled=true;$('msg').className='';$('msg').textContent='جاري الحفظ...';
  try{
    const r=await fetch('/api/update-cookies',{method:'POST',headers:{'Content-Type':'text/plain; charset=utf-8',...authHeaders},body:v});
    const d=await r.json();
    if(r.ok){$('msg').className='ok';$('msg').textContent=d.message||'تم ✅'}
    else{$('msg').className='err';$('msg').textContent=d.error||'فشل'}
  }catch(e){$('msg').className='err';$('msg').textContent='خطأ اتصال: '+e.message}
  $('save').disabled=false;loadHealth();
};
$('clearCache').onclick=async()=>{
  if(!confirm('تنظيف كل كاش الـ RAM؟'))return;
  try{
    const r=await fetch('/api/cache/clear',{method:'POST',headers:authHeaders});
    const d=await r.json();
    $('msg').className=r.ok?'ok':'err';
    $('msg').textContent=d.message||d.error||JSON.stringify(d);
  }catch(e){$('msg').className='err';$('msg').textContent=e.message}
};
var incFilter = 'all';
function esc2(t){return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function ago2(t){var s=Math.max(0,Math.round((Date.now()-t)/1000));if(s<90)return s+'ث';var m=Math.round(s/60);if(m<90)return m+'د';var h=Math.round(m/60);return h<48?h+'س':Math.round(h/24)+'ي'}
function hhmm(t){return new Date(t).toISOString().slice(11,19)}
function incMsg(t,bad){var m=$('incMsg');m.textContent=t;m.className=bad?'err':'ok'}
function renderGroups(groups){
  if(!groups.length)return '<div class="hint ok">مفيش مشاكل مسجّلة ✅</div>';
  return groups.map(function(g){
    var vids=(g.videos&&g.videos.length)?'<div style="opacity:.7;margin-top:4px">فيديوهات: '+g.videos.map(esc2).join(' , ')+'</div>':'';
    return '<div class="g"><div class="top"><span class="badge b-'+g.level+'">'+g.level.toUpperCase()+'</span><span class="badge b-cat">'+esc2(g.cat)+'</span><b>×'+g.count+'</b><span style="opacity:.6">آخر مرة منذ '+ago2(g.last)+'</span>'+(g.maxMs?'<span style="opacity:.6">أقصى زمن '+g.maxMs+'ms</span>':'')+'</div><div>'+esc2(g.msg)+'</div>'+(g.detail?'<pre>'+esc2(g.detail)+'</pre>':'')+vids+'</div>';
  }).join('');
}
function renderOps(ops){
  if(!ops.length)return '<div class="hint">السجل فاضي</div>';
  return ops.map(function(o){var ic=o.level==='ok'?'✅':o.level==='error'?'❌':o.level==='warn'?'⚠️':'ℹ️';return '<div class="opsline">'+hhmm(o.t)+' '+ic+' '+esc2(o.msg)+'</div>'}).join('');
}
function renderSelfTest(st){
  if(!st)return '';
  return '<div class="g"><b>🩺 آخر فحص شامل ('+hhmm(st.at)+' UTC — '+Math.round(st.totalMs/1000)+'ث)</b>'+st.steps.map(function(s){return '<div class="st-row"><span>'+(s.ok?'✅':'❌')+' '+esc2(s.name)+'</span><span style="opacity:.7;direction:ltr;text-align:left;max-width:60%">'+esc2(s.detail||'')+' ('+s.ms+'ms)</span></div>'}).join('')+'</div>';
}
async function loadIncidents(){
  try{
    var level=(incFilter==='ops')?'all':incFilter;
    var r=await fetch('/api/incidents?level='+level,{headers:authHeaders});
    if(!r.ok)throw new Error('HTTP '+r.status);
    var d=await r.json();
    $('i-err').textContent=d.summary.lastHour.errors;
    $('i-warn').textContent=d.summary.lastHour.warnings;
    $('i-slow').textContent=d.summary.lastHour.slow;
    $('i-q').textContent=d.env.concurrency.procQueued+' / '+d.env.concurrency.procRunning+' شغّال';
    $('hints').innerHTML=d.hints.map(function(h){return '<div class="hint '+(h.lvl==='ok'?'ok':h.lvl)+'">'+(h.lvl==='bad'?'🔴':h.lvl==='warn'?'🟠':'🟢')+' '+esc2(h.text)+'</div>'}).join('');
    $('stBox').innerHTML=renderSelfTest(d.lastSelfTest);
    $('incList').innerHTML=(incFilter==='ops')?renderOps(d.ops):renderGroups(d.groups);
  }catch(e){$('incList').textContent='❌ تعذر تحميل السجل: '+e.message}
}
async function copyText(txt){
  try{await navigator.clipboard.writeText(txt);return true}catch(e){}
  try{var ta=$('copyFallback');ta.style.display='block';ta.value=txt;ta.focus();ta.select();var ok=document.execCommand('copy');if(ok){ta.style.display='none'}return ok}catch(e){return false}
}
$('copyAll').onclick=async function(){
  incMsg('جاري تجهيز التقرير...');
  try{
    var r=await fetch('/api/incidents/report',{headers:authHeaders});
    if(!r.ok)throw new Error('HTTP '+r.status);
    var txt=await r.text();
    var ok=await copyText(txt);
    incMsg(ok?'تم نسخ التقرير كامل ('+txt.length+' حرف) ✅ — الصقه في الشات':'المتصفح منع النسخ التلقائي — حدّدت التقرير في الخانة تحت، انسخه يدوي (Ctrl+C)',!ok);
  }catch(e){incMsg('فشل تجهيز التقرير: '+e.message,true)}
};
$('selftest').onclick=async function(){
  var b=$('selftest');b.disabled=true;incMsg('الفحص الشامل شغّال... ممكن ياخد لحد دقيقتين ⏳');
  try{
    var r=await fetch('/api/selftest',{method:'POST',headers:authHeaders});
    var d=await r.json();
    if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
    var bad=d.steps.filter(function(s){return !s.ok}).length;
    incMsg(bad?('الفحص خلص: '+bad+' خطوة فشلت ❌ (التفاصيل تحت)'):'الفحص خلص: كله سليم ✅',!!bad);
  }catch(e){incMsg('الفحص فشل: '+e.message,true)}
  b.disabled=false;loadIncidents();
};
$('incRefresh').onclick=loadIncidents;
$('incClear').onclick=async function(){
  if(!confirm('مسح كل المشاكل وسجل العمليات؟'))return;
  try{var r=await fetch('/api/incidents/clear',{method:'POST',headers:authHeaders});var d=await r.json();incMsg(d.message||d.error,!r.ok)}catch(e){incMsg(e.message,true)}
  loadIncidents();
};
Array.prototype.forEach.call(document.querySelectorAll('.fbtn'),function(b){
  b.onclick=function(){incFilter=b.getAttribute('data-f');Array.prototype.forEach.call(document.querySelectorAll('.fbtn'),function(x){x.classList.remove('on')});b.classList.add('on');loadIncidents()}
});
loadIncidents();
setInterval(loadIncidents,10000);
loadHealth();
setInterval(loadHealth,30000);
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
    name: '🎬 srver YOUTUBE-FULL — proxy playback, account, captions, chapters, transcript, rich metadata, home sections',
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
      comments: '/comments?v=VIDEO_ID&limit=50',
      captions: '/captions?v=VIDEO_ID',
      captionsFile: '/captions/file?v=VIDEO_ID&lang=ar&ext=vtt',
      audioTracks: '/audio-tracks?v=VIDEO_ID',
      chapters: '/chapters?v=VIDEO_ID',
      transcript: '/transcript?v=VIDEO_ID&lang=ar',
      thumb: '/thumb?v=VIDEO_ID&q=hq',
      embed: '/embed?v=VIDEO_ID',
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
      meSummary: '/api/me/summary',
      meLive: '/api/me/live',
      liveNow: '/api/live?q=QUERY&limit=20&page=1',
      recommendations: '/recommendations?region=EG&page=1&limit=20',
      adminPanel: '/admin (أو /cookies) — لوحة أدمن الكوكيز والحالة',
      cookiesStatus: '/api/cookies-status',
      testAll: '/api/test-all?v=dQw4w9WgXcQ&channel=UCuAXFkgsw1L7xaCfnd5JJOw',
      clearCache: 'POST /api/cache/clear (يتطلب ADMIN_SECRET)'
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
    // Google suggest أسرع بمراحل من yt-dlp search
    const url = `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}`;
    const body = await new Promise((resolve, reject) => {
      https.get(url, { agent: keepAliveAgent, timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve(d));
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('suggest timeout')); });
    });
    let suggestions = [];
    try {
      const parsed = JSON.parse(body);
      const list = Array.isArray(parsed) ? parsed[1] : [];
      suggestions = (list || []).map(x => Array.isArray(x) ? x[0] : x).filter(Boolean).slice(0, 10);
    } catch {
      suggestions = [];
    }
    // لو جوجل فاضي — fallback خفيف
    if (!suggestions.length) {
      try {
        const results = await searchVideos(q, 5);
        const seen = new Set();
        suggestions = results.map(v => v.title).filter(t => t && !seen.has(t) && seen.add(t)).slice(0, 8);
      } catch {}
    }
    const out = { query: q, suggestions };
    suggestionCache.set(key, out, CACHE_TTL.suggestions);
    res.json(out);
  } catch {
    res.json({ query: q, suggestions: [] });
  }
});

// ==========================================================================
// 🔥 Prefetch endpoint: frontend can warm metadata/related before opening.
// It never returns cookies or upstream credentials.
// ==========================================================================
app.get('/api/prefetch', async (req, res) => {
  const id = String(req.query.v || '');
  if (!isValidVideoId(id)) return res.status(400).json({ error: 'Video ID غير صحيح' });
  // رد فوري + تسخين في الخلفية (ستريم + related) عشان أول play يبقى أسرع
  res.json({ id, queued: true });
  setImmediate(() => {
    getRelatedVideos(id, 16).catch(() => {});
    getVideoInfo(id).catch(() => {}).then(() => getFastStreamUrl(id)).catch(() => {});
  });
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
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'غير مصرح — أرسل X-Admin-Key أو ?key=' });
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
    ytdlp: { version: ytdlpState.version, bin: ytdlpState.bin, remoteComponents: ytdlpState.remoteComponents, lastError: ytdlpState.lastError, updatedAt: ytdlpState.updatedAt ? new Date(ytdlpState.updatedAt).toISOString() : null },
    steps: []
  };

  try {
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

    // فحص حقيقي لكل مصدر: بنجرّب طلب صغير على الرابط بدون كوكيز ومعاها (من غير ما نعرض الروابط نفسها)
    const fm = (info.formats || []).filter(f => f && typeof f.url === 'string' && !isHlsUrl(f.url) && /^https?$/.test(String(f.protocol || 'https')));
    const progressive = fm.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none').slice(0, 4);
    const videoOnly = fm.filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none')).sort((a, b) => (b.height || 0) - (a.height || 0)).slice(0, 3);
    const audioOnly = fm.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')).slice(0, 1);
    const probes = [];
    for (const f of [...progressive, ...videoOnly, ...audioOnly]) {
      usableDirectUrl(f);
      const row = { formatId: String(f.format_id), height: f.height || null, vcodec: f.vcodec, acodec: f.acodec, ua: String((f.http_headers || {})['User-Agent'] || '').slice(0, 40) || null };
      for (const [label, withCookies] of [['noCookies', false], ['withCookies', true]]) {
        try { row[label] = (await probeOnce(f.url, buildUpstreamHeaders(f.url, { withCookies }))).status; }
        catch (e) { row[label] = 'ERR ' + String(e.message || e).slice(0, 40); }
      }
      probes.push(row);
    }
    out.probes = probes;

    const t1 = Date.now();
    try {
      const fast = await getFastStreamUrl(id);
      out.steps.push({ name: 'fast-source', ok: true, ms: Date.now() - t1, urlLength: fast.length });
    } catch (e) {
      out.steps.push({ name: 'fast-source', ok: false, ms: Date.now() - t1, error: String(e.message || e).split('\n')[0] });
    }

    out.totalMs = Date.now() - started;
    out.ok = out.steps.every(s => s.ok);
    const good = probes.filter(p => [200, 206].includes(p.noCookies) || [200, 206].includes(p.withCookies));
    out.hint = !probes.length ? 'مفيش formats بروابط مباشرة — غالبًا yt-dlp قديم أو يوتيوب رفض: حدّث yt-dlp وجدّد الكوكيز'
      : !good.length ? 'كل الروابط بترجع 403/خطأ من جوجل: yt-dlp قديم أو الـ IP/الكوكيز/PO Token مرفوضين'
      : 'في روابط شغالة — السيرفر هيستخدمها تلقائيًا';
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
  const started = Date.now();

  try {
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

/**
 * GET /api/me/summary
 * ملخص سريع لحسابك: آخر المشاهدات + الاشتراكات + اللايكات + القوائم
 */
app.get('/api/me/summary', requireCookies, async (req, res) => {
  try {
    const started = Date.now();
    const [history, subscriptions, liked, playlists, channels] = await Promise.allSettled([
      fetchAccountList('history', 8),
      fetchAccountList('subscriptions', 8),
      fetchAccountList('liked', 8),
      fetchAccountPlaylists(20),
      fetchAccountChannels(30)
    ]);
    res.json({
      personalized: true,
      tookMs: Date.now() - started,
      history: history.status === 'fulfilled' ? history.value : [],
      subscriptions: subscriptions.status === 'fulfilled' ? subscriptions.value : [],
      liked: liked.status === 'fulfilled' ? liked.value : [],
      playlists: playlists.status === 'fulfilled' ? playlists.value : [],
      channels: channels.status === 'fulfilled' ? channels.value : [],
      counts: {
        history: history.status === 'fulfilled' ? history.value.length : 0,
        subscriptions: subscriptions.status === 'fulfilled' ? subscriptions.value.length : 0,
        liked: liked.status === 'fulfilled' ? liked.value.length : 0,
        playlists: playlists.status === 'fulfilled' ? playlists.value.length : 0,
        channels: channels.status === 'fulfilled' ? channels.value.length : 0
      }
    });
  } catch (e) {
    res.status(502).json({ error: 'تعذّر بناء ملخص الحساب' });
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

// ==========================================================================
// 🧪 لوحة التجربة: /test — حالة السيرفر + تشغيل فيديو/صوت + اختبار الجودات
// محمية بـ ADMIN_SECRET لو موجود (?key=...)
// ==========================================================================
const TEST_PAGE_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة التجربة</title>
<style>
body{font-family:system-ui,Tahoma,sans-serif;background:#0f1115;color:#eee;margin:0 auto;padding:16px;max-width:900px}
h2{margin:8px 0}
.card{background:#181b22;border:1px solid #262b36;border-radius:12px;padding:14px;margin:12px 0}
input,select,button{font-size:16px;padding:10px;border-radius:8px;border:1px solid #333;background:#0f1115;color:#eee}
button{background:#e11d48;border:0;cursor:pointer;color:#fff;font-weight:bold}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
.ok{color:#4ade80}.bad{color:#f87171}
pre{white-space:pre-wrap;word-break:break-all;background:#0b0d11;padding:10px;border-radius:8px;font-size:13px;max-height:280px;overflow:auto}
video{width:100%;max-height:480px;background:#000;border-radius:10px}
#msg{margin:6px 0;font-weight:bold}
</style></head><body>
<h2>🎬 لوحة الإدارة والتجربة</h2>

<div class="card"><b>حالة السيرفر</b>
<div id="status">جاري التحميل...</div>
<div class="row"><button onclick="loadStatus()">تحديث الحالة</button></div>
</div>

<div class="card"><b>تجربة تشغيل فيديو</b>
<div class="row"><input id="vid" value="XiHeZamhotQ" placeholder="Video ID (11 حرف)" style="flex:1;min-width:200px"></div>
<div class="row">
<select id="q">
<option value="">افتراضي (360)</option>
<option value="144">144p</option>
<option value="240">240p</option>
<option value="360">360p</option>
<option value="480">480p</option>
<option value="720">720p</option>
<option value="1080">1080p</option>
<option value="audio">صوت فقط</option>
</select>
<button onclick="play()">▶ شغّل</button>
<button onclick="checkQ()">اختبار الجودات</button>
</div>
<div id="msg"></div>
<video id="player" controls playsinline></video>
</div>

<div class="card"><b>تفاصيل آخر طلب</b><pre id="out">-</pre></div>

<script>
var KEY = new URLSearchParams(location.search).get('key') || '';
function withKey(path) {
  if (!KEY) return path;
  return path + (path.indexOf('?') > -1 ? '&' : '?') + 'key=' + encodeURIComponent(KEY);
}
function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function show(x) { document.getElementById('out').textContent = (typeof x === 'string') ? x : JSON.stringify(x, null, 2); }
function msg(t, bad) { var m = document.getElementById('msg'); m.textContent = t; m.className = bad ? 'bad' : 'ok'; }
function getJson(path) {
  return fetch(withKey(path)).then(function (r) {
    return r.text().then(function (t) {
      var j; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 500) }; }
      return { status: r.status, body: j };
    });
  });
}

function loadStatus() {
  Promise.all([
    getJson('/health'),
    getJson('/api/po-token/status'),
    getJson('/api/cookies-status')
  ]).then(function (a) {
    var health = a[0].body, po = a[1].body, ck = a[2].body;
    var rows = [];
    rows.push('الكوكيز: ' + (ck.hasCookies ? '<span class="ok">✅ موجودة</span>' : '<span class="bad">❌ فارغة</span>'));
    rows.push('PO Token: ' + (po.hasToken ? '<span class="ok">✅ ' + esc(po.mode) + '</span>' : '<span class="bad">❌ ' + esc(po.mode) + '</span>'));
    if (po.lastError) rows.push('<span class="bad">سبب: ' + esc(po.lastError) + '</span>');
    if (health && health.ffmpegReady !== undefined) {
      rows.push('ffmpeg: ' + (health.ffmpegReady ? '<span class="ok">✅</span>' : '<span class="bad">❌</span>'));
    }
    document.getElementById('status').innerHTML = rows.join('<br>');
    show({ health: a[0], poToken: a[1], cookies: a[2] });
  }).catch(function (e) {
    document.getElementById('status').innerHTML = '<span class="bad">تعذّر الاتصال: ' + esc(e) + '</span>';
  });
}

function play() {
  var id = document.getElementById('vid').value.trim();
  var qv = document.getElementById('q').value;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) { msg('Video ID لازم يكون 11 حرف', true); return; }
  var url = '/video?v=' + id + (qv ? '&quality=' + qv : '');
  var player = document.getElementById('player');
  player.onerror = function () { msg('المشغّل ما قدرش يشغّل المصدر — شوف التفاصيل تحت', true); };
  if (!qv) {
    msg('بيشغّل الافتراضي...');
    show({ url: url });
    player.src = url;
    player.play().catch(function () {});
    return;
  }
  msg('جاري التحضير... (أول مرة ممكن ياخد 10-40 ثانية)');
  getJson(url + '&probe=1').then(function (x) {
    show(x);
    if (x.status >= 400) {
      var b = x.body || {};
      msg('فشل (' + x.status + '): ' + (b.error || 'خطأ') + (b.hint ? ' — ' + b.hint : ''), true);
      return;
    }
    msg('تم التحضير، بيشغّل...');
    player.src = url;
    player.play().catch(function () {});
  }).catch(function (e) { msg('خطأ شبكة: ' + e, true); });
}

function checkQ() {
  var id = document.getElementById('vid').value.trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) { msg('Video ID لازم يكون 11 حرف', true); return; }
  msg('بيفحص الجودات...');
  getJson('/video/qualities?v=' + id).then(function (x) {
    show(x);
    if (x.status >= 400) { msg('فشل الفحص (' + x.status + ')', true); return; }
    var list = (x.body.qualities || []).map(function (q) {
      return (q.label || q.quality) + ' → ' + (q.type || '?') + (q.playable ? ' ✅' : ' ❌');
    });
    msg('الجودات: ' + (list.length ? list.join(' | ') : 'مفيش'));
  }).catch(function (e) { msg('خطأ شبكة: ' + e, true); });
}

loadStatus();
</script>
</body></html>`;

app.get('/test', (req, res) => {
  if (!isAdminAuthorized(req)) {
    return res.status(401).type('text/plain; charset=utf-8').send('غير مصرح — أضف ?key=ADMIN_SECRET للرابط');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(TEST_PAGE_HTML);
});

// ==========================================================================
// 🧾 تقرير المشاكل + تشخيص تلقائي + فحص ذاتي (v13.7)
// GET  /api/incidents          → JSON للوحة
// GET  /api/incidents/report   → نص كامل جاهز للنسخ وإرساله
// POST /api/incidents/clear    → مسح السجل
// GET|POST /api/selftest       → فحص شامل (yt-dlp, ffmpeg, استخراج, ترجمة, صوت, جودات) بيتسجّل نتيجته
// ==========================================================================
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}ث`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}د`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}س` : `${Math.round(h / 24)}ي`;
}
const tsShort = (t) => new Date(t).toISOString().replace('T', ' ').slice(5, 19);

function envSnapshot() {
  const mem = process.memoryUsage();
  return {
    version: SERVER_VERSION,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    ytdlp: { version: ytdlpState.version, bin: ytdlpState.bin, remoteComponents: ytdlpState.remoteComponents, lastError: ytdlpState.lastError, updatedAt: ytdlpState.updatedAt ? new Date(ytdlpState.updatedAt).toISOString() : null },
    ffmpeg: { status: ffmpegState.status, source: ffmpegState.source, bin: ffmpegState.bin, lastError: ffmpegState.lastError, attempts: ffmpegState.attempts },
    jsRuntime: detectNodeRuntime() || (commandExists('deno') ? 'deno' : (commandExists('bun') ? 'bun' : null)),
    cookies: { ready: cookiesReady, bytes: lastCookiesContent.length },
    poToken: poManager.status(),
    memory: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), containerLimitMb: containerMemMb() },
    cpu: Number(containerCpus().toFixed(2)),
    concurrency: {
      procMax: PROC_MAX, procRunning: procLimiter.current, procQueued: procLimiter.queued,
      meta: { max: META_CONCURRENCY, running: ytdlpLimiter.current, queued: ytdlpLimiter.queue.length },
      stream: { max: STREAM_CONCURRENCY, running: streamLimiter.current, queued: streamLimiter.queue.length }
    },
    spawn: { stream: spawnSummary('stream'), meta: spawnSummary('meta') },
    caches: { info: infoCache.stats(), stream: streamCache.stats(), fastStream: fastStreamCache.stats(), search: searchCache.stats(), subtitles: subtitleCache.stats() }
  };
}

// تشخيص مبدئي من الحالة + المشاكل الأخيرة — بيقولك "غالبًا المشكلة فين"
function diagnose() {
  const env = envSnapshot();
  const hints = [];
  const add = (lvl, text) => hints.push({ lvl, text });
  if (env.ffmpeg.status !== 'ready') add('bad', `ffmpeg مش شغال (الحالة: ${env.ffmpeg.status}) → من غيره مفيش غير الجودات الجاهزة (360p). آخر خطأ: ${env.ffmpeg.lastError || 'لسه بيحاول'}. الحل الدائم: ضيف ffmpeg-static في package.json أو ثبّت ffmpeg في الـ build.`);
  if (!env.ytdlp.version) add('bad', 'yt-dlp مش بيشتغل خالص (مفيش version) → كل الفيديوهات/الترجمة/الصوت هتفشل.');
  else if (env.ytdlp.lastError) add('warn', `تحديث yt-dlp الأوتوماتيك فشل: ${env.ytdlp.lastError} (النسخة الحالية ${env.ytdlp.version}) — نسخة قديمة = مشاكل 403/جودات ناقصة.`);
  if (!env.cookies.ready) add('warn', 'الكوكيز مش موجودة → الترجمات والدبلجات (المقاطع الصوتية) والمقترح الشخصي غالبًا هتفشل. ارفعها من الخانة اللي فوق.');
  if (!env.jsRuntime) add('warn', 'مفيش node/deno متاح لـ yt-dlp → حل تحدي n/sig هيفشل وروابط web هترجع 403.');
  if (env.poToken.mode === 'none') add('warn', `PO Token مش متولّد${env.poToken.lastError ? ': ' + env.poToken.lastError : ''} → ممكن روابط web/الترجمة ترفضها يوتيوب.`);
  if (env.concurrency.procQueued > 3) add('warn', `طابور yt-dlp مزدحم (${env.concurrency.procQueued} مستنيين من ${env.concurrency.procMax} مسموح) → ده سبب بطء مباشر. زوّد رام/CPU للسيرفر أو YTDLP_MAX_PROCS.`);
  if (env.spawn.stream.p95Ms > 20000) add('warn', `عمليات yt-dlp بطيئة (p95 = ${Math.round(env.spawn.stream.p95Ms / 1000)}ث) → غالبًا يوتيوب بيتأخر/بيحظر، أو المعالج ضعيف.`);
  if (env.memory.containerLimitMb && env.memory.rssMb > env.memory.containerLimitMb * 0.8) add('warn', `استهلاك الرام عالي (${env.memory.rssMb}MB من ${env.memory.containerLimitMb}MB).`);

  const since = Date.now() - 6 * 3600 * 1000;
  const recent = [...incStore.groups.values()].filter(g => g.last > since && g.level !== 'slow');
  const blob = recent.map(g => `${g.msg}\n${g.detail}`).join('\n');
  const rules = [
    [/page needs to be reloaded/i, 'bad', 'يوتيوب بيرد "The page needs to be reloaded" مع الكوكيز → الكوكيز غالبًا اتلغت/اتبدّلت (يوتيوب بيقفل الجلسة لما الحساب يتفتح في متصفح بعد التصدير). صدّر كوكيز جديدة من نافذة Incognito، واقفلها فورًا، وماتفتحش الحساب تاني.'],
    [/sign in to confirm|not a bot/i, 'bad', 'يوتيوب شاكك إن السيرفر بوت (Sign in to confirm) → جدّد الكوكيز (حساب مسجّل دخول، صيغة Netscape) وتأكد إن IP السيرفر مش محظور.'],
    [/po.?token/i, 'warn', 'ظهرت أخطاء متعلقة بـ PO Token → راجع حالة التوليد التلقائي (bgutils-js + jsdom لازم يكونوا منصّبين).'],
    [/http error 403|upstream rejected|\(403\)|status.?403/i, 'warn', 'روابط جوجل بترجع 403 → غالبًا PO Token/كوكيز/IP أو yt-dlp قديم. جرّب /api/video-debug?v=ID.'],
    [/429|too many requests/i, 'warn', 'يوتيوب بيعمل Rate limit (429) → قلّل الطلبات المتوازية أو استنى شوية.'],
    [/n challenge|nsig|signature solving|js.?runtime|ejs|jsc/i, 'warn', 'فشل حل تحدي n/sig → لازم node شغال و yt-dlp محدّث (--remote-components ejs:github محتاج وصول لـ GitHub).'],
    [/requested format is not available/i, 'warn', 'الفورمات المطلوبة مش متاحة → يوتيوب بيخفي روابط الـ client ده (SABR/PO Token). التجربة بتتكرر على clients تانية تلقائيًا.'],
    [/timeout|timed out|\[timeout|sigterm|killed/i, 'warn', 'عمليات بتنتهي بـ timeout → بطء من يوتيوب أو ضغط على السيرفر.'],
    [/enotfound|eai_again|econnreset|etimedout|econnrefused/i, 'warn', 'أخطاء شبكة (DNS/اتصال) → مشكلة في خروج السيرفر للإنترنت.'],
    [/download HTTP 4|github/i, 'warn', 'تنزيل من GitHub فشل → ffmpeg/تحديث yt-dlp محتاجين وصول لـ GitHub.']
  ];
  for (const [re, lvl, text] of rules) if (re.test(blob)) add(lvl, text);
  const degraded = recent.find(g => /info degraded/.test(g.msg));
  if (degraded) add('warn', 'فيه فيديوهات استخراجها رجّع أعلى جودة 360p أو أقل → التفاصيل في مشكلة "info degraded" تحت (الـ clients اللي اتجرّبت ونتيجة كل واحد).');
  if (!hints.length) add('ok', 'مفيش مشاكل واضحة في الحالة الحالية. لو لسه فيه شكوى، شغّل "الفحص الشامل" وابعت التقرير.');
  return hints;
}

function sortedGroups(levelFilter) {
  const rank = { error: 0, warn: 1, slow: 2 };
  return [...incStore.groups.values()]
    .filter(g => !levelFilter || levelFilter === 'all' || g.level === levelFilter)
    .sort((a, b) => (rank[a.level] - rank[b.level]) || (b.last - a.last));
}

function incidentSummary() {
  const hourAgo = Date.now() - 3600 * 1000;
  const count = (lvl, since = 0) => incStore.events.filter(e => e.level === lvl && e.t > since).length;
  return {
    lastHour: { errors: count('error', hourAgo), warnings: count('warn', hourAgo), slow: count('slow', hourAgo) },
    stored: { errors: count('error'), warnings: count('warn'), slow: count('slow'), groups: incStore.groups.size, ops: incStore.ops.length },
    since: new Date(incStore.events[0] ? incStore.events[0].t : incStore.startedAt).toISOString()
  };
}

function buildReport() {
  const L = [];
  const P = (s = '') => L.push(s);
  const env = envSnapshot();
  const icon = { error: '❌', warn: '⚠️', slow: '🐢' };
  P('════════ تقرير مشاكل السيرفر (TITAN) ════════');
  P(`الوقت (UTC): ${new Date().toISOString()}`);
  P(`النسخة: ${env.version} | Uptime: ${fmtDur(env.uptimeSec * 1000)} | Node ${env.node}`);
  P('');
  P('── الحالة ──');
  P(`yt-dlp: ${env.ytdlp.version || 'مش شغال'} | bin=${env.ytdlp.bin} | remote-components=${env.ytdlp.remoteComponents} | آخر تحديث=${env.ytdlp.updatedAt || '-'}${env.ytdlp.lastError ? ' | خطأ التحديث: ' + env.ytdlp.lastError : ''}`);
  P(`ffmpeg: ${env.ffmpeg.status}${env.ffmpeg.source ? ' (' + env.ffmpeg.source + ')' : ''}${env.ffmpeg.lastError ? ' | خطأ: ' + env.ffmpeg.lastError : ''}`);
  P(`JS runtime: ${env.jsRuntime || 'مفيش'} | كوكيز: ${env.cookies.ready ? 'موجودة (' + env.cookies.bytes + 'B)' : 'مفيش'} | PO Token: ${env.poToken.mode}${env.poToken.lastError ? ' (' + env.poToken.lastError + ')' : ''}`);
  P(`رام: ${env.memory.rssMb}MB / حد الحاوية ${env.memory.containerLimitMb}MB | CPU: ${env.cpu}`);
  P(`طابور yt-dlp: شغّال ${env.concurrency.procRunning}/${env.concurrency.procMax} | مستنّي ${env.concurrency.procQueued}`);
  P(`زمن yt-dlp: stream avg=${env.spawn.stream.avgMs}ms p95=${env.spawn.stream.p95Ms}ms (فشل ${env.spawn.stream.fails}/${env.spawn.stream.runs}) | meta avg=${env.spawn.meta.avgMs}ms p95=${env.spawn.meta.p95Ms}ms (فشل ${env.spawn.meta.fails}/${env.spawn.meta.runs})`);
  P(`كاش info: ${env.caches.info.entries} (hit ${env.caches.info.hits}/miss ${env.caches.info.misses}) | stream: ${env.caches.stream.entries}`);
  const sum = incidentSummary();
  P(`آخر ساعة: ${sum.lastHour.errors} أخطاء، ${sum.lastHour.warnings} تحذيرات، ${sum.lastHour.slow} بطء`);
  P('');
  P('── التشخيص المبدئي ──');
  for (const h of diagnose()) P(`${h.lvl === 'bad' ? '🔴' : h.lvl === 'warn' ? '🟠' : '🟢'} ${h.text}`);
  P('');
  const groups = sortedGroups('all').slice(0, 40);
  P(`── المشاكل المتكررة (${groups.length}) ──`);
  if (!groups.length) P('(مفيش)');
  groups.forEach((g, i) => {
    P(`[${i + 1}] ${icon[g.level] || ''} ${g.level.toUpperCase()} · ${g.cat} · ×${g.count} · آخر مرة منذ ${fmtDur(Date.now() - g.last)} · أول مرة ${tsShort(g.first)}${g.maxMs ? ' · أقصى زمن ' + g.maxMs + 'ms' : ''}`);
    P(`    ${g.msg}`);
    if (g.detail) P(g.detail.split('\n').map(x => '    ↳ ' + x).join('\n'));
    if (g.videos && g.videos.length) P(`    فيديوهات: ${g.videos.join(', ')}`);
  });
  P('');
  const evs = incStore.events.slice(-80);
  P(`── آخر ${evs.length} حدث (الأحدث تحت) ──`);
  for (const e of evs) {
    const extra = [e.videoId && `v=${e.videoId}`, e.route && e.route, e.status && `HTTP ${e.status}`, e.ms != null && `${e.ms}ms`, e.reqId && `req=${e.reqId}`].filter(Boolean).join(' ');
    P(`${tsShort(e.t)} ${icon[e.level] || ''}[${e.cat}] ${e.msg}${extra ? '  {' + extra + '}' : ''}`);
    if (e.detail) P('      ↳ ' + e.detail.split('\n').slice(0, 3).join(' | ').slice(0, 300));
  }
  P('');
  const ops = incStore.ops.slice(-60);
  P(`── سجل العمليات (آخر ${ops.length}) ──`);
  for (const o of ops) P(`${tsShort(o.t)} ${o.level === 'ok' ? '✅' : o.level === 'error' ? '❌' : o.level === 'warn' ? '⚠️' : 'ℹ️'} ${o.msg}`);
  const st = incStore.lastSelfTest;
  if (st) {
    P('');
    P(`── آخر فحص شامل (${tsShort(st.at)} UTC، فيديو ${st.videoId}، ${st.totalMs}ms) ──`);
    for (const s of st.steps) P(`${s.ok ? '✅' : '❌'} ${s.name} (${s.ms}ms) ${s.detail || ''}`);
  }
  P('');
  P('════════ نهاية التقرير ════════');
  return L.join('\n');
}

let selfTestRunning = false;
// تفاصيل رابط: format + حالة الرد بدون/مع كوكيز (عشان نعرف ليه 403)
async function describeUrlProbe(f) {
  const u = f && f.url;
  if (!u) return `${f && f.format_id}: مفيش url`;
  const res = [];
  for (const withCookies of [false, true]) {
    try { res.push(`${withCookies ? 'كوكيز' : 'بدون'}=${(await probeOnce(u, buildUpstreamHeaders(u, { withCookies }))).status}`); }
    catch (e) { res.push(`${withCookies ? 'كوكيز' : 'بدون'}=${String(e.message || e).slice(0, 30)}`); }
  }
  return `${f.format_id}[${f.format_note || f.ext || ''}|${f.protocol || ''}${/[?&]pot=/.test(u) ? '|pot' : ''}${/[?&]sabr=/.test(u) ? '|sabr' : ''}] ${res.join(' ')}`;
}
async function runSelfTest(videoId = 'dQw4w9WgXcQ') {
  const steps = [];
  const t00 = Date.now();
  const step = async (name, fn, timeoutMs = 30000) => {
    const t = Date.now();
    let timer;
    try {
      const r = await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`انتهى وقت الخطوة (${Math.round(timeoutMs / 1000)}ث)`)), timeoutMs); })]);
      const ok = r && r.ok !== undefined ? !!r.ok : true;
      steps.push({ name, ok, ms: Date.now() - t, detail: (r && r.detail) || '' });
      if (!ok) addIncident('error', `فحص ذاتي فشل: ${name}`, { cat: 'selftest', detail: r && r.detail, ms: Date.now() - t, videoId });
    } catch (e) {
      steps.push({ name, ok: false, ms: Date.now() - t, detail: cleanErr(e, 300) });
      addIncident('error', `فحص ذاتي فشل: ${name}`, { cat: 'selftest', detail: cleanErr(e), ms: Date.now() - t, videoId });
    } finally { clearTimeout(timer); }
  };

  await step('yt-dlp شغّال', async () => ({ ok: !!ytdlpState.version, detail: `${ytdlpState.version || 'مفيش'} (${ytdlpState.bin})` }), 5000);
  await step('ffmpeg جاهز ويدعم https', async () => {
    const ok = await hasFfmpegNow(25000);
    if (!ok) return { ok: false, detail: `الحالة ${ffmpegState.status}: ${ffmpegState.lastError || '-'}` };
    const { stdout } = await execFileAsync(ffmpegBin, ['-hide_banner', '-protocols'], { timeout: 10000, maxBuffer: 1024 * 1024 });
    const hasHttps = /\bhttps\b/.test(stdout);
    return { ok: hasHttps, detail: `${ffmpegState.source || 'system'} — ${hasHttps ? 'https مدعوم' : 'مفيش دعم https (مش هينفع للدمج)'}` };
  }, 40000);
  await step('الاتصال بيوتيوب', async () => {
    const r = await httpGetText('https://www.youtube.com/robots.txt', { timeout: 8000 });
    return { ok: r.status === 200, detail: `HTTP ${r.status}` };
  }, 10000);
  await step('الاتصال بـ GitHub (للتحديث/ffmpeg)', async () => {
    const r = await httpGetText('https://api.github.com/rate_limit', { timeout: 8000 });
    return { ok: r.status === 200, detail: `HTTP ${r.status}` };
  }, 10000);
  await step('الكوكيز', async () => ({ ok: cookiesReady, detail: cookiesReady ? `${lastCookiesContent.length} بايت` : 'مفيش كوكيز' }), 3000);

  let info = null;
  await step('استخراج بيانات الفيديو + الجودات', async () => {
    forgetVideo(videoId);
    info = await getVideoInfo(videoId);
    await waitSettled(info, 30000);
    const heights = getAvailableQualities(info);
    const maxH = heights[0] || 0;
    return { ok: maxH > 360, detail: `جودات: ${heights.join(',') || 'مفيش'} | formats=${(info.formats || []).length}${maxH <= 360 ? ' ← أعلى جودة 360 أو أقل (غير طبيعي للفيديو ده)' : ''}` };
  }, 120000);
  if (info) {
    await step('الترجمة', async () => {
      await waitSettled(info, 25000);
      const withSubs = await ensureSubtitles(videoId, info);
      const langs = [...Object.keys(withSubs.subtitles || {}), ...Object.keys(withSubs.automatic_captions || {})];
      if (!langs.length) return { ok: false, detail: 'مفيش لغات ترجمة اتلقت' };
      const lang = langs.includes('en') ? 'en' : langs[0];
      const body = await getSubtitleBody(videoId, withSubs, lang, 'vtt');
      return { ok: !!(body && body.body && body.body.length > 20), detail: `${langs.length} لغة | تحميل ${lang} عن طريق ${body && body.via}` };
    }, 90000);
    await step('المقاطع الصوتية', async () => {
      await waitSettled(info, 15000);
      const audio = (info.formats || []).filter(f => f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && !isManifestFormat(f));
      const langs = [...new Set(audio.map(f => f.language || 'und'))];
      const url = pickBestAudioUrl(info);
      const ok = !!url && await verifyUrl(url);
      const extra = ok ? '' : ' | ' + await describeUrlProbe(audio.find(f => f.url === url) || audio[0]);
      return { ok, detail: `${audio.length} مسار | لغات: ${langs.join(',')} | الرابط ${ok ? 'شغّال' : 'مرفوض/مفيش'}${extra}` };
    }, 40000);
    await step('بث 360p (progressive)', async () => {
      const u = await getFastStreamUrl(videoId);
      return { ok: !!u, detail: u ? 'رابط متحقق منه' : 'مفيش رابط' };
    }, 60000);
    await step('بث 1080p (دمج ffmpeg)', async () => {
      const heights = getAvailableQualities(info);
      if (!heights.includes(1080)) return { ok: true, detail: 'الفيديو ده مفيهوش 1080 — اتخطّى' };
      const sel = chooseQualityFormats(info, 1080);
      if (sel.mode === 'direct') {
        const u = usableDirectUrl((info.formats || []).find(f => String(f.format_id) === sel.videoFormatId));
        return { ok: !!u && await verifyUrl(u), detail: 'progressive مباشر' };
      }
      const vUrl = usableDirectUrl((info.formats || []).find(f => String(f.format_id) === sel.videoFormatId));
      const aUrl = usableDirectUrl((info.formats || []).find(f => String(f.format_id) === sel.audioFormatId));
      const ok = !!(vUrl && aUrl) && await verifyAll([vUrl, aUrl]);
      const extra = ok ? '' : ' | فيديو: ' + await describeUrlProbe((info.formats || []).find(f => String(f.format_id) === sel.videoFormatId)) + ' | صوت: ' + await describeUrlProbe((info.formats || []).find(f => String(f.format_id) === sel.audioFormatId));
      return { ok, detail: ok ? 'روابط الفيديو والصوت متحقق منها' : 'روابط الفيديو/الصوت مرفوضة (403) أو ناقصة — ده سبب إن الجودات العالية مش بتشتغل' + extra };
    }, 60000);
  }
  const result = { at: Date.now(), videoId, totalMs: Date.now() - t00, steps };
  incStore.lastSelfTest = result;
  return result;
}

app.get('/api/incidents', (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'غير مصرح' });
  const level = String(req.query.level || 'all');
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    summary: incidentSummary(),
    env: envSnapshot(),
    hints: diagnose(),
    groups: sortedGroups(level).slice(0, 60),
    events: incStore.events.slice(-120).reverse(),
    ops: incStore.ops.slice(-150).reverse(),
    lastSelfTest: incStore.lastSelfTest
  });
});
app.get('/api/incidents/report', (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).type('text/plain; charset=utf-8').send('غير مصرح');
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/plain; charset=utf-8').send(buildReport());
});
app.post('/api/incidents/clear', (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'غير مصرح' });
  incStore.events = []; incStore.groups.clear(); incStore.ops = []; incStore.dirty = true; incStore.lastSelfTest = null;
  saveIncidents();
  res.json({ success: true, message: 'تم مسح سجل المشاكل والعمليات' });
});
app.all('/api/selftest', async (req, res) => {
  if (!isAdminAuthorized(req)) return res.status(401).json({ error: 'غير مصرح' });
  if (selfTestRunning) return res.status(409).json({ error: 'فحص شغّال دلوقتي — استنى لحد ما يخلص' });
  const vid = isValidVideoId(String(req.query.v || '')) ? String(req.query.v) : 'dQw4w9WgXcQ';
  selfTestRunning = true;
  try { res.json(await runSelfTest(vid)); }
  catch (e) { res.status(500).json({ error: 'الفحص نفسه فشل', details: cleanErr(e) }); }
  finally { selfTestRunning = false; }
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
    ['comments', `/comments?v=${encodeURIComponent(videoId)}&limit=5`],
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

// 404 + Error handler — لازم يكونوا آخر حاجة (قبل كده /api/test-all كانت متسجّلة بعدهم فمكانتش بتشتغل أبدًا)
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint غير موجود', path: req.path });
});
app.use((err, req, res, next) => {
  res.locals.__reported = true;
  log.error(`Unhandled error: ${String(err && err.message || err)}`, { cat: catFromPath(req.path), route: req.originalUrl, detail: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : '' });
  if (res.headersSent) return;
  res.status(500).json({
    error: 'خطأ في السيرفر',
    details: NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
// ==========================================================================
// 🧠 Memory watchdog (v13.6) — لو الرام قربت من الحد (Railway بيقتل العملية) بنفضّي الكاشات التقيلة بدل ما السيرفر يقع.
// الحد: MEM_SOFT_LIMIT_MB أو 70% من حد الحاوية (cgroup)، وإلا 1000MB.
// ==========================================================================
function memSoftLimitMb() {
  const env = parseInt(process.env.MEM_SOFT_LIMIT_MB, 10);
  if (env > 0) return env;
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try { const n = Number(fs.readFileSync(f, 'utf8').trim()); if (n > 0 && n < 64 * 1024 ** 3) return Math.max(256, Math.round(n / 1048576 * 0.7)); } catch {}
  }
  return 1000;
}
const MEM_LIMIT_MB = memSoftLimitMb();
setInterval(() => {
  const rss = process.memoryUsage().rss / 1048576;
  if (rss > MEM_LIMIT_MB) {
    log.warn(`🧠 RSS ${Math.round(rss)}MB > ${MEM_LIMIT_MB}MB → تفريغ كاشات الميتاداتا`);
    infoCache.clear(); searchCache.clear(); channelCache.clear(); subtitleCache.clear(); channelMetaCache.clear(); urlMeta.clear();
    if (global.gc) try { global.gc(); } catch {}
  }
}, 30000).unref();

// yt-dlp: اقرا النسخة/الإمكانيات الأول، وبعدين حدّث في الخلفية (مش بيعطّل أي طلب)
(async () => {
  await refreshYtdlpInfo();
  log.info(`yt-dlp ${ytdlpState.version || 'غير متاح'} (${ytdlpState.bin}) remote-components=${ytdlpState.remoteComponents}`);
  setTimeout(() => { updateYtDlp(false).catch(() => {}); }, 4000).unref();
  setInterval(() => { updateYtDlp(false).catch(() => {}); }, 6 * 3600 * 1000).unref();
})().catch(e => log.warn(`yt-dlp init: ${e.message}`));

// 🔥 تسخين الكاش: الهوم فيد جاهز قبل ما أول مستخدم يطلبه، ويتجدد في الخلفية
async function warmCaches() {
  try {
    await getRecommendedVideos('EG', 40, []);
    log.info('🔥 warm: home feed ready');
  } catch (e) { log.warn(`warm failed: ${String(e.message || e).split('\n')[0]}`); }
}
setTimeout(() => { warmCaches(); }, 6000).unref();
setInterval(() => { warmCaches(); }, 10 * 60 * 1000).unref();

const server = app.listen(PORT, '0.0.0.0', () => {
  ensureFfmpeg().then(ok => { if (ok) log.success('✅ ffmpeg available for multi-quality'); else log.warn('⚠️ ffmpeg missing — only progressive heights'); }).catch(e => log.warn(String(e.message||e)));
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0;
  server.maxConnections = 2000;
  // لو ffmpeg لسه مش جاهز: حاول تاني في الخلفية كل 5 دقايق (من غير ما حد يطلب جودة)
  setInterval(() => { if (ffmpegState.status !== 'ready') ensureFfmpeg().catch(() => {}); }, 5 * 60 * 1000).unref();
  log.info(`🧾 لوحة المشاكل وسجل العمليات: /admin  (عمليات yt-dlp المتزامنة: ${PROC_MAX})`);
  const ytdlpStatus = commandExists(ytdlpBin) ? '✅' : '❌';
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
  log.error(`Unhandled Rejection: ${cleanErr(reason, 200).split('\n')[0]}`, { cat: 'system', detail: reason && reason.stack ? String(reason.stack).split('\n').slice(0, 6).join('\n') : cleanErr(reason) });
});
process.on('uncaughtException', (err) => {
  log.error(`Uncaught Exception: ${String(err && err.message || err)}`, { cat: 'system', detail: err && err.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : '' });
  saveIncidents();
});
