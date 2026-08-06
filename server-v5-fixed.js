const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const { URL } = require('url');
const cookieParser = require('cookie-parser');

const app = express();
let browser = null;
const pagePool = new Set();
const maxPages = 5;

// ============================================
// إعدادات
// ============================================
const CONFIG = {
    proxyBase: '/proxy',
    timeout: 60000,
    pageTimeout: 30000,
    maxConnections: 10,
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ]
};

// Middleware
app.use(cors({ 
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cookieParser());

// ============================================
// تهيئة Puppeteer
// ============================================
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
                    '--allow-running-insecure-content'
                ]
            });
        } catch (err) {
            console.error('[PUPPETEER ERROR]', err.message);
            browser = null;
        }
    }
    return browser;
}

// ============================================
// إغلاق الصفحات القديمة
// ============================================
async function cleanupPages() {
    if (pagePool.size > maxPages) {
        const pagesToClose = Array.from(pagePool).slice(0, Math.floor(pagePool.size / 2));
        for (const page of pagesToClose) {
            try {
                await page.close();
                pagePool.delete(page);
            } catch (e) {
                pagePool.delete(page);
            }
        }
    }
}

// ============================================
// دالة ضخ HTML عام مع Puppeteer
// ============================================
async function renderWithPuppeteer(url, options = {}) {
    const browser = await getBrowser();
    if (!browser) throw new Error('فشل تشغيل المتصفح');

    const page = await browser.newPage();
    pagePool.add(page);
    await cleanupPages();

    try {
        const userAgent = CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1366, height: 768 });

        // Block resources
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            const requestUrl = request.url();

            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                request.abort();
            } else if (requestUrl.includes('analytics') || requestUrl.includes('ads') || requestUrl.includes('doubleclick')) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Navigate with timeout
        const response = await Promise.race([
            page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.pageTimeout }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), CONFIG.pageTimeout))
        ]);

        if (!response) throw new Error('فشل تحميل الصفحة');

        // تأخير صغير لتحميل JS
        await page.waitForTimeout(2000);

        let html = await page.content();

        // إعادة كتابة الروابط
        html = html.replace(/(href|src|action|poster|data)\s*=\s*["']([^"']*)["']/gi, (match, attr, attrUrl) => {
            if (!attrUrl || attrUrl.startsWith('javascript:') || attrUrl.startsWith('#') || attrUrl.startsWith('data:')) {
                return match;
            }

            try {
                const absoluteUrl = new URL(attrUrl, url).href;
                return `${attr}="${CONFIG.proxyBase}?url=${encodeURIComponent(absoluteUrl)}"`;
            } catch {
                return match;
            }
        });

        // إضافة proxy script
        const proxyScript = `
        <script>
        window.PROXY_BASE = '${CONFIG.proxyBase}';
        window.ORIGINAL_URL = '${url}';
        
        const origFetch = window.fetch;
        window.fetch = async (resource, config) => {
            let url = typeof resource === 'string' ? resource : resource.url;
            
            if (!url.includes(window.PROXY_BASE) && !url.startsWith('blob:') && !url.startsWith('data:')) {
                try {
                    let absoluteUrl = url;
                    if (url.startsWith('/')) {
                        const base = new URL(window.ORIGINAL_URL);
                        absoluteUrl = base.origin + url;
                    } else if (url.startsWith('//')) {
                        absoluteUrl = 'https:' + url;
                    } else if (!url.startsWith('http')) {
                        const base = new URL(window.ORIGINAL_URL);
                        absoluteUrl = new URL(url, base.origin).href;
                    }
                    url = window.PROXY_BASE + '?url=' + encodeURIComponent(absoluteUrl);
                } catch (e) {}
            }
            
            return origFetch(url, config);
        };

        const origXHR = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
            let finalUrl = url;
            if (!url.includes(window.PROXY_BASE) && !url.startsWith('blob:')) {
                try {
                    let absoluteUrl = url;
                    if (url.startsWith('/')) {
                        const base = new URL(window.ORIGINAL_URL);
                        absoluteUrl = base.origin + url;
                    } else if (!url.startsWith('http')) {
                        const base = new URL(window.ORIGINAL_URL);
                        absoluteUrl = new URL(url, base.origin).href;
                    }
                    finalUrl = window.PROXY_BASE + '?url=' + encodeURIComponent(absoluteUrl);
                } catch (e) {}
            }
            return origXHR.call(this, method, finalUrl, ...args);
        };
        </script>
        `;

        html = html.replace('</head>', proxyScript + '</head>');
        if (!html.includes('</head>')) {
            html = html.replace('</body>', proxyScript + '</body>');
        }

        return html;

    } finally {
        try {
            await page.close();
            pagePool.delete(page);
        } catch (e) {
            pagePool.delete(page);
        }
    }
}

// ============================================
// معالج الـ fetch العام
// ============================================
async function fetchUrl(url) {
    const userAgent = CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': userAgent,
                'Accept': '*/*',
                'Accept-Language': 'ar-EG,ar;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache'
            },
            timeout: CONFIG.timeout,
            redirect: 'follow'
        });

        if (!response.ok) return null;

        const buffer = await response.buffer();
        const contentType = response.headers.get('content-type') || '';

        return {
            data: buffer,
            contentType,
            headers: Object.fromEntries(response.headers)
        };

    } catch (error) {
        console.error('[FETCH ERROR]', error.message);
        return null;
    }
}

// ============================================
// الطريق الرئيسي للـ Proxy
// ============================================
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send(getErrorPage('خطأ', 'مطلوب URL'));
    }

    try {
        new URL(targetUrl);
    } catch {
        return res.status(400).send(getErrorPage('خطأ في URL', 'الرابط غير صحيح'));
    }

    try {
        console.log(`[PROXY] ${targetUrl.substring(0, 60)}...`);
        const hostname = new URL(targetUrl).hostname || '';

        // المواقع التي تحتاج Puppeteer
        const puppeteerSites = ['youtube.com', 'youtu.be', 'google.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'reddit.com', 'twitch.tv'];
        const needsPuppeteer = puppeteerSites.some(site => hostname.includes(site));

        let html;
        if (needsPuppeteer) {
            console.log('[RENDERING] Using Puppeteer');
            html = await renderWithPuppeteer(targetUrl);
        } else {
            console.log('[FETCHING] Using Direct Fetch');
            const result = await fetchUrl(targetUrl);
            if (!result) {
                return res.status(503).send(getErrorPage('خطأ في التحميل', 'فشل تحميل الموقع'));
            }

            html = result.data.toString('utf-8');

            // إعادة كتابة الروابط
            html = html.replace(/(href|src|action|data-src)\s*=\s*["']([^"']*)["']/gi, (match, attr, attrUrl) => {
                if (!attrUrl || attrUrl.startsWith('javascript:') || attrUrl.startsWith('#')) {
                    return match;
                }

                try {
                    const absoluteUrl = new URL(attrUrl, targetUrl).href;
                    return `${attr}="${CONFIG.proxyBase}?url=${encodeURIComponent(absoluteUrl)}"`;
                } catch {
                    return match;
                }
            });

            // إضافة proxy script
            const proxyScript = `<script>
            window.PROXY_BASE = '${CONFIG.proxyBase}';
            window.ORIGINAL_URL = '${targetUrl}';
            const origFetch = window.fetch;
            window.fetch = async (resource, config) => {
                let url = typeof resource === 'string' ? resource : resource.url;
                if (!url.includes(window.PROXY_BASE) && !url.startsWith('blob:')) {
                    try {
                        const absoluteUrl = new URL(url, window.ORIGINAL_URL).href;
                        url = window.PROXY_BASE + '?url=' + encodeURIComponent(absoluteUrl);
                    } catch (e) {}
                }
                return origFetch(url, config);
            };
            </script>`;

            html = html.replace('</head>', proxyScript + '</head>');
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(html);

    } catch (error) {
        console.error('[PROXY ERROR]', error.message);
        res.status(500).send(getErrorPage('خطأ في الخادم', error.message));
    }
});

// ============================================
// الصفحة الرئيسية
// ============================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>وكيل الويب الذكي</title>
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
            border-radius: 20px;
            padding: 60px 40px;
            max-width: 650px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: right;
        }
        h1 {
            color: #333;
            font-size: 36px;
            margin-bottom: 10px;
        }
        .subtitle {
            color: #777;
            font-size: 16px;
            margin-bottom: 40px;
        }
        .search-group {
            display: flex;
            gap: 10px;
            margin-bottom: 40px;
        }
        input {
            flex: 1;
            padding: 16px 20px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 16px;
            transition: all 0.3s;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        .btn {
            padding: 16px 35px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            transition: all 0.3s;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(102, 126, 234, 0.3);
        }
        .services {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 12px;
            margin: 40px 0;
        }
        .service-btn {
            padding: 18px 15px;
            border: 2px solid #e8e8e8;
            background: #fafafa;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.3s;
            text-align: center;
            text-decoration: none;
            color: #333;
            font-weight: 700;
            font-size: 14px;
        }
        .service-btn:hover {
            border-color: #667eea;
            background: #667eea;
            color: white;
            transform: translateY(-3px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.2);
        }
        .info {
            background: #f5f7ff;
            padding: 20px;
            border-radius: 12px;
            margin-top: 30px;
            color: #667eea;
            font-size: 14px;
            border: 1px solid rgba(102, 126, 234, 0.15);
            line-height: 1.7;
        }
        @media (max-width: 600px) {
            .container { padding: 40px 25px; }
            h1 { font-size: 28px; }
            .search-group { flex-direction: column; }
            .services { grid-template-columns: repeat(2, 1fr); }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>وكيل الويب الذكي</h1>
        <p class="subtitle">تصفح أي موقع بحرية كاملة</p>
        
        <div class="search-group">
            <input type="text" id="urlInput" placeholder="أدخل رابط أو ابحث..." autofocus>
            <button class="btn" onclick="go()">بحث</button>
        </div>

        <div class="services">
            <a class="service-btn" href="/proxy?url=https://www.youtube.com">YouTube</a>
            <a class="service-btn" href="/proxy?url=https://www.google.com">Google</a>
            <a class="service-btn" href="/proxy?url=https://www.facebook.com">Facebook</a>
            <a class="service-btn" href="/proxy?url=https://www.instagram.com">Instagram</a>
            <a class="service-btn" href="/proxy?url=https://www.tiktok.com">TikTok</a>
            <a class="service-btn" href="/proxy?url=https://www.twitter.com">Twitter</a>
            <a class="service-btn" href="/proxy?url=https://www.reddit.com">Reddit</a>
            <a class="service-btn" href="/proxy?url=https://www.twitch.tv">Twitch</a>
        </div>

        <div class="info">
            السيرفر الذكي يحمل المواقع كاملة باستخدام تقنيات متقدمة:
            <br>• YouTube والفيديوهات والتعليقات
            <br>• Google Search مع كل النتائج
            <br>• أي موقع تاني بدون مشاكل
            <br>• تحميل سريع وآمن
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

// ============================================
// Health Check
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'operational',
        version: '5.1.0',
        uptime: process.uptime(),
        pagePoolSize: pagePool.size,
        timestamp: new Date().toISOString()
    });
});

// ============================================
// صفحة الخطأ
// ============================================
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
            border-radius: 20px;
            padding: 50px;
            max-width: 600px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: right;
        }
        h1 { color: #d32f2f; margin-bottom: 15px; font-size: 32px; }
        p { color: #666; line-height: 1.8; font-size: 16px; }
        a { color: #667eea; text-decoration: none; margin-top: 25px; display: inline-block; font-weight: 700; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="error-box">
        <h1>${title}</h1>
        <p>${message}</p>
        <a href="/">العودة للرئيسية</a>
    </div>
</body>
</html>
    `;
}

// ============================================
// تشغيل السيرفر
// ============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', async () => {
    try {
        await getBrowser();
        console.log(`
╔═════════════════════════════════════════════╗
║   وكيل الويب الذكي v5.1                    ║
║   Smart Web Proxy - Fixed Edition           ║
║                                             ║
║   http://localhost:${PORT}                  ║
║                                             ║
║   المميزات:                                 ║
║   ✓ Puppeteer rendering للمواقع الكبيرة    ║
║   ✓ Direct fetch للمواقع البسيطة          ║
║   ✓ Memory management محسّن               ║
║   ✓ Error handling كامل                    ║
║   ✓ Dynamic content loading                ║
║   ✓ Proxy script injection                 ║
║                                             ║
║   Status: Ready ✅                          ║
╚═════════════════════════════════════════════╝
        `);
    } catch (err) {
        console.error('[STARTUP ERROR]', err.message);
        process.exit(1);
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    
    // Close all pages
    for (const page of pagePool) {
        try {
            await page.close();
        } catch (e) {}
    }
    pagePool.clear();

    if (browser) {
        try {
            await browser.close();
        } catch (e) {}
    }

    console.log('Shutdown complete');
    process.exit(0);
});

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]', reason);
});
