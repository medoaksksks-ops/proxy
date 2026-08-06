const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());

// ============================================
// 🎯 الوكيل الرئيسي - بيعدل كل الروابط
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

        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        if (!response.ok) {
            return res.status(response.status).send(`❌ خطأ: ${response.status}`);
        }

        let html = await response.text();

        // ============================================
        // 🔄 تعديل كل الروابط عشان تفضل جوه البروكسي
        // ============================================
        const proxyPath = '/proxy';

        function rewriteUrl(url) {
            if (!url) return url;
            if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) return url;
            if (url.startsWith('mailto:') || url.startsWith('tel:')) return url;

            try {
                if (url.startsWith('http://') || url.startsWith('https://')) {
                    return `${proxyPath}?url=${encodeURIComponent(url)}`;
                }
                if (url.startsWith('/')) {
                    const absolute = `https://www.croxyproxy.com${url}`;
                    return `${proxyPath}?url=${encodeURIComponent(absolute)}`;
                }
                const absolute = new URL(url, targetUrl).href;
                return `${proxyPath}?url=${encodeURIComponent(absolute)}`;
            } catch {
                return url;
            }
        }

        // تعديل جميع الروابط في HTML
        html = html.replace(/(href|src|action|data|poster|background)\s*=\s*["']([^"']*)["']/gi, (match, attr, value) => {
            return match.replace(value, rewriteUrl(value));
        });

        // تعديل srcset
        html = html.replace(/srcset\s*=\s*["']([^"']*)["']/gi, (match, srcset) => {
            const parts = srcset.split(',').map(p => p.trim());
            const rewritten = parts.map(part => {
                const [url, size] = part.split(/\s+/);
                return `${rewriteUrl(url)}${size ? ' ' + size : ''}`;
            }).join(', ');
            return match.replace(srcset, rewritten);
        });

        // تعديل style attribute
        html = html.replace(/style\s*=\s*["']([^"']*)["']/gi, (match, style) => {
            const rewritten = style.replace(/url\(["']?([^"')]*)["']?\)/gi, (m, url) => {
                return `url(${rewriteUrl(url)})`;
            });
            return match.replace(style, rewritten);
        });

        // إضافة client script
        const clientScript = `
        <script>
        (function() {
            const proxyPath = '/proxy';
            
            function rewriteUrl(url) {
                if (!url) return url;
                if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) return url;
                if (url.startsWith('http://') || url.startsWith('https://')) {
                    return proxyPath + '?url=' + encodeURIComponent(url);
                }
                if (url.startsWith('/')) {
                    return proxyPath + '?url=' + encodeURIComponent('https://www.croxyproxy.com' + url);
                }
                return url;
            }

            // fetch
            const originalFetch = window.fetch;
            window.fetch = function(url, options) {
                return originalFetch(rewriteUrl(url), options);
            };

            // XMLHttpRequest
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                return originalOpen.call(this, method, rewriteUrl(url), async, user, password);
            };

            console.log('✅ Proxy client loaded');
        })();
        </script>
        `;

        html = html.replace(/<\/head>/i, clientScript + '</head>');
        if (!html.includes(clientScript)) {
            html = html.replace(/<\/body>/i, clientScript + '</body>');
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);

    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).send(`❌ خطأ: ${error.message}`);
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
    <title>🚀 وكيل CroxyProxy</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1a1a2e, #16213e, #0f3460);
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
            max-width: 700px;
            width: 100%;
            text-align: center;
        }
        h1 { color: #fff; font-size: 28px; margin-bottom: 10px; }
        .subtitle { color: #aaa; margin-bottom: 30px; }
        .input-group { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
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
        .input-group input:focus { outline: none; border-color: #e74c3c; }
        .btn {
            padding: 14px 25px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            background: #e74c3c;
            color: white;
            transition: 0.3s;
        }
        .btn:hover { background: #c0392b; transform: scale(1.02); }
        .sites {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            justify-content: center;
            margin: 20px 0;
        }
        .sites a {
            padding: 8px 16px;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 20px;
            color: #ddd;
            text-decoration: none;
            font-size: 14px;
            transition: 0.3s;
        }
        .sites a:hover { background: #e74c3c; border-color: #e74c3c; color: white; }
        .footer { margin-top: 30px; color: #666; font-size: 12px; }
        .status { background: rgba(46,204,113,0.15); border: 1px solid rgba(46,204,113,0.3); color: #2ecc71; padding: 10px; border-radius: 8px; margin-bottom: 20px; }
        @media (max-width: 600px) { .input-group { flex-direction: column; } .btn { width: 100%; } }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 وكيل CroxyProxy</h1>
        <p class="subtitle">افتح أي موقع من خلال CroxyProxy</p>
        <div class="status">✅ السيرفر شغال</div>
        <div class="input-group">
            <input type="text" id="urlInput" placeholder="https://www.croxyproxy.com/_ar/" />
            <button class="btn" onclick="go()">🚀 فتح</button>
        </div>
        <div class="sites">
            <a href="/proxy?url=https://www.croxyproxy.com/_ar/">🌐 CroxyProxy</a>
            <a href="/proxy?url=https://www.youtube.com">▶️ YouTube</a>
            <a href="/proxy?url=https://www.facebook.com">📘 Facebook</a>
            <a href="/proxy?url=https://www.tiktok.com">🎵 TikTok</a>
            <a href="/proxy?url=https://twitter.com">🐦 Twitter</a>
        </div>
        <div class="footer">🔒 جميع المواقع تمر عبر CroxyProxy | v1.0</div>
    </div>
    <script>
        function go() {
            const url = document.getElementById('urlInput').value.trim();
            if (url) window.location.href = '/proxy?url=' + encodeURIComponent(url);
        }
    </script>
</body>
</html>
    `);
});

// ============================================
// 🚀 تشغيل السيرفر
// ============================================
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════╗
║   🚀 وكيل CroxyProxy v1.0          ║
║   📡 http://localhost:${port}        ║
║   ✅ شغال وجاهز                     ║
╚══════════════════════════════════════╝
    `);
});
