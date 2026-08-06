const express = require('express');
const app = express();

// ============================================
// 🏠 الصفحة الرئيسية (قائمة المواقع)
// ============================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🚀 بوابة التصفح الآمن</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
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
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        }
        h1 {
            color: white;
            text-align: center;
            font-size: 28px;
            margin-bottom: 10px;
        }
        .subtitle {
            color: #aaa;
            text-align: center;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 15px;
        }
        .site-card {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 15px;
            padding: 20px 10px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s ease;
            color: white;
            text-decoration: none;
        }
        .site-card:hover {
            background: rgba(255,255,255,0.15);
            transform: translateY(-5px);
            border-color: #e74c3c;
        }
        .site-card .icon {
            font-size: 40px;
            display: block;
            margin-bottom: 8px;
        }
        .site-card .name {
            font-size: 16px;
            font-weight: 600;
        }
        .site-card .badge {
            font-size: 11px;
            background: rgba(231,76,60,0.3);
            color: #e74c3c;
            padding: 2px 10px;
            border-radius: 20px;
            margin-top: 5px;
            display: inline-block;
        }
        .footer {
            margin-top: 30px;
            text-align: center;
            color: #555;
            font-size: 12px;
        }
        .input-section {
            margin-top: 20px;
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        .input-section input {
            flex: 1;
            padding: 12px;
            border-radius: 10px;
            border: 1px solid rgba(255,255,255,0.1);
            background: rgba(255,255,255,0.05);
            color: white;
            font-size: 14px;
            min-width: 150px;
        }
        .input-section input::placeholder {
            color: #666;
        }
        .input-section button {
            padding: 12px 20px;
            border: none;
            border-radius: 10px;
            background: #e74c3c;
            color: white;
            font-weight: bold;
            cursor: pointer;
            transition: 0.3s;
        }
        .input-section button:hover {
            background: #c0392b;
        }
        @media (max-width: 500px) {
            .grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌍 بوابة التصفح الآمن</h1>
        <p class="subtitle">اختر الموقع للتصفح من خلال البروكسي</p>

        <div class="grid">
            <a class="site-card" href="/api/proxy?url=https://www.youtube.com">
                <span class="icon">▶️</span>
                <span class="name">يوتيوب</span>
                <span class="badge">YouTube</span>
            </a>
            <a class="site-card" href="/api/proxy?url=https://www.facebook.com">
                <span class="icon">📘</span>
                <span class="name">فيسبوك</span>
                <span class="badge">Facebook</span>
            </a>
            <a class="site-card" href="/api/proxy?url=https://www.tiktok.com">
                <span class="icon">🎵</span>
                <span class="name">تيك توك</span>
                <span class="badge">TikTok</span>
            </a>
            <a class="site-card" href="/api/proxy?url=https://twitter.com">
                <span class="icon">🐦</span>
                <span class="name">تويتر</span>
                <span class="badge">Twitter</span>
            </a>
            <a class="site-card" href="/api/proxy?url=https://www.instagram.com">
                <span class="icon">📸</span>
                <span class="name">إنستجرام</span>
                <span class="badge">Instagram</span>
            </a>
            <a class="site-card" href="/api/proxy?url=https://www.reddit.com">
                <span class="icon">🤖</span>
                <span class="name">ريديت</span>
                <span class="badge">Reddit</span>
            </a>
        </div>

        <div class="input-section">
            <input type="text" id="customUrl" placeholder="أو الصق رابط أي موقع...">
            <button onclick="goToUrl()">🚀 فتح</button>
        </div>

        <div class="footer">
            🔒 جميع المواقع تمر عبر البروكسي | v7.0
        </div>
    </div>

    <script>
        function goToUrl() {
            const url = document.getElementById('customUrl').value.trim();
            if (url) {
                window.location.href = '/api/proxy?url=' + encodeURIComponent(url);
            } else {
                alert('من فضلك أدخل رابط الموقع');
            }
        }
    </script>
</body>
</html>
    `);
});

// ============================================
// 🌐 وكيل التصفح الكامل (بيجيب أي موقع)
// ============================================
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send('❌ مطلوب رابط الموقع');
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache'
            }
        });

        if (!response.ok) {
            return res.status(response.status).send(`❌ خطأ: ${response.status}`);
        }

        const contentType = response.headers.get('content-type') || 'text/html';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');

        // لو HTML، نعدل الروابط عشان التصفح يستمر عبر البروكسي
        if (contentType.includes('text/html')) {
            let html = await response.text();
            // نعدل كل الروابط عشان تفضل جوه البروكسي
            html = html.replace(/(href|src|action)\s*=\s*["']\/([^"']*)["']/gi, (match, attr, path) => {
                return `${attr}="/api/proxy?url=${encodeURIComponent(new URL(path, targetUrl).href)}"`;
            });
            html = html.replace(/(href|src|action)\s*=\s*["'](https?:\/\/[^"']*)["']/gi, (match, attr, url) => {
                return `${attr}="/api/proxy?url=${encodeURIComponent(url)}"`;
            });
            return res.send(html);
        }

        // مش HTML، نمررها زي ما هي
        response.body.pipe(res);

    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).send(`❌ خطأ في الوكيل: ${error.message}`);
    }
});

// ============================================
// 🚀 تشغيل السيرفر
// ============================================
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════╗
║   🌍 بوابة التصفح الآمن v7.0       ║
║   📡 http://localhost:${port}        ║
║   ✅ يدعم: يوتيوب، فيسبوك، تيك توك ║
║   ✅ وجميع المواقع الأخرى          ║
╚══════════════════════════════════════╝
    `);
});
