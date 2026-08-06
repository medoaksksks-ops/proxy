const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const { URL } = require('url');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');

const app = express();
let browser = null;
const pagePool = new Set();
const maxPages = 5;
const cache = new Map();
const CACHE_TTL = 30000;

// ============================================================
//  إعدادات
// ============================================================
const CONFIG = {
    proxyBase: '/proxy',
    timeout: 120000,
    pageTimeout: 90000,
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ]
};

// Middleware
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
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
        '.mp4': 'video/mp4', '.webm': 'video/webm',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
        '.wasm': 'application/wasm'
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
                    '--window-size=1920,1080'
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
//  جلب الموارد مع دعم POST
// ============================================================
async function fetchResource(targetUrl, reqHeaders = {}, body = null, method = 'GET') {
    const userAgent = CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];

    // للتخزين المؤقت نستخدم فقط للـ GET
    if (method === 'GET') {
        const cacheKey = getCacheKey(targetUrl, reqHeaders);
        if (cache.has(cacheKey)) {
            const cached = cache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_TTL) {
                return cached.data;
            } else {
                cache.delete(cacheKey);
            }
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

        const fetchOptions = {
            method: method,
            headers: headers,
            timeout: CONFIG.timeout,
            redirect: 'follow'
        };

        // إضافة الجسم للـ POST
        if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            fetchOptions.body = body;
        }

        const response = await fetch(targetUrl, fetchOptions);

        if (!response.ok) return null;

        const buffer = await response.buffer();
        const contentType = response.headers.get('content-type') || getContentTypeFromExtension(targetUrl) || 'application/octet-stream';

        const result = {
            data: buffer,
            contentType: contentType,
            headers: Object.fromEntries(response.headers),
            statusCode: response.status
        };

        // تخزين مؤقت للـ GET فقط
        if (method === 'GET' && buffer.length < 3 * 1024 * 1024) {
            cache.set(cacheKey, { data: result, timestamp: Date.now() });
        }

        return result;

    } catch (error) {
        console.error(`[FETCH ERROR] ${targetUrl.substring(0, 60)}...`);
        return null;
    }
}

// ============================================================
//  إعادة كتابة الروابط
// ============================================================
function rewriteLinks(html, baseUrl, proxyBase) {
    let rewritten = html;

    rewritten = rewritten.replace(/(href|src|action|poster|data-src|data-href|data-original|data-url)\s*=\s*["']([^"']*)["']/gi, (match, attr, attrUrl) => {
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
//  سكربت اعتراض متقدم لـ YouTube
// ============================================================
function getYouTubeInterceptionScript(proxyBase, originalUrl) {
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
            if (url.startsWith('http://') || url.startsWith('https://')) {
                return window.PROXY_BASE + '?url=' + encodeURIComponent(url);
            }
            try {
                const absolute = new URL(url, window.ORIGINAL_URL).href;
                return window.PROXY_BASE + '?url=' + encodeURIComponent(absolute);
            } catch (e) {
                return url;
            }
        }

        // اعتراض fetch مع دعم POST
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

        // اعتراض XMLHttpRequest مع دعم POST
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
            if (url && typeof url === 'string') {
                url = rewriteUrl(url);
            }
            return origOpen.call(this, method, url, ...args);
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

        console.log('[PROXY] ✅ YouTube interception loaded');
    })();
    </script>
    `;
}

// ============================================================
//  معالج خاص بـ YouTube
// ============================================================
async function renderYouTube(url) {
    const browser = await getBrowser();
    if (!browser) throw new Error('Browser not available');

    const page = await browser.newPage();
    pagePool.add(page);
    await cleanupPages();

    try {
        const userAgent = CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1920, height: 1080 });

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            request.continue();
        });

        await page.goto(url, { 
            waitUntil: 'networkidle2', 
            timeout: CONFIG.pageTimeout 
        });

        await page.waitForTimeout(8000);

        try {
            await page.waitForSelector('ytd-app, ytd-page-manager, #content', { timeout: 15000 });
        } catch (_) {}

        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 200;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= Math.min(scrollHeight, 5000)) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 200);
            });
        });

        await page.waitForTimeout(3000);

        let html = await page.content();
        html = rewriteLinks(html, url, CONFIG.proxyBase);

        const script = getYouTubeInterceptionScript(CONFIG.proxyBase, url);
        html = html.replace('</head>', script + '</head>');
        if (!html.includes('</head>')) {
            html = html.replace('</body>', script + '</body>');
        }

        console.log('[YOUTUBE] ✅ Page rendered successfully');
        return html;

    } catch (error) {
        console.error('[YOUTUBE ERROR]', error.message);
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
//  المعالج الرئيسي - يقبل جميع الطرق (GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD)
// ============================================================
app.all('/proxy', async (req, res) => {
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
        const method = req.method;
        console.log(`[PROXY] ${method} ${targetUrl.substring(0, 80)}...`);

        // إذا كان طلب مورد (CSS, JS, صور, فيديو)
        const isResource = targetUrl.match(/\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|mp4|webm|mp3|pdf|zip|gz|wasm|json|xml)$/i);
        const acceptHeader = req.headers.accept || '';

        // معالجة الموارد
        if (isResource || (!acceptHeader.includes('text/html') && !targetUrl.includes('youtube.com/watch'))) {
            // الحصول على الجسم للـ POST
            let body = null;
            if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
                body = JSON.stringify(req.body);
            }

            const result = await fetchResource(targetUrl, req.headers, body, method);
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

        // معالجة صفحات YouTube
        let html;
        if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
            // للـ POST على YouTube (مثل log_event) نمررها مباشرة
            if (method !== 'GET') {
                const body = JSON.stringify(req.body);
                const result = await fetchResource(targetUrl, req.headers, body, method);
                if (!result) {
                    return res.status(404).send(getErrorPage('غير موجود', 'تعذر جلب المورد'));
                }
                res.setHeader('Content-Type', result.contentType);
                return res.send(result.data);
            }

            console.log('[YOUTUBE] Rendering with special handler');
            html = await renderYouTube(targetUrl);
        } else {
            const result = await fetchResource(targetUrl, req.headers);
            if (!result) {
                return res.status(503).send(getErrorPage('خطأ في التحميل', 'فشل تحميل الموقع'));
            }
            html = result.data.toString('utf-8');
            html = rewriteLinks(html, targetUrl, CONFIG.proxyBase);
            const script = getYouTubeInterceptionScript(CONFIG.proxyBase, targetUrl);
            html = html.replace('</head>', script + '</head>');
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
//  الصفحة الرئيسية - YouTube فقط
// ============================================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YouTube Proxy</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, sans-serif;
            background: linear-gradient(135deg, #ff0000 0%, #cc0000 100%);
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
            max-width: 650px;
            box-shadow: 0 30px 80px rgba(0,0,0,0.4);
            text-align: center;
            width: 100%;
        }
        .logo { font-size: 80px; margin-bottom: 10px; }
        h1 { color: #ff0000; font-size: 40px; margin-bottom: 8px; font-weight: 900; }
        .subtitle { color: #666; font-size: 18px; margin-bottom: 40px; }
        .search-group { display: flex; gap: 12px; margin-bottom: 30px; }
        input {
            flex: 1;
            padding: 18px 22px;
            border: 2px solid #e2e8f0;
            border-radius: 14px;
            font-size: 17px;
            transition: 0.3s;
            background: #f7fafc;
            direction: ltr;
        }
        input:focus {
            outline: none;
            border-color: #ff0000;
            box-shadow: 0 0 0 4px rgba(255, 0, 0, 0.15);
            background: white;
        }
        .btn {
            padding: 18px 40px;
            border: none;
            border-radius: 14px;
            font-size: 18px;
            font-weight: 700;
            cursor: pointer;
            background: #ff0000;
            color: white;
            transition: 0.3s;
            white-space: nowrap;
        }
        .btn:hover { transform: translateY(-3px); box-shadow: 0 8px 25px rgba(255, 0, 0, 0.4); background: #cc0000; }
        .links { display: flex; gap: 15px; justify-content: center; flex-wrap: wrap; margin-top: 30px; }
        .link-btn {
            padding: 15px 25px;
            border: 2px solid #e2e8f0;
            background: #fafcff;
            border-radius: 12px;
            cursor: pointer;
            transition: 0.3s;
            text-decoration: none;
            color: #333;
            font-weight: 700;
            font-size: 16px;
        }
        .link-btn:hover { border-color: #ff0000; background: #fff5f5; transform: translateY(-3px); }
        .info {
            background: #fff5f5;
            padding: 20px;
            border-radius: 12px;
            margin-top: 30px;
            color: #333;
            font-size: 14px;
            border: 1px solid rgba(255, 0, 0, 0.15);
            line-height: 1.8;
        }
        .info strong { color: #ff0000; }
        @media (max-width: 600px) {
            .container { padding: 30px 20px; }
            h1 { font-size: 28px; }
            .search-group { flex-direction: column; }
            .logo { font-size: 50px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">▶️</div>
        <h1>YouTube Proxy</h1>
        <p class="subtitle">شوف أي فيديو من غير حظر 🚀</p>

        <div class="search-group">
            <input type="text" id="urlInput" placeholder="https://youtube.com/watch?v=..." autofocus>
            <button class="btn" onclick="go()">▶ تشغيل</button>
        </div>

        <div class="links">
            <a class="link-btn" href="/proxy?url=https://www.youtube.com">🏠 الرئيسية</a>
            <a class="link-btn" href="/proxy?url=https://www.youtube.com/trending">🔥 رائج</a>
            <a class="link-btn" href="/proxy?url=https://www.youtube.com/feed/subscriptions">📺 اشتراكات</a>
        </div>

        <div class="info">
            <strong>💡 فقط YouTube:</strong><br>
            • شوف أي فيديو بحرية<br>
            • دعم كامل للتعليقات<br>
            • تشغيل سلس للفيديو<br>
            • واجهة كاملة مثل الموقع الأصلي
        </div>
    </div>

    <script>
        function go() {
            const input = document.getElementById('urlInput').value.trim();
            if (!input) return;
            let finalUrl;
            if (input.startsWith('http://') || input.startsWith('https://')) {
                finalUrl = input;
            } else if (input.includes('youtube.com') || input.includes('youtu.be')) {
                finalUrl = 'https://' + input;
            } else if (input.includes(' ') || !input.includes('.')) {
                finalUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(input);
            } else {
                finalUrl = 'https://' + input;
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
        version: '7.1.0',
        service: 'YouTube Proxy Only - Supports GET & POST',
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
            background: linear-gradient(135deg, #ff0000 0%, #cc0000 100%);
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
            text-align: center;
        }
        h1 { color: #e53e3e; margin-bottom: 16px; font-size: 34px; }
        p { color: #4a5568; line-height: 1.9; font-size: 18px; }
        a { color: #ff0000; text-decoration: none; margin-top: 30px; display: inline-block; font-weight: 700; font-size: 18px; }
        a:hover { text-decoration: underline; }
        .logo { font-size: 60px; }
    </style>
</head>
<body>
    <div class="error-box">
        <div class="logo">😢</div>
        <h1>${title}</h1>
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
║         🎬  YOUTUBE PROXY v7.1  –  Full Support              ║
║                                                                ║
║  🌐  http://localhost:${PORT}                                  ║
║                                                                ║
║  ✅  يدعم جميع الطرق: GET, POST, PUT, DELETE, PATCH           ║
║  ✅  مخصص لـ YouTube فقط:                                     ║
║     ✓  فيديوهات كاملة                                         ║
║     ✓  تعليقات                                                ║
║     ✓  بث مباشر                                               ║
║     ✓  تشغيل سلس                                             ║
║     ✓  واجهة كاملة مثل الأصلي                                ║
║     ✓  دعم طلبات الـ API (log_event, إلخ)                    ║
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