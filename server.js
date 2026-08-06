const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const url = require('url');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// ============================================
// 🎯 البروكسي الشامل
// ============================================
app.get('/proxy', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) {
            return res.status(400).send('❌ مطلوب رابط (url parameter)');
        }

        const decodedUrl = decodeURIComponent(targetUrl);
        
        // تحقق من صحة الرابط
        if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) {
            return res.status(400).send('❌ الرابط يجب أن يبدأ بـ http:// أو https://');
        }

        console.log('📡 البروكسي يمرّر:', decodedUrl);

        const response = await fetch(decodedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
                'Referer': new URL(decodedUrl).origin,
            },
            redirect: 'follow',
            timeout: 30000
        });

        if (!response.ok) {
            return res.status(response.status).send(`❌ خطأ من الموقع: ${response.status}`);
        }

        // نقل رؤوس الاستجابة
        const contentType = response.headers.get('content-type');
        res.setHeader('Content-Type', contentType || 'text/html; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // لا نرسل رؤوس مشكوك فيها
        const headerBlacklist = ['content-encoding', 'transfer-encoding', 'content-security-policy', 'x-frame-options'];
        response.headers.forEach((value, name) => {
            if (!headerBlacklist.includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        response.body.pipe(res);

    } catch (error) {
        console.error('❌ خطأ البروكسي:', error.message);
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
    <title>🌐 Proxy Browser</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .navbar {
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            border-radius: 12px;
            padding: 15px 20px;
            margin-bottom: 20px;
            display: flex;
            gap: 10px;
            align-items: center;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .logo {
            font-size: 24px;
            font-weight: bold;
            color: #fff;
            min-width: 120px;
        }
        .url-bar {
            flex: 1;
            display: flex;
            gap: 8px;
        }
        .url-bar input {
            flex: 1;
            padding: 10px 16px;
            border: 1px solid rgba(255,255,255,0.2);
            background: rgba(255,255,255,0.05);
            color: #fff;
            border-radius: 8px;
            font-size: 14px;
            min-width: 0;
        }
        .url-bar input::placeholder {
            color: rgba(255,255,255,0.6);
        }
        .url-bar input:focus {
            outline: none;
            background: rgba(255,255,255,0.15);
            border-color: rgba(255,255,255,0.4);
        }
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.3s ease;
            white-space: nowrap;
        }
        .btn-go {
            background: #fff;
            color: #667eea;
        }
        .btn-go:hover {
            transform: scale(1.05);
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        }
        .btn-clear {
            background: rgba(255,0,0,0.3);
            color: #fff;
            border: 1px solid rgba(255,0,0,0.5);
        }
        .btn-clear:hover {
            background: rgba(255,0,0,0.5);
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        .content-area {
            background: #fff;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            height: 80vh;
            display: flex;
            flex-direction: column;
        }
        #iframe-container {
            flex: 1;
            display: none;
            position: relative;
        }
        #proxy-iframe {
            width: 100%;
            height: 100%;
            border: none;
        }
        .welcome-screen {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 20px;
            padding: 40px;
            text-align: center;
        }
        .welcome-screen h1 {
            font-size: 48px;
            color: #667eea;
            margin-bottom: 10px;
        }
        .welcome-screen p {
            color: #666;
            font-size: 18px;
            margin-bottom: 20px;
        }
        .instructions {
            background: rgba(102, 126, 234, 0.1);
            padding: 30px;
            border-radius: 12px;
            max-width: 500px;
            color: #333;
            text-align: right;
            line-height: 1.8;
        }
        .instructions strong {
            color: #667eea;
            display: block;
            margin-top: 15px;
            margin-bottom: 10px;
        }
        .loading {
            display: none;
            text-align: center;
            padding: 20px;
        }
        .spinner {
            border: 4px solid rgba(102, 126, 234, 0.1);
            border-top: 4px solid #667eea;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 10px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .error {
            display: none;
            background: rgba(255,0,0,0.1);
            color: #d32f2f;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 15px;
            border: 1px solid rgba(255,0,0,0.3);
        }
        @media (max-width: 768px) {
            .navbar {
                flex-wrap: wrap;
            }
            .url-bar {
                width: 100%;
                order: 3;
            }
            .welcome-screen h1 {
                font-size: 32px;
            }
            .content-area {
                height: auto;
                min-height: 60vh;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div id="error" class="error"></div>
        
        <div class="navbar">
            <div class="logo">🌐 Proxy</div>
            <div class="url-bar">
                <input type="text" id="urlInput" placeholder="https://example.com" />
                <button class="btn btn-go" id="goBtn">GO</button>
                <button class="btn btn-clear" id="clearBtn">✕</button>
            </div>
        </div>

        <div class="content-area">
            <div id="loading" class="loading">
                <div class="spinner"></div>
                <p style="color: #667eea; margin-top: 10px;">جاري التحميل...</p>
            </div>

            <div id="iframe-container">
                <iframe id="proxy-iframe"></iframe>
            </div>

            <div id="welcome" class="welcome-screen">
                <h1>🌐 Proxy Browser</h1>
                <p>ادخل رابط أي موقع وشغّله من خلال البروكسي</p>
                <div class="instructions">
                    <strong>📌 طريقة الاستخدام:</strong>
                    1️⃣ ادخل رابط الموقع (مثل https://example.com)<br>
                    2️⃣ اضغط زر GO<br>
                    3️⃣ الموقع هيتحمّل من خلال البروكسي<br>
                    <br>
                    <strong>⚡ أمثلة:</strong>
                    https://google.com<br>
                    https://reddit.com<br>
                    https://wikipedia.org
                </div>
            </div>
        </div>
    </div>

    <script>
        const urlInput = document.getElementById('urlInput');
        const goBtn = document.getElementById('goBtn');
        const clearBtn = document.getElementById('clearBtn');
        const iframe = document.getElementById('proxy-iframe');
        const iframeContainer = document.getElementById('iframe-container');
        const welcome = document.getElementById('welcome');
        const loading = document.getElementById('loading');
        const errorDiv = document.getElementById('error');

        function showError(msg) {
            errorDiv.textContent = msg;
            errorDiv.style.display = 'block';
            setTimeout(() => {
                errorDiv.style.display = 'none';
            }, 5000);
        }

        function loadProxy() {
            const inputUrl = urlInput.value.trim();
            if (!inputUrl) {
                showError('❌ ادخل رابط الموقع');
                return;
            }

            // أضف http إذا لم يكن موجود
            let targetUrl = inputUrl;
            if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
                targetUrl = 'https://' + targetUrl;
            }

            // بناء رابط البروكسي
            const proxyUrl = \`/proxy?url=\${encodeURIComponent(targetUrl)}\`;

            console.log('🔄 جاري التحميل من البروكسي:', proxyUrl);

            welcome.style.display = 'none';
            loading.style.display = 'block';

            iframe.onload = () => {
                loading.style.display = 'none';
                iframeContainer.style.display = 'block';
            };

            iframe.onerror = () => {
                loading.style.display = 'none';
                showError('❌ حدث خطأ في تحميل الموقع');
                welcome.style.display = 'flex';
                iframeContainer.style.display = 'none';
            };

            iframe.src = proxyUrl;
        }

        goBtn.addEventListener('click', loadProxy);
        clearBtn.addEventListener('click', () => {
            urlInput.value = '';
            iframe.src = '';
            iframeContainer.style.display = 'none';
            welcome.style.display = 'flex';
            loading.style.display = 'none';
            urlInput.focus();
        });

        urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') loadProxy();
        });

        // ركّز على الـ input
        urlInput.focus();

        console.log('🚀 Proxy Browser v1.0');
    </script>
</body>
</html>
    `);
});

// ============================================
// 🚀 تشغيل السيرفر
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════╗
║  🌐 Proxy Browser v1.0                ║
║  📡 http://localhost:${PORT}           ║
║  ✅ بروكسي شامل لأي موقع              ║
╚════════════════════════════════════════╝

📝 الاستخدام:
   - اذهب إلى http://localhost:${PORT}
   - ادخل رابط الموقع
   - اضغط GO

💡 أمثلة:
   https://google.com
   https://reddit.com
   https://wikipedia.org
    `);
});
           
