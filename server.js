const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { URL } = require('url');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============================================
// 🎯 البروكسي المتقدم - جيب الموقع كله
// ============================================

// تخزين مؤقت للموارد
const resourceCache = new Map();

// دالة جيب المورد (صور، CSS، JS، إلخ)
async function fetchResource(resourceUrl, baseUrl) {
    try {
        // إذا كان المورد رابط نسبي، حوّله لمطلق
        let fullUrl = resourceUrl;
        if (resourceUrl.startsWith('/')) {
            const baseUrlObj = new URL(baseUrl);
            fullUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${resourceUrl}`;
        } else if (!resourceUrl.startsWith('http')) {
            fullUrl = new URL(resourceUrl, baseUrl).toString();
        }

        // تحقق من الـ cache
        if (resourceCache.has(fullUrl)) {
            return resourceCache.get(fullUrl);
        }

        const response = await fetch(fullUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': baseUrl,
            },
            timeout: 10000
        });

        if (!response.ok) {
            return null;
        }

        const buffer = await response.buffer();
        
        // خزّن في الـ cache (حد أقصى 100 مورد)
        if (resourceCache.size > 100) {
            const firstKey = resourceCache.keys().next().value;
            resourceCache.delete(firstKey);
        }
        resourceCache.set(fullUrl, buffer);

        return buffer;
    } catch (error) {
        console.error('❌ خطأ في جيب المورد:', error.message);
        return null;
    }
}

// الـ endpoint الرئيسي للبروكسي
app.get('/proxy', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) {
            return res.status(400).json({ error: '❌ مطلوب رابط (url parameter)' });
        }

        const decodedUrl = decodeURIComponent(targetUrl);

        // تحقق من صحة الرابط
        if (!decodedUrl.startsWith('http://') && !decodedUrl.startsWith('https://')) {
            return res.status(400).json({ error: '❌ الرابط يجب أن يبدأ بـ http:// أو https://' });
        }

        console.log('📡 البروكسي يجيب:', decodedUrl);

        const response = await fetch(decodedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
            },
            redirect: 'follow',
            timeout: 30000
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: `❌ خطأ: ${response.status}` });
        }

        const contentType = response.headers.get('content-type') || 'text/html';

        // إذا كان HTML، عدّل الروابط
        if (contentType.includes('text/html')) {
            let html = await response.text();

            // استخدم cheerio لتعديل HTML
            const $ = cheerio.load(html);

            // عدّل الروابط في الـ href و src
            $('a').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href) {
                    if (!href.startsWith('http') && !href.startsWith('javascript:') && !href.startsWith('#')) {
                        const fullUrl = new URL(href, decodedUrl).toString();
                        $(elem).attr('href', `/proxy?url=${encodeURIComponent(fullUrl)}`);
                    } else if (href.startsWith('http')) {
                        $(elem).attr('href', `/proxy?url=${encodeURIComponent(href)}`);
                    }
                }
            });

            // عدّل الصور
            $('img').each((i, elem) => {
                const src = $(elem).attr('src');
                if (src && !src.startsWith('data:')) {
                    const fullUrl = new URL(src, decodedUrl).toString();
                    $(elem).attr('src', `/proxy?url=${encodeURIComponent(fullUrl)}`);
                }
            });

            // عدّل CSS
            $('link[rel="stylesheet"]').each((i, elem) => {
                const href = $(elem).attr('href');
                if (href && !href.startsWith('http')) {
                    const fullUrl = new URL(href, decodedUrl).toString();
                    $(elem).attr('href', `/proxy?url=${encodeURIComponent(fullUrl)}`);
                } else if (href && href.startsWith('http')) {
                    $(elem).attr('href', `/proxy?url=${encodeURIComponent(href)}`);
                }
            });

            // عدّل الـ scripts
            $('script').each((i, elem) => {
                const src = $(elem).attr('src');
                if (src && !src.startsWith('http')) {
                    const fullUrl = new URL(src, decodedUrl).toString();
                    $(elem).attr('src', `/proxy?url=${encodeURIComponent(fullUrl)}`);
                } else if (src && src.startsWith('http')) {
                    $(elem).attr('src', `/proxy?url=${encodeURIComponent(src)}`);
                }
            });

            // أضف meta tag للـ base URL
            $('head').prepend(`<base href="${decodedUrl}">`);

            // أضف CSS مخصص لتحسين الواجهة
            $('head').append(`
                <style>
                    body { margin: 0; padding: 0; }
                    * { box-sizing: border-box; }
                </style>
            `);

            res.set('Content-Type', 'text/html; charset=utf-8');
            res.send($.html());
        } else {
            // للملفات الأخرى (صور، PDF، إلخ)
            res.set('Content-Type', contentType);
            res.set('Access-Control-Allow-Origin', '*');
            response.body.pipe(res);
        }

    } catch (error) {
        console.error('❌ خطأ البروكسي:', error.message);
        res.status(500).json({ error: `❌ خطأ: ${error.message}` });
    }
});

// endpoint لجيب الملفات الثابتة (صور، CSS، JS)
app.get('/resource', async (req, res) => {
    try {
        const resourceUrl = req.query.url;
        const baseUrl = req.query.base;

        if (!resourceUrl || !baseUrl) {
            return res.status(400).send('Missing parameters');
        }

        const buffer = await fetchResource(decodeURIComponent(resourceUrl), decodeURIComponent(baseUrl));

        if (!buffer) {
            return res.status(404).send('Resource not found');
        }

        // حدّد نوع المحتوى بناءً على الامتداد
        const ext = resourceUrl.split('.').pop().toLowerCase();
        const mimeTypes = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'svg': 'image/svg+xml',
            'css': 'text/css',
            'js': 'application/javascript',
            'woff': 'font/woff',
            'woff2': 'font/woff2',
            'ttf': 'font/ttf',
            'eot': 'application/vnd.ms-fontobject'
        };

        res.set('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(buffer);
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).send('Error');
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
    <title>🌐 Proxy Pro - بروكسي ضخم</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        html, body {
            width: 100%;
            height: 100%;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .navbar {
            background: rgba(0,0,0,0.3);
            backdrop-filter: blur(10px);
            padding: 12px 20px;
            display: flex;
            gap: 10px;
            align-items: center;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            flex-shrink: 0;
            z-index: 1000;
        }
        .logo {
            font-size: 22px;
            font-weight: bold;
            color: #fff;
            white-space: nowrap;
        }
        .url-bar {
            flex: 1;
            display: flex;
            gap: 8px;
            min-width: 0;
        }
        .url-bar input {
            flex: 1;
            padding: 8px 14px;
            border: 1px solid rgba(255,255,255,0.2);
            background: rgba(255,255,255,0.05);
            color: #fff;
            border-radius: 6px;
            font-size: 13px;
            min-width: 200px;
        }
        .url-bar input::placeholder {
            color: rgba(255,255,255,0.5);
        }
        .url-bar input:focus {
            outline: none;
            background: rgba(255,255,255,0.1);
            border-color: rgba(255,255,255,0.3);
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
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
        .btn-go:active {
            transform: scale(0.98);
        }
        .btn-clear {
            background: rgba(255,0,0,0.2);
            color: #fff;
            border: 1px solid rgba(255,0,0,0.5);
        }
        .btn-clear:hover {
            background: rgba(255,0,0,0.4);
        }
        .content {
            flex: 1;
            display: flex;
            overflow: hidden;
        }
        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        #proxy-frame {
            flex: 1;
            border: none;
            width: 100%;
            height: 100%;
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
            color: #fff;
        }
        .welcome-screen h1 {
            font-size: 56px;
            margin-bottom: 10px;
            text-shadow: 0 2px 10px rgba(0,0,0,0.3);
        }
        .welcome-screen p {
            font-size: 18px;
            opacity: 0.9;
            margin-bottom: 30px;
        }
        .instructions {
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            padding: 30px;
            border-radius: 12px;
            max-width: 500px;
            line-height: 1.8;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .instructions strong {
            display: block;
            margin-top: 15px;
            margin-bottom: 10px;
            font-size: 16px;
        }
        .loading-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            justify-content: center;
            align-items: center;
            z-index: 999;
        }
        .loading-overlay.active {
            display: flex;
        }
        .loader {
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            padding: 40px;
            border-radius: 12px;
            text-align: center;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .spinner {
            border: 4px solid rgba(255,255,255,0.1);
            border-top: 4px solid #fff;
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 1s linear infinite;
            margin: 0 auto 15px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .loader p {
            color: #fff;
            font-weight: 500;
            margin-top: 10px;
        }
        .error-msg {
            display: none;
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(255,0,0,0.9);
            color: #fff;
            padding: 15px 20px;
            border-radius: 6px;
            max-width: 400px;
            z-index: 2000;
            animation: slideIn 0.3s ease;
        }
        .error-msg.show {
            display: block;
        }
        @keyframes slideIn {
            from {
                transform: translateX(400px);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        @media (max-width: 768px) {
            .navbar {
                flex-wrap: wrap;
            }
            .url-bar {
                width: 100%;
                order: 2;
            }
            .welcome-screen h1 {
                font-size: 32px;
            }
            .instructions {
                max-width: 90%;
            }
        }
    </style>
</head>
<body>
    <div class="navbar">
        <div class="logo">🌐 Proxy Pro</div>
        <div class="url-bar">
            <input type="text" id="urlInput" placeholder="https://example.com" />
            <button class="btn btn-go" id="goBtn">GO</button>
            <button class="btn btn-clear" id="clearBtn">✕</button>
        </div>
    </div>

    <div class="content">
        <div class="main-content">
            <div id="welcome" class="welcome-screen">
                <h1>🌐 Proxy Pro</h1>
                <p>بروكسي ضخم - افتح أي موقع بكل محتوياته</p>
                <div class="instructions">
                    <strong>📌 الاستخدام:</strong>
                    1️⃣ ادخل رابط الموقع<br>
                    2️⃣ اضغط GO أو Enter<br>
                    3️⃣ الموقع يفتح بكل محتوياته<br>
                    <br>
                    <strong>⚡ أمثلة:</strong>
                    google.com<br>
                    reddit.com<br>
                    wikipedia.org<br>
                    github.com
                </div>
            </div>
            <iframe id="proxy-frame"></iframe>
        </div>
    </div>

    <div id="loading" class="loading-overlay">
        <div class="loader">
            <div class="spinner"></div>
            <p>جاري التحميل...</p>
        </div>
    </div>

    <div id="error" class="error-msg"></div>

    <script>
        const urlInput = document.getElementById('urlInput');
        const goBtn = document.getElementById('goBtn');
        const clearBtn = document.getElementById('clearBtn');
        const frame = document.getElementById('proxy-frame');
        const welcome = document.getElementById('welcome');
        const loading = document.getElementById('loading');
        const errorDiv = document.getElementById('error');

        function showError(msg) {
            errorDiv.textContent = msg;
            errorDiv.classList.add('show');
            setTimeout(() => {
                errorDiv.classList.remove('show');
            }, 5000);
        }

        function loadProxy() {
            let inputUrl = urlInput.value.trim();
            if (!inputUrl) {
                showError('❌ ادخل رابط الموقع');
                return;
            }

            // أضف https إذا لم يكن موجود
            if (!inputUrl.startsWith('http://') && !inputUrl.startsWith('https://')) {
                inputUrl = 'https://' + inputUrl;
            }

            console.log('🔄 جاري التحميل:', inputUrl);

            welcome.style.display = 'none';
            loading.classList.add('active');

            // حدّث شريط العنوان
            urlInput.value = inputUrl;

            // جيب الصفحة من خلال البروكسي
            const proxyUrl = \`/proxy?url=\${encodeURIComponent(inputUrl)}\`;
            frame.src = proxyUrl;

            // إخفاء التحميل عند انتهاء جيب الصفحة
            const timeout = setTimeout(() => {
                loading.classList.remove('active');
            }, 5000);

            frame.onload = () => {
                clearTimeout(timeout);
                loading.classList.remove('active');
                console.log('✅ تم التحميل');
            };

            frame.onerror = () => {
                clearTimeout(timeout);
                loading.classList.remove('active');
                showError('❌ خطأ في تحميل الموقع');
                welcome.style.display = 'flex';
            };
        }

        goBtn.addEventListener('click', loadProxy);
        clearBtn.addEventListener('click', () => {
            urlInput.value = '';
            frame.src = '';
            welcome.style.display = 'flex';
            loading.classList.remove('active');
            urlInput.focus();
        });

        urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') loadProxy();
        });

        urlInput.focus();
        console.log('🚀 Proxy Pro v2.0 - بروكسي ضخم');
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
║  🌐 Proxy Pro v2.0 - بروكسي ضخم      ║
║  📡 http://localhost:${PORT}           ║
║  ✅ البروكسي يجيب الموقع كله          ║
╚════════════════════════════════════════╝

📝 المميزات:
   ✓ جيب الموقع بكل محتوياته
   ✓ CSS و JavaScript و صور
   ✓ تعديل تلقائي للروابط
   ✓ واجهة احترافية
   ✓ سرعة عالية مع Cache

🚀 الاستخدام:
   http://localhost:${PORT}
    `);
});
        
