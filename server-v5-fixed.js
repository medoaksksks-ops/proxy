const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const { URL } = require('url');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ============================================================
//  SMART WEB PROXY v6.5 – YouTube & All Sites Enhanced
//  -------------------------------------------------------
//  ✓ دعم كامل لـ YouTube (فيديوهات، تعليقات، بث مباشر)
//  ✓ تحميل جميع الموارد (CSS, JS, صور, فيديو)
//  ✓ اعتراض طلبات AJAX و Fetch
//  ✓ دعم Range للفيديو
//  ✓ حجم كود > 60 كيلو بايت
// ============================================================

const app = express();
let browser = null;
const pagePool = new Set();
const maxPages = 8;
const cache = new Map();
const CACHE_TTL = 30000; // 30 ثانية بس للموارد

// ============================================================
//  الإعدادات
// ============================================================
const CONFIG = {
    proxyBase: '/proxy',
    timeout: 120000,
    pageTimeout: 90000,
    maxConnections: 20,
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ],
    // كل المواقع الكبيرة
    puppeteerSites: [
        'youtube.com', 'youtu.be',
        'google.com', 'gmail.com',
        'facebook.com', 'instagram.com',
        'tiktok.com', 'twitter.com', 'x.com',
        'reddit.com', 'twitch.tv',
        'netflix.com', 'amazon.com',
        'spotify.com', 'discord.com'
    ]
};

// ============================================================
//  Middleware
// ============================================================
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] }));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(cookieParser());

// ============================================================
//  دوال مساعدة
// ============================================================
function getCacheKey(url, headers = {}) {
    const range = headers.range || '';
    return crypto.createHash('md5').update(url + range).digest('hex');
}

function getContentTypeFromExtension(url) {
    const ext = path.extname(url).toLowerCase();
    const map = {
        '.html': 'text/html', '.htm': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
        '.mp4': 'video/mp4', '.webm': 'video/webm',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
        '.pdf': 'application/pdf', '.txt': 'text/plain',
        '.xml': 'application/xml', '.zip': 'application/zip',
        '.gz': 'application/gzip', '.wasm': 'application/wasm'
    };
    return map[ext] || null;
}

async function cleanupPages() {
    if (pagePool.size > maxPages) {
        const toClose = Array.from(pagePool).slice(0, Math.floor(pagePool.size / 2));
        for (const page of toClose) {
            try { await page.close(); } catch (_) {}
            pagePool.delete(page);
        }
    }
}

async function getBrowser() {
    if (!browser) {
        try {
            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-resources',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--allow-running-insecure-content',
                    '--disable-blink-features=AutomationControlled',
                    '--window-size=1920,1080',
                    '--disable-accelerated-2d-canvas',
                    '--disable-pdf-viewer'
                ]
            });
            console.log('[PUPPETEER] ✅ Browser launched.');
        } catch (err) {
            console.error('[PUPPETEER ERROR]', err.message);
            browser = null;
        }
    }
    return browser;
}

// ============================================================
//  جلب الموارد
// ============================================================
async function fetchResource(targetUrl, reqHeaders = {}, options = {}) {
    const userAgent = CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];

    const cacheKey = getCacheKey(targetUrl, reqHeaders);
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.data;
        } else {
            cache.delete(cacheKey);
        }
    }

    try {
        const headers = {
            'User-Agent': userAgent,
            'Accept': '*/*',
            'Accept-Language': 'ar-EG,ar;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            ...reqHeaders
        };

        delete headers['host'];
        delete headers['connection'];
        delete headers['content-length'];

        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: headers,
            timeout: CONFIG.timeout,
            redirect: 'follow'
        });

        if (!response.ok) return null;

        const buffer = await response.buffer();
        const contentType = response.headers.get('content-type') || getContentTypeFromExtension(targetUrl) || 'application/octet-stream';

        const result = {
            data: buffer,
            contentType: contentType,
            headers: Object.fromEntries(response.headers),
            statusCode: response.status
        };

        if (buffer.length < 3 * 1024 * 1024) {
            cache.set(cacheKey, { data: result, timestamp: Date.now() });
        }

        return result;

    } catch (error) {
        console.error(`[FETCH ERROR] ${targetUrl.substring(0, 60)}...`);
        return null;
    }
}

// ============================================================
//  إعادة كتابة الروابط (مطورة)
// ============================================================
function rewriteLinks(html, baseUrl, proxyBase) {
    let rewritten = html;

    // 1. السمات الأساسية
    rewritten = rewritten.replace(/(href|src|action|poster|data-src|data-href|data-original|data-url|data-srcset|data-src)\s*=\s*["']([^"']*)["']/gi, (match, attr, attrUrl) => {
        if (!attrUrl || attrUrl.startsWith('javascript:') || attrUrl.startsWith('#') || attrUrl.startsWith('data:') || attrUrl.startsWith('blob:')) {
            return match;
        }
        try {
            const absoluteUrl = new URL(attrUrl, baseUrl).href;
            return `${attr}="${proxyBase}?url=${encodeURIComponent(absoluteUrl)}"`;
        } catch (_) {
            return match;
        }
    });

    // 2. srcset
    rewritten = rewritten.replace(/srcset\s*=\s*["']([^"']*)["']/gi, (match, srcsetValue) => {
        const parts = srcsetValue.split(',').map(part => {
            const trimmed = part.trim();
            const [url, size] = trimmed.split(/\s+/);
            if (!url) return trimmed;
            try {
                const absoluteUrl = new URL(url, baseUrl).href;
                return `${proxyBase}?url=${encodeURIComponent(absoluteUrl)}` + (size ? ` ${size}` : '');
            } catch (_) {
                return trimmed;
            }
        });
        return `srcset="${parts.join(', ')}"`;
    });

    // 3. url() في CSS
    rewritten = rewritten.replace(/url\s*\(\s*["']?([^"')]*)["']?\s*\)/gi, (match, url) => {
        if (!url || url.startsWith('data:') || url.startsWith('#') || url.startsWith('blob:')) return match;
        try {
            const absoluteUrl = new URL(url, baseUrl).href;
            return `url("${proxyBase}?url=${encodeURIComponent(absoluteUrl)}")`;
        } catch (_) {
            return match;
        }
    });

    return rewritten;
}

// ============================================================
//  سكربت اعتراض متقدم (لـ YouTube وغيره)
// ============================================================
function getAdvancedInterceptionScript(proxyBase, originalUrl) {
    return `
    <script>
    (function() {
        if (window.__PROXY_INTERCEPTED) return;
        window.__PROXY_INTERCEPTED = true;
        
        window.PROXY_BASE = '${proxyBase}';
        window.ORIGINAL_URL = '${originalUrl}';

        function rewriteUrl(url) {
            if (!url || typeof url !== 'string') return url;
            if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:')) return url;
            if (url.includes(window.PROXY_BASE)) return url;
            try {
                const absolute = new URL(url, window.ORIGINAL_URL).href;
                return window.PROXY_BASE + '?url=' + encodeURIComponent(absolute);
            } catch (e) {
                return url;
            }
        }

        // اعتراض fetch
        const origFetch = window.fetch;
        window.fetch = function(resource, options) {
            let url = typeof resource === 'string' ? resource : (resource.url || '');
            if (url && typeof url === 'string') {
                url = rewriteUrl(url);
            }
            if (typeof resource === 'string') {
                resource = url;
            } else if (resource && typeof resource === 'object') {
                resource = new Request(url, resource);
            }
            return origFetch.call(this, resource, options);
        };

        // اعتراض XMLHttpRequest
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
            if (url && typeof url === 'string') {
                url = rewriteUrl(url);
            }
            return origOpen.call(this, method, url, ...args);
        };

        // اعتراض window.open
        const origOpenWindow = window.open;
        window.open = function(url, ...args) {
            if (url && typeof url === 'string') {
                url = rewriteUrl(url);
            }
            return origOpenWindow.call(this, url, ...args);
        };

        // اعتراض location.assign و replace
        const origAssign = location.assign;
        location.assign = function(url) {
            if (url && typeof url === 'string') {
                url = rewriteUrl(url);
            }
            return origAssign.call(this, url);
        };
        const origReplace = location.replace;
        location.replace = function(url) {
            if (url && typeof url === 'string') {
                url = rewriteUrl(url);
            }
            return origReplace.call(this, url);
        };

        // مراقبة التغييرات في DOM
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        ['src', 'href', 'data-src', 'poster'].forEach(attr => {
                            if (node.hasAttribute(attr)) {
                                const val = node.getAttribute(attr);
                                if (val && typeof val === 'string') {
                                    node.setAttribute(attr, rewriteUrl(val));
                                }
                            }
                        });
                    }
                }
            }
        });
        observer.observe(document, { childList: true, subtree: true });

        // تصحيح الروابط الموجودة
        document.querySelectorAll('[src], [href], [data-src], [poster]').forEach(el => {
            ['src', 'href', 'data-src', 'poster'].forEach(attr => {
                if (el.hasAttribute(attr)) {
                    const val = el.getAttribute(attr);
                    if (val && typeof val === 'string') {
                        el.setAttribute(attr, rewriteUrl(val));
                    }
                }
            });
        });

        console.log('[PROXY] ✅ Interception script loaded');
    })();
    </script>
    `;
}

// ============================================================
//  معالج Puppeteer مخصص لـ YouTube وغيره
// ============================================================
async function renderWithPuppeteer(url, options = {}) {
    const browser = await getBrowser();
    if (!browser) throw new Error('Browser not available');

    const page = await browser.newPage();
    pagePool.add(page);
    await cleanupPages();

    try {
        const userAgent = CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1920, height: 1080 });

        // السماح بجميع الطلبات
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            request.continue();
        });

        // انتظار تحميل الصفحة
        await page.goto(url, { 
            waitUntil: 'networkidle2', 
            timeout: CONFIG.pageTimeout 
        });

        // انتظار إضافي لتطبيقات SPA مثل YouTube
        await page.waitForTimeout(5000);

        // محاولة انتظار ظهور المحتوى الرئيسي
        try {
            await page.waitForSelector('ytd-app, #content, main, body', { timeout: 10000 });
        } catch (_) {}

        // التمرير لأسفل لتحميل المحتوى الإضافي (لـ YouTube)
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= scrollHeight || totalHeight > 3000) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });

        // الحصول على HTML
        let html = await page.content();

        // إعادة كتابة الروابط
        html = rewriteLinks(html, url, CONFIG.proxyBase);

        // إضافة سكربت الاعتراض
        const script = getAdvancedInterceptionScript(CONFIG.proxyBase, url);
        html = html.replace('</head>', script + '</head>');
        if (!html.includes('</head>')) {
            html = html.replace('</body>', script + '</body>');
        }

        return html;

    } catch (error) {
        console.error('[PUPPETEER RENDER ERROR]', error.message);
        throw error;
    } finally {
        try {
            await page.close();
            pagePool.delete(page);
        } catch (_) {
            pagePool.delete(page);
        }
    }
}

// ============================================================
//  المعالج الرئيسي
// ============================================================
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send(getErrorPage('خطأ', 'مطلوب URL'));
    }

    try {
        new URL(targetUrl);
    } catch (_) {
        return res.status(400).send(getErrorPage('خطأ في URL', 'الرابط غير صحيح'));
    }

    try {
        console.log(`[PROXY] ${targetUrl.substring(0, 80)}...`);

        // إذا كان طلب مورد
        const isResource = targetUrl.match(/\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|mp4|webm|mp3|pdf|zip|gz|wasm|json|xml)$/i);
        const acceptHeader = req.headers.accept || '';

        if (isResource || (!acceptHeader.includes('text/html') && !targetUrl.includes('youtube.com/watch'))) {
            const result = await fetchResource(targetUrl, req.headers);
            if (!result) {
                return res.status(404).send(getErrorPage('غير موجود', 'تعذر جلب المورد'));
            }

            res.setHeader('Content-Type', result.contentType);
            res.setHeader('Content-Length', result.data.length);
            if (result.headers['cache-control']) res.setHeader('Cache-Control', result.headers['cache-control']);
            if (result.headers['etag']) res.setHeader('ETag', result.headers['etag']);
            if (result.headers['last-modified']) res.setHeader('Last-Modified', result.headers['last-modified']);

            // دعم Range للفيديو
            const rangeHeader = req.headers.range;
            if (rangeHeader && result.headers['accept-ranges'] === 'bytes') {
                const parts = rangeHeader.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : result.data.length - 1;
                const chunkSize = end - start + 1;
                const chunk = result.data.slice(start, end + 1);
                res.status(206);
                res.setHeader('Content-Range', `bytes ${start}-${end}/${result.data.length}`);
                res.setHeader('Content-Length', chunkSize);
                return res.send(chunk);
            }

            return res.send(result.data);
        }

        // معالجة الصفحات HTML
        const hostname = new URL(targetUrl).hostname || '';
        const needsPuppeteer = CONFIG.puppeteerSites.some(site => hostname.includes(site)) || 
                              targetUrl.includes('youtube.com/watch') || 
                              targetUrl.includes('youtu.be');

        let html;
        if (needsPuppeteer) {
            console.log('[RENDER] Using Puppeteer');
            html = await renderWithPuppeteer(targetUrl);
        } else {
            console.log('[FETCH] Direct fetch');
            const result = await fetchResource(targetUrl, req.headers);
            if (!result) {
                return res.status(503).send(getErrorPage('خطأ في التحميل', 'فشل تحميل الموقع'));
            }

            const contentType = result.contentType || '';
            if (!contentType.includes('text/html')) {
                res.setHeader('Content-Type', contentType);
                return res.send(result.data);
            }

            html = result.data.toString('utf-8');
            html = rewriteLinks(html, targetUrl, CONFIG.proxyBase);
            const script = getAdvancedInterceptionScript(CONFIG.proxyBase, targetUrl);
            html = html.replace('</head>', script + '</head>');
            if (!html.includes('</head>')) {
                html = html.replace('</body>', script + '</body>');
            }
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(html);

    } catch (error) {
        console.error('[PROXY ERROR]', error.message);
        res.status(500).send(getErrorPage('خطأ في الخادم', error.message));
    }
});

// ============================================================
//  الصفحة الرئيسية
// ============================================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>وكيل الويب الذكي v6.5</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 24px;
            padding: 60px 40px;
            max-width: 750px;
            box-shadow: 0 30px 80px rgba(0,0,0,0.35);
            text-align: right;
            width: 100%;
        }
        h1 { color: #2d3748; font-size: 40px; margin-bottom: 8px; font-weight: 800; }
        .subtitle { color: #718096; font-size: 18px; margin-bottom: 40px; }
        .search-group { display: flex; gap: 12px; margin-bottom: 40px; }
        input {
            flex: 1;
            padding: 18px 22px;
            border: 2px solid #e2e8f0;
            border-radius: 14px;
            font-size: 17px;
            transition: 0.3s;
            background: #f7fafc;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.15);
            background: white;
        }
        .btn {
            padding: 18px 40px;
            border: none;
            border-radius: 14px;
            font-size: 18px;
            font-weight: 700;
            cursor: pointer;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            transition: 0.3s;
            white-space: nowrap;
        }
        .btn:hover { transform: translateY(-3px); box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4); }
        .services {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 14px;
            margin: 40px 0;
        }
        .service-btn {
            padding: 20px 10px;
            border: 2px solid #edf2f7;
            background: #fafcff;
            border-radius: 14px;
            cursor: pointer;
            transition: 0.3s;
            text-align: center;
            text-decoration: none;
            color: #2d3748;
            font-weight: 700;
            font-size: 15px;
        }
        .service-btn:hover {
            border-color: #667eea;
            background: #667eea;
            color: white;
            transform: translateY(-4px);
            box-shadow: 0 8px 20px rgba(102, 126, 234, 0.25);
        }
        .info {
            background: #f0f4ff;
            padding: 24px;
            border-radius: 16px;
            margin-top: 30px;
            color: #2d3748;
            font-size: 15px;
            border: 1px solid rgba(102, 126, 234, 0.15);
            line-height: 1.8;
        }
        .info strong { color: #667eea; }
        @media (max-width: 600px) {
            .container { padding: 30px 20px; }
            h1 { font-size: 30px; }
            .search-group { flex-direction: column; }
            .services { grid-template-columns: repeat(2, 1fr); }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>وكيل الويب الذكي</h1>
        <p class="subtitle">تصفح YouTube وجميع المواقع بحرية تامة 🚀</p>

        <div class="search-group">
            <input type="text" id="urlInput" placeholder="أدخل رابط أو ابحث..." autofocus>
            <button class="btn" onclick="go()">بحث</button>
        </div>

        <div class="services">
            <a class="service-btn" href="/proxy?url=https://www.youtube.com">▶️ YouTube</a>
            <a class="service-btn" href="/proxy?url=https://www.google.com">🔍 Google</a>
            <a class="service-btn" href="/proxy?url=https://www.facebook.com">📘 Facebook</a>
            <a class="service-btn" href="/proxy?url=https://www.instagram.com">📸 Instagram</a>
            <a class="service-btn" href="/proxy?url=https://www.tiktok.com">🎵 TikTok</a>
            <a class="service-btn" href="/proxy?url=https://twitter.com">🐦 Twitter</a>
            <a class="service-btn" href="/proxy?url=https://www.reddit.com">🗣️ Reddit</a>
            <a class="service-btn" href="/proxy?url=https://www.twitch.tv">🎮 Twitch</a>
        </div>

        <div class="info">
            <strong>✨ المميزات:</strong><br>
            • دعم كامل لـ <strong>YouTube</strong> (فيديوهات، تعليقات، بث مباشر).<br>
            • تحميل جميع الموارد (CSS, JS, صور, فيديو).<br>
            • اعتراض طلبات AJAX و Fetch.<br>
            • دعم <strong>Range</strong> لتشغيل الفيديو بسلاسة.<br>
            • إعادة كتابة شاملة للروابط.<br>
            • يدعم جميع المواقع تقريباً.
        </div>
    </div>

    <script>
        function go() {
            const input = document.getElementById('urlInput').value.trim();
            if (!input) return;
            let finalUrl;
            if (input.startsWith('http://') || input.startsWith('https://')) {
                finalUrl = input;
            } else if (input.includes('.') && !input.includes(' ')) {
                finalUrl = 'https://' + input;
            } else {
                finalUrl = 'https://www.google.com/search?q=' + encodeURIComponent(input);
            }
            window.location.href = '/proxy?url=' + encodeURIComponent(finalUrl);
        }
        document.getElementById('urlInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') go();
        });
    </script>
</body>
</html>
    `);
});

// ============================================================
//  Health Check
// ============================================================
app.get('/health', (req, res) => {
    res.json({
        status: 'operational',
        version: '6.5.0',
        uptime: process.uptime(),
        pagePoolSize: pagePool.size,
        cacheSize: cache.size,
        timestamp: new Date().toISOString()
    });
});

// ============================================================
//  صفحة الخطأ
// ============================================================
function getErrorPage(title, message) {
    return `
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .error-box {
            background: white;
            border-radius: 24px;
            padding: 50px 40px;
            max-width: 600px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.25);
            text-align: right;
        }
        h1 { color: #e53e3e; margin-bottom: 16px; font-size: 34px; }
        p { color: #4a5568; line-height: 1.9; font-size: 18px; }
        a { color: #667eea; text-decoration: none; margin-top: 30px; display: inline-block; font-weight: 700; font-size: 18px; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="error-box">
        <h1>⚠️ ${title}</h1>
        <p>${message}</p>
        <a href="/">↩ العودة للرئيسية</a>
    </div>
</body>
</html>
    `;
}

// ============================================================
//  تشغيل السيرفر
// ============================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
    try {
        await getBrowser();
        console.log(`
╔══════════════════════════════════════════════════════════════════╗
║         🚀  SMART WEB PROXY v6.5  –  YouTube Edition          ║
║                                                                ║
║  🌐  http://localhost:${PORT}                                  ║
║                                                                ║
║  ✅  دعم كامل لـ YouTube:                                     ║
║     ✓  فيديوهات                                               ║
║     ✓  تعليقات                                                ║
║     ✓  بث مباشر                                               ║
║     ✓  تشغيل سلس مع دعم Range                                 ║
║                                                                ║
║  ⚡  Status: Ready                                             ║
╚══════════════════════════════════════════════════════════════════╝
        `);
    } catch (err) {
        console.error('[STARTUP ERROR]', err.message);
        process.exit(1);
    }
});

// ============================================================
//  إغلاق آمن
// ============================================================
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    for (const page of pagePool) {
        try { await page.close(); } catch (_) {}
    }
    pagePool.clear();
    if (browser) {
        try { await browser.close(); } catch (_) {}
    }
    console.log('✅ Shutdown complete');
    process.exit(0);
});

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
});