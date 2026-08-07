const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { URL } = require('url');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// ================================================================
//  إعدادات
// ================================================================
const CONFIG = {
    proxyBase: '/proxy',
    timeout: 60000,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

// ================================================================
//  جلب مع دعم Range للفيديو
// ================================================================
async function fetchWithRange(url, reqHeaders = {}) {
    try {
        const headers = {
            'User-Agent': CONFIG.userAgent,
            'Accept': '*/*',
            'Accept-Language': 'ar-EG,ar;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Range': reqHeaders.range || 'bytes=0-'
        };

        // حذف الرؤوس المزعجة
        delete headers['host'];
        delete headers['connection'];

        const response = await fetch(url, {
            method: 'GET',
            headers: headers,
            timeout: CONFIG.timeout,
            redirect: 'follow'
        });

        if (!response.ok) {
            return null;
        }

        const buffer = await response.buffer();
        const contentType = response.headers.get('content-type') || 'video/mp4';
        
        return {
            data: buffer,
            contentType: contentType,
            headers: Object.fromEntries(response.headers),
            statusCode: response.status
        };

    } catch (error) {
        console.error('[FETCH ERROR]', error.message);
        return null;
    }
}

// ================================================================
//  جلب HTML عادي
// ================================================================
async function fetchHTML(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': CONFIG.userAgent,
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'ar-EG,ar;q=0.9'
            },
            timeout: CONFIG.timeout
        });

        if (!response.ok) return null;
        return await response.text();
    } catch {
        return null;
    }
}

// ================================================================
//  جلب الموارد (CSS, JS, صور)
// ================================================================
async function fetchResource(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': CONFIG.userAgent,
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br'
            },
            timeout: CONFIG.timeout
        });

        if (!response.ok) return null;
        const buffer = await response.buffer();
        return {
            data: buffer,
            contentType: response.headers.get('content-type') || 'application/octet-stream'
        };
    } catch {
        return null;
    }
}

// ================================================================
//  إعادة كتابة الروابط
// ================================================================
function rewriteLinks(html, baseUrl) {
    let rewritten = html;

    // إعادة كتابة الروابط عشان تمر من البروكسي
    rewritten = rewritten.replace(/(src|href|data-src|poster)\s*=\s*["']([^"']*)["']/gi, (match, attr, url) => {
        if (!url || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('data:')) {
            return match;
        }
        try {
            const absoluteUrl = new URL(url, baseUrl).href;
            // لو الرابط ده فيديو من يوتيوب
            if (absoluteUrl.includes('googlevideo.com') || absoluteUrl.includes('video')) {
                return `${attr}="${CONFIG.proxyBase}?url=${encodeURIComponent(absoluteUrl)}"`;
            }
            return `${attr}="${CONFIG.proxyBase}?url=${encodeURIComponent(absoluteUrl)}"`;
        } catch {
            return match;
        }
    });

    // إضافة سكربت اعتراض
    const script = `
    <script>
    (function() {
        if (window.__PROXY_INTERCEPTED) return;
        window.__PROXY_INTERCEPTED = true;
        
        window.PROXY_BASE = '${CONFIG.proxyBase}';
        window.ORIGINAL_URL = '${baseUrl}';

        function rewriteUrl(url) {
            if (!url || typeof url !== 'string') return url;
            if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('javascript:')) return url;
            if (url.includes(window.PROXY_BASE)) return url;
            try {
                const absolute = new URL(url, window.ORIGINAL_URL).href;
                return window.PROXY_BASE + '?url=' + encodeURIComponent(absolute);
            } catch (e) {
                return url;
            }
        }

        // اعتراض fetch
        const origFetch = window.fetch;
        window.fetch = function(resource, options) {
            let url = typeof resource === 'string' ? resource : (resource.url || '');
            if (url && typeof url === 'string') {
                url = rewriteUrl(url);
            }
            if (typeof resource === 'string') {
                resource = url;
            } else if (resource && typeof resource === 'object') {
                resource = new Request(url, resource);
            }
            return origFetch.call(this, resource, options);
        };

        // اعتراض XMLHttpRequest
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
            if (url && typeof url === 'string') {
                url = rewriteUrl(url);
            }
            return origOpen.call(this, method, url, ...args);
        };

        // مراقبة التغييرات
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        ['src', 'href', 'data-src', 'poster'].forEach(attr => {
                            if (node.hasAttribute(attr)) {
                                const val = node.getAttribute(attr);
                                if (val && typeof val === 'string') {
                                    node.setAttribute(attr, rewriteUrl(val));
                                }
                            }
                        });
                    }
                }
            }
        });
        observer.observe(document, { childList: true, subtree: true });

        // تصحيح الروابط الموجودة
        document.querySelectorAll('[src], [href], [data-src], [poster]').forEach(el => {
            ['src', 'href', 'data-src', 'poster'].forEach(attr => {
                if (el.hasAttribute(attr)) {
                    const val = el.getAttribute(attr);
                    if (val && typeof val === 'string') {
                        el.setAttribute(attr, rewriteUrl(val));
                    }
                }
            });
        });

        console.log('[PROXY] ✅ Interception loaded');
    })();
    </script>
    `;

    rewritten = rewritten.replace('</head>', script + '</head>');
    if (!rewritten.includes('</head>')) {
        rewritten = rewritten.replace('</body>', script + '</body>');
    }

    return rewritten;
}

// ================================================================
//  المعالج الرئيسي
// ================================================================
app.all('/proxy', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('⚠️ مطلوب رابط');
    }

    try {
        new URL(targetUrl);
    } catch {
        return res.status(400).send('⚠️ رابط غير صحيح');
    }

    // استجابة OPTIONS
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        return res.sendStatus(200);
    }

    try {
        const urlObj = new URL(targetUrl);
        console.log(`[📡] ${req.method} ${urlObj.hostname}${urlObj.pathname.substring(0, 30)}...`);

        // ============================================================
        //  معالجة فيديوهات يوتيوب (googlevideo.com)
        // ============================================================
        if (targetUrl.includes('googlevideo.com')) {
            console.log('[🎬] جاري تحميل الفيديو...');
            
            const result = await fetchWithRange(targetUrl, req.headers);
            if (!result) {
                return res.status(404).send('فشل تحميل الفيديو');
            }

            // رؤوس الفيديو
            res.setHeader('Content-Type', result.contentType);
            res.setHeader('Content-Length', result.data.length);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');
            
            // دعم التحميل التدريجي (Range)
            const rangeHeader = req.headers.range;
            if (rangeHeader) {
                const parts = rangeHeader.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : result.data.length - 1;
                const chunkSize = end - start + 1;
                const chunk = result.data.slice(start, end + 1);
                
                res.status(206);
                res.setHeader('Content-Range', `bytes ${start}-${end}/${result.data.length}`);
                res.setHeader('Content-Length', chunkSize);
                return res.send(chunk);
            }

            return res.send(result.data);
        }

        // ============================================================
        //  معالجة صفحات يوتيوب (HTML)
        // ============================================================
        if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
            console.log('[📄] جاري تحميل صفحة يوتيوب...');
            
            const html = await fetchHTML(targetUrl);
            if (!html) {
                return res.status(404).send('فشل تحميل الصفحة');
            }

            // إعادة كتابة الروابط
            const rewrittenHtml = rewriteLinks(html, targetUrl);
            
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(rewrittenHtml);
        }

        // ============================================================
        //  معالجة الموارد الأخرى (CSS, JS, صور)
        // ============================================================
        const resource = await fetchResource(targetUrl);
        if (!resource) {
            return res.status(404).send('تعذر تحميل المورد');
        }

        res.setHeader('Content-Type', resource.contentType);
        res.setHeader('Content-Length', resource.data.length);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(resource.data);

    } catch (error) {
        console.error('[❌]', error.message);
        res.status(500).send('خطأ في الخادم: ' + error.message);
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
        <title>بروكسي يوتيوب</title>
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
                max-width: 550px;
                width: 100%;
                text-align: center;
                background: #131519;
                padding: 40px;
                border-radius: 16px;
                border: 1px solid #2a2a2a;
            }
            h1 { font-size: 32px; color: #e8c96a; margin-bottom: 8px; }
            p { color: #8a8f98; margin-bottom: 25px; }
            input {
                width: 100%;
                padding: 14px 18px;
                border-radius: 10px;
                border: 1px solid #2a2a2a;
                background: #0a0b0d;
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
            .examples {
                margin-top: 20px;
                font-size: 13px;
                color: #555;
                text-align: right;
                line-height: 2;
                padding: 15px;
                background: #0a0b0d;
                border-radius: 10px;
            }
            .examples strong { color: #e8c96a; }
            .examples code {
                background: #1a1a1a;
                padding: 2px 8px;
                border-radius: 4px;
                color: #e8c96a;
                font-size: 12px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎬 بروكسي يوتيوب</h1>
            <p>شوف أي فيديو من غير حظر</p>
            <input type="text" id="urlInput" placeholder="https://www.youtube.com/watch?v=..." dir="ltr">
            <button onclick="go()">▶ تشغيل</button>
            <div class="examples">
                <strong>📌 طرق الاستخدام:</strong><br>
                • <code>https://youtube.com/watch?v=dQw4w9WgXcQ</code><br>
                • <code>https://youtu.be/dQw4w9WgXcQ</code><br>
                • <code>dQw4w9WgXcQ</code> (ID الفيديو بس)
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
    console.log(`
╔══════════════════════════════════════════════════╗
║   🎬  بروكسي يوتيوب v3.0                       ║
║                                                ║
║   http://localhost:${PORT}                      ║
║                                                ║
║   ✅ جاهز لتشغيل الفيديوهات                    ║
╚══════════════════════════════════════════════════╝
    `);
});

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});
