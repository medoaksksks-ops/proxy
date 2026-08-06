const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { URL } = require('url');
const zlib = require('zlib');
const cookieParser = require('cookie-parser');
const app = express();

// Middleware
app.use(cors({ 
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['*']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));
app.use(cookieParser());

// ============================================
// الإعدادات المتقدمة
// ============================================
const CONFIG = {
    proxyBase: '/proxy',
    timeout: 120000,
    maxRedirects: 10,
    retryAttempts: 3,
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ]
};

// ============================================
// نظام الـ Cookie Management
// ============================================
class CookieManager {
    constructor() {
        this.cookies = {};
    }

    set(domain, cookies) {
        if (!this.cookies[domain]) this.cookies[domain] = [];
        this.cookies[domain] = [...this.cookies[domain], ...cookies];
    }

    get(domain) {
        return this.cookies[domain] || [];
    }

    format(domain) {
        const cookies = this.get(domain);
        return cookies.map(c => c.split(';')[0]).join('; ');
    }
}

const cookieManager = new CookieManager();

// ============================================
// محرك إعادة الكتابة المتقدم
// ============================================
class ProxyEngine {
    constructor(baseUrl, proxyPath) {
        this.baseUrl = baseUrl;
        this.proxyPath = proxyPath;
        this.domain = new URL(baseUrl).hostname;
    }

    rewrite(url) {
        if (!url || typeof url !== 'string') return url;
        
        const protocols = ['data:', 'javascript:', 'mailto:', 'tel:', 'blob:', '#'];
        if (protocols.some(p => url.startsWith(p))) return url;
        
        try {
            if (url.startsWith('http://') || url.startsWith('https://')) {
                return `${this.proxyPath}?url=${encodeURIComponent(url)}`;
            }
            
            if (url.startsWith('//')) {
                return `${this.proxyPath}?url=${encodeURIComponent('https:' + url)}`;
            }
            
            if (url.startsWith('/')) {
                const origin = new URL(this.baseUrl).origin;
                return `${this.proxyPath}?url=${encodeURIComponent(origin + url)}`;
            }
            
            const absolute = new URL(url, this.baseUrl).href;
            return `${this.proxyPath}?url=${encodeURIComponent(absolute)}`;
        } catch (e) {
            return url;
        }
    }

    rewriteSrcset(srcset) {
        if (!srcset) return srcset;
        return srcset.split(',').map(part => {
            const trimmed = part.trim();
            const parts = trimmed.split(/\s+/);
            const url = parts[0];
            const rest = parts.slice(1).join(' ');
            return `${this.rewrite(url)}${rest ? ' ' + rest : ''}`;
        }).join(', ');
    }

    rewriteCSS(css) {
        if (!css) return css;
        
        // url() في CSS
        css = css.replace(/url\(['"]?([^'"()]+)['"]?\)/gi, (match, url) => {
            if (!url || url.startsWith('data:') || url.startsWith('#')) return match;
            return `url("${this.rewrite(url)}")`;
        });
        
        // @import
        css = css.replace(/@import\s+['"]([^'"]+)['"]/gi, (match, url) => {
            return `@import "${this.rewrite(url)}"`;
        });
        
        // background-image
        css = css.replace(/background-image\s*:\s*url\(['"]?([^'"()]+)['"]?\)/gi, (match, url) => {
            if (!url || url.startsWith('data:')) return match;
            return `background-image: url("${this.rewrite(url)}")`;
        });
        
        return css;
    }

    rewriteHTML(html, targetUrl) {
        if (!html) return html;

        // إزالة Content Security Policy
        html = html.replace(/<meta\s+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');
        html = html.replace(/<meta\s+[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');

        // إزالة X-UA-Compatible
        html = html.replace(/<meta\s+[^>]*X-UA-Compatible[^>]*>/gi, '');

        // تحديث base tag
        html = html.replace(/<base\s+href\s*=\s*["']([^"']*)["'][^>]*>/gi, 
            `<base href="${this.baseUrl}">`);
        
        if (!html.includes('<base')) {
            html = html.replace(/<head[^>]*>/i, 
                `<head><base href="${this.baseUrl}">`);
        }

        // تحديث الروابط والـ attributes
        const patterns = [
            // href
            { regex: /(href|src|action|poster|data|background)\s*=\s*["']([^"']*)["']/gi, replace: (m, a, v) => `${a}="${this.rewrite(v)}"` },
            // srcset
            { regex: /srcset\s*=\s*["']([^"']*)["']/gi, replace: (m, v) => `srcset="${this.rewriteSrcset(v)}"` },
        ];

        patterns.forEach(p => {
            html = html.replace(p.regex, p.replace);
        });

        // style attributes
        html = html.replace(/style\s*=\s*["']([^"']*)["']/gi, (match, style) => {
            return `style="${this.rewriteCSS(style)}"`;
        });

        // <style> tags
        html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
            return `<style>${this.rewriteCSS(css)}</style>`;
        });

        // meta refresh
        html = html.replace(/<meta\s+http-equiv\s*=\s*["']refresh["']\s+content\s*=\s*["']([^"']*)["']/gi, 
            (match, content) => {
                const urlMatch = content.match(/url=([^;]*)/i);
                if (urlMatch) {
                    const rewritten = this.rewrite(urlMatch[1].trim());
                    return match.replace(urlMatch[1], rewritten);
                }
                return match;
            });

        // إضافة meta tags مهمة
        const metaTags = `
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
        <meta charset="UTF-8">
        `;

        if (!html.includes('viewport')) {
            html = html.replace(/<head[^>]*>/i, `<head>${metaTags}`);
        }

        // إضافة Client Script
        const clientScript = this.getClientScript(targetUrl);
        html = html.replace(/<\/head>/i, `${clientScript}</head>`);
        if (!html.includes(clientScript)) {
            html = html.replace(/<\/body>/i, `${clientScript}</body>`);
        }

        return html;
    }

    getClientScript(targetUrl) {
        return `<script>
        window.PROXY_CONFIG = {
            path: '${this.proxyPath}',
            baseUrl: '${this.baseUrl}',
            targetUrl: '${targetUrl}'
        };
        
        (function() {
            const config = window.PROXY_CONFIG;
            
            function rewriteUrl(url) {
                if (!url || typeof url !== 'string') return url;
                const blocked = ['data:', 'javascript:', 'mailto:', 'tel:', 'blob:', '#'];
                if (blocked.some(b => url.startsWith(b))) return url;
                if (url.includes(config.path)) return url;
                
                try {
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        return config.path + '?url=' + encodeURIComponent(url);
                    }
                    if (url.startsWith('//')) {
                        return config.path + '?url=' + encodeURIComponent('https:' + url);
                    }
                    if (url.startsWith('/')) {
                        const origin = new URL(config.baseUrl).origin;
                        return config.path + '?url=' + encodeURIComponent(origin + url);
                    }
                    const absolute = new URL(url, config.baseUrl).href;
                    return config.path + '?url=' + encodeURIComponent(absolute);
                } catch (e) {
                    return url;
                }
            }

            // Override fetch
            const originalFetch = window.fetch;
            window.fetch = function(resource, init) {
                const url = typeof resource === 'string' ? resource : resource.url;
                const rewritten = rewriteUrl(url);
                const newResource = typeof resource === 'string' ? rewritten : { ...resource, url: rewritten };
                return originalFetch(newResource, init);
            };

            // Override XMLHttpRequest
            const XHROpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                const rewritten = rewriteUrl(url);
                return XHROpen.apply(this, [method, rewritten, ...rest]);
            };

            // Override WebSocket
            if (window.WebSocket) {
                const OriginalWebSocket = window.WebSocket;
                window.WebSocket = function(url, ...args) {
                    const rewritten = rewriteUrl(url).replace(/^\/proxy/, 'wss://');
                    return new OriginalWebSocket(rewritten, ...args);
                };
            }

            // Handle form submissions
            document.addEventListener('submit', function(e) {
                const form = e.target;
                if (form.action) {
                    form.action = rewriteUrl(form.action);
                }
            }, true);

            // Handle navigation
            window.addEventListener('click', function(e) {
                const link = e.target.closest('a');
                if (link && link.href && !link.href.includes(config.path)) {
                    const href = link.getAttribute('href');
                    if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
                        e.preventDefault();
                        window.location.href = rewriteUrl(href);
                    }
                }
            }, true);

            // Override History API
            const pushState = history.pushState.bind(history);
            history.pushState = function(state, title, url) {
                if (url) url = rewriteUrl(url);
                return pushState(state, title, url);
            };

            const replaceState = history.replaceState.bind(history);
            history.replaceState = function(state, title, url) {
                if (url) url = rewriteUrl(url);
                return replaceState(state, title, url);
            };

            // Override Image constructor
            const OriginalImage = window.Image;
            window.Image = function(...args) {
                const img = new OriginalImage(...args);
                const descriptor = Object.getOwnPropertyDescriptor(OriginalImage.prototype, 'src');
                if (descriptor) {
                    Object.defineProperty(img, 'src', {
                        get: descriptor.get,
                        set: function(value) {
                            descriptor.set.call(this, rewriteUrl(value));
                        }
                    });
                }
                return img;
            };

            console.log('Proxy engine loaded');
        })();
        </script>`;
    }
}

// ============================================
// معالجات الطلبات المتقدمة
// ============================================
async function fetchWithRetry(url, options, retries = CONFIG.retryAttempts) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fetch(url, {
                ...options,
                timeout: CONFIG.timeout
            });
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
}

function getRandomUserAgent() {
    return CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
}

// ============================================
// طريق Proxy الرئيسي
// ============================================
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).send(getErrorPage('خطأ', 'مطلوب تحديد رابط: /proxy?url=https://...'));
    }

    try {
        // تحقق من صحة الـ URL
        try {
            new URL(targetUrl);
        } catch {
            return res.status(400).send(getErrorPage('خطأ في الرابط', `${targetUrl} رابط غير صحيح`));
        }

        console.log(`[PROXY] جلب: ${targetUrl}`);

        const headers = {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };

        // أضف cookies إذا كانت موجودة
        const domain = new URL(targetUrl).hostname;
        const cookies = cookieManager.get(domain);
        if (cookies.length > 0) {
            headers['Cookie'] = cookieManager.format(domain);
        }

        // جلب المحتوى
        const response = await fetchWithRetry(targetUrl, {
            headers,
            redirect: 'follow',
            timeout: CONFIG.timeout
        });

        if (!response.ok) {
            return res.status(response.status).send(
                getErrorPage(`خطأ ${response.status}`, response.statusText)
            );
        }

        // حفظ الـ Cookies
        const setCookies = response.headers.raw()['set-cookie'];
        if (setCookies) {
            cookieManager.set(domain, Array.isArray(setCookies) ? setCookies : [setCookies]);
        }

        const contentType = (response.headers.get('content-type') || '').split(';')[0];
        const contentEncoding = response.headers.get('content-encoding') || '';

        // CORS Headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Content-Range');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        
        // معالجة المحتويات المختلفة
        if (contentType === 'text/html') {
            // HTML - أعد الكتابة
            let html = await response.text();
            
            // فك الضغط إذا لزم الأمر
            if (contentEncoding === 'br') {
                try {
                    const buffer = Buffer.from(html);
                    html = zlib.brotliDecompressSync(buffer).toString();
                } catch (e) {
                    console.warn('Brotli decompression failed');
                }
            }

            const engine = new ProxyEngine(targetUrl, CONFIG.proxyBase);
            html = engine.rewriteHTML(html, targetUrl);
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.send(html);

        } else if (contentType.includes('application/json') || contentType.includes('application/javascript') || contentType.includes('text/javascript')) {
            // JSON و JavaScript - أعد كتابة الروابط
            let content = await response.text();
            
            // أعد كتابة الروابط في JSON و JS
            content = content.replace(/"(https?:\/\/[^"]+)"/g, (match, url) => {
                if (url.length > 2000) return match;
                return `"${CONFIG.proxyBase}?url=${encodeURIComponent(url)}"`;
            });

            res.setHeader('Content-Type', contentType + '; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.send(content);

        } else if (contentType.includes('text/css')) {
            // CSS
            let css = await response.text();
            const engine = new ProxyEngine(targetUrl, CONFIG.proxyBase);
            css = engine.rewriteCSS(css);
            
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(css);

        } else {
            // ملفات ثنائية - مرر مباشرة
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            response.body.pipe(res);
        }

    } catch (error) {
        console.error('[ERROR]', error.message);
        res.status(500).send(getErrorPage('خطأ في السيرفر', error.message));
    }
});

// ============================================
// POST proxy للنماذج والبيانات
// ============================================
app.post('/proxy', async (req, res) => {
    const targetUrl = req.query.url || req.body.url;
    
    if (!targetUrl) {
        return res.status(400).json({ error: 'URL required' });
    }

    try {
        const headers = {
            'User-Agent': getRandomUserAgent(),
            'Content-Type': req.get('content-type') || 'application/x-www-form-urlencoded',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7'
        };

        const body = typeof req.body === 'object' 
            ? JSON.stringify(req.body) 
            : req.body;

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body,
            redirect: 'follow',
            timeout: CONFIG.timeout
        });

        const contentType = response.headers.get('content-type') || '';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (contentType.includes('application/json')) {
            res.json(await response.json());
        } else {
            res.send(await response.text());
        }

    } catch (error) {
        res.status(500).json({ error: error.message });
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
    <title>وكيل الويب المتقدم</title>
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
            background: rgba(255,255,255,0.95);
            border-radius: 20px;
            box-shadow: 0 20px 80px rgba(0,0,0,0.3);
            padding: 50px 40px;
            max-width: 600px;
            width: 100%;
        }
        h1 {
            color: #333;
            font-size: 32px;
            margin-bottom: 10px;
            text-align: center;
        }
        .subtitle {
            color: #666;
            text-align: center;
            margin-bottom: 40px;
            font-size: 16px;
        }
        .input-group {
            display: flex;
            gap: 10px;
            margin-bottom: 30px;
        }
        input {
            flex: 1;
            padding: 15px 20px;
            border: 2px solid #ddd;
            border-radius: 10px;
            font-size: 16px;
            transition: border-color 0.3s;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
        }
        .btn {
            padding: 15px 30px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            transition: transform 0.2s;
        }
        .btn:hover {
            transform: scale(1.05);
        }
        .sites {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
            gap: 12px;
            margin: 30px 0;
        }
        .site-btn {
            padding: 15px;
            border: 2px solid #ddd;
            background: #f8f9ff;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.3s;
            text-align: center;
            text-decoration: none;
            color: #333;
            font-weight: 500;
        }
        .site-btn:hover {
            border-color: #667eea;
            background: #667eea;
            color: white;
            transform: translateY(-3px);
        }
        .stats {
            background: #f0f2ff;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
            margin-top: 30px;
            color: #666;
            font-size: 14px;
        }
        @media (max-width: 600px) {
            .container { padding: 30px 20px; }
            h1 { font-size: 24px; }
            .input-group { flex-direction: column; }
            .sites { grid-template-columns: repeat(2, 1fr); }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>وكيل الويب</h1>
        <p class="subtitle">تصفح أي موقع بحرية كاملة</p>
        
        <div class="input-group">
            <input type="text" id="urlInput" placeholder="أدخل رابط الموقع..." value="https://www.youtube.com">
            <button class="btn" onclick="go()">افتح</button>
        </div>

        <div class="sites">
            <a class="site-btn" href="/proxy?url=https://www.youtube.com">YouTube</a>
            <a class="site-btn" href="/proxy?url=https://www.tiktok.com">TikTok</a>
            <a class="site-btn" href="/proxy?url=https://www.facebook.com">Facebook</a>
            <a class="site-btn" href="/proxy?url=https://www.instagram.com">Instagram</a>
            <a class="site-btn" href="/proxy?url=https://twitter.com">Twitter</a>
            <a class="site-btn" href="/proxy?url=https://www.reddit.com">Reddit</a>
            <a class="site-btn" href="/proxy?url=https://www.twitch.tv">Twitch</a>
            <a class="site-btn" href="/proxy?url=https://www.wikipedia.org">Wikipedia</a>
        </div>

        <div class="stats">
            تم تحسين السيرفر لدعم جميع المواقع الكبرى بكفاءة عالية
        </div>
    </div>

    <script>
        function go() {
            let url = document.getElementById('urlInput').value.trim();
            if (url) {
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'https://' + url;
                }
                window.location.href = '/proxy?url=' + encodeURIComponent(url);
            }
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
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

// ============================================
// دالة صفحات الخطأ
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
            padding: 40px;
            max-width: 600px;
            box-shadow: 0 20px 80px rgba(0,0,0,0.3);
        }
        h1 { color: #d32f2f; margin-bottom: 15px; }
        p { color: #666; line-height: 1.6; }
        a { color: #667eea; text-decoration: none; margin-top: 20px; display: inline-block; }
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
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════╗
║   وكيل الويب المتقدم v3.0                 ║
║   Server: http://localhost:${PORT}       ║
║   Status: Running                         ║
║   Features:                               ║
║   - YouTube, TikTok, Facebook             ║
║   - CSS/JS Rewriting                      ║
║   - Cookie Management                     ║
║   - Advanced Proxying                     ║
╚═══════════════════════════════════════════╝
    `);
});
