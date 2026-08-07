const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { URL } = require('url');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// ================================================================
//  إعدادات سريعة
// ================================================================
const CONFIG = {
    proxyBase: '/proxy',
    timeout: 30000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

// ================================================================
//  جلب سريع
// ================================================================
async function quickFetch(url) {
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': CONFIG.userAgent,
                'Accept': '*/*',
                'Accept-Language': 'ar-EG,ar;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br'
            },
            timeout: CONFIG.timeout
        });
        if (!res.ok) return null;
        const buffer = await res.buffer();
        return {
            data: buffer,
            contentType: res.headers.get('content-type') || 'application/octet-stream'
        };
    } catch {
        return null;
    }
}

// ================================================================
//  المعالج الرئيسي
// ================================================================
app.all('/proxy', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('خطأ: مطلوب رابط');
    }

    try {
        new URL(targetUrl);
    } catch {
        return res.status(400).send('خطأ: رابط غير صحيح');
    }

    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        return res.sendStatus(200);
    }

    try {
        const result = await quickFetch(targetUrl);
        if (!result) {
            return res.status(404).send('تعذر تحميل المحتوى');
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');

        if (result.contentType.includes('text/html')) {
            let html = result.data.toString('utf-8');
            
            html = html.replace(/(src|href|data-src)\s*=\s*["']([^"']*)["']/gi, (match, attr, url) => {
                if (!url || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('data:')) {
                    return match;
                }
                try {
                    const absoluteUrl = new URL(url, targetUrl).href;
                    return `${attr}="/proxy?url=${encodeURIComponent(absoluteUrl)}"`;
                } catch {
                    return match;
                }
            });

            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        }

        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Content-Length', result.data.length);
        res.send(result.data);

    } catch (error) {
        console.error('[PROXY]', error.message);
        res.status(500).send('خطأ في الخادم');
    }
});

// ================================================================
//  الصفحة الرئيسية
// ================================================================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>بروكسي سريع</title>
        <style>
            body {
                margin: 0;
                padding: 40px 20px;
                font-family: 'Segoe UI', Tahoma, sans-serif;
                background: #0a0b0d;
                color: #ede9e2;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
            }
            .container {
                max-width: 500px;
                width: 100%;
                text-align: center;
            }
            h1 { font-size: 28px; color: #e8c96a; margin-bottom: 10px; }
            p { color: #8a8f98; margin-bottom: 25px; }
            input {
                width: 100%;
                padding: 14px 18px;
                border-radius: 10px;
                border: 1px solid #2a2a2a;
                background: #131519;
                color: #ede9e2;
                font-size: 16px;
                box-sizing: border-box;
                direction: ltr;
            }
            input:focus { outline: none; border-color: #e8c96a; }
            button {
                margin-top: 12px;
                width: 100%;
                padding: 14px;
                border: none;
                border-radius: 10px;
                background: #e8c96a;
                color: #0a0b0d;
                font-size: 18px;
                font-weight: 700;
                cursor: pointer;
            }
            button:hover { background: #d4b558; }
            .info {
                margin-top: 20px;
                font-size: 13px;
                color: #555;
                text-align: right;
                line-height: 1.8;
            }
            .info strong { color: #e8c96a; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 بروكسي سريع</h1>
            <p>شغل أي فيديو أو موقع من خلال البروكسي</p>
            <input type="text" id="urlInput" placeholder="https://www.youtube.com/watch?v=..." dir="ltr">
            <button onclick="go()">▶ تشغيل</button>
            <div class="info">
                <strong>📌 طريقة الاستخدام:</strong><br>
                • حط رابط يوتيوب كامل<br>
                • أو حط ID الفيديو بس (مثل: dQw4w9WgXcQ)<br>
                • أو أي رابط موقع تاني
            </div>
        </div>
        <script>
            function go() {
                const input = document.getElementById('urlInput').value.trim();
                if (!input) return;
                let url = input;
                if (!input.startsWith('http')) {
                    if (input.includes('youtube.com') || input.includes('youtu.be')) {
                        url = 'https://' + input;
                    } else if (!input.includes('.')) {
                        url = 'https://www.youtube.com/watch?v=' + input;
                    } else {
                        url = 'https://' + input;
                    }
                }
                window.location.href = '/proxy?url=' + encodeURIComponent(url);
            }
            document.getElementById('urlInput').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') go();
            });
        </script>
    </body>
    </html>
    `);
});

// ================================================================
//  تشغيل السيرفر
// ================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ سيرفر البروكسي شغال على http://localhost:${PORT}`);
});

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});
