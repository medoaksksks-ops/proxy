const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static('public'));

// ============================================
// 🎯 الوكيل الرئيسي (بيجيب الفيديو فقط)
// ============================================
app.get('/api/stream', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).send('❌ مطلوب رابط الفيديو');
    }

    try {
        const decodedUrl = decodeURIComponent(url);
        console.log('📥 جلب الفيديو:', decodedUrl);

        const response = await fetch(decodedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.youtube.com/',
                'Origin': 'https://www.youtube.com'
            }
        });

        if (!response.ok) {
            return res.status(response.status).send(`❌ خطأ: ${response.status}`);
        }

        // ننقل الـ headers المهمة
        res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp4');
        res.setHeader('Content-Length', response.headers.get('content-length'));
        res.setHeader('Access-Control-Allow-Origin', '*');

        // نرسل الفيديو مباشرة
        response.body.pipe(res);

    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).send(`❌ خطأ في الوكيل: ${error.message}`);
    }
});

// ============================================
// 🏠 الصفحة الرئيسية (الواجهة)
// ============================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎥 مشغل يوتيوب - الوكيل الشامل</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
            max-width: 800px;
            width: 100%;
            padding: 40px;
        }
        h1 {
            color: #fff;
            text-align: center;
            margin-bottom: 10px;
            font-size: 28px;
        }
        .subtitle {
            color: #aaa;
            text-align: center;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .input-group {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .input-group input {
            flex: 1;
            padding: 14px 20px;
            border: 2px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            font-size: 16px;
            min-width: 200px;
        }
        .input-group input::placeholder {
            color: #888;
        }
        .input-group input:focus {
            outline: none;
            border-color: #e74c3c;
        }
        .btn {
            padding: 14px 25px;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .btn-primary {
            background: #e74c3c;
            color: white;
        }
        .btn-primary:hover {
            background: #c0392b;
            transform: scale(1.02);
        }
        .btn-secondary {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }
        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.2);
        }
        .btn-paste {
            background: #3498db;
            color: white;
        }
        .btn-paste:hover {
            background: #2980b9;
        }
        .player-container {
            background: rgba(0, 0, 0, 0.3);
            border-radius: 12px;
            overflow: hidden;
            margin-top: 20px;
            display: none;
        }
        .player-container.active {
            display: block;
        }
        #videoPlayer {
            width: 100%;
            max-height: 450px;
            display: block;
        }
        .error-message {
            color: #e74c3c;
            background: rgba(231, 76, 60, 0.1);
            padding: 12px;
            border-radius: 8px;
            margin-top: 10px;
            display: none;
            border: 1px solid rgba(231, 76, 60, 0.3);
        }
        .info-box {
            background: rgba(255, 255, 255, 0.05);
            padding: 15px;
            border-radius: 10px;
            margin: 15px 0;
            color: #aaa;
            font-size: 13px;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .info-box strong {
            color: #fff;
        }
        @media (max-width: 600px) {
            .input-group {
                flex-direction: column;
            }
            .btn {
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎥 مشغل يوتيوب</h1>
        <p class="subtitle">شغل أي فيديو من يوتيوب بسهولة</p>

        <div class="input-group">
            <input type="text" id="videoUrl" placeholder="https://www.youtube.com/watch?v=VIDEO_ID" />
            <button class="btn btn-paste" id="pasteBtn">📋 لصق</button>
            <button class="btn btn-primary" id="playBtn">▶️ تشغيل</button>
        </div>

        <div class="info-box">
            <strong>📌 طريقة الاستخدام:</strong><br>
            1- انسخ رابط الفيديو من يوتيوب<br>
            2- اضغط زر "لصق" أو اكتب الرابط يدوياً<br>
            3- اضغط "تشغيل" واستمتع 🎬
        </div>

        <div id="errorMessage" class="error-message"></div>

        <div id="playerContainer" class="player-container">
            <video id="videoPlayer" controls autoplay></video>
        </div>
    </div>

    <script>
        const videoUrlInput = document.getElementById('videoUrl');
        const playBtn = document.getElementById('playBtn');
        const pasteBtn = document.getElementById('pasteBtn');
        const playerContainer = document.getElementById('playerContainer');
        const videoPlayer = document.getElementById('videoPlayer');
        const errorMessage = document.getElementById('errorMessage');

        // 🎯 زرار اللصق
        pasteBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text && text.includes('youtube.com')) {
                    videoUrlInput.value = text;
                    hideError();
                } else {
                    showError('❌ الحافظة لا تحتوي على رابط يوتيوب صحيح');
                }
            } catch (err) {
                showError('❌ لا يمكن الوصول إلى الحافظة. الصق الرابط يدوياً');
            }
        });

        // 🎯 زرار التشغيل
        playBtn.addEventListener('click', playVideo);

        // 🎯 تشغيل بالضغط على Enter
        videoUrlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') playVideo();
        });

        function playVideo() {
            const url = videoUrlInput.value.trim();
            if (!url) {
                showError('❌ من فضلك أدخل رابط الفيديو');
                return;
            }

            // نستخرج رابط الفيديو المباشر
            const proxyUrl = \`/api/stream?url=\${encodeURIComponent(url)}\`;
            console.log('🎬 تشغيل:', proxyUrl);

            // نختبر الرابط الأول
            fetch(proxyUrl)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(\`HTTP \${response.status}\`);
                    }
                    // لو نجح، نشغل الفيديو
                    videoPlayer.src = proxyUrl;
                    playerContainer.classList.add('active');
                    hideError();
                    videoPlayer.play().catch(e => console.warn('Autoplay prevented'));
                })
                .catch(error => {
                    showError(\`❌ فشل تشغيل الفيديو: \${error.message}\`);
                    playerContainer.classList.remove('active');
                });
        }

        function showError(msg) {
            errorMessage.textContent = msg;
            errorMessage.style.display = 'block';
        }

        function hideError() {
            errorMessage.style.display = 'none';
        }

        // 🎯 لو فيه رابط في الـ URL، يشتغل تلقائي
        const params = new URLSearchParams(window.location.search);
        const autoUrl = params.get('url');
        if (autoUrl) {
            videoUrlInput.value = autoUrl;
            playVideo();
        }

        console.log('🚀 الوكيل الشامل v5.0 - شغال');
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
║   🎥 مشغل يوتيوب - الوكيل الشامل   ║
║   📡 http://localhost:${port}        ║
║   ✅ شغال وجاهز للاستخدام           ║
╚══════════════════════════════════════╝
    `);
});
