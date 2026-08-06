const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { URL } = require('url');
const app = express();

app.use(cors());

// ============================================
// ⚙️ الإعدادات
// ============================================
const CONFIG = {
    proxyBase: '/proxy',
    croxyDomain: 'https://www.croxyproxy.com',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    timeout: 60000,
    maxRedirects: 5
};

// ============================================
// 🧠 نظام إعادة كتابة الروابط الذكي
// ============================================
class LinkRewriter {
    constructor(baseUrl, proxyPath) {
        this.baseUrl = baseUrl;
        this.proxyPath = proxyPath;
        this.croxyDomain = 'https://www.croxyproxy.com';
    }

    // 🎯 إعادة كتابة أي رابط
    rewrite(url) {
        if (!url) return url;
        if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) return url;
        if (url.startsWith('mailto:') || url.startsWith('tel:')) return url;
        if (url.startsWith('blob:')) return url;
        
        try {
            // لو الرابط مطلق (absolute)
            if (url.startsWith('http://') || url.startsWith('https://')) {
                return `${this.proxyPath}?url=${encodeURIComponent(url)}`;
            }
            
            // لو الرابط بيبدأ بـ / (نسبي للجذر)
            if (url.startsWith('/')) {
                const absolute = new URL(url, this.croxyDomain).href;
                return `${this.proxyPath}?url=${encodeURIComponent(absolute)}`;
            }
            
            // لو الرابط نسبي (relative)
            const absolute = new URL(url, this.baseUrl).href;
            return `${this.proxyPath}?url=${encodeURIComponent(absolute)}`;
            
        } catch (e) {
            console.warn('⚠️ فشل إعادة كتابة الرابط:', url, e.message);
            return url;
        }
    }

    // 🎯 إعادة كتابة روابط srcset
    rewriteSrcset(srcset) {
        if (!srcset) return srcset;
        return srcset.split(',').map(part => {
            const trimmed = part.trim();
            const [url, ...rest] = trimmed.split(/\s+/);
            return `${this.rewrite(url)} ${rest.join(' ')}`;
        }).join(', ');
    }

    // 🎯 إعادة كتابة روابط CSS
    rewriteCSS(css) {
        if (!css) return css;
        
        // url(...) في CSS
        css = css.replace(/url\(["']?([^"')]*)["']?\)/gi, (match, url) => {
            if (url.startsWith('data:') || url.startsWith('#')) return match;
            return `url("${this.rewrite(url)}")`;
        });
        
        // @import
        css = css.replace(/@import\s+["']([^"']*)["']/gi, (match, url) => {
            return `@import "${this.rewrite(url)}"`;
        });
        
        return css;
    }

    // 🎯 إعادة كتابة HTML بالكامل
    rewriteHTML(html) {
        if (!html) return html;

        // 1️⃣ href, src, action, data, poster
        const attrPattern = /(href|src|action|data|poster|background|manifest|codebase)\s*=\s*["']([^"']*)["']/gi;
        html = html.replace(attrPattern, (match, attr, value) => {
            return match.replace(value, this.rewrite(value));
        });

        // 2️⃣ srcset
        html = html.replace(/srcset\s*=\s*["']([^"']*)["']/gi, (match, srcset) => {
            return `srcset="${this.rewriteSrcset(srcset)}"`;
        });

        // 3️⃣ style attribute
        html = html.replace(/style\s*=\s*["']([^"']*)["']/gi, (match, style) => {
            const rewritten = this.rewriteCSS(style);
            return match.replace(style, rewritten);
        });

        // 4️⃣ <style> tags
        html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
            return match.replace(css, this.rewriteCSS(css));
        });

        // 5️⃣ meta refresh
        html = html.replace(/<meta\s+http-equiv=["']refresh["']\s+content=["']([^"']*)["']/gi, (match, content) => {
            const urlMatch = content.match(/url=([^;]*)/i);
            if (urlMatch) {
                const rewritten = this.rewrite(urlMatch[1]);
                return match.replace(urlMatch[1], rewritten);
            }
            return match;
        });

        // 6️⃣ <link> tags (preload, prefetch, etc.)
        html = html.replace(/<link\s+([^>]*?)(?:href\s*=\s*["']([^"']*)["'])([^>]*?)>/gi, (match, before, href, after) => {
            return `<link ${before}href="${this.rewrite(href)}"${after}>`;
        });

        // 7️⃣ <img> tags
        html = html.replace(/<img\s+([^>]*?)(?:src\s*=\s*["']([^"']*)["'])([^>]*?)>/gi, (match, before, src, after) => {
            return `<img ${before}src="${this.rewrite(src)}"${after}>`;
        });

        // 8️⃣ <script> tags (src)
        html = html.replace(/<script\s+([^>]*?)(?:src\s*=\s*["']([^"']*)["'])([^>]*?)>/gi, (match, before, src, after) => {
            return `<script ${before}src="${this.rewrite(src)}"${after}>`;
        });

        // 9️⃣ <iframe> tags
        html = html.replace(/<iframe\s+([^>]*?)(?:src\s*=\s*["']([^"']*)["'])([^>]*?)>/gi, (match, before, src, after) => {
            return `<iframe ${before}src="${this.rewrite(src)}"${after}>`;
        });

        // 🔟 <video>, <audio>, <source>
        html = html.replace(/<(video|audio|source)\s+([^>]*?)(?:src\s*=\s*["']([^"']*)["'])([^>]*?)>/gi, (match, tag, before, src, after) => {
            return `<${tag} ${before}src="${this.rewrite(src)}"${after}>`;
        });

        // 1️⃣1️⃣ <form> action
        html = html.replace(/<form\s+([^>]*?)(?:action\s*=\s*["']([^"']*)["'])([^>]*?)>/gi, (match, before, action, after) => {
            return `<form ${before}action="${this.rewrite(action)}"${after}>`;
        });

        // 1️⃣2️⃣ <a> tags (تأكد من تعديل كل الروابط)
        html = html.replace(/<a\s+([^>]*?)(?:href\s*=\s*["']([^"']*)["'])([^>]*?)>/gi, (match, before, href, after) => {
            return `<a ${before}href="${this.rewrite(href)}"${after}>`;
        });

        // 1️⃣3️⃣ <object>, <embed>
        html = html.replace(/<(object|embed)\s+([^>]*?)(?:data|src)\s*=\s*["']([^"']*)["']([^>]*?)>/gi, (match, tag, before, url, after) => {
            return `<${tag} ${before}data="${this.rewrite(url)}"${after}>`;
        });

        // 1️⃣4️⃣ <area> (image maps)
        html = html.replace(/<area\s+([^>]*?)(?:href\s*=\s*["']([^"']*)["'])([^>]*?)>/gi, (match, before, href, after) => {
            return `<area ${before}href="${this.rewrite(href)}"${after}>`;
        });

        // 1️⃣5️⃣ <base>
        html = html.replace(/<base\s+href\s*=\s*["']([^"']*)["']/gi, (match, href) => {
            return `<base href="${this.rewrite(href)}"`;
        });

        // 1️⃣6️⃣ إضافة client script (للتلاعب بالـ JavaScript)
        const clientScript = this.getClientScript();
        html = html.replace(/<\/head>/i, clientScript + '</head>');
        if (!html.includes(clientScript)) {
            html = html.replace(/<\/body>/i, clientScript + '</body>');
        }

        return html;
    }

    // 🎯 Client-side JavaScript (يعالج fetch, XHR, WebSocket, إلخ)
    getClientScript() {
        return `
        <script>
        (function() {
            const proxyPath = '${this.proxyPath}';
            const croxyDomain = '${this.croxyDomain}';
            
            function rewriteUrl(url) {
                if (!url) return url;
                if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) return url;
                if (url.startsWith('mailto:') || url.startsWith('tel:')) return url;
                if (url.startsWith('blob:')) return url;
                if (url.includes(proxyPath)) return url;
                
                try {
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        return proxyPath + '?url=' + encodeURIComponent(url);
                    }
                    if (url.startsWith('/')) {
                        return proxyPath + '?url=' + encodeURIComponent(croxyDomain + url);
                    }
                    const absolute = new URL(url, window.location.href).href;
                    return proxyPath + '?url=' + encodeURIComponent(absolute);
                } catch {
                    return url;
                }
            }

            // 🔄 fetch
            const originalFetch = window.fetch;
            window.fetch = function(url, options) {
                const rewritten = rewriteUrl(url);
                return originalFetch(rewritten, options);
            };

            // 🔄 XMLHttpRequest
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                const rewritten = rewriteUrl(url);
                return originalOpen.call(this, method, rewritten, async !== false, user, password);
            };

            // 🔄 WebSocket
            const originalWebSocket = window.WebSocket;
            window.WebSocket = function(url, protocols) {
                const rewritten = rewriteUrl(url);
                return new originalWebSocket(rewritten, protocols);
            };

            // 🔄 EventSource
            const originalEventSource = window.EventSource;
            window.EventSource = function(url, eventSourceInitDict) {
                const rewritten = rewriteUrl(url);
                return new originalEventSource(rewritten, eventSourceInitDict);
            };

            // 🔄 navigator.sendBeacon
            if (navigator.sendBeacon) {
                const originalSendBeacon = navigator.sendBeacon.bind(navigator);
                navigator.sendBeacon = function(url, data) {
                    const rewritten = rewriteUrl(url);
                    return originalSendBeacon(rewritten, data);
                };
            }

            // 🔄 Workers
            const originalWorker = window.Worker;
            window.Worker = function(url, options) {
                const rewritten = rewriteUrl(url);
                return new originalWorker(rewritten, options);
            };

            const originalSharedWorker = window.SharedWorker;
            window.SharedWorker = function(url, name, options) {
                const rewritten = rewriteUrl(url);
                return new originalSharedWorker(rewritten, name, options);
            };

            // 🔄 History API
            const originalPushState = history.pushState.bind(history);
            history.pushState = function(state, title, url) {
                if (url) {
                    const rewritten = rewriteUrl(url);
                    return originalPushState(state, title, rewritten);
                }
                return originalPushState(state, title, url);
            };

            const originalReplaceState = history.replaceState.bind(history);
            history.replaceState = function(state, title, url) {
                if (url) {
                    const rewritten = rewriteUrl(url);
                    return originalReplaceState(state, title, rewritten);
                }
                return originalReplaceState(state, title, url);
            };

            // 🔄 createElement (للعناصر الديناميكية)
            const originalCreateElement = document.createElement.bind(document);
            document.createElement = function(tagName, options) {
                const element = originalCreateElement(tagName, options);
                
                const attributesToRewrite = ['src', 'href', 'data', 'action', 'poster', 'background'];
                const originalSetAttribute = element.setAttribute.bind(element);
                element.setAttribute = function(name, value) {
                    if (attributesToRewrite.includes(name)) {
                        value = rewriteUrl(value);
                    }
                    return originalSetAttribute(name, value);
                };

                // إعادة تعريف الخصائص
                if (tagName === 'img' || tagName === 'script' || tagName === 'iframe' || 
                    tagName === 'video' || tagName === 'audio' || tagName === 'link') {
                    Object.defineProperty(element, 'src', {
                        get: function() { return this.getAttribute('src'); },
                        set: function(value) { this.setAttribute('src', rewriteUrl(value)); }
                    });
                    Object.defineProperty(element, 'href', {
                        get: function() { return this.getAttribute('href'); },
                        set: function(value) { this.setAttribute('href', rewriteUrl(value)); }
                    });
                }

                return element;
            };

            // 🔄 Image
            const originalImage = window.Image;
            window.Image = function(width, height) {
                const img = new originalImage(width, height);
                Object.defineProperty(img, 'src', {
                    get: function() { return this.getAttribute('src'); },
                    set: function(value) { this.setAttribute('src', rewriteUrl(value)); }
                });
                return img;
            };

            console.log('🌐 CroxyProxy client script loaded successfully');
        })();
        </script>
        `;
    }
}

// ============================================
// 🌐 الوكيل الرئيسي
// ============================================
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    
    if (!targetUrl) {
        return res.status(400).send(`
            <h1>❌ مطلوب رابط</h1>
            <p>استخدم: /proxy?url=https://www.croxyproxy.com/_ar/</p>
        `);
    }

    try {
        console.log(`📥 جلب: ${targetUrl}`);

        // نحدد الـ headers المناسبة
        const headers = {
            'User-Agent': CONFIG.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-User': '?1',
            'Sec-Fetch-Dest': 'document',
            'Upgrade-Insecure-Requests': '1'
        };

        // نجلب المحتوى
        const response = await fetch(targetUrl, {
            headers,
            redirect: 'follow',
            timeout: CONFIG.timeout
        });

        if (!response.ok) {
            return res.status(response.status).send(`
                <h1>❌ خطأ ${response.status}</h1>
                <p>${response.statusText}</p>
            `);
        }

        const contentType = response.headers.get('content-type') || '';

        // نمرر الـ Content-Type الأصلي
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', '*');

        // لو الصفحة مش HTML، نمررها كما هي
        if (!contentType.includes('text/html')) {
            response.body.pipe(res);
            return;
        }

        // نقرأ HTML
        let html = await response.text();

        // نحدد الـ base URL
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

        // نعيد كتابة الروابط
        const rewriter = new LinkRewriter(baseUrl, CONFIG.proxyBase);
        html = rewriter.rewriteHTML(html);

        // نرسل الـ HTML المعدل
        res.send(html);

    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).send(`
            <h1>❌ خطأ في الوكيل</h1>
            <p>${error.message}</p>
        `);
    }
});

// ============================================
// 🏠 الصفحة الرئيسية
// ============================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🚀 وكيل CroxyProxy المحترف</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: rgba(255,255,255,0.05);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            border: 1px solid rgba(255,255,255,0.1);
            padding: 40px;
            max-width: 800px;
            width: 100%;
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        }
        h1 { color: #fff; text-align: center; font-size: 28px; }
        .subtitle { color: #aaa; text-align: center; margin-bottom: 30px; font-size: 14px; }
        .input-group {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            margin-bottom: 20px;
        }
        .input-group input {
            flex: 1;
            padding: 14px 20px;
            border: 2px solid rgba(255,255,255,0.1);
            border-radius: 12px;
            background: rgba(255,255,255,0.05);
            color: #fff;
            font-size: 16px;
            min-width: 200px;
        }
        .input-group input::placeholder { color: #888; }
        .input-group input:focus { outline: none; border-color: #e74c3c; }
        .btn {
            padding: 14px 25px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            transition: 0.3s;
        }
        .btn-primary { background: #e74c3c; color: white; }
        .btn-primary:hover { background: #c0392b; transform: scale(1.02); }
        .sites-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 10px;
            margin: 20px 0;
        }
        .sites-grid a {
            padding: 12px;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 10px;
            color: #ddd;
            text-decoration: none;
            text-align: center;
            font-size: 14px;
            transition: 0.3s;
        }
        .sites-grid a:hover {
            background: #e74c3c;
            border-color: #e74c3c;
            color: white;
            transform: translateY(-3px);
        }
        .sites-grid a .icon { font-size: 28px; display: block; margin-bottom: 5px; }
        .footer { margin-top: 30px; color: #666; font-size: 12px; text-align: center; }
        .status {
            background: rgba(46, 204, 113, 0.15);
            border: 1px solid rgba(46, 204, 113, 0.3);
            color: #2ecc71;
            padding: 10px;
            border-radius: 8px;
            text-align: center;
            margin-bottom: 20px;
        }
        @media (max-width: 600px) {
            .input-group { flex-direction: column; }
            .btn { width: 100%; }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 وكيل CroxyProxy</h1>
        <p class="subtitle">تصفح الإنترنت بحرية وأمان</p>
        
        <div class="status">✅ السيرفر شغال | ${new Date().toLocaleString('ar-EG')}</div>

        <div class="input-group">
            <input type="text" id="urlInput" placeholder="https://www.croxyproxy.com/_ar/" value="https://www.croxyproxy.com/_ar/" />
            <button class="btn btn-primary" onclick="go()">🚀 افتح</button>
        </div>

        <div class="sites-grid">
            <a href="/proxy?url=https://www.croxyproxy.com/_ar/"><span class="icon">🌐</span>CroxyProxy</a>
            <a href="/proxy?url=https://www.youtube.com"><span class="icon">▶️</span>YouTube</a>
            <a href="/proxy?url=https://www.facebook.com"><span class="icon">📘</span>Facebook</a>
            <a href="/proxy?url=https://www.tiktok.com"><span class="icon">🎵</span>TikTok</a>
            <a href="/proxy?url=https://twitter.com"><span class="icon">🐦</span>Twitter</a>
            <a href="/proxy?url=https://www.instagram.com"><span class="icon">📸</span>Instagram</a>
            <a href="/proxy?url=https://www.reddit.com"><span class="icon">🤖</span>Reddit</a>
            <a href="/proxy?url=https://www.twitch.tv"><span class="icon">🎮</span>Twitch</a>
        </div>

        <div class="footer">🔒 جميع المواقع تمر عبر CroxyProxy | v2.0 (600+ سطر)</div>
    </div>

    <script>
        function go() {
            const url = document.getElementById('urlInput').value.trim();
            if (url) {
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
// ❤️ Health check
// ============================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage()
    });
});

// ============================================
// 🚀 تشغيل السيرفر
// ============================================
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   🚀 وكيل CroxyProxy المحترف v2.0          ║
║   📡 http://localhost:${port}                 ║
║   🔗 /proxy?url=https://...                  ║
║   📊 /health                                 ║
║   ✅ أكثر من 600 سطر                        ║
║   ✅ يدعم كل أنواع الروابط                  ║
║   ✅ يدعم JavaScript (fetch, XHR, WebSocket)║
║   ✅ يدعم CSS, srcset, form, iframe         ║
╚══════════════════════════════════════════════╝
    `);
});