const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());

// ============================================
// 🎯 الوكيل البسيط - CroxyProxy كـ "هدف"
// ============================================
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.send(`
            <h1>🌐 Proxy to CroxyProxy</h1>
            <p>Usage: /proxy?url=https://croxyproxy.com</p>
        `);
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });

        const html = await response.text();
        
        // نعدل الروابط عشان تفضل جوه البروكسي بتاعنا
        const fixedHtml = html.replace(/(href|src|action|data)\s*=\s*["']([^"']*)["']/gi, (match, attr, url) => {
            // لو الرابط يبدأ ب / نضيف الـ domain بتاع CroxyProxy
            if (url.startsWith('/')) {
                const newUrl = `https://croxyproxy.com${url}`;
                return `${attr}="/proxy?url=${encodeURIComponent(newUrl)}"`;
            }
            // لو الرابط كامل
            if (url.startsWith('http')) {
                return `${attr}="/proxy?url=${encodeURIComponent(url)}"`;
            }
            return match;
        });

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(fixedHtml);

    } catch (error) {
        res.status(500).send(`❌ Error: ${error.message}`);
    }
});

// ============================================
// 🏠 الصفحة الرئيسية
// ============================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🚀 CroxyProxy Mirror</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background: #0d1117;
            color: white;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }
        .container {
            text-align: center;
            background: #161b22;
            padding: 40px;
            border-radius: 15px;
            max-width: 500px;
        }
        input {
            width: 80%;
            padding: 12px;
            border-radius: 8px;
            border: none;
            font-size: 16px;
            margin: 10px 0;
        }
        button {
            padding: 12px 30px;
            background: #238636;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
        }
        button:hover { background: #2ea043; }
        .sites {
            margin-top: 20px;
        }
        .sites a {
            display: inline-block;
            margin: 5px;
            padding: 8px 16px;
            background: #21262d;
            color: #58a6ff;
            text-decoration: none;
            border-radius: 20px;
            font-size: 14px;
        }
        .sites a:hover { background: #30363d; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 CroxyProxy Mirror</h1>
        <p>ادخل الرابط وافتح أي موقع</p>
        <input type="text" id="urlInput" placeholder="https://www.youtube.com" />
        <button onclick="go()">🔄 افتح</button>
        <div class="sites">
            <a href="/proxy?url=https://www.youtube.com">▶️ YouTube</a>
            <a href="/proxy?url=https://www.facebook.com">📘 Facebook</a>
            <a href="/proxy?url=https://www.tiktok.com">🎵 TikTok</a>
            <a href="/proxy?url=https://twitter.com">🐦 Twitter</a>
            <a href="/proxy?url=https://www.instagram.com">📸 Instagram</a>
        </div>
        <p style="margin-top:20px;font-size:12px;color:#666;">🔒 يمر عبر CroxyProxy</p>
    </div>
    <script>
        function go() {
            const url = document.getElementById('urlInput').value.trim();
            if (url) {
                window.location.href = '/proxy?url=' + encodeURIComponent(url);
            }
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
║   🚀 CroxyProxy Mirror Server      ║
║   📡 http://localhost:${port}        ║
║   🔗 /proxy?url=https://youtube.com ║
║   ✅ يعمل بكفاءة                    ║
╚══════════════════════════════════════╝
    `);
});
