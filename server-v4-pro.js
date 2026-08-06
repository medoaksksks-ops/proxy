const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { URL } = require('url');
const zlib = require('zlib');
const cookieParser = require('cookie-parser');
const https = require('https');
const http = require('http');
const app = express();

// Middleware
app.use(cors({ 
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
    allowedHeaders: '*'
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static('public'));
app.use(cookieParser());

// ============================================
// الإعدادات
// ============================================
const CONFIG = {
    proxyBase: '/proxy',
    timeout: 180000,
    maxRedirects: 20,
    retryAttempts: 5,
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1'
    ]
};

// ============================================
// Cookie Manager المتقدم
// ============================================
class AdvancedCookieManager {
    constructor() {
        this.cookies = {};
        this.lastUpdate = {};
    }

    set(domain, setCookieHeaders) {
        if (!Array.isArray(setCookieHeaders)) setCookieHeaders = [setCookieHeaders];
        
        if (!this.cookies[domain]) this.cookies[domain] = {};
        
        setCookieHeaders.forEach(header => {
            const parts = header.split(';');
            const [name, value] = parts[0].trim().split('=');
            if (name && value) {
                this.cookies[domain][name] = value;
            }
        });
        
        this.lastUpdate[domain] = Date.now();
    }

    get(domain) {
        return this.cookies[domain] || {};
    }

    format(domain) {
        const cookies = this.get(domain);
        return Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }
}

const cookieManager = new AdvancedCookieManager();

// ============================================
// محرك الـ Proxy المتقدم
// ============================================
class AdvancedProxyEngine {
    constructor(baseUrl, proxyPath) {
        this.baseUrl = baseUrl;
        this.proxyPath = proxyPath;
        this.domain = new URL(baseUrl).hostname;
        this.origin = new URL(baseUrl).origin;
    }

    rewrite(url) {
        if (!url || typeof url !== 'string') return url;
        
        const blocked = ['data:', 'javascript:', 'mailto:', 'tel:', 'blob:', '#', 'file://'];
        if (blocked.some(b => url.startsWith(b))) return url;
        if (url.includes(this.proxyPath)) return url;
        
        try {
            if (url.startsWith('http://') || url.startsWith('https://')) {
                return `${this.proxyPath}?url=${encodeURIComponent(url)}`;
            }
            
            if (url.startsWith('//')) {
                const protocol = new URL(this.baseUrl).protocol;
                return `${this.proxyPath}?url=${encodeURIComponent(protocol + url)}`;
            }
            
            if (url.startsWith('/')) {
                return `${this.proxyPath}?url=${encodeURIComponent(this.origin + url)}`;
            }
            
            const absolute = new URL(url, this.baseUrl).href;
            return `${this.proxyPath}?url=${encodeURIComponent(absolute)}`;
        } catch (e) {
            return url;
        }
    }

    rewriteJSON(json) {
        if (!json || typeof json !== 'string') return json;
        
        return json
            .replace(/"(https?:\/\/[^"]{10,})"/g, (match, url) => {
                if (url.length > 2048) return match;
                return `"${this.proxyPath}?url=${encodeURIComponent(url)}"`;
            })
            .replace(/"\/\/([^"]{10,})"/g, (match, url) => {
                if (url.length > 2048) return match;
                return `"${this.proxyPath}?url=${encodeURIComponent('https://' + url)}"`;
            })
            .replace(/\\\/\\\/([-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*))/g, 
                (match, url) => {
                    try {
                        const fullUrl = 'https://' + url;
                        return `\\/\\/${this.proxyPath}?url=${encodeURIComponent(fullUrl)}`;
                    } catch {
                        return match;
                    }
                });
    }

    rewriteCSS(css) {
        if (!css) return css;
        
        css = css.replace(/url\(['"]?([^'"()]+)['"]?\)/gi, (match, url) => {
            if (!url || url.startsWith('data:') || url.startsWith('#')) return match;
            return `url("${this.rewrite(url)}")`;
        });
        
        css = css.replace(/@import\s+['"]([^'"]+)['"]/gi, (match, url) => {
            return `@import "${this.rewrite(url)}"`;
        });
        
        css = css.replace(/background-image\s*:\s*url\(['"]?([^'"()]+)['"]?\)/gi, (match, url) => {
            if (!url || url.startsWith('data:')) return match;
            return `background-image: url("${this.rewrite(url)}")`;
        });
        
        return css;
    }

    removeBadScripts(html) {
        // إزالة Service Workers
        html = html.replace(/<script[^>]*>.*?navigator\.serviceWorker.*?<\/script>/gis, '');
        
        // إزالة Web Workers المشبوهة
        html = html.replace(/new\s+Worker\s*\(\s*["'][^"']*["']\s*\)/g, '');
        
        // إزالة إنشاء iframes للـ ads
        html = html.replace(/createElementNS\s*\(\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["'][^)]*\)/g, '');
        
        return html;
    }

    patchHTML(html) {
        if (!html.includes('</head>')) {
            html = html.replace(/<\/body>/i, '</body>');
        }

        const patchScript = `
        <script>
        window.PROXY_CONFIG = {
            path: '${this.proxyPath}',
            baseUrl: '${this.baseUrl}',
            origin: '${this.origin}'
        };

        // منع Service Workers
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations = async () => [];
            navigator.serviceWorker.register = async () => ({ 
                scope: '/',
                active: null,
                installing: null,
                waiting: null
            });
        }

        // منع Web Workers
        const OriginalWorker = window.Worker;
        window.Worker = class extends OriginalWorker {
            constructor(url) {
                const rewritten = window.PROXY_CONFIG.path + '?url=' + encodeURIComponent(url);
                super(rewritten);
            }
        };

        // تحسين fetch
        const origFetch = fetch;
        window.fetch = async (input, init = {}) => {
            let url = typeof input === 'string' ? input : input.url;
            
            if (!url.includes(window.PROXY_CONFIG.path) && 
                (url.startsWith('http') || url.startsWith('/') || url.startsWith('//'))) {
                
                if (url.startsWith('//')) {
                    url = 'https:' + url;
                } else if (url.startsWith('/')) {
                    url = window.PROXY_CONFIG.origin + url;
                }
                
                const proxyUrl = window.PROXY_CONFIG.path + '?url=' + encodeURIComponent(url);
                
                const response = await origFetch(proxyUrl, {
                    ...init,
                    headers: {
                        ...init.headers,
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });

                if (!response.ok) {
                    console.warn('Fetch failed:', url, response.status);
                    return response;
                }

                const contentType = response.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const data = await response.json();
                    return {
                        ...response,
                        json: async () => data,
                        text: async () => JSON.stringify(data),
                        clone: () => response.clone()
                    };
                }

                return response;
            }
            
            return origFetch(input, init);
        };

        // XHR Override
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            if (!url.includes(window.PROXY_CONFIG.path)) {
                if (url.startsWith('http') || url.startsWith('/') || url.startsWith('//')) {
                    if (url.startsWith('//')) {
                        url = 'https:' + url;
                    } else if (url.startsWith('/')) {
                        url = window.PROXY_CONFIG.origin + url;
                    }
                    url = window.PROXY_CONFIG.path + '?url=' + encodeURIComponent(url);
                }
            }
            return origOpen.call(this, method, url, ...rest);
        };

        // منع تحميل الـ scripts الخارجية
        const origScript = document.createElement.bind(document);
        document.createElement = function(tag, ...args) {
            const el = origScript(tag, ...args);
            if (tag.toLowerCase() === 'script') {
                const origSetAttr = el.setAttribute.bind(el);
                el.setAttribute = function(name, value) {
                    if (name === 'src' && value && !value.includes(window.PROXY_CONFIG.path)) {
                        value = window.PROXY_CONFIG.path + '?url=' + encodeURIComponent(value);
                    }
                    return origSetAttr(name, value);
                };
            }
            return el;
        };

        // Navigation
        window.addEventListener('click', (e) => {
            const link = e.target.closest('a[href]');
            if (link) {
                let href = link.getAttribute('href');
                if (href && !href.startsWith('javascript:') && !href.startsWith('#') && !href.includes(window.PROXY_CONFIG.path)) {
                    if (href.startsWith('//')) {
                        href = 'https:' + href;
                    } else if (href.startsWith('/')) {
                        href = window.PROXY_CONFIG.origin + href;
                    } else if (!href.startsWith('http')) {
                        try {
                            href = new URL(href, window.location.href).href;
                        } catch {}
                    }
                    
                    if (href.startsWith('http')) {
                        e.preventDefault();
                        e.stopPropagation();
                        window.location.href = window.PROXY_CONFIG.path + '?url=' + encodeURIComponent(href);
                    }
                }
            }
        }, true);

        console.log('Proxy patches applied');
        </script>
        `;

        html = html.replace(/<\/head>/i, patchScript + '</head>');
        if (!html.includes(patchScript)) {
            html = html.replace(/<\/body>/i, patchScript + '</body>');
        }

        return html;
    }

    rewriteHTML(html, targetUrl) {
        if (!html) return html;

        // إزالة الـ meta tags الخطرة
        html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '');
        html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']X-UA-Compatible["'][^>]*>/gi, '');
        html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']Refresh["'][^>]*>/gi, '');

        // إضافة Base tag
        if (!html.includes('<base')) {
            html = html.replace(/<head[^>]*>/i, `<head><base href="${this.baseUrl}">`);
        }

        // إعادة كتابة الـ attributes
        html = html.replace(/(href|src|action|data|poster|background)\s*=\s*["']([^"']*)["']/gi, 
            (m, attr, url) => `${attr}="${this.rewrite(url)}"`);

        // srcset
        html = html.replace(/srcset\s*=\s*["']([^"']*)["']/gi, 
            (m, srcset) => `srcset="${srcset.split(',').map(s => {
                const parts = s.trim().split(/\s+/);
                return this.rewrite(parts[0]) + (parts[1] ? ' ' + parts[1] : '');
            }).join(', ')}"`);

        // Style attributes
        html = html.replace(/style\s*=\s*["']([^"']*)["']/gi, 
            (m, style) => `style="${this.rewriteCSS(style)}"`);

        // Style tags
        html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, 
            (m, css) => `<style>${this.rewriteCSS(css)}</style>`);

        // إزالة الـ scripts المشبوهة
        html = this.removeBadScripts(html);

        // إضافة الـ patches
        html = this.patchHTML(html);

        return html;
    }
}

// ============================================
// Fetch مع إعادة محاولة
// ============================================
async function fetchWithRetry(url, options, retries = CONFIG.retryAttempts) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                ...options,
                timeout: CONFIG.timeout
            });
            return response;
        } catch (error) {
            console.log(`[RETRY ${i + 1}/${retries}] ${url}: ${error.message}`);
            if (i === retries - 1) throw error;
            await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        }
    }
}

// ============================================
// طريق Proxy
// ============================================
app.all('/proxy', async (req, res) => {
    const targetUrl = req.query.url || req.body?.url;
    
    if (!targetUrl) {
        return res.status(400).send(getErrorPage('خطأ', 'مطلوب تحديد URL'));
    }

    try {
        try {
            new URL(targetUrl);
        } catch {
            return res.status(400).send(getErrorPage('خطأ في URL', `${targetUrl} رابط غير صحيح`));
        }

        console.log(`[PROXY] ${req.method} ${targetUrl.substring(0, 60)}...`);

        const randomUA = CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
        
        const headers = {
            'User-Agent': randomUA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'DNT': '1',
            'Connection': 'keep-alive'
        };

        // أضف cookies
        const domain = new URL(targetUrl).hostname;
        const cookieStr = cookieManager.format(domain);
        if (cookieStr) headers['Cookie'] = cookieStr;

        // جلب البيانات
        const response = await fetchWithRetry(targetUrl, {
            method: req.method,
            headers,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
            redirect: 'follow',
            timeout: CONFIG.timeout
        });

        if (!response.ok && response.status !== 206) {
            return res.status(response.status).send(
                getErrorPage(`خطأ ${response.status}`, response.statusText)
            );
        }

        // حفظ cookies
        const setCookies = response.headers.raw()['set-cookie'];
        if (setCookies) {
            cookieManager.set(domain, Array.isArray(setCookies) ? setCookies : [setCookies]);
        }

        const contentType = (response.headers.get('content-type') || '').split(';')[0];
        const contentEncoding = response.headers.get('content-encoding') || '';

        // CORS + Security Headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Expose-Headers', '*');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        // معالجة HTML
        if (contentType === 'text/html') {
            let html = await response.text();
            
            if (contentEncoding === 'br') {
                try {
                    const buffer = Buffer.from(html);
                    html = zlib.brotliDecompressSync(buffer).toString();
                } catch (e) {
                    console.warn('Brotli decompression failed');
                }
            }

            const engine = new AdvancedProxyEngine(targetUrl, CONFIG.proxyBase);
            html = engine.rewriteHTML(html, targetUrl);
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
            res.send(html);

        // JSON و API
        } else if (contentType.includes('application/json') || contentType.includes('application/x-javascript') || contentType.includes('text/javascript')) {
            let content = await response.text();
            const engine = new AdvancedProxyEngine(targetUrl, CONFIG.proxyBase);
            content = engine.rewriteJSON(content);
            
            res.setHeader('Content-Type', contentType + '; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.send(content);

        // CSS
        } else if (contentType === 'text/css') {
            let css = await response.text();
            const engine = new AdvancedProxyEngine(targetUrl, CONFIG.proxyBase);
            css = engine.rewriteCSS(css);
            
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(css);

        // Binary
        } else {
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=86400');
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
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
            background: rgba(255,255,255,0.97);
            border-radius: 20px;
            box-shadow: 0 25px 100px rgba(0,0,0,0.4);
            padding: 50px 40px;
            max-width: 700px;
            width: 100%;
        }
        h1 {
            color: #333;
            font-size: 36px;
            margin-bottom: 15px;
            text-align: center;
            font-weight: 700;
        }
        .subtitle {
            color: #666;
            text-align: center;
            margin-bottom: 35px;
            font-size: 16px;
        }
        .input-group {
            display: flex;
            gap: 12px;
            margin-bottom: 35px;
        }
        input {
            flex: 1;
            padding: 16px 20px;
            border: 2px solid #e0e0e0;
            border-radius: 12px;
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
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            transition: all 0.3s;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
        }
        .btn:active {
            transform: translateY(0);
        }
        .sites {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
            gap: 12px;
            margin: 35px 0;
        }
        .site-btn {
            padding: 16px;
            border: 2px solid #e8e8e8;
            background: #fafafa;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.3s;
            text-align: center;
            text-decoration: none;
            color: #333;
            font-weight: 600;
            font-size: 15px;
        }
        .site-btn:hover {
            border-color: #667eea;
            background: #667eea;
            color: white;
            transform: translateY(-3px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
        }
        .stats {
            background: linear-gradient(135deg, #f5f7ff 0%, #e8e8ff 100%);
            padding: 20px;
            border-radius: 12px;
            text-align: center;
            margin-top: 35px;
            color: #667eea;
            font-size: 14px;
            border: 1px solid rgba(102, 126, 234, 0.1);
        }
        @media (max-width: 600px) {
            .container { padding: 30px 20px; }
            h1 { font-size: 26px; }
            .input-group { flex-direction: column; }
            .sites { grid-template-columns: repeat(2, 1fr); }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>وكيل الويب</h1>
        <p class="subtitle">تصفح كل المواقع بحرية بدون حد</p>
        
        <div class="input-group">
            <input type="text" id="urlInput" placeholder="أدخل رابط الموقع..." value="https://www.youtube.com" autofocus>
            <button class="btn" onclick="go()">افتح</button>
        </div>

        <div class="sites">
            <a class="site-btn" href="/proxy?url=https://www.youtube.com">YouTube</a>
            <a class="site-btn" href="/proxy?url=https://www.tiktok.com">TikTok</a>
            <a class="site-btn" href="/proxy?url=https://www.facebook.com">Facebook</a>
            <a class="site-btn" href="/proxy?url=https://www.instagram.com">Instagram</a>
            <a class="site-btn" href="/proxy?url=https://www.google.com">Google</a>
            <a class="site-btn" href="/proxy?url=https://www.twitter.com">Twitter</a>
            <a class="site-btn" href="/proxy?url=https://www.reddit.com">Reddit</a>
            <a class="site-btn" href="/proxy?url=https://www.twitch.tv">Twitch</a>
        </div>

        <div class="stats">
            تم تحسين السيرفر لدعم YouTube و Google و كل المواقع الكبرى بسرعة عالية
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
        const input = document.getElementById('urlInput');
        input.addEventListener('keypress', (e) => {
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
        version: '4.0.0',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ============================================
// صفحات الأخطاء
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
            box-shadow: 0 25px 100px rgba(0,0,0,0.4);
        }
        h1 { color: #d32f2f; margin-bottom: 15px; font-size: 28px; }
        p { color: #666; line-height: 1.6; font-size: 16px; }
        a { color: #667eea; text-decoration: none; margin-top: 20px; display: inline-block; font-weight: 600; }
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
// Start Server
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═════════════════════════════════════════════╗
║   وكيل الويب المتقدم v4.0 Pro              ║
║   http://localhost:${PORT}                  ║
║                                             ║
║   المميزات:                                 ║
║   ✓ YouTube + TikTok + Facebook            ║
║   ✓ Google Support                         ║
║   ✓ Service Worker Blocking                ║
║   ✓ API Rewriting                          ║
║   ✓ Dynamic Content Loading                ║
║   ✓ Advanced Cookie Management             ║
║   ✓ Brotli Compression Support             ║
║   ✓ JSON/JavaScript Rewriting              ║
╚═════════════════════════════════════════════╝
    `);
});
