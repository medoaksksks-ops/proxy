const express = require('express');
const httpProxy = require('http-proxy');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const cheerio = require('cheerio');
const { URL } = require('url');
const http = require('http');
const https = require('https');
const { PassThrough } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// Create proxy instances
const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    followRedirects: true,
    timeout: 30000,
    proxyTimeout: 30000,
    ws: true
});

// Cache for processed pages
const cache = new Map();
const CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes

// ============================================
// Middleware
// ============================================
app.use(compression({ level: 6 }));
app.use(cookieParser());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ============================================
// Security Functions
// ============================================
function isValidURL(urlStr) {
    try {
        const url = new URL(urlStr);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function preventSSRF(urlStr) {
    try {
        const url = new URL(urlStr);
        const host = url.hostname.toLowerCase();
        
        if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || 
            host === '::1' || host.includes('internal')) {
            return false;
        }
        
        const parts = host.split('.');
        if (parts.length === 4 && parts.every(p => !isNaN(p))) {
            const [a, b] = [parseInt(parts[0]), parseInt(parts[1])];
            if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || 
                (a === 192 && b === 168)) {
                return false;
            }
        }
        
        return true;
    } catch {
        return false;
    }
}

function encodeURL(url) {
    return Buffer.from(url).toString('base64url');
}

function decodeURL(encoded) {
    try {
        return Buffer.from(encoded, 'base64url').toString('utf-8');
    } catch {
        return null;
    }
}

function rewriteURL(url, baseURL) {
    try {
        if (!url || url.startsWith('javascript:') || url.startsWith('data:') || 
            url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('#')) {
            return url;
        }

        let fullURL = url;
        if (url.startsWith('//')) {
            fullURL = 'https:' + url;
        } else if (url.startsWith('/')) {
            const base = new URL(baseURL);
            fullURL = `${base.protocol}//${base.host}${url}`;
        } else if (!url.startsWith('http')) {
            fullURL = new URL(url, baseURL).href;
        }

        if (!isValidURL(fullURL) || !preventSSRF(fullURL)) {
            return url;
        }

        return `/p/${encodeURL(fullURL)}`;
    } catch {
        return url;
    }
}

// ============================================
// HTML Rewriting
// ============================================
function rewriteHTML(html, baseURL) {
    try {
        const $ = cheerio.load(html, { decodeEntities: false });

        // Rewrite all links
        $('a').each((_, el) => {
            const href = $(el).attr('href');
            if (href) $(el).attr('href', rewriteURL(href, baseURL));
        });

        // Rewrite images
        $('img').each((_, el) => {
            const src = $(el).attr('src');
            const srcset = $(el).attr('srcset');
            if (src) $(el).attr('src', rewriteURL(src, baseURL));
            if (srcset) {
                const rewritten = srcset.split(',').map(s => {
                    const [url, desc] = s.trim().split(/\s+/);
                    return (rewriteURL(url, baseURL) + (desc ? ' ' + desc : '')).trim();
                }).join(', ');
                $(el).attr('srcset', rewritten);
            }
        });

        // Rewrite scripts
        $('script').each((_, el) => {
            const src = $(el).attr('src');
            if (src) $(el).attr('src', rewriteURL(src, baseURL));
            
            const content = $(el).html();
            if (content) {
                $(el).html(rewriteJS(content, baseURL));
            }
        });

        // Rewrite stylesheets
        $('link[rel="stylesheet"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href) $(el).attr('href', rewriteURL(href, baseURL));
        });

        // Rewrite iframes
        $('iframe').each((_, el) => {
            const src = $(el).attr('src');
            if (src) $(el).attr('src', rewriteURL(src, baseURL));
        });

        // Rewrite video/audio
        $('video, audio').each((_, el) => {
            const src = $(el).attr('src');
            if (src) $(el).attr('src', rewriteURL(src, baseURL));
        });

        $('video source, audio source').each((_, el) => {
            const src = $(el).attr('src');
            if (src) $(el).attr('src', rewriteURL(src, baseURL));
        });

        // Rewrite forms
        $('form').each((_, el) => {
            const action = $(el).attr('action');
            if (action) $(el).attr('action', rewriteURL(action, baseURL));
        });

        // Rewrite styles
        $('style').each((_, el) => {
            const content = $(el).html();
            if (content) {
                $(el).html(rewriteCSS(content, baseURL));
            }
        });

        // Rewrite style attributes
        $('[style]').each((_, el) => {
            const style = $(el).attr('style');
            if (style) {
                $(el).attr('style', rewriteCSS(style, baseURL));
            }
        });

        // Add base tag
        if (!$('base').length) {
            $('head').prepend(`<base href="${baseURL}">`);
        }

        // Inject proxy script
        $('head').append(`<script>${getClientScript(baseURL)}</script>`);

        return $.html();
    } catch (err) {
        console.error('HTML rewriting error:', err);
        return html;
    }
}

function rewriteCSS(css, baseURL) {
    return css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
        if (url.startsWith('data:')) return match;
        const rewritten = rewriteURL(url, baseURL);
        return `url('${rewritten}')`;
    });
}

function rewriteJS(js, baseURL) {
    try {
        // Rewrite fetch
        js = js.replace(/fetch\s*\(\s*['"`]([^'"`]+)['"`]/g, (m, url) => {
            const rewritten = rewriteURL(url, baseURL);
            return `fetch('${rewritten}'`;
        });

        // Rewrite XMLHttpRequest
        js = js.replace(/\.open\s*\(\s*['"]([A-Z]+)['"]\s*,\s*['"`]([^'"`]+)['"`]/g, (m, method, url) => {
            const rewritten = rewriteURL(url, baseURL);
            return `.open('${method}', '${rewritten}'`;
        });

        // Rewrite WebSocket
        js = js.replace(/new\s+WebSocket\s*\(\s*['"`]([^'"`]+)['"`]/g, (m, url) => {
            const wsURL = url.replace(/^https?/, url.startsWith('https') ? 'wss' : 'ws');
            const rewritten = rewriteURL(wsURL, baseURL);
            return `new WebSocket('${rewritten}'`;
        });

        // Rewrite EventSource
        js = js.replace(/new\s+EventSource\s*\(\s*['"`]([^'"`]+)['"`]/g, (m, url) => {
            const rewritten = rewriteURL(url, baseURL);
            return `new EventSource('${rewritten}'`;
        });

        // Rewrite import()
        js = js.replace(/import\s*\(\s*['"`]([^'"`]+)['"`]/g, (m, url) => {
            const rewritten = rewriteURL(url, baseURL);
            return `import('${rewritten}'`;
        });

        return js;
    } catch {
        return js;
    }
}

// ============================================
// Client-Side Script Injection
// ============================================
function getClientScript(baseURL) {
    return `
(function() {
    const baseURL = "${baseURL}";
    const baseOrigin = new URL(baseURL).origin;
    
    function proxyURL(url) {
        if (!url || typeof url !== 'string') return url;
        if (url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('mailto:') || 
            url.startsWith('tel:') || url.startsWith('#')) return url;
        
        try {
            let full = url;
            if (url.startsWith('//')) full = 'https:' + url;
            else if (url.startsWith('/')) full = new URL(url, baseURL).href;
            else if (!url.startsWith('http')) full = new URL(url, baseURL).href;
            
            if (full.startsWith('http') && !new URL(full).origin === baseOrigin) {
                return '/p/' + btoa(full).replace(/\\+/g, '-').replace(/\\//g, '_');
            }
        } catch(e) {}
        return url;
    }
    
    const origFetch = fetch;
    window.fetch = function(url, opts) {
        return origFetch(proxyURL(url), opts);
    };
    
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        return origOpen.call(this, method, proxyURL(url), ...args);
    };
    
    const OrigWS = WebSocket;
    window.WebSocket = class extends OrigWS {
        constructor(url, protocols) {
            const wsURL = url.replace(/^https?/, url.startsWith('https') ? 'wss' : 'ws');
            super(proxyURL(wsURL), protocols);
        }
    };
    
    const OrigES = EventSource;
    window.EventSource = class extends OrigES {
        constructor(url, opts) {
            super(proxyURL(url), opts);
        }
    };
    
    const origPush = history.pushState;
    history.pushState = function(s, t, u) {
        return origPush.call(this, s, t, proxyURL(u));
    };
    
    const origReplace = history.replaceState;
    history.replaceState = function(s, t, u) {
        return origReplace.call(this, s, t, proxyURL(u));
    };
    
    document.addEventListener('click', e => {
        const a = e.target.closest('a[href]');
        if (a && !a.href.startsWith('javascript:')) {
            e.preventDefault();
            window.location.href = proxyURL(a.href);
        }
    }, true);
    
    document.addEventListener('submit', e => {
        const form = e.target;
        const action = form.action || baseURL;
        if (action && !action.startsWith('javascript:')) {
            e.preventDefault();
            const method = (form.method || 'GET').toUpperCase();
            const proxy = proxyURL(action);
            if (method === 'GET') {
                window.location.href = proxy + (proxy.includes('?') ? '&' : '?') + new URLSearchParams(new FormData(form));
            } else {
                form.action = proxy;
                form.submit();
            }
        }
    }, true);
})();
`;
}

// ============================================
// Routes
// ============================================
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>⚡ Proxy Browser Pro</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
            color: #f1f5f9;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        
        .navbar {
            background: rgba(30, 41, 59, 0.9);
            backdrop-filter: blur(10px);
            border-bottom: 1px solid #334155;
            padding: 12px 20px;
            display: flex;
            gap: 12px;
            align-items: center;
            flex-shrink: 0;
            z-index: 1000;
        }
        
        .nav-btn {
            width: 36px;
            height: 36px;
            border: 1px solid #334155;
            background: #0f172a;
            color: #f1f5f9;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .nav-btn:hover:not(:disabled) {
            background: #3b82f6;
            border-color: #3b82f6;
        }
        
        .nav-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .url-bar {
            flex: 1;
            display: flex;
            gap: 8px;
        }
        
        .url-bar input {
            flex: 1;
            padding: 10px 16px;
            border: 1px solid #334155;
            background: #0f172a;
            color: #f1f5f9;
            border-radius: 6px;
            font-size: 14px;
        }
        
        .url-bar input:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }
        
        .go-btn {
            padding: 10px 24px;
            background: #3b82f6;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
        }
        
        .go-btn:hover {
            background: #1e40af;
        }
        
        .content {
            flex: 1;
            display: flex;
            overflow: hidden;
        }
        
        iframe {
            width: 100%;
            height: 100%;
            border: none;
        }
        
        .welcome {
            flex: 1;
            overflow-y: auto;
            padding: 40px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
        }
        
        .welcome h1 {
            font-size: 48px;
            margin-bottom: 16px;
            background: linear-gradient(135deg, #3b82f6, #06b6d4);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        
        .welcome p {
            font-size: 16px;
            color: #cbd5e1;
            margin-bottom: 40px;
        }
        
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 16px;
            max-width: 900px;
            width: 100%;
        }
        
        .card {
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(6, 182, 212, 0.1));
            border: 1px solid #334155;
            border-radius: 8px;
            padding: 20px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s;
        }
        
        .card:hover {
            border-color: #3b82f6;
            transform: translateY(-4px);
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(6, 182, 212, 0.2));
        }
        
        .card-icon { font-size: 40px; margin-bottom: 8px; }
        .card-name { font-size: 12px; font-weight: 600; }
        
        .loading { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); }
        .loading.show { display: block; }
        .spinner { 
            width: 40px;
            height: 40px;
            border: 4px solid #334155;
            border-top: 4px solid #3b82f6;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .error {
            display: none;
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #ef4444;
            color: white;
            padding: 16px;
            border-radius: 6px;
            z-index: 2000;
        }
        .error.show { display: block; }
        
        @media (max-width: 768px) {
            .navbar { flex-wrap: wrap; }
            .url-bar { width: 100%; order: 2; }
            .welcome h1 { font-size: 32px; }
            .grid { grid-template-columns: repeat(3, 1fr); }
        }
    </style>
</head>
<body>
    <div class="navbar">
        <div style="display:flex;gap:6px">
            <button class="nav-btn" id="back" title="Back">←</button>
            <button class="nav-btn" id="fwd" title="Forward">→</button>
            <button class="nav-btn" id="ref" title="Refresh">⟳</button>
            <button class="nav-btn" id="home" title="Home">⌂</button>
        </div>
        <div class="url-bar">
            <input type="text" id="url" placeholder="https://youtube.com" spellcheck="false" />
            <button class="go-btn" id="go">GO</button>
        </div>
    </div>
    
    <div class="content">
        <div class="welcome" id="welcome">
            <h1>⚡ Proxy Browser Pro</h1>
            <p>Fast anonymous browsing of any website</p>
            <div class="grid">
                <div class="card" data-url="https://www.youtube.com"><div class="card-icon">📹</div><div class="card-name">YouTube</div></div>
                <div class="card" data-url="https://www.facebook.com"><div class="card-icon">👥</div><div class="card-name">Facebook</div></div>
                <div class="card" data-url="https://www.tiktok.com"><div class="card-icon">🎬</div><div class="card-name">TikTok</div></div>
                <div class="card" data-url="https://www.instagram.com"><div class="card-icon">📸</div><div class="card-name">Instagram</div></div>
                <div class="card" data-url="https://x.com"><div class="card-icon">𝕏</div><div class="card-name">X</div></div>
                <div class="card" data-url="https://www.reddit.com"><div class="card-icon">🔗</div><div class="card-name">Reddit</div></div>
                <div class="card" data-url="https://www.wikipedia.org"><div class="card-icon">📖</div><div class="card-name">Wiki</div></div>
                <div class="card" data-url="https://www.google.com"><div class="card-icon">🔍</div><div class="card-name">Google</div></div>
                <div class="card" data-url="https://www.github.com"><div class="card-icon">💻</div><div class="card-name">GitHub</div></div>
            </div>
        </div>
        <iframe id="frame"></iframe>
    </div>
    
    <div class="loading" id="loading"><div class="spinner"></div></div>
    <div class="error" id="error"></div>
    
    <script>
        const urlInput = document.getElementById('url');
        const frame = document.getElementById('frame');
        const welcome = document.getElementById('welcome');
        const loading = document.getElementById('loading');
        const error = document.getElementById('error');
        
        let history = [];
        let idx = -1;
        
        function norm(u) {
            u = u.trim();
            if (!u.startsWith('http')) u = 'https://' + u;
            return u;
        }
        
        function enc(u) {
            return btoa(u).replace(/\\+/g, '-').replace(/\\//g, '_');
        }
        
        function load(u) {
            u = norm(u);
            if (!u.startsWith('http')) {
                error.textContent = 'Invalid URL';
                error.classList.add('show');
                setTimeout(() => error.classList.remove('show'), 3000);
                return;
            }
            
            if (idx > -1 && history[idx] !== u) history = history.slice(0, idx + 1);
            history.push(u);
            idx = history.length - 1;
            
            urlInput.value = u;
            welcome.style.display = 'none';
            frame.style.display = 'block';
            loading.classList.add('show');
            
            frame.src = '/p/' + enc(u);
            
            document.getElementById('back').disabled = idx === 0;
            document.getElementById('fwd').disabled = idx === history.length - 1;
        }
        
        document.getElementById('go').addEventListener('click', () => load(urlInput.value));
        urlInput.addEventListener('keypress', e => e.key === 'Enter' && load(urlInput.value));
        
        document.getElementById('back').addEventListener('click', () => idx > 0 && load(history[--idx]));
        document.getElementById('fwd').addEventListener('click', () => idx < history.length - 1 && load(history[++idx]));
        document.getElementById('ref').addEventListener('click', () => frame.src = frame.src);
        document.getElementById('home').addEventListener('click', () => {
            welcome.style.display = 'flex';
            frame.style.display = 'none';
            urlInput.value = '';
        });
        
        document.querySelectorAll('.card').forEach(card => {
            card.addEventListener('click', () => load(card.dataset.url));
        });
        
        frame.addEventListener('load', () => loading.classList.remove('show'));
        frame.addEventListener('error', () => loading.classList.remove('show'));
        
        urlInput.focus();
    </script>
</body>
</html>`);
});

// ============================================
// Proxy Route - Main Handler
// ============================================
app.all('/p/:encoded(*)', (req, res, next) => {
    const encoded = req.params.encoded;
    const targetURL = decodeURL(encoded);

    if (!targetURL || !isValidURL(targetURL) || !preventSSRF(targetURL)) {
        return res.status(403).send('Access denied');
    }

    // Add query string if present
    const fullURL = req.url.includes('?') 
        ? targetURL + '?' + req.url.split('?')[1]
        : targetURL;

    console.log(`[PROXY] ${req.method} ${fullURL}`);

    const proxyReq = proxy.web(req, res, {
        target: fullURL,
        changeOrigin: true,
        followRedirects: true,
        ws: false,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
    }, (err) => {
        if (err) {
            console.error('[PROXY ERROR]', err.message);
            res.status(500).send('Proxy error');
        }
    });

    // Intercept and rewrite response
    const originalWrite = res.write;
    const originalEnd = res.end;
    let chunks = [];
    let isHTML = false;

    res.write = function(chunk) {
        if (!isHTML && typeof chunk === 'string') {
            chunks.push(chunk);
        } else if (Buffer.isBuffer(chunk)) {
            chunks.push(chunk);
        }
        return this;
    };

    res.end = function(chunk) {
        if (chunk) chunks.push(chunk);

        const contentType = res.get('content-type') || '';
        isHTML = contentType.includes('text/html');

        if (isHTML && chunks.length > 0) {
            const content = chunks.map(c => typeof c === 'string' ? c : c.toString()).join('');
            const rewritten = rewriteHTML(content, targetURL);
            
            originalWrite.call(res, rewritten);
        } else if (chunks.length > 0) {
            chunks.forEach(c => originalWrite.call(res, c));
        }

        originalEnd.call(res);
    };
});

// WebSocket support
const server = http.createServer(app);
server.on('upgrade', (req, res, head) => {
    const urlMatch = req.url.match(/^\/p\/([A-Za-z0-9_-]+)/);
    if (!urlMatch) {
        res.writeHead(404);
        res.end();
        return;
    }

    const encoded = urlMatch[1];
    const targetURL = decodeURL(encoded);

    if (!targetURL || !isValidURL(targetURL) || !preventSSRF(targetURL)) {
        res.writeHead(403);
        res.end();
        return;
    }

    const wsURL = targetURL.replace(/^https?/, targetURL.startsWith('https') ? 'wss' : 'ws');
    proxy.ws(req, res, head, { target: wsURL, changeOrigin: true }, (err) => {
        console.error('[WS ERROR]', err);
    });
});

// ============================================
// Error Handling
// ============================================
proxy.on('error', (err, req, res) => {
    console.error('[PROXY ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Proxy error');
});

app.use((err, req, res, next) => {
    console.error('[ERROR]', err);
    res.status(500).send('Server error');
});

app.use((req, res) => {
    res.status(404).send('Not found');
});

// ============================================
// Start Server
// ============================================
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════╗
║  ⚡ Proxy Browser Pro                  ║
║  🚀 http://localhost:${PORT}           ║
║  ✅ YouTube, TikTok, Instagram Ready  ║
║  🔒 Full HTML/CSS/JS Rewriting        ║
║  ⚡ Ultra Fast Streaming              ║
╚════════════════════════════════════════╝
    `);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
