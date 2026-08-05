const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();
app.use(cors());

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256 });

function getAgent(url) {
    return url.startsWith('https') ? httpsAgent : httpAgent;
}

// ============================================
// 🎯 هيدرات خاصة بيوتيوب (وكيل تصفح)
// ============================================
function getYouTubeHeaders(url) {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '?1',
        'Sec-Fetch-Dest': 'document',
        'Upgrade-Insecure-Requests': '1',
        'Cookie': 'PREF=f1=50000000&hl=en; VISITOR_INFO1_LIVE=...; CONSENT=YES+cb',
        'Referer': 'https://www.youtube.com/'
    };
}

// ============================================
// 🔍 نظام ذكي لاستخراج الـ Headers حسب الموقع
// ============================================
function getHeaders(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;

        if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
            return getYouTubeHeaders(url);
        }

        if (hostname.includes('facebook.com')) {
            return {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-Mode': 'navigate'
            };
        }

        if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
            return {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            };
        }

        if (hostname.includes('instagram.com')) {
            return {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-Mode': 'navigate'
            };
        }

        if (hostname.includes('tiktok.com')) {
            return {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            };
        }

        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7',
            'Origin': `https://${hostname}`,
            'Referer': `https://${hostname}/`,
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        };

    } catch (e) {
        console.warn('⚠️ خطأ في تحليل URL:', e.message);
        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };
    }
}

// ============================================
// 🔄 دالة لتعديل الروابط داخل الصفحة (عشان التصفح الكامل)
// ============================================
function rewriteLinks(html, baseUrl, proxyBase) {
    // تعديل روابط <a href="...">
    html = html.replace(/<a\s+(?:[^>]*?\s+)?href\s*=\s*["']([^"']*)["']/gi, (match, href) => {
        try {
            const absoluteUrl = new URL(href, baseUrl).href;
            // نتأكد إن الرابط مش خارجي (نفس النطاق) عشان نمرره
            if (absoluteUrl.startsWith('https://www.youtube.com') || 
                absoluteUrl.startsWith('https://youtube.com') ||
                absoluteUrl.startsWith('https://youtu.be')) {
                return match.replace(href, `${proxyBase}?url=${encodeURIComponent(absoluteUrl)}`);
            }
            // لو الرابط لموقع تاني، نمرره برضه عشان التصفح الكامل
            return match.replace(href, `${proxyBase}?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {
            return match;
        }
    });

    // تعديل روابط <form action="...">
    html = html.replace(/<form\s+(?:[^>]*?\s+)?action\s*=\s*["']([^"']*)["']/gi, (match, action) => {
        try {
            const absoluteUrl = new URL(action, baseUrl).href;
            return match.replace(action, `${proxyBase}?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {
            return match;
        }
    });

    // تعديل روابط <img src="..."> (الصور)
    html = html.replace(/<img\s+(?:[^>]*?\s+)?src\s*=\s*["']([^"']*)["']/gi, (match, src) => {
        try {
            const absoluteUrl = new URL(src, baseUrl).href;
            return match.replace(src, `${proxyBase}?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {
            return match;
        }
    });

    // تعديل روابط <link href="..."> (CSS, icons)
    html = html.replace(/<link\s+(?:[^>]*?\s+)?href\s*=\s*["']([^"']*)["']/gi, (match, href) => {
        try {
            const absoluteUrl = new URL(href, baseUrl).href;
            return match.replace(href, `${proxyBase}?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {
            return match;
        }
    });

    // تعديل روابط <script src="...">
    html = html.replace(/<script\s+(?:[^>]*?\s+)?src\s*=\s*["']([^"']*)["']/gi, (match, src) => {
        try {
            const absoluteUrl = new URL(src, baseUrl).href;
            return match.replace(src, `${proxyBase}?url=${encodeURIComponent(absoluteUrl)}`);
        } catch (e) {
            return match;
        }
    });

    return html;
}

// ============================================
// 📡 نقطة نهاية الوكيل الرئيسية (للتصفح الكامل)
// ============================================
app.get('/api/stream', async (req, res) => {
    const urlMatch = req.query.url;

    if (!urlMatch) {
        return res.status(400).json({
            error: '❌ مطلوب رابط',
            example: '/api/stream?url=https://www.youtube.com'
        });
    }

    let url = decodeURIComponent(urlMatch);

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    try {
        const headers = getHeaders(url);

        if (req.headers.range) {
            headers.Range = req.headers.range;
        }

        const response = await fetch(url, {
            headers,
            redirect: 'follow',
            agent: getAgent(url),
            signal: abortController.signal,
            timeout: 30000
        });

        if (!response.ok) {
            return res.status(response.status).json({
                error: `HTTP ${response.status}`,
                details: response.statusText
            });
        }

        const contentType = response.headers.get('content-type') || 'text/html';
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');

        // ============================================
        // 🎯 لو الـ response HTML، نعدل الروابط عشان التصفح الكامل
        // ============================================
        if (contentType.includes('text/html')) {
            let html = await response.text();
            const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
            const proxyBase = '/api/stream';
            html = rewriteLinks(html, baseUrl, proxyBase);
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(html);
        }

        // ============================================
        // 🎯 لو مش HTML (صور، فيديوهات، CSS، JS) نمررها زي ما هي
        // ============================================
        res.setHeader('Content-Type', contentType);
        const contentLength = response.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);

        const setCookie = response.headers.get('set-cookie');
        if (setCookie) {
            res.setHeader('Set-Cookie', setCookie);
        }

        const headersToForward = ['cache-control', 'etag', 'last-modified', 'accept-ranges'];
        for (const header of headersToForward) {
            const value = response.headers.get(header);
            if (value) res.setHeader(header, value);
        }

        response.body.pipe(res);

        response.body.on('error', (err) => {
            console.error('❌ خطأ في الـ streaming:', err.message);
            if (!res.headersSent) res.status(502).end();
            else res.end();
        });

    } catch (error) {
        if (error.name === 'AbortError' || abortController.signal.aborted) {
            console.warn('⚠️ تم إلغاء الطلب من قبل المستخدم');
            return;
        }
        console.error('❌ خطأ في الوكيل:', error.message);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Proxy Error',
                message: error.message
            });
        }
    }
});

// ============================================
// 🏠 الصفحة الرئيسية
// ============================================
app.get('/', (req, res) => {
    res.type('text/html').send(`
<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🚀 الوكيل الشامل - تصفح كامل</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 15px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 800px;
            width: 100%;
            padding: 40px;
        }
        h1 { color: #667eea; margin-bottom: 10px; }
        .status {
            background: #d4edda;
            border: 1px solid #c3e6cb;
            color: #155724;
            padding: 12px 15px;
            border-radius: 5px;
            margin: 20px 0;
        }
        .section {
            margin: 25px 0;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 10px;
            border-right: 4px solid #667eea;
        }
        .section h2 { color: #333; font-size: 18px; margin-bottom: 15px; }
        code {
            background: #2d2d2d;
            color: #f8f8f2;
            padding: 12px;
            border-radius: 5px;
            display: block;
            margin: 10px 0;
            overflow-x: auto;
            font-size: 13px;
        }
        .feature-list { list-style: none; margin: 15px 0; }
        .feature-list li {
            padding: 8px 0;
            display: flex;
            align-items: center;
            gap: 10px;
            color: #555;
        }
        .feature-list li:before {
            content: "✅";
            font-weight: bold;
            font-size: 18px;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            text-align: center;
            color: #999;
            font-size: 13px;
        }
        .badge {
            display: inline-block;
            background: #667eea;
            color: white;
            padding: 3px 10px;
            border-radius: 20px;
            font-size: 12px;
            margin: 0 5px;
        }
        .big-link {
            display: block;
            background: #667eea;
            color: white;
            padding: 15px;
            border-radius: 10px;
            text-align: center;
            text-decoration: none;
            font-size: 18px;
            margin: 20px 0;
        }
        .big-link:hover {
            background: #5a6fd6;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌍 الوكيل الشامل v4.0</h1>
        <div class="status">
            ✅ تصفح كامل | يدعم <span class="badge">يوتيوب</span> <span class="badge">فيسبوك</span> <span class="badge">تويتر</span> <span class="badge">إنستجرام</span> <span class="badge">تيك توك</span>
        </div>

        <a class="big-link" href="/api/stream?url=https://www.youtube.com">
            🎥 افتح يوتيوب الآن
        </a>

        <div class="section">
            <h2>📖 طريقة الاستخدام</h2>
            <code>/api/stream?url=https://www.youtube.com</code>
            <p style="margin-top: 10px; color: #666;">👆 افتح الرابط واتصفح يوتيوب كامل</p>
        </div>

        <div class="section">
            <h2>⚡ المواقع المدعومة</h2>
            <ul class="feature-list">
                <li>YouTube, YouTube Shorts (تصفح كامل)</li>
                <li>Facebook, Instagram, Twitter/X, TikTok</li>
                <li>أي موقع تاني تلقائي ✅</li>
            </ul>
        </div>

        <div class="footer">
            <p>🚀 تم البناء بـ ❤️ | v4.0 - وكيل تصفح كامل</p>
        </div>
    </div>
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
╔══════════════════════════════════════════════╗
║   🚀 الوكيل الشامل v4.0 شغال بنجاح        ║
║   📡 http://localhost:${port}                 ║
║   🌐 http://localhost:${port}/api/stream     ║
║   ✅ تصفح كامل لـ YouTube وجميع المواقع   ║
╚══════════════════════════════════════════════╝
    `);
});
