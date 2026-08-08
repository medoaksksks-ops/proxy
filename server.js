const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
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

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Timing-Allow-Origin', '*');
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
const infoCache = new NodeCache({ stdTTL: 7200 });
const trendingCache = new NodeCache({ stdTTL: 1200 });
const streamCache = new NodeCache({ stdTTL: 240 });
const channelCache = new NodeCache({ stdTTL: 3600 });

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
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  acquire() {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }

    return new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    this.current--;

    const next = this.queue.shift();

    if (next) {
      this.current++;
      next();
    }
  }
}

const YTDLP_CONCURRENCY =
  parseInt(process.env.YTDLP_CONCURRENCY, 10) || 4;

const ytdlpLimiter = new Semaphore(YTDLP_CONCURRENCY);

// ==========================================================================
// YouTube Cookies
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

      res.on('data', chunk => {
        data += chunk;
      });

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
    }).on('timeout', function () {
      this.destroy();
      resolve('');
    });
  });
}

let lastCookiesContent = '';

async function refreshCookies() {
  try {
    const content = await fetchCookiesFromFirebase();

    if (
      content &&
      content.trim() &&
      content !== lastCookiesContent
    ) {
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

// ==========================================================================
// Check yt-dlp
// ==========================================================================
function checkYtDlp() {
  try {
    require('child_process').execSync(
      'yt-dlp --version',
      { stdio: 'ignore' }
    );

    return true;

  } catch {
    return false;
  }
}

// ==========================================================================
// Validation
// ==========================================================================
function isValidVideoId(id) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function sanitizeFilename(name) {
  return name
    .replace(/[^\w\s-]/g, '')
    .substring(0, 100) || 'video';
}

// ==========================================================================
// Run yt-dlp
// ==========================================================================
async function runYtDlp(
  args,
  {
    timeout = TIMEOUT,
    maxBuffer = 1024 * 1024 * 10
  } = {}
) {
  await ytdlpLimiter.acquire();

  try {
    const finalArgs = cookiesReady
      ? ['--cookies', COOKIES_PATH, ...args]
      : args;

    const { stdout } = await execFileAsync(
      'yt-dlp',
      ['--no-warnings', ...finalArgs],
      {
        timeout,
        maxBuffer,
        encoding: 'utf-8'
      }
    );

    return stdout;

  } finally {
    ytdlpLimiter.release();
  }
}

// ==========================================================================
// Map result
// ==========================================================================
function mapFlatEntry(item, excludeId) {
  if (!item || !item.id) return null;

  if (excludeId && item.id === excludeId) {
    return null;
  }

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

      try {
        item = JSON.parse(line);
      } catch {
        return null;
      }

      return mapFlatEntry(item, excludeId);
    })
    .filter(Boolean);
}

// ==========================================================================
// Pagination بدون سقف داخلي
// ==========================================================================
async function getPaginatedPool(
  cache,
  cacheKeyBase,
  fetchPoolFn,
  page,
  limit,
  maxPool = Infinity
) {
  const pageNum = Math.max(
    1,
    parseInt(page, 10) || 1
  );

  const pageSize = Math.max(
    parseInt(limit, 10) || 20,
    1
  );

  const needed = pageNum * pageSize;

  const poolSize = Number.isFinite(maxPool)
    ? Math.min(
        Math.max(needed, pageSize * 2),
        maxPool
      )
    : Math.max(
        needed,
        pageSize * 2
      );

  const cacheKey =
    `${cacheKeyBase}_${poolSize}`;

  let pool = cache.get(cacheKey);

  if (!pool) {
    pool = await fetchPoolFn(poolSize);
    cache.set(cacheKey, pool);
  }

  const start =
    (pageNum - 1) * pageSize;

  const results =
    pool.slice(
      start,
      start + pageSize
    );

  const hasMore =
    pool.length > start + pageSize;

  return {
    page: pageNum,
    limit: pageSize,
    results,
    hasMore
  };
}

// ==========================================================================
// Video Info
// ==========================================================================
async function getVideoInfo(videoId) {
  const stdout = await runYtDlp([
    '--dump-json',
    `https://www.youtube.com/watch?v=${videoId}`
  ]);

  return JSON.parse(stdout);
}

// ==========================================================================
// Stream URL
// ==========================================================================
async function getVideoStreamUrl(
  videoId,
  format = 'bestvideo+bestaudio/best'
) {
  const stdout = await runYtDlp([
    '--get-url',
    '-f',
    format,
    `https://www.youtube.com/watch?v=${videoId}`
  ]);

  const streamUrl =
    stdout.trim().split('\n')[0];

  log.success(
    `🎬 Got stream URL (${streamUrl.length} chars)`
  );

  return streamUrl;
}

// ==========================================================================
// Search
// ==========================================================================
async function searchVideos(
  query,
  limit = 20
) {
  const safeLimit =
    Math.max(
      parseInt(limit, 10) || 20,
      1
    );

  log.info(
    `🔎 Searching: "${query}" (limit ${safeLimit})`
  );

  const stdout = await runYtDlp([
    `ytsearch${safeLimit}:${query}`,
    '--dump-json',
    '--flat-playlist'
  ]);

  return parseFlatItems(stdout);
}

// ==========================================================================
// Related
// ==========================================================================
async function getRelatedVideos(
  videoId,
  limit = 10
) {
  const url =
    `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;

  log.info(
    `🧭 Fetching related videos: ${videoId} (limit ${limit})`
  );

  let items = [];

  try {
    const stdout = await runYtDlp([
      '--dump-json',
      '--flat-playlist',
      '--yes-playlist',
      '--playlist-end',
      String(limit + 1),
      url
    ]);

    items = parseFlatItems(
      stdout,
      videoId
    );

  } catch (e) {
    log.warn(
      `Flat related fetch failed: ${e.message}`
    );
  }

  if (items.length === 0) {
    log.warn(
      '⚠️ Flat related empty, retrying with full extraction...'
    );

    const stdout = await runYtDlp([
      '--dump-json',
      '--yes-playlist',
      '--playlist-end',
      String(limit + 1),
      '--skip-download',
      url
    ]);

    items = parseFlatItems(
      stdout,
      videoId
    );
  }

  return items.slice(0, limit);
}

// ==========================================================================
// Recommended
// ==========================================================================
async function getRecommendedVideos(
  region = 'EG',
  limit = 20
) {
  let items = [];

  try {
    const url =
      `https://www.youtube.com/feed/trending?gl=${encodeURIComponent(region)}`;

    const stdout = await runYtDlp([
      '--dump-json',
      '--flat-playlist',
      '--playlist-end',
      String(limit),
      url
    ]);

    items = parseFlatItems(stdout);

  } catch (e) {
    log.warn(
      `Trending feed failed (${e.message}), falling back`
    );
  }

  if (items.length < 5) {
    const topicPool = [
      'أخبار مصر اليوم',
      'أغاني مصرية جديدة',
      'كوميدي مصري',
      'رياضة مصر أهداف',
      'بودكاست عربي',
      'أفلام كوميدي مصرية',
      'مسلسلات رمضان',
      'تكنولوجيا وتقنية',
      'وصفات طبخ سريعة',
      'ألعاب فيديو',
      'سيارات ومحركات',
      'سفر وسياحة',
      'علوم وتاريخ',
      'موسيقى عربي مختلط',
      'تمثيليات وكواليس'
    ];

    const shuffled =
      topicPool
        .sort(() => Math.random() - 0.5)
        .slice(0, 5);

    const perQuery =
      Math.max(
        10,
        Math.ceil(limit / shuffled.length) + 5
      );

    const pool = [];

    for (const q of shuffled) {
      try {
        const stdout = await runYtDlp([
          `ytsearch${perQuery}:${q}`,
          '--dump-json',
          '--flat-playlist'
        ]);

        pool.push(
          ...parseFlatItems(stdout)
        );

      } catch (e) {
        log.warn(
          `Recommended fallback query failed "${q}": ${e.message}`
        );
      }
    }

    const seen = new Set();

    items = pool
      .filter(v => {
        if (seen.has(v.id)) {
          return false;
        }

        seen.add(v.id);
        return true;
      })
      .sort(() => Math.random() - 0.5);
  }

  return {
    items: items.slice(0, limit),
    personalized: false
  };
}

// ==========================================================================
// Channel
// ==========================================================================
async function getChannelVideos(
  channelId,
  limit = 20
) {
  const url =
    `https://www.youtube.com/channel/${channelId}/videos`;

  log.info(
    `📺 Fetching channel: ${channelId} (limit ${limit})`
  );

  const stdout = await runYtDlp([
    '--flat-playlist',
    '--dump-single-json',
    '--playlist-end',
    String(limit),
    url
  ]);

  const data =
    JSON.parse(stdout);

  const videos =
    (data.entries || [])
      .map(e => mapFlatEntry(e))
      .filter(Boolean);

  return {
    channel: {
      id: data.channel_id || channelId,
      title:
        data.channel ||
        data.uploader ||
        'قناة',

      followers:
        data.channel_follower_count ||
        null,

      avatar:
        data.thumbnails?.length
          ? data.thumbnails[
              data.thumbnails.length - 1
            ].url
          : null,

      description:
        data.description || ''
    },

    videos
  };
}

// ==========================================================================
// Comments
// ==========================================================================
async function getVideoComments(
  videoId,
  limit = 50
) {
  log.info(
    `💬 Fetching comments: ${videoId} (limit ${limit})`
  );

  const args = [
    '--skip-download',
    '--dump-json',
    '--write-comments',
    '--extractor-args',
    `youtube:comment_sort=top;max_comments=${limit},all,all,${limit}`,
    `https://www.youtube.com/watch?v=${videoId}`
  ];

  const stdout =
    await runYtDlp(
      args,
      { timeout: 45000 }
    );

  const lines =
    stdout
      .trim()
      .split('\n')
      .filter(Boolean);

  const data =
    JSON.parse(
      lines[lines.length - 1]
    );

  return (data.comments || [])
    .slice(0, limit)
    .map(c => ({
      id: c.id,
      author:
        c.author ||
        'مستخدم يوتيوب',

      authorThumbnail:
        c.author_thumbnail || '',

      text:
        c.text || '',

      likeCount:
        c.like_count || 0,

      isReply:
        !!(
          c.parent &&
          c.parent !== 'root'
        ),

      timestamp:
        c.timestamp
          ? new Date(
              c.timestamp * 1000
            ).toISOString()
          : null
    }));
}

// ==========================================================================
// Trending
// ==========================================================================
app.get('/trending', async (req, res) => {
  const region =
    (req.query.region || 'EG')
      .toUpperCase();

  try {
    const pageNum =
      Math.max(
        1,
        parseInt(req.query.page, 10) || 1
      );

    const pageSize =
      Math.max(
        parseInt(req.query.limit, 10) || 20,
        1
      );

    const needed =
      pageNum * pageSize;

    const poolSize =
      Math.min(
        Math.max(
          needed,
          pageSize * 2
        ),
        150
      );

    const cacheKey =
      `recommended_${region}_${poolSize}`;

    let cached =
      trendingCache.get(cacheKey);

    if (!cached) {
      cached =
        await getRecommendedVideos(
          region,
          poolSize
        );

      trendingCache.set(
        cacheKey,
        cached
      );
    }

    const start =
      (pageNum - 1) * pageSize;

    const results =
      cached.items.slice(
        start,
        start + pageSize
      );

    const hasMore =
      cached.items.length >
      start + pageSize;

    res.json({
      region,
      page: pageNum,
      limit: pageSize,
      count: results.length,
      hasMore,
      personalized:
        cached.personalized,
      results
    });

  } catch (error) {
    log.error(
      `Error fetching recommended: ${error.message}`
    );

    res.status(500).json({
      error:
        'تعذّر جلب المحتوى المقترح',

      details:
        NODE_ENV === 'development'
          ? error.message
          : undefined
    });
  }
});

// ==========================================================================
// Search
// ==========================================================================
app.get('/search', async (req, res) => {
  const {
    q: query
  } = req.query;

  if (!query || !query.trim()) {
    return res.status(400).json({
      error:
        'كلمة البحث مطلوبة',

      example:
        '/search?q=funny+cats&limit=20&page=1'
    });
  }

  try {
    const {
      page,
      limit,
      results,
      hasMore
    } = await getPaginatedPool(
      infoCache,
      `search_${query}`,
      (poolSize) =>
        searchVideos(
          query,
          poolSize
        ),
      req.query.page,
      req.query.limit
    );

    res.json({
      query,
      page,
      limit,
      count: results.length,
      hasMore,
      results
    });

  } catch (error) {
    log.error(
      `Error searching: ${error.message}`
    );

    res.status(500).json({
      error:
        'تعذّر تنفيذ البحث',

      details:
        NODE_ENV === 'development'
          ? error.message
          : undefined
    });
  }
});

// ==========================================================================
// Related
// ==========================================================================
app.get('/related', async (req, res) => {
  const {
    v: videoId
  } = req.query;

  if (
    !videoId ||
    !isValidVideoId(videoId)
  ) {
    return res.status(400).json({
      error:
        'Video ID مطلوب وصحيح (11 حرف)',

      example:
        '/related?v=dQw4w9WgXcQ&limit=10&page=1'
    });
  }

  try {
    const {
      page,
      limit,
      results,
      hasMore
    } = await getPaginatedPool(
      infoCache,
      `related_${videoId}`,
      (poolSize) =>
        getRelatedVideos(
          videoId,
          poolSize
        ),
      req.query.page,
      req.query.limit
    );

    res.json({
      id: videoId,
      page,
      limit,
      count: results.length,
      hasMore,
      results
    });

  } catch (error) {
    log.error(
      `Error fetching related: ${error.message}`
    );

    res.status(500).json({
      error:
        'تعذّر جلب الفيديوهات المقترحة',

      details:
        NODE_ENV === 'development'
          ? error.message
          : undefined
    });
  }
});

// ==========================================================================
// Channel
// ==========================================================================
app.get('/channel', async (req, res) => {
  const channelId =
    req.query.id;

  if (!channelId) {
    return res.status(400).json({
      error:
        'channel id مطلوب',

      example:
        '/channel?id=UCxxxxxxxx&limit=20&page=1'
    });
  }

  try {
    const pageNum =
      Math.max(
        1,
        parseInt(req.query.page, 10) || 1
      );

    const pageSize =
      Math.max(
        parseInt(req.query.limit, 10) || 20,
        1
      );

    const needed =
      pageNum * pageSize;

    const poolSize =
      Math.max(
        needed,
        pageSize * 2
      );

    const dataCacheKey =
      `channel_${channelId}_${poolSize}`;

    let data =
      channelCache.get(
        dataCacheKey
      );

    if (!data) {
      data =
        await getChannelVideos(
          channelId,
          poolSize
        );

      channelCache.set(
        dataCacheKey,
        data
      );
    }

    const start =
      (pageNum - 1) * pageSize;

    const videos =
      data.videos.slice(
        start,
        start + pageSize
      );

    const hasMore =
      data.videos.length >
      start + pageSize;

    res.json({
      channel: data.channel,
 page: pageNum,
      limit: pageSize,
      count: videos.length,
      hasMore,
      videos
    });

  } catch (error) {
    log.error(
      `Error fetching channel: ${error.message}`
    );

    res.status(500).json({
      error:
        'تعذّر جلب بيانات القناة',

      details:
        NODE_ENV === 'development'
          ? error.message
          : undefined
    });
  }
});

// ==========================================================================
// Comments
// ==========================================================================
app.get('/comments', async (req, res) => {
  const videoId =
    req.query.v;

  const limit =
    Math.min(
      parseInt(req.query.limit, 10) || 50,
      100
    );

  if (
    !videoId ||
    !isValidVideoId(videoId)
  ) {
    return res.status(400).json({
      error:
        'Video ID غير صحيح'
    });
  }

  const cacheKey =
    `comments_${videoId}_${limit}`;

  const cached =
    infoCache.get(cacheKey);

  if (cached) {
    return res.json(cached);
  }

  try {
    const comments =
      await getVideoComments(
        videoId,
        limit
      );

    const response = {
      id: videoId,
      count: comments.length,
      results: comments
    };

    infoCache.set(
      cacheKey,
      response,
      1800
    );

    res.json(response);

  } catch (error) {
    log.error(
      `Error fetching comments: ${error.message}`
    );

    res.status(500).json({
      error:
        'تعذّر جلب التعليقات',

      details:
        NODE_ENV === 'development'
          ? error.message
          : undefined
    });
  }
});

// ==========================================================================
// Stream Proxy
// ==========================================================================
function streamFromUpstream(
  req,
  res,
  url,
  redirectCount = 0
) {
  if (redirectCount > 5) {
    if (!res.headersSent) {
      res.status(502).json({
        error:
          'تحويلات كتير أوي من المصدر'
      });
    }

    return;
  }

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
  };

  if (req.headers.range) {
    headers.Range =
      req.headers.range;
  }

  const upstreamReq =
    https.get(
      url,
      {
        headers,
        timeout: 20000
      },
      (upstreamRes) => {

        if (
          [301, 302, 303, 307, 308]
            .includes(
              upstreamRes.statusCode
            ) &&
          upstreamRes.headers.location
        ) {
          upstreamRes.resume();

          return streamFromUpstream(
            req,
            res,
            upstreamRes.headers.location,
            redirectCount + 1
          );
        }

        if (
          upstreamRes.statusCode >= 400
        ) {
          upstreamRes.resume();

          if (!res.headersSent) {
            res.status(502).json({
              error:
                'تعذّر تحميل الفيديو من المصدر'
            });
          }

          return;
        }

        res.status(
          upstreamRes.statusCode
        );

        [
          'content-type',
          'content-length',
          'content-range',
          'accept-ranges',
          'cache-control'
        ].forEach(h => {
          if (upstreamRes.headers[h]) {
            res.setHeader(
              h,
              upstreamRes.headers[h]
            );
          }
        });

        upstreamRes.pipe(res);
      }
    );

  upstreamReq.on(
    'timeout',
    () =>
      upstreamReq.destroy(
        new Error(
          'Upstream timeout'
        )
      )
  );

  upstreamReq.on(
    'error',
    (err) => {
      log.error(
        `Stream proxy error: ${err.message}`
      );

      if (!res.headersSent) {
        res.status(502).json({
          error:
            'تعذّر الاتصال بمصدر الفيديو'
        });
      }
    }
  );

  req.on(
    'close',
    () => upstreamReq.destroy()
  );
}

// ==========================================================================
// Video
// ==========================================================================
app.get('/video', async (req, res) => {
  const {
    v: videoId,
    format = 'bestvideo+bestaudio/best'
  } = req.query;

  if (
    !videoId ||
    !isValidVideoId(videoId)
  ) {
    return res.status(400).json({
      error:
        'Video ID مطلوب وصحيح (11 حرف)',

      example:
        '/video?v=dQw4w9WgXcQ&format=bestvideo+bestaudio/best'
    });
  }

  const cacheKey =
    `stream_${videoId}_${format}`;

  const cachedUrl =
    streamCache.get(cacheKey);

  if (cachedUrl) {
    return streamFromUpstream(
      req,
      res,
      cachedUrl
    );
  }

  let attempts = 0;
  let lastError = null;

  while (
    attempts < MAX_RETRIES
  ) {
    try {
      log.info(
        `🎬 Fetching video: ${videoId} (attempt ${attempts + 1}/${MAX_RETRIES})`
      );

      const streamUrl =
        await getVideoStreamUrl(
          videoId,
          format
        );

      if (!streamUrl) {
        throw new Error(
          'Failed to get stream URL'
        );
      }

      streamCache.set(
        cacheKey,
        streamUrl
      );

      log.success(
        `▶️ Streaming: ${videoId}`
      );

      streamFromUpstream(
        req,
        res,
        streamUrl
      );

      return;

    } catch (error) {
      lastError = error;
      attempts++;

      log.warn(
        `Attempt ${attempts} failed: ${error.message}`
      );

      if (
        attempts < MAX_RETRIES
      ) {
        await new Promise(
          r =>
            setTimeout(
              r,
              1000 * attempts
            )
        );
      }
    }
  }

  if (
    lastError?.message
      .includes('unavailable') ||
    lastError?.message
      .includes('not available')
  ) {
    return res.status(404).json({
      error:
        'الفيديو غير متاح أو محذوف'
    });
  }

  if (
    lastError?.message
      .includes('private')
  ) {
    return res.status(403).json({
      error:
        'الفيديو خاص (private)'
    });
  }

  if (
    lastError?.message
      .includes('age')
  ) {
    return res.status(403).json({
      error:
        'الفيديو يحتاج verification العمر'
    });
  }

  res.status(500).json({
    error:
      'فشل في تشغيل الفيديو',

    details:
      NODE_ENV === 'development'
        ? lastError?.message
        : undefined
  });
});

// ==========================================================================
// Info
// ==========================================================================
app.get('/info', async (req, res) => {
  const videoId =
    req.query.v;

  if (
    !videoId ||
    !isValidVideoId(videoId)
  ) {
    return res.status(400).json({
      error:
        'Video ID غير صحيح'
    });
  }

  const cached =
    infoCache.get(
      `info_${videoId}`
    );

  if (cached) {
    return res.json(cached);
  }

  try {
    const info =
      await getVideoInfo(
        videoId
      );

    const result = {
      id: videoId,

      title:
        info.title,

      duration:
        info.duration || 0,

      author:
        info.uploader ||
        info.channel ||
        'Unknown',

      channelId:
        info.channel_id || '',

      description:
        info.description || '',

      thumbnail:
        info.thumbnail || '',

      publishedAt:
        info.upload_date
          ? new Date(
              `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`
            ).toISOString()
          : null,

      viewCount:
        info.view_count || 0,

      likeCount:
        info.like_count || 0,

      ageRestricted:
        info.age_limit
          ? info.age_limit > 0
          : false,

      isLive:
        info.is_live || false,

      formats:
        info.formats?.length || 0,

      qualities:
        [
          ...new Set(
            (info.formats || [])
              .filter(
                f =>
                  f.vcodec &&
                  f.vcodec !== 'none' &&
                  f.height
              )
              .map(
                f => f.height
              )
          )
        ].sort(
          (a, b) => b - a
        )
    };

    infoCache.set(
      `info_${videoId}`,
      result
    );

    res.json(result);

  } catch (error) {
    log.error(
      `Error fetching info: ${error.message}`
    );

    res.status(500).json({
      error:
        'تعذّر جلب معلومات الفيديو',

      details:
        NODE_ENV === 'development'
          ? error.message
          : undefined
    });
  }
});

// ==========================================================================
// Formats / Qualities
// ==========================================================================
async function formatsHandler(req, res) {
  const videoId =
    req.query.v;

  if (
    !videoId ||
    !isValidVideoId(videoId)
  ) {
    return res.status(400).json({
      error:
        'Video ID غير صحيح'
    });
  }

  try {
    log.info(
      `📊 Fetching formats: ${videoId}`
    );

    const info =
      await getVideoInfo(
        videoId
      );

    const formats =
      (info.formats || [])
        .filter(
          f =>
            f.vcodec !== 'none' ||
            f.acodec !== 'none'
        )
        .map(f => ({
          formatId:
            f.format_id,

          format:
            f.format || '',

          ext:
            f.ext || '',

          videoCodec:
            f.vcodec || 'none',

          audioCodec:
            f.acodec || 'none',

          height:
            f.height || null,

          width:
            f.width || null,

          fps:
            f.fps || null,

          bitrate:
            f.tbr ||
            f.vbr ||
            null,

          audioBitrate:
            f.abr || null,

          fileSize:
            f.filesize ||
            f.filesize_approx ||
            null,

          hasVideo:
            f.vcodec &&
            f.vcodec !== 'none',

          hasAudio:
            f.acodec &&
            f.acodec !== 'none'
        }))
        .sort(
          (a, b) => {
            const h =
              (b.height || 0) -
              (a.height || 0);

            if (h !== 0) {
              return h;
            }

            return (
              (b.bitrate || 0) -
              (a.bitrate || 0)
            );
          }
        );

    const qualityMap =
      new Map();

    for (const f of formats) {
      if (
        !f.hasVideo ||
        !f.height
      ) {
        continue;
      }

      const current =
        qualityMap.get(
          f.height
        );

      if (!current) {
        qualityMap.set(
          f.height,
          f
        );

        continue;
      }

      const currentScore =
        (current.hasAudio
          ? 1000000
          : 0) +
        (current.bitrate || 0) +
        (current.audioBitrate || 0);

      const newScore =
        (f.hasAudio
          ? 1000000
          : 0) +
        (f.bitrate || 0) +
        (f.audioBitrate || 0);

      if (
        newScore >
        currentScore
      ) {
        qualityMap.set(
          f.height,
          f
        );
      }
    }

    const qualities =
      [...qualityMap.values()]
        .sort(
          (a, b) =>
            (b.height || 0) -
            (a.height || 0)
        )
        .map(f => ({
          height:
            f.height,

          width:
            f.width,

          label:
            `${f.height}p`,

          formatId:
            f.formatId,

          ext:
            f.ext,

          hasAudio:
            f.hasAudio,

          videoCodec:
            f.videoCodec,

          audioCodec:
            f.audioCodec,

          fps:
            f.fps,

          bitrate:
            f.bitrate,

          fileSize:
            f.fileSize
        }));

    res.json({
      id: videoId,

      title:
        info.title,

      duration:
        info.duration || 0,

      thumbnail:
        info.thumbnail || '',

      qualities,

      formats
    });

  } catch (error) {
    log.error(
      `Error fetching formats: ${error.message}`
    );

    res.status(500).json({
      error:
        'تعذّر جلب الـ formats',

      details:
        NODE_ENV === 'development'
          ? error.message
          : undefined
    });
  }
}

app.get(
  '/formats',
  formatsHandler
);

app.get(
  '/qualities',
  formatsHandler
);

// ==========================================================================
// Health
// ==========================================================================
app.get('/health', (req, res) => {
  res.json({
    status:
      'operational',

    timestamp:
      new Date().toISOString(),

    uptime:
      process.uptime(),

    ytdlpReady:
      checkYtDlp(),

    cookiesReady,

    concurrency: {
      max:
        YTDLP_CONCURRENCY,

      current:
        ytdlpLimiter.current,

      queued:
        ytdlpLimiter.queue.length
    }
  });
});

// ==========================================================================
// Update Cookies
// ==========================================================================
app.post(
  '/api/update-cookies',
  async (req, res) => {
    try {
      const cookies =
        req.body;

      if (
        !cookies ||
        !cookies.trim()
      ) {
        return res.status(400).json({
          error:
            'الكوكيز فارغة'
        });
      }

      log.info(
        `📝 Updating cookies (${cookies.length} bytes)...`
      );

      const url =
        `${FIREBASE_URL}/youtube_cookies.json`;

      const auth =
        FIREBASE_SECRET
          ? `?auth=${FIREBASE_SECRET}`
          : '';

      const fullUrl =
        url + auth;

      const payloadData =
        JSON.stringify({
          value:
            cookies,

          updated_at:
            new Date().toISOString()
        });

      const options = {
        method:
          'PUT',

        headers: {
          'Content-Type':
            'application/json',

          'Content-Length':
            Buffer.byteLength(
              payloadData
            )
        }
      };

      const req_firebase =
        https.request(
          fullUrl,
          options,
          (res_fb) => {

            let response = '';

            res_fb.on(
              'data',
              chunk =>
                response += chunk
            );

            res_fb.on(
              'end',
              async () => {

                if (
                  res_fb.statusCode === 200
                ) {
                  await refreshCookies();

                  res.json({
                    success:
                      true,

                    message:
                      'تم تحديث الكوكيز',

                    timestamp:
                      new Date().toISOString(),

                    size:
                      cookies.length
                  });

                } else {
                  res.status(500).json({
                    error:
                      'فشل في تحديث الكوكيز',

                    details:
                      response
                  });
                }
              }
            );
          }
        );

      req_firebase.on(
        'error',
        err => {
          res.status(500).json({
            error:
              'فشل الاتصال بـ Firebase',

            details:
              err.message
          });
        }
      );

      req_firebase.end(
        payloadData
      );

    } catch (error) {
      res.status(500).json({
        error:
          'خطأ في السيرفر',

        details:
          error.message
      });
    }
  }
);

// ==========================================================================
// Cookies Status
// ==========================================================================
app.get(
  '/api/cookies-status',
  async (req, res) => {
    res.json({
      hasCoockes:
        cookiesReady,

      length:
        lastCookiesContent.length,

      preview:
        lastCookiesContent
          ? lastCookiesContent.substring(
              0,
              50
            ) + '...'
          : 'لا توجد كوكيز',

      status:
        cookiesReady
          ? '✅ موجودة'
          : '❌ فارغة أو غير موجودة'
    });
  }
);

// ==========================================================================
// Root
// ==========================================================================
app.get('/', (req, res) => {
  res.json({
    name:
      '🎬 YouTube Proxy',

    version:
      '5.0.0',

    environment:
      NODE_ENV,

    cookies: {
      source:
        'Firebase Realtime Database',

      url:
        FIREBASE_URL,

      refresh:
        'كل 5 دقايق',

      ready:
        cookiesReady
    },

    concurrency: {
      max:
        YTDLP_CONCURRENCY
    },

    endpoints: {
      trending:
        '/trending?region=EG&page=1',

      video:
        '/video?v=VIDEO_ID&format=bestvideo+bestaudio/best',

      info:
        '/info?v=VIDEO_ID',

      formats:
        '/formats?v=VIDEO_ID',

      qualities:
        '/qualities?v=VIDEO_ID',

      search:
        '/search?q=QUERY&limit=20&page=1',

      related:
        '/related?v=VIDEO_ID&limit=10&page=1',

      channel:
        '/channel?id=CHANNEL_ID&limit=20&page=1',

      comments:
        '/comments?v=VIDEO_ID&limit=50',

      health:
        '/health',

      cookiesStatus:
        '/api/cookies-status'
    },

    examples: {
      'Play video':
        '/video?v=dQw4w9WgXcQ',

      'Search':
        '/search?q=funny+cats&page=1',

      'Qualities':
        '/qualities?v=dQw4w9WgXcQ',

      'Formats':
        '/formats?v=dQw4w9WgXcQ',

      'Related':
        '/related?v=dQw4w9WgXcQ',

      'Channel':
        '/channel?id=UCuAXFkgsw1L7xaCfnd5JJOw',

      'Comments':
        '/comments?v=dQw4w9WgXcQ',

      'Health':
        '/health'
    }
  });
});

// ==========================================================================
// 404
// ==========================================================================
app.use((req, res) => {
  res.status(404).json({
    error:
      'Endpoint غير موجود',

    path:
      req.path
  });
});

// ==========================================================================
// Error Handler
// ==========================================================================
app.use(
  (err, req, res, next) => {
    log.error(
      `Unhandled error: ${err.message}`
    );

    res.status(500).json({
      error:
        'خطأ في السيرفر',

      details:
        NODE_ENV === 'development'
          ? err.message
          : undefined
    });
  }
);

// ==========================================================================
// Start
// ==========================================================================
const server =
  app.listen(
    PORT,
    '0.0.0.0',
    () => {

      const ytdlpStatus =
        checkYtDlp()
          ? '✅'
          : '❌';

      console.log(`
╔═══════════════════════════════════════════╗
║       🎬 YouTube Proxy Server 🔥          ║
║═══════════════════════════════════════════║
║ Environment: ${NODE_ENV}
║ yt-dlp: ${ytdlpStatus}
║ Cookies: ${cookiesReady ? '✅' : '❌'}
║ Concurrency: ${YTDLP_CONCURRENCY}
║ Port: ${PORT}
╚═══════════════════════════════════════════╝
      `);

      log.success(
        '✅ Server ready'
      );
    }
  );

// ==========================================================================
// Graceful Shutdown
// ==========================================================================
process.on(
  'SIGINT',
  () => {
    log.warn(
      'Shutting down...'
    );

    server.close(
      () => {
        log.success(
          'Server stopped'
        );

        process.exit(0);
      }
    );
  }
);

process.on(
  'SIGTERM',
  () => {
    log.warn(
      'Terminating...'
    );

    server.close(
      () => {
        process.exit(0);
      }
    );
  }
);

process.on(
  'unhandledRejection',
  reason => {
    log.error(
      `Unhandled Rejection: ${reason}`
    );
  }
);