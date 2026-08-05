const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const http = require('http');
const https = require('https');

const app = express();
app.use(cors());

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256 });

function getAgent(url) {
    return url.startsWith('https') ? httpsAgent : httpAgent;
}

function getHeaders(url) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'ar-EG,ar;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    };

    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;

        if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
            headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
            headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
            headers['Sec-Fetch-Site'] = 'none';
            headers['Sec-Fetch-Mode'] = 'navigate';
            headers['Sec-Fetch-User'] = '?1';
            headers['Upgrade-Insecure-Requests'] = '1';
        } else if (hostname.includes('facebook.com')) {
            headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
            headers['Sec-Fetch-Site'] = 'none';
            headers['Sec-Fetch-Mode'] = 'navigate';
        } else if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
            headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
        } else if (hostname.includes('instagram.com')) {
            headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
            headers['Sec-Fetch-Site'] = 'none';
        } else if (hostname.includes('tiktok.com')) {
            headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
        } else {
            headers['Origin'] = `https://${hostname}`;
            headers['Referer'] = `https://${hostname}/`;
        }

        if (hostname.includes('360-sport') || hostname.includes('kora-yalla')) {
            headers['Origin'] = 'https://y2.sites10.top';
            headers['Referer'] = 'https://y2.sites10.top/';
        }

        if (hostname.includes('vertyuz')) {
            const match = urlObj.pathname.match(/ch(\d+)/i);
            const channel = match ? match[1] : '1';
            headers['Origin'] = 'https://tv.vertyuz.xyz';
            headers['Referer'] = `https://tv.vertyuz.xyz/ch${channel}.php`;
        }

    } catch (e) {
        console.warn('⚠️ خطأ:', e.message);
    }

    return headers;
}

app.get('/api/stream', async (req, res) => {
    const urlMatch = req.query.url;

    if (!urlMatch) {
        return res.status(400).json({ 
            error: '❌ مطلوب رابط',
            example: '/api/stream?url=https://www.youtube.com/watch?v=VIDEO_ID'
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
            signal: abortController.signal
        });

        if (!response.ok) {
            return res.status(response.status).json({ 
                error: `HTTP ${response.status}` 
            });
        }

        const contentType = response.headers.get('content-type') || 'text/html';
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
        res.setHeader('Content-Type', contentType);

        const contentLength = response.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);

        response.body.pipe(res);

        response.body.on('error', (err) => {
            console.error('❌ خطأ:', err.message);
            if (!res.headersSent) res.status(502).end();
            else res.end();
        });

    } catch (error) {
        if (error.name === 'AbortError' || abortController.signal.aborted) {
            return;
        }
        console.error('❌ خطأ:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Proxy Error', message: error.message });
        }
    }
});

app.get('/', (req, res) => {
    res.type('text/html').send(`
        <!DOCTYPE html>
        <html dir="rtl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>🚀 الوكيل الشامل</title>
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
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🌍 الوكيل الشامل</h1>
                <div class="status">
                    ✅ السيرفر شغال | يدعم <span class="badge">يوتيوب</span> <span class="badge">فيسبوك</span> <span class="badge">تويتر</span> <span class="badge">إنستجرام</span> <span class="badge">تيك توك</span>
                </div>
                <div class="section">
                    <h2>📖 طريقة الاستخدام</h2>
                    <code>GET /api/stream?url=https://www.youtube.com/watch?v=VIDEO_ID</code>
                </div>
                <div class="footer"><p>🚀 v2.0</p></div>
            </div>
        </body>
        </html>
    `);
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 شغال على http://localhost:${port}`);
});
