const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const { URL } = require('url');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');

const app = express();
let browser = null;
const pagePool = new Set();
const maxPages = 8;
const cache = new Map();
const CACHE_TTL = 60000;

// ============================================================
//  إعدادات السيرفر - YouTube Proxy بالعربي
// ============================================================
const CONFIG = {
    proxyBase: '/proxy',
    timeout: 120000,
    pageTimeout: 60000,
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ],
    // المواقع اللي محتاجة Puppeteer
    puppeteerSites: ['youtube.com', 'youtu.be']
};

// Middleware
app.use(cors({ 
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
    credentials: true
}));
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
        '.mjs': 'application/javascript',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.wasm': 'application/wasm',
        '.txt': 'text/plain',
        '.xml': 'application/xml',
        '.pdf': 'application/pdf'
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
                    '--disable-pdf-viewer',
                    '--autoplay-policy=no-user-gesture-required'
                ]
            });
            console.log('[✅] تم تشغيل المتصفح بنجاح');
        } catch (err) {
            console.error('[❌] خطأ في تشغيل المتصفح:', err.message);
            browser = null;
        }
    }
    return browser;
}

// ============================================================
//  جلب الموارد مع دعم جميع الطرق
// ============================================================
async function fetchResource(targetUrl, reqHeaders = {}, body = null, method = 'GET') {
    const userAgent = CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];

    // التخزين المؤقت للـ GET فقط
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
            'Origin': 'https://www.youtube.com',
            'Referer': 'https://www.youtube.com/',
            ...reqHeaders
        };

        // حذف الرؤوس المزعجة
        delete headers['host'];
        delete headers['connection'];
        delete headers['content-length'];

        const fetchOptions = {
            method: method,
            headers: headers,
            timeout: CONFIG.timeout,
            redirect: 'follow'
        };

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

        // تخزين مؤقت للملفات الصغيرة
        if (method === 'GET' && buffer.length < 5 * 1024 * 1024) {
            cache.set(cacheKey, { data: result, timestamp: Date.now() });
        }

        return result;

    } catch (error) {
        console.error(`[❌] خطأ في جلب المورد: ${targetUrl.substring(0, 60)}...`);
        return null;
    }
}

// ============================================================
//  إعادة كتابة الروابط في HTML
// ============================================================
function rewriteLinks(html, baseUrl, proxyBase) {
    let rewritten = html;

    // إعادة كتابة جميع الروابط
    rewritten = rewritten.replace(/(href|src|action|poster|data-src|data-href|data-original|data-url|data-srcset)\s*=\s*["']([^"']*)["']/gi, (match, attr, attrUrl) => {
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

    // إعادة كتابة srcset
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

    // إعادة كتابة url() في CSS
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
//  سكربت اعتراض متقدم (بالعربي)
// ============================================================
function getInterceptionScript(proxyBase, originalUrl) {
    return `
    <script>
    (function() {
        if (window.__PROXY_INTERCEPTED) return;
        window.__PROXY_INTERCEPTED = true;
        
        window.PROXY_BASE = '${proxyBase}';
        window.ORIGINAL_URL = '${originalUrl}';
        window.IS_PROXY = true;

        // دالة إعادة كتابة الرابط
        function rewriteUrl(url) {
            if (!url || typeof url !== 'string') return url;
            if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:')) return url;
            if (url.includes(window.PROXY_BASE)) return url;
            if (url.startsWith('//')) {
                url = 'https:' + url;
            }
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

        console.log('[✅] تم تحميل سكربت الاعتراض بنجاح');
    })();
    </script>
    `;
}

// ============================================================
//  معالج يوتيوب باستخدام Puppeteer
// ============================================================
async function renderYouTube(url) {
    const browser = await getBrowser();
    if (!browser) throw new Error('المتصفح غير متاح');

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
            const url = request.url();
            // نمرر كل الطلبات عادي
            request.continue();
        });

        console.log('[⏳] جاري تحميل يوتيوب...');

        // الذهاب إلى يوتيوب
        await page.goto(url, { 
            waitUntil: 'networkidle2', 
            timeout: CONFIG.pageTimeout 
        });

        // انتظار تحميل التطبيق
        await page.waitForTimeout(5000);

        // انتظار ظهور العناصر الرئيسية
        try {
            await page.waitForSelector('ytd-app, ytd-page-manager, #content', { timeout: 15000 });
        } catch (_) {
            console.log('[⏳] في انتظار تحميل العناصر...');
        }

        // التمرير لأسفل لتحميل المحتوى
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 300;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= Math.min(scrollHeight, 3000)) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 200);
            });
        });

        // انتظار إضافي
        await page.waitForTimeout(3000);

        // الحصول على HTML
        let html = await page.content();

        // إعادة كتابة الروابط
        html = rewriteLinks(html, url, CONFIG.proxyBase);

        // إضافة سكربت الاعتراض
        const script = getInterceptionScript(CONFIG.proxyBase, url);
        html = html.replace('</head>', script + '</head>');
        if (!html.includes('</head>')) {
            html = html.replace('</body>', script + '</body>');
        }

        console.log('[✅] تم تحميل يوتيوب بنجاح');
        return html;

    } catch (error) {
        console.error('[❌] خطأ في تحميل يوتيوب:', error.message);
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
//  المعالج الرئيسي - يقبل جميع الطرق
// ============================================================
app.all('/proxy', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send(getErrorPage('خطأ', 'مطلوب رابط'));
    }

    try {
        new URL(targetUrl);
    } catch (_) {
        return res.status(400).send(getErrorPage('خطأ في الرابط', 'الرابط غير صحيح'));
    }

    try {
        const method = req.method;
        console.log(`[📡] ${method} ${targetUrl.substring(0, 60)}...`);

        // التحقق مما إذا كان طلب مورد (CSS, JS, صور, فيديو)
        const isResource = targetUrl.match(/\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|mp4|webm|mp3|pdf|zip|gz|wasm|json|xml|txt)$/i);
        const acceptHeader = req.headers.accept || '';

        // معالجة الموارد والـ API
        if (isResource || (!acceptHeader.includes('text/html') && !targetUrl.includes('youtube.com/watch'))) {
            let body = null;
            if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
                body = JSON.stringify(req.body);
            }

            const result = await fetchResource(targetUrl, req.headers, body, method);
            if (!result) {
                return res.status(404).send(getErrorPage('غير موجود', 'تعذر جلب المورد'));
            }

            // إعداد الرؤوس
            res.setHeader('Content-Type', result.contentType);
            res.setHeader('Content-Length', result.data.length);
            
            if (result.headers['cache-control']) res.setHeader('Cache-Control', result.headers['cache-control']);
            if (result.headers['etag']) res.setHeader('ETag', result.headers['etag']);
            if (result.headers['last-modified']) res.setHeader('Last-Modified', result.headers['last-modified']);
            
            // دعم CORS للفيديو
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');

            // دعم Range للفيديو (مهم جداً لتشغيل الفيديو)
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

        // معالجة صفحات يوتيوب
        let html;
        const hostname = new URL(targetUrl).hostname || '';
        const needsPuppeteer = CONFIG.puppeteerSites.some(site => hostname.includes(site));

        if (needsPuppeteer) {
            console.log('[🎬] جاري تحميل يوتيوب...');
            html = await renderYouTube(targetUrl);
        } else {
            const result = await fetchResource(targetUrl, req.headers);
            if (!result) {
                return res.status(503).send(getErrorPage('خطأ في التحميل', 'فشل تحميل الموقع'));
            }
            html = result.data.toString('utf-8');
            html = rewriteLinks(html, targetUrl, CONFIG.proxyBase);
            const script = getInterceptionScript(CONFIG.proxyBase, targetUrl);
            html = html.replace('</head>', script + '</head>');
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(html);

    } catch (error) {
        console.error('[❌] خطأ في البروكسي:', error.message);
        res.status(500).send(getErrorPage('خطأ في الخادم', error.message));
    }
});

// ============================================================
//  الصفحة الرئيسية - بالعربي
// ============================================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>وكيل يوتيوب - YouTube Proxy</title>
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
            border-radius: 28px;
            padding: 60px 40px;
            max-width: 700px;
            box-shadow: 0 40px 100px rgba(0,0,0,0.4);
            text-align: center;
            width: 100%;
        }
        .logo { font-size: 90px; margin-bottom: 5px; }
        h1 { 
            color: #ff0000; 
            font-size: 44px; 
            margin-bottom: 8px; 
            font-weight: 900;
        }
        .subtitle { 
            color: #666; 
            font-size: 20px; 
            margin-bottom: 35px;
        }
        .search-group {
            display: flex;
            gap: 12px;
            margin-bottom: 30px;
        }
        input {
            flex: 1;
            padding: 20px 25px;
            border: 2px solid #e2e8f0;
            border-radius: 16px;
            font-size: 18px;
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
            padding: 20px 45px;
            border: none;
            border-radius: 16px;
            font-size: 20px;
            font-weight: 700;
            cursor: pointer;
            background: #ff0000;
            color: white;
            transition: 0.3s;
            white-space: nowrap;
        }
        .btn:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 30px rgba(255, 0, 0, 0.4);
            background: #cc0000;
        }
        .links {
            display: flex;
            gap: 12px;
            justify-content: center;
            flex-wrap: wrap;
            margin-top: 30px;
        }
        .link-btn {
            padding: 16px 28px;
            border: 2px solid #e2e8f0;
            background: #fafcff;
            border-radius: 14px;
            cursor: pointer;
            transition: 0.3s;
            text-decoration: none;
            color: #333;
            font-weight: 700;
            font-size: 16px;
        }
        .link-btn:hover {
            border-color: #ff0000;
            background: #fff5f5;
            transform: translateY(-3px);
            box-shadow: 0 5px 15px rgba(255, 0, 0, 0.1);
        }
        .info {
            background: #fff5f5;
            padding: 25px;
            border-radius: 16px;
            margin-top: 35px;
            color: #333;
            font-size: 16px;
            border: 1px solid rgba(255, 0, 0, 0.12);
            line-height: 2;
            text-align: right;
        }
        .info strong { color: #ff0000; }
        @media (max-width: 600px) {
            .container { padding: 30px 20px; }
            h1 { font-size: 32px; }
            .search-group { flex-direction: column; }
            .logo { font-size: 60px; }
            .subtitle { font-size: 16px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">▶️</div>
        <h1>وكيل يوتيوب</h1>
        <p class="subtitle">شوف أي فيديو بحرية وبسرعة 🚀</p>

        <div class="search-group">
            <input type="text" id="urlInput" placeholder="https://youtube.com/watch?v=..." autofocus>
            <button class="btn" onclick="go()">▶ تشغيل</button>
        </div>

        <div class="links">
            <a class="link-btn" href="/proxy?url=https://www.youtube.com">🏠 الرئيسية</a>
            <a class="link-btn" href="/proxy?url=https://www.youtube.com/trending">🔥 رائج</a>
            <a class="link-btn" href="/proxy?url=https://www.youtube.com/feed/subscriptions">📺 اشتراكات</a>
            <a class="link-btn" href="/proxy?url=https://www.youtube.com/feed/explore">🔍 استكشاف</a>
        </div>

        <div class="info">
            <strong>💡 مميزات الوكيل:</strong><br>
            • مشاهدة أي فيديو يوتيوب بدون حظر<br>
            • دعم كامل للفيديوهات والتعليقات<br>
            • تشغيل سلس مع دعم الجودة العالية<br>
            • واجهة كاملة مثل الموقع الأصلي<br>
            • تحميل سريع وآمن
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
//  صفحة الحالة الصحية
// ============================================================
app.get('/health', (req, res) => {
    res.json({
        status: 'يعمل',
        version: '8.0.0',
        service: 'وكيل يوتيوب - YouTube Proxy',
        uptime: process.uptime(),
        pagePoolSize: pagePool.size,
        cacheSize: cache.size,
        timestamp: new Date().toISOString()
    });
});

// ============================================================
//  صفحة الخطأ - بالعربي
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
            border-radius: 28px;
            padding: 50px 40px;
            max-width: 600px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
        }
        .icon { font-size: 70px; margin-bottom: 10px; }
        h1 { color: #e53e3e; margin-bottom: 16px; font-size: 34px; }
        p { color: #4a5568; line-height: 2; font-size: 18px; }
        a { 
            color: #ff0000; 
            text-decoration: none; 
            margin-top: 30px; 
            display: inline-block; 
            font-weight: 700; 
            font-size: 18px;
            padding: 12px 30px;
            border: 2px solid #ff0000;
            border-radius: 12px;
            transition: 0.3s;
        }
        a:hover {
            background: #ff0000;
            color: white;
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="error-box">
        <div class="icon">😢</div>
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
║         🎬  وكيل يوتيوب v8.0  –  YouTube Proxy               ║
║                                                                ║
║  🌐  http://localhost:${PORT}                                  ║
║                                                                ║
║  ✅  المميزات:                                                ║
║     ✓  واجهة عربية كاملة                                      ║
║     ✓  دعم جميع فيديوهات يوتيوب                              ║
║     ✓  تشغيل الفيديو بجودة عالية                             ║
║     ✓  دعم التعليقات                                         ║
║     ✓  دعم البث المباشر                                      ║
║     ✓  تحميل سريع وآمن                                       ║
║     ✓  يدعم جميع طلبات الـ API                               ║
║                                                                ║
║  ⚡  الحالة: جاهز ✅                                           ║
╚══════════════════════════════════════════════════════════════════╝
        `);
    } catch (err) {
        console.error('[❌] خطأ في بدء التشغيل:', err.message);
        process.exit(1);
    }
});

// ============================================================
//  إغلاق آمن
// ============================================================
process.on('SIGINT', async () => {
    console.log('\n🛑 جاري الإغلاق...');
    for (const page of pagePool) {
        try { await page.close(); } catch (_) {}
    }
    pagePool.clear();
    if (browser) {
        try { await browser.close(); } catch (_) {}
    }
    console.log('✅ تم الإغلاق بنجاح');
    process.exit(0);
});

process.on('unhandledRejection', (reason) => {
    console.error('[❌] خطأ غير متوقع:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[❌] استثناء غير متوقع:', err);
});