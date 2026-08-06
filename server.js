const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.static('public'));

// ============================================
// 🎯 الوكيل - تمرير الطلبات ليوتيوب
// ============================================
app.get('/api/proxy/:path', async (req, res) => {
    try {
        const targetUrl = decodeURIComponent(req.query.url);
        console.log('📡 البروكسي:', targetUrl);

        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'https://www.youtube.com/',
                'Origin': 'https://www.youtube.com',
                'Accept': '*/*',
            }
        });

        if (!response.ok) {
            return res.status(response.status).send(`❌ خطأ: ${response.status}`);
        }

        // نقل رؤوس الاستجابة
        response.headers.forEach((value, name) => {
            if (!['content-encoding', 'transfer-encoding'].includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        response.body.pipe(res);

    } catch (error) {
        console.error('❌ خطأ البروكسي:', error.message);
        res.status(500).send(`❌ خطأ: ${error.message}`);
    }
});

// ============================================
// 🏠 الصفحة الرئيسية - يوتيوب عبر البروكسي
// ============================================
app.get('/', (req, res) => {
    const defaultVideo = 'https://www.youtube.com/watch?v=KnuIqBn6UTM';

    res.send(`
<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎥 يوتيوب عبر البروكسي</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f0f0f;
            color: #fff;
            min-height: 100vh;
            padding: 10px;
        }
        .container {
            max-width: 1280px;
            margin: 0 auto;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 15px 0;
            margin-bottom: 20px;
            border-bottom: 1px solid rgba(255,255,255,0.1);
        }
        .logo {
            font-size: 24px;
            font-weight: bold;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .search-bar {
            display: flex;
            gap: 8px;
            flex: 1;
            max-width: 500px;
            margin: 0 20px;
        }
        .search-bar input {
            flex: 1;
            padding: 10px 16px;
            border: 1px solid rgba(255,255,255,0.2);
            background: rgba(255,255,255,0.05);
            color: #fff;
            border-radius: 20px;
            font-size: 14px;
        }
        .search-bar input::placeholder {
            color: rgba(255,255,255,0.5);
        }
        .search-bar input:focus {
            outline: none;
            background: rgba(255,255,255,0.1);
            border-color: #065fd4;
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 20px;
            font-size: 14px;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.2s ease;
        }
        .btn-primary {
            background: #065fd4;
            color: white;
        }
        .btn-primary:hover {
            background: #0a5bc8;
        }
        .btn-secondary {
            background: rgba(255,255,255,0.1);
            color: #fff;
        }
        .btn-secondary:hover {
            background: rgba(255,255,255,0.2);
        }
        .player-container {
            position: relative;
            width: 100%;
            padding-bottom: 56.25%;
            background: #000;
            border-radius: 12px;
            overflow: hidden;
            margin-bottom: 20px;
        }
        .player-iframe {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            border: none;
        }
        .message {
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 15px;
            display: none;
        }
        .message.error {
            background: rgba(255,0,0,0.1);
            color: #ff0000;
            border: 1px solid rgba(255,0,0,0.3);
            display: block;
        }
        .message.success {
            background: rgba(0,255,0,0.1);
            color: #00ff00;
            border: 1px solid rgba(0,255,0,0.3);
            display: block;
        }
        .info-box {
            background: rgba(255,255,255,0.05);
            padding: 15px;
            border-radius: 8px;
            margin-top: 20px;
            border: 1px solid rgba(255,255,255,0.1);
            font-size: 14px;
            line-height: 1.6;
        }
        @media (max-width: 768px) {
            .search-bar {
                flex-direction: column;
                max-width: 100%;
                margin: 0;
            }
            .header {
                flex-direction: column;
                gap: 15px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🎥 YouTube Proxy</div>
            <div class="search-bar">
                <input type="text" id="videoUrl" placeholder="ادخل رابط يوتيوب هنا..." value="${defaultVideo}" />
                <button class="btn btn-primary" id="playBtn">▶️ تشغيل</button>
            </div>
        </div>

        <div id="errorMessage" class="message error"></div>
        <div id="successMessage" class="message success"></div>

        <div class="player-container">
            <iframe id="player" class="player-iframe" allow="autoplay; encrypted-media" allowfullscreen></iframe>
        </div>

        <div class="info-box">
            <strong>📌 كيفية الاستخدام:</strong><br>
            • انسخ رابط الفيديو من يوتيوب<br>
            • الصقه في صندوق البحث<br>
            • اضغط "تشغيل"<br>
            <br>
            <strong>⚡ المميزات:</strong><br>
            • تشغيل مباشر بدون تحميل<br>
            • واجهة يوتيوب كاملة<br>
            • يعمل مع أي رابط يوتيوب
        </div>
    </div>

    <script>
        const videoUrlInput = document.getElementById('videoUrl');
        const playBtn = document.getElementById('playBtn');
        const player = document.getElementById('player');
        const errorMessage = document.getElementById('errorMessage');
        const successMessage = document.getElementById('successMessage');

        // استخراج معرّف الفيديو من الرابط
        function extractVideoId(url) {
            const patterns = [
                /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
                /youtube\.com\/embed\/([^&\n?#]+)/,
                /youtube\.com\/v\/([^&\n?#]+)/
            ];
            
            for (let pattern of patterns) {
                const match = url.match(pattern);
                if (match && match[1]) {
                    return match[1];
                }
            }
            return null;
        }

        function playVideo() {
            const url = videoUrlInput.value.trim();
            if (!url) {
                showError('❌ من فضلك أدخل رابط الفيديو');
                return;
            }

            const videoId = extractVideoId(url);
            if (!videoId) {
                showError('❌ رابط يوتيوب غير صحيح');
                return;
            }

            // بناء رابط الـ embed
            const embedUrl = \`https://www.youtube.com/embed/\${videoId}?autoplay=1\`;
            
            player.src = embedUrl;
            hideError();
            showSuccess('✅ تم تحميل الفيديو');
            
            console.log('🎬 تشغيل الفيديو:', videoId);
        }

        playBtn.addEventListener('click', playVideo);
        
        videoUrlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') playVideo();
        });

        function showError(msg) {
            errorMessage.textContent = msg;
            errorMessage.style.display = 'block';
            successMessage.style.display = 'none';
        }

        function hideError() {
            errorMessage.style.display = 'none';
        }

        function showSuccess(msg) {
            successMessage.textContent = msg;
            successMessage.style.display = 'block';
        }

        // تشغيل الفيديو الافتراضي عند التحميل
        window.addEventListener('load', () => {
            setTimeout(playVideo, 500);
        });

        console.log('🚀 YouTube Proxy v3.0 - مع البث المباشر');
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
╔════════════════════════════════════════╗
║  🎥 YouTube Proxy v3.0                ║
║  📡 http://localhost:${port}          ║
║  ⚡ تشغيل يوتيوب مباشر بدون تحميل    ║
╚════════════════════════════════════════╝
    `);
});
            
