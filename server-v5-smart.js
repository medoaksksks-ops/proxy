const express = require('express');
const cors = require('cors');
const httpProxy = require('http-proxy');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const { URL } = require('url');
const zlib = require('zlib');
const cookieParser = require('cookie-parser');

const app = express();
let browser = null;

// Middleware
app.use(cors({ 
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
    allowedHeaders: '*'
}));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(cookieParser());

// ============================================
// إعدادات
// ============================================
const CONFIG = {
    proxyBase: '/proxy',
    timeout: 300000,
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ]
};

// ============================================
// تهيئة Puppeteer
// ============================================
async function getBrowser() {
    if (!browser) {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-web-resources',
                '--disable-component-extensions-with-background-pages'
            ]
        });
    }
    return browser;
}

// ============================================
// معالج YouTube
// ============================================
async function handleYouTube(url, res) {
    console.log(`[YOUTUBE] Loading ${url}`);
    
    try {
        const browser = await getBrowser();
        const page = await browser.newPage();

        // Set viewport
        await page.setViewport({ width: 1366, height: 768 });

        // Set User-Agent
        await page.setUserAgent(CONFIG.userAgents[0]);

        // Block ads and tracking
        await page.on('request', (request) => {
            const resourceType = request.resourceType();
            if (['image', 'stylesheet', 'font'].includes(resourceType)) {
                request.continue();
            } else if (request.url().includes('ads') || request.url().includes('doubleclick')) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Navigate
        await Promise.race([
            page.goto(url, { waitUntil: 'networkidle0', timeout: CONFIG.timeout }),
            new Promise(r => setTimeout(() => r('timeout'), 120000))
        ]);

        // Inject proxy script
        await page.evaluate(() => {
            window.location.href = window.location.href; // Refresh if needed
        });

        // Get HTML
        let html = await page.content();

        // Rewrite URLs
        const baseUrl = url;
        html = html.replace(/(href|src|action|poster|data)\s*=\s*["']([^"']*)["']/gi, (m, attr, url) => {
            if (!url.startsWith('http') && !url.startsWith('//') && !url.startsWith('javascript')) {
                if (url.startsWith('/')) {
                    return `${attr}="${CONFIG.proxyBase}?url=${encodeURIComponent(new URL(url, baseUrl).href)}"`;
                } else if (!url.startsWith('#')) {
                    return `${attr}="${CONFIG.proxyBase}?url=${encodeURIComponent(new URL(url, baseUrl).href)}"`;
                }
            }
            return `${attr}="${CONFIG.proxyBase}?url=${encodeURIComponent(url)}"`;
        });

        // Inject proxy client
        const proxyScript = `
        <script>
        window.PROXY_CONFIG = { path: '${CONFIG.proxyBase}', base: '${baseUrl}' };
        
        const origFetch = window.fetch;
        window.fetch = async (url, opts) => {
            let finalUrl = typeof url === 'string' ? url : url.url;
            if (!finalUrl.includes(window.PROXY_CONFIG.path)) {
                if (finalUrl.startsWith('http')) {
                    finalUrl = window.PROXY_CONFIG.path + '?url=' + encodeURIComponent(finalUrl);
                } else if (finalUrl.startsWith('//')) {
                    finalUrl = window.PROXY_CONFIG.path + '?url=' + encodeURIComponent('https:' + finalUrl);
                } else if (finalUrl.startsWith('/')) {
                    const base = new URL(window.PROXY_CONFIG.base);
                    finalUrl = window.PROXY_CONFIG.path + '?url=' + encodeURIComponent(base.origin + finalUrl);
                }
            }
            return origFetch(finalUrl, opts);
        };
        </script>
        `;

        html = html.replace('</head>', proxyScript + '</head>');

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
        await page.close();

    } catch (error) {
        console.error('[YOUTUBE ERROR]', error.message);
        res.status(500).send(getErrorPage('خطأ YouTube', error.message));
    }
}

// ============================================
// معالج Google Search
// ============================================
async function handleGoogleSearch(query, res) {
    console.log(`[GOOGLE] Searching for: ${query}`);
    
    try {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        
        const browser = await getBrowser();
        const page = await browser.newPage();
        await page.setUserAgent(CONFIG.userAgents[0]);

        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });

        let html = await page.content();

        // Rewrite all links
        html = html.replace(/(href|src)\s*=\s*["']([^"']*)["']/gi, (m, attr, url) => {
            if (url && !url.startsWith('javascript:') && !url.startsWith('#')) {
                return `${attr}="${CONFIG.proxyBase}?url=${encodeURIComponent(url)}"`;
            }
            return m;
        });

        // Add proxy script
        const script = `<script>
        window.PROXY_CONFIG = { path: '${CONFIG.proxyBase}' };
        const origFetch = window.fetch;
        window.fetch = async (url, opts) => {
            let finalUrl = typeof url === 'string' ? url : url.url;
            if (!finalUrl.includes('${CONFIG.proxyBase}')) {
                finalUrl = window.PROXY_CONFIG.path + '?url=' + encodeURIComponent(finalUrl);
            }
            return origFetch(finalUrl, opts);
        };
        </script>`;

        html = html.replace('</head>', script + '</head>');

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
        await page.close();

    } catch (error) {
        console.error('[GOOGLE ERROR]', error.message);
        res.status(500).send(getErrorPage('خطأ البحث', error.message));
    }
}

// ============================================
// معالج عام للـ Proxy
// ============================================
app.get('/proxy', async (req, res) => {
    const url = req.query.url;

    if (!url) {
        return res.status(400).send(getErrorPage('خطأ', 'مطلوب URL'));
    }

    try {
        new URL(url);
    } catch {
        return res.status(400).send(getErrorPage('خطأ في URL', url));
    }

    try {
        console.log(`[PROXY] ${url.substring(0, 80)}...`);

        const hostname = new URL(url).hostname;

        // معالجة خاصة لـ YouTube
        if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
            return handleYouTube(url, res);
        }

        // معالجة خاصة لـ Google
        if (hostname.includes('google.com')) {
            return handleGoogleSearch(url, res);
        }

        // للمواقع الأخرى - استخدم fetch عادي
        const userAgent = CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            redirect: 'follow',
            timeout: CONFIG.timeout
        });

        if (!response.ok) {
            return res.status(response.status).send(
                getErrorPage(`خطأ ${response.status}`, response.statusText)
            );
        }

        const contentType = (response.headers.get('content-type') || '').split(';')[0];

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', '*');

        if (contentType === 'text/html') {
            let html = await response.text();

            // Rewrite URLs
            html = html.replace(/(href|src|action|poster|data)\s*=\s*["']([^"']*)["']/gi, 
                (m, attr, u) => {
                    if (!u.startsWith('http') && !u.startsWith('//') && !u.startsWith('javascript') && !u.startsWith('#')) {
                        try {
                            const fullUrl = new URL(u, url).href;
                            return `${attr}="${CONFIG.proxyBase}?url=${encodeURIComponent(fullUrl)}"`;
                        } catch {
                            return m;
                        }
                    }
                    if (u.startsWith('http') || u.startsWith('//')) {
                        return `${attr}="${CONFIG.proxyBase}?url=${encodeURIComponent(u.startsWith('//') ? 'https:' + u : u)}"`;
                    }
                    return m;
                });

            // Inject script
            const script = `<script>
            window.PROXY_CONFIG = { path: '${CONFIG.proxyBase}', base: '${url}' };
            const origFetch = window.fetch;
            window.fetch = async (input, init) => {
                let url = typeof input === 'string' ? input : input.url;
                if (!url.includes(window.PROXY_CONFIG.path) && 
                    (url.startsWith('http') || url.startsWith('/') || url.startsWith('//'))) {
                    
                    if (url.startsWith('//')) url = 'https:' + url;
                    else if (url.startsWith('/')) {
                        const base = new URL(window.PROXY_CONFIG.base);
                        url = base.origin + url;
                    }
                    
                    const newUrl = window.PROXY_CONFIG.path + '?url=' + encodeURIComponent(url);
                    const newInput = typeof input === 'string' ? newUrl : { ...input, url: newUrl };
                    return origFetch(newInput, init);
                }
                return origFetch(input, init);
            };
            </script>`;

            html = html.replace('</head>', script + '</head>');
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(html);

        } else if (contentType.includes('application/json') || contentType.includes('javascript')) {
            let content = await response.text();
            res.setHeader('Content-Type', contentType + '; charset=utf-8');
            res.send(content);

        } else {
            res.setHeader('Content-Type', contentType);
            response.body.pipe(res);
        }

    } catch (error) {
        console.error('[ERROR]', error.message);
        res.status(500).send(getErrorPage('خطأ السيرفر', error.message));
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
            background: rgba(255,255,255,0.98);
            border-radius: 25px;
            box-shadow: 0 30px 120px rgba(0,0,0,0.45);
            padding: 60px 45px;
            max-width: 750px;
            width: 100%;
        }
        h1 {
            color: #333;
            font-size: 40px;
            margin-bottom: 15px;
            text-align: center;
            font-weight: 700;
        }
        .subtitle {
            color: #666;
            text-align: center;
            margin-bottom: 40px;
            font-size: 16px;
        }
        .search-group {
            display: flex;
            gap: 15px;
            margin-bottom: 40px;
            margin-top: 30px;
        }
        input {
            flex: 1;
            padding: 18px 22px;
            border: 2px solid #e0e0e0;
            border-radius: 12px;
            font-size: 16px;
            transition: all 0.3s;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.1);
        }
        .btn {
            padding: 18px 40px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            transition: all 0.3s;
            box-shadow: 0 4px 20px rgba(102, 126, 234, 0.3);
        }
        .btn:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 30px rgba(102, 126, 234, 0.4);
        }
        .services {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
            gap: 15px;
            margin: 40px 0;
        }
        .service-btn {
            padding: 20px;
            border: 2px solid #e8e8e8;
            background: #fafafa;
            border-radius: 15px;
            cursor: pointer;
            transition: all 0.3s;
            text-align: center;
            text-decoration: none;
            color: #333;
            font-weight: 700;
            font-size: 16px;
        }
        .service-btn:hover {
            border-color: #667eea;
            background: #667eea;
            color: white;
            transform: translateY(-5px);
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.25);
        }
        .info {
            background: linear-gradient(135deg, #f5f7ff 0%, #e8e8ff 100%);
            padding: 25px;
            border-radius: 15px;
            margin-top: 40px;
            color: #667eea;
            font-size: 15px;
            border: 1px solid rgba(102, 126, 234, 0.15);
            line-height: 1.8;
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
        <p class="subtitle">تصفح YouTube و Google و كل المواقع بحرية</p>
        
        <div class="search-group">
            <input type="text" id="urlInput" placeholder="أدخل رابط أو كلمة البحث..." autofocus>
            <button class="btn" onclick="go()">بحث</button>
        </div>

        <div class="services">
            <a class="service-btn" href="/proxy?url=https://www.youtube.com">YouTube</a>
            <a class="service-btn" href="/proxy?url=https://www.google.com">Google</a>
            <a class="service-btn" href="/proxy?url=https://www.tiktok.com">TikTok</a>
            <a class="service-btn" href="/proxy?url=https://www.facebook.com">Facebook</a>
            <a class="service-btn" href="/proxy?url=https://www.instagram.com">Instagram</a>
            <a class="service-btn" href="/proxy?url=https://www.twitter.com">Twitter</a>
            <a class="service-btn" href="/proxy?url=https://www.reddit.com">Reddit</a>
            <a class="service-btn" href="/proxy?url=https://www.twitch.tv">Twitch</a>
        </div>

        <div class="info">
            السيرفر الذكي يستخدم تقنيات متقدمة لتحميل المواقع بشكل كامل:
            <br>✓ YouTube مع الفيديوهات والتعليقات
            <br>✓ Google Search مع النتائج الكاملة
            <br>✓ دعم كل المواقع الكبرى
            <br>✓ تحميل سريع وآمن
        </div>
    </div>

    <script>
        function go() {
            let input = document.getElementById('urlInput').value.trim();
            if (!input) return;

            let finalUrl;
            
            if (input.startsWith('http://') || input.startsWith('https://')) {
                finalUrl = input;
            } else if (input.includes('.') && !input.includes(' ')) {
                finalUrl = 'https://' + input;
            } else {
                // بحث عن كلمة
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
        version: '5.0.0',
        uptime: process.uptime(),
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
            border-radius: 25px;
            padding: 50px;
            max-width: 600px;
            box-shadow: 0 30px 120px rgba(0,0,0,0.45);
        }
        h1 { color: #d32f2f; margin-bottom: 15px; font-size: 32px; }
        p { color: #666; line-height: 1.8; font-size: 16px; }
        a { color: #667eea; text-decoration: none; margin-top: 25px; display: inline-block; font-weight: 700; font-size: 16px; }
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
    // تهيئة Puppeteer
    await getBrowser();

    console.log(`
╔═════════════════════════════════════════════╗
║   وكيل الويب الذكي v5.0                    ║
║   Smart Web Proxy with Puppeteer            ║
║                                             ║
║   http://localhost:${PORT}                  ║
║                                             ║
║   المميزات:                                 ║
║   ✓ YouTube - Real Browser Rendering       ║
║   ✓ Google Search - Full Support           ║
║   ✓ TikTok, Facebook, Instagram            ║
║   ✓ Twitter, Reddit, Twitch                ║
║   ✓ Smart URL Detection                    ║
║   ✓ Cookie Management                      ║
║   ✓ Dynamic Content Loading                ║
║                                             ║
║   Status: Ready ✅                          ║
╚═════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    if (browser) await browser.close();
    process.exit(0);
});
