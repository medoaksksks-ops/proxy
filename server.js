const express = require('express');
const httpProxy = require('http-proxy');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const { URL } = require('url');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();

// ============================================
// Configuration
// ============================================
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const PROXY_PREFIX = '/b';

// Session storage
const sessions = new Map();
const sessionCookies = new Map();

// Blocked domains (SSRF protection)
const BLOCKED_DOMAINS = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    'internal',
    'private'
];

// Unsafe headers to remove
const UNSAFE_HEADERS = [
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'x-content-type-options',
    'x-xss-protection',
    'strict-transport-security',
    'referrer-policy',
    'permissions-policy',
    'cross-origin-embedder-policy',
    'cross-origin-opener-policy',
    'cross-origin-resource-policy',
    'set-cookie'
];

// ============================================
// Middleware Setup
// ============================================
app.use(compression());
app.use(cookieParser());
app.use(bodyParser.raw({ type: '*/*', limit: '100mb' }));
app.use(bodyParser.text({ limit: '100mb' }));
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ============================================
// Utility Functions
// ============================================
function isValidURL(urlString) {
    try {
        const url = new URL(urlString);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (err) {
        return false;
    }
}

function preventSSRF(urlString) {
    try {
        const url = new URL(urlString);
        const hostname = url.hostname.toLowerCase();
        
        for (const blocked of BLOCKED_DOMAINS) {
            if (hostname.includes(blocked)) {
                return false;
            }
        }
        
        // Block private IP ranges
        const parts = hostname.split('.');
        if (parts.length === 4 && parts.every(p => !isNaN(p))) {
            const [a, b] = [parseInt(parts[0]), parseInt(parts[1])];
            if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || 
                (a === 192 && b === 168) || a === 0) {
                return false;
            }
        }
        
        return true;
    } catch (err) {
        return false;
    }
}

function encodeURL(url) {
    return Buffer.from(url).toString('base64url');
}

function decodeURL(encoded) {
    try {
        return Buffer.from(encoded, 'base64url').toString('utf-8');
    } catch (err) {
        return null;
    }
}

function rewriteURL(originalURL, baseURL) {
    try {
        let absoluteURL = originalURL;
        
        if (originalURL.startsWith('javascript:') || originalURL.startsWith('mailto:') || 
            originalURL.startsWith('tel:') || originalURL.startsWith('data:') ||
            originalURL.startsWith('#')) {
            return originalURL;
        }
        
        if (originalURL.startsWith('//')) {
            absoluteURL = 'https:' + originalURL;
        } else if (originalURL.startsWith('/')) {
            const baseObj = new URL(baseURL);
            absoluteURL = `${baseObj.protocol}//${baseObj.host}${originalURL}`;
        } else if (!originalURL.startsWith('http://') && !originalURL.startsWith('https://')) {
            try {
                absoluteURL = new URL(originalURL, baseURL).toString();
            } catch (err) {
                return null;
            }
        }
        
        if (!isValidURL(absoluteURL) || !preventSSRF(absoluteURL)) {
            return null;
        }
        
        return `${PROXY_PREFIX}/${encodeURL(absoluteURL)}`;
    } catch (err) {
        return null;
    }
}

function rewriteHTML(html, baseURL) {
    try {
        // Rewrite standard attributes
        html = html.replace(/\b(href|src|action|data|poster|manifest)=["']([^"']*?)["']/gi, (match, attr, url) => {
            if (!url || url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('#') || 
                url.startsWith('mailto:') || url.startsWith('tel:')) {
                return match;
            }
            const rewritten = rewriteURL(url, baseURL);
            return rewritten ? `${attr}="${rewritten}"` : match;
        });

        // Rewrite srcset
        html = html.replace(/srcset=["']([^"']*?)["']/gi, (match, srcset) => {
            const rewritten = srcset.split(',').map(src => {
                const parts = src.trim().split(/\s+/);
                const url = parts[0];
                const descriptor = parts.slice(1).join(' ');
                const newURL = rewriteURL(url, baseURL);
                return newURL ? (descriptor ? `${newURL} ${descriptor}` : newURL) : url;
            }).join(', ');
            return `srcset="${rewritten}"`;
        });

        // Rewrite inline styles
        html = html.replace(/style=["']([^"']*?)["']/gi, (match, styles) => {
            const rewritten = rewriteCSS(styles, baseURL);
            return `style="${rewritten}"`;
        });

        // Rewrite <style> tags content
        html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, content) => {
            const rewritten = rewriteCSS(content, baseURL);
            return match.replace(content, rewritten);
        });

        // Rewrite <script> tags content
        html = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (match, content) => {
            const rewritten = rewriteJavaScript(content, baseURL);
            return match.replace(content, rewritten);
        });

        // Add base tag if not present
        if (!html.includes('<base ')) {
            html = html.replace(/<head[^>]*>/i, (match) => {
                return match + `<base href="${baseURL}">`;
            });
        }

        return html;
    } catch (err) {
        console.error('HTML rewriting error:', err);
        return html;
    }
}

function rewriteCSS(css, baseURL) {
    try {
        return css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, url) => {
            if (url.startsWith('data:') || url.startsWith('javascript:')) {
                return match;
            }
            const rewritten = rewriteURL(url, baseURL);
            return rewritten ? `url('${rewritten}')` : match;
        });
    } catch (err) {
        return css;
    }
}

function rewriteJavaScript(js, baseURL) {
    try {
        // Rewrite fetch calls
        js = js.replace(/fetch\s*\(\s*['"`]([^'"`]+)['"`]/g, (match, url) => {
            if (url.startsWith('data:') || url.startsWith('javascript:')) {
                return match;
            }
            const rewritten = rewriteURL(url, baseURL);
            return rewritten ? `fetch('${rewritten}'` : match;
        });

        // Rewrite XMLHttpRequest.open
        js = js.replace(/\.open\s*\(\s*['"]([A-Z]+)['"]\s*,\s*['"`]([^'"`]+)['"`]/g, (match, method, url) => {
            if (url.startsWith('data:') || url.startsWith('javascript:')) {
                return match;
            }
            const rewritten = rewriteURL(url, baseURL);
            return rewritten ? `.open('${method}', '${rewritten}'` : match;
        });

        // Rewrite WebSocket
        js = js.replace(/new\s+WebSocket\s*\(\s*['"`]([^'"`]+)['"`]/g, (match, url) => {
            const wsURL = url.replace(/^https?:/, 'wss:').replace(/^http:/, 'ws:');
            const rewritten = rewriteURL(wsURL, baseURL);
            return rewritten ? `new WebSocket('${rewritten}'` : match;
        });

        // Rewrite EventSource
        js = js.replace(/new\s+EventSource\s*\(\s*['"`]([^'"`]+)['"`]/g, (match, url) => {
            if (url.startsWith('data:') || url.startsWith('javascript:')) {
                return match;
            }
            const rewritten = rewriteURL(url, baseURL);
            return rewritten ? `new EventSource('${rewritten}'` : match;
        });

        // Rewrite import()
        js = js.replace(/import\s*\(\s*['"`]([^'"`]+)['"`]/g, (match, url) => {
            if (url.startsWith('data:') || url.startsWith('javascript:')) {
                return match;
            }
            const rewritten = rewriteURL(url, baseURL);
            return rewritten ? `import('${rewritten}'` : match;
        });

        return js;
    } catch (err) {
        return js;
    }
}

const CLIENT_INJECTION = `
<script>
(function() {
    const baseURLMatch = window.location.pathname.match(/\\/b\\/([A-Za-z0-9_-]+)/);
    if (!baseURLMatch) return;
    
    const targetURL = atob(baseURLMatch[1].replace(/-/g, '+').replace(/_/g, '/'));
    const targetOrigin = new URL(targetURL).origin;
    
    function rewriteProxyURL(url) {
        if (!url || typeof url !== 'string') return url;
        if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('mailto:') || 
            url.startsWith('tel:') || url.startsWith('#')) {
            return url;
        }
        try {
            let absoluteURL = url;
            if (url.startsWith('//')) {
                absoluteURL = 'https:' + url;
            } else if (url.startsWith('/')) {
                absoluteURL = new URL(url, targetURL).href;
            } else if (!url.startsWith('http')) {
                absoluteURL = new URL(url, targetURL).href;
            }
            if (absoluteURL.startsWith('http') && !absoluteURL.includes(targetOrigin)) {
                return '/b/' + btoa(absoluteURL).replace(/\\+/g, '-').replace(/\\//g, '_');
            }
        } catch (e) {}
        return url;
    }
    
    // Patch fetch
    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        const proxyURL = rewriteProxyURL(url);
        return originalFetch.call(this, proxyURL, options);
    };
    
    // Patch XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        const proxyURL = rewriteProxyURL(url);
        return originalOpen.call(this, method, proxyURL, ...args);
    };
    
    // Patch WebSocket
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = class extends OriginalWebSocket {
        constructor(url, protocols) {
            const wsURL = url.replace(/^https?:/, 'wss:').replace(/^http:/, 'ws:');
            const proxyURL = rewriteProxyURL(wsURL);
            super(proxyURL, protocols);
        }
    };
    
    // Patch EventSource
    const OriginalEventSource = window.EventSource;
    window.EventSource = class extends OriginalEventSource {
        constructor(url, options) {
            const proxyURL = rewriteProxyURL(url);
            super(proxyURL, options);
        }
    };
    
    // Patch history
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    
    window.history.pushState = function(state, title, url) {
        const proxyURL = rewriteProxyURL(url);
        return originalPushState.call(this, state, title, proxyURL);
    };
    
    window.history.replaceState = function(state, title, url) {
        const proxyURL = rewriteProxyURL(url);
        return originalReplaceState.call(this, state, title, proxyURL);
    };
    
    // Patch location
    Object.defineProperty(window.location, 'href', {
        set: function(value) {
            window.location.href = rewriteProxyURL(value);
        }
    });
    
    // Intercept link clicks
    document.addEventListener('click', function(e) {
        const link = e.target.closest('a[href]');
        if (link) {
            e.preventDefault();
            const href = link.getAttribute('href');
            if (!href.startsWith('javascript:') && !href.startsWith('mailto:')) {
                window.location.href = rewriteProxyURL(href);
            }
        }
    }, true);
    
    // Intercept form submissions
    document.addEventListener('submit', function(e) {
        const form = e.target;
        const action = form.getAttribute('action') || targetURL;
        if (action && !action.startsWith('javascript:')) {
            e.preventDefault();
            const proxyAction = rewriteProxyURL(action);
            const method = (form.getAttribute('method') || 'GET').toUpperCase();
            
            if (method === 'GET') {
                const formData = new FormData(form);
                const params = new URLSearchParams(formData);
                window.location.href = proxyAction + (proxyAction.includes('?') ? '&' : '?') + params.toString();
            } else {
                form.setAttribute('action', proxyAction);
                form.submit();
            }
        }
    }, true);
})();
</script>
`;

// ============================================
// Routes - Home Page
// ============================================
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxy Browser - Browse Anonymously</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --primary: #3b82f6;
            --primary-dark: #1e40af;
            --bg: #0f172a;
            --bg-secondary: #1e293b;
            --border: #334155;
            --text: #f1f5f9;
            --text-secondary: #cbd5e1;
        }

        html, body {
            width: 100%;
            height: 100%;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, var(--bg) 0%, var(--bg-secondary) 100%);
            color: var(--text);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .navbar {
            background: rgba(30, 41, 59, 0.8);
            backdrop-filter: blur(10px);
            border-bottom: 1px solid var(--border);
            padding: 12px 20px;
            display: flex;
            gap: 12px;
            align-items: center;
            flex-shrink: 0;
            z-index: 1000;
        }

        .nav-buttons {
            display: flex;
            gap: 6px;
        }

        .nav-btn {
            width: 36px;
            height: 36px;
            border: 1px solid var(--border);
            background: var(--bg);
            color: var(--text);
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .nav-btn:hover:not(:disabled) {
            background: var(--primary);
            border-color: var(--primary);
        }

        .nav-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .url-bar {
            flex: 1;
            display: flex;
            gap: 8px;
            min-width: 200px;
        }

        .url-bar input {
            flex: 1;
            padding: 10px 16px;
            border: 1px solid var(--border);
            background: var(--bg);
            color: var(--text);
            border-radius: 6px;
            font-size: 14px;
            transition: all 0.2s;
        }

        .url-bar input:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .url-bar input::placeholder {
            color: var(--text-secondary);
        }

        .go-btn {
            padding: 10px 24px;
            background: var(--primary);
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
            font-size: 14px;
            transition: all 0.2s;
        }

        .go-btn:hover {
            background: var(--primary-dark);
        }

        .go-btn:active {
            transform: scale(0.98);
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
            background: white;
        }

        .welcome {
            flex: 1;
            overflow-y: auto;
            padding: 40px 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .welcome-header {
            text-align: center;
            margin-bottom: 50px;
            max-width: 600px;
        }

        .welcome-header h1 {
            font-size: 42px;
            margin-bottom: 16px;
            background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .welcome-header p {
            font-size: 16px;
            color: var(--text-secondary);
            line-height: 1.6;
        }

        .quick-access {
            width: 100%;
            max-width: 900px;
            margin-bottom: 40px;
        }

        .quick-access-title {
            font-size: 18px;
            font-weight: 600;
            margin-bottom: 20px;
            color: var(--text);
        }

        .cards-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 16px;
        }

        .card {
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(6, 182, 212, 0.1));
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 20px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s;
        }

        .card:hover {
            border-color: var(--primary);
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(6, 182, 212, 0.2));
            transform: translateY(-4px);
            box-shadow: 0 8px 24px rgba(59, 130, 246, 0.2);
        }

        .card-icon {
            font-size: 40px;
            margin-bottom: 12px;
        }

        .card-name {
            font-size: 14px;
            font-weight: 600;
            color: var(--text);
        }

        .loading-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            justify-content: center;
            align-items: center;
            z-index: 2000;
        }

        .loading-overlay.show {
            display: flex;
        }

        .loader {
            text-align: center;
        }

        .spinner {
            width: 50px;
            height: 50px;
            border: 4px solid rgba(255, 255, 255, 0.2);
            border-top: 4px solid var(--primary);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .error-toast {
            display: none;
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #ef4444;
            color: white;
            padding: 16px 20px;
            border-radius: 8px;
            font-size: 14px;
            z-index: 2001;
        }

        .error-toast.show {
            display: block;
            animation: slideUp 0.3s ease;
        }

        @keyframes slideUp {
            from {
                transform: translateY(100px);
                opacity: 0;
            }
            to {
                transform: translateY(0);
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

            .welcome {
                padding: 20px 10px;
            }

            .welcome-header h1 {
                font-size: 28px;
            }

            .cards-grid {
                grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
                gap: 12px;
            }

            .card {
                padding: 16px;
            }

            .card-icon {
                font-size: 32px;
            }

            .card-name {
                font-size: 12px;
            }
        }
    </style>
</head>
<body>
    <div class="navbar">
        <div class="nav-buttons">
            <button class="nav-btn" id="backBtn" title="Back">←</button>
            <button class="nav-btn" id="forwardBtn" title="Forward">→</button>
            <button class="nav-btn" id="refreshBtn" title="Refresh">⟳</button>
            <button class="nav-btn" id="homeBtn" title="Home">⌂</button>
        </div>
        <div class="url-bar">
            <input 
                type="text" 
                id="urlInput" 
                placeholder="https://example.com" 
                spellcheck="false"
                autocomplete="off"
            />
            <button class="go-btn" id="goBtn">GO</button>
        </div>
    </div>

    <div class="content">
        <div class="welcome" id="welcome">
            <div class="welcome-header">
                <h1>🌐 Proxy Browser</h1>
                <p>Access any website with complete anonymity and privacy protection</p>
            </div>

            <div class="quick-access">
                <div class="quick-access-title">Quick Access</div>
                <div class="cards-grid">
                    <div class="card" data-url="https://www.youtube.com">
                        <div class="card-icon">📹</div>
                        <div class="card-name">YouTube</div>
                    </div>
                    <div class="card" data-url="https://www.facebook.com">
                        <div class="card-icon">👥</div>
                        <div class="card-name">Facebook</div>
                    </div>
                    <div class="card" data-url="https://www.tiktok.com">
                        <div class="card-icon">🎬</div>
                        <div class="card-name">TikTok</div>
                    </div>
                    <div class="card" data-url="https://www.instagram.com">
                        <div class="card-icon">📸</div>
                        <div class="card-name">Instagram</div>
                    </div>
                    <div class="card" data-url="https://x.com">
                        <div class="card-icon">𝕏</div>
                        <div class="card-name">X</div>
                    </div>
                    <div class="card" data-url="https://www.reddit.com">
                        <div class="card-icon">🔗</div>
                        <div class="card-name">Reddit</div>
                    </div>
                    <div class="card" data-url="https://www.wikipedia.org">
                        <div class="card-icon">📖</div>
                        <div class="card-name">Wikipedia</div>
                    </div>
                    <div class="card" data-url="https://www.google.com">
                        <div class="card-icon">🔍</div>
                        <div class="card-name">Google</div>
                    </div>
                    <div class="card" data-url="https://www.github.com">
                        <div class="card-icon">💻</div>
                        <div class="card-name">GitHub</div>
                    </div>
                </div>
            </div>
        </div>
        <iframe id="frame"></iframe>
    </div>

    <div class="loading-overlay" id="loading">
        <div class="loader">
            <div class="spinner"></div>
        </div>
    </div>

    <div class="error-toast" id="error"></div>

    <script>
        const urlInput = document.getElementById('urlInput');
        const goBtn = document.getElementById('goBtn');
        const backBtn = document.getElementById('backBtn');
        const forwardBtn = document.getElementById('forwardBtn');
        const refreshBtn = document.getElementById('refreshBtn');
        const homeBtn = document.getElementById('homeBtn');
        const frame = document.getElementById('frame');
        const welcome = document.getElementById('welcome');
        const loading = document.getElementById('loading');
        const error = document.getElementById('error');
        const cards = document.querySelectorAll('.card');

        let history = [];
        let currentIndex = -1;

        function showError(msg) {
            error.textContent = msg;
            error.classList.add('show');
            setTimeout(() => error.classList.remove('show'), 5000);
        }

        function normalizeURL(url) {
            url = url.trim();
            if (!url) return '';
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                return 'https://' + url;
            }
            return url;
        }

        function encodeProxyURL(url) {
            return btoa(url).replace(/\\+/g, '-').replace(/\\//g, '_');
        }

        function loadURL(targetURL) {
            targetURL = normalizeURL(targetURL);
            
            if (!targetURL) {
                showError('Please enter a URL');
                return;
            }

            if (!targetURL.startsWith('http://') && !targetURL.startsWith('https://')) {
                showError('Invalid URL');
                return;
            }

            if (currentIndex > -1 && history[currentIndex] !== targetURL) {
                history = history.slice(0, currentIndex + 1);
            }
            
            if (!history.length || history[history.length - 1] !== targetURL) {
                history.push(targetURL);
                currentIndex = history.length - 1;
            }

            updateNavButtons();
            urlInput.value = targetURL;
            welcome.style.display = 'none';
            loading.classList.add('show');

            const encoded = encodeProxyURL(targetURL);
            frame.src = '/b/' + encoded;

            const timeout = setTimeout(() => {
                loading.classList.remove('show');
            }, 15000);

            frame.onload = () => {
                clearTimeout(timeout);
                loading.classList.remove('show');
            };

            frame.onerror = () => {
                clearTimeout(timeout);
                loading.classList.remove('show');
                showError('Failed to load page');
            };
        }

        function updateNavButtons() {
            backBtn.disabled = currentIndex <= 0;
            forwardBtn.disabled = currentIndex >= history.length - 1;
        }

        goBtn.addEventListener('click', () => loadURL(urlInput.value));
        urlInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') loadURL(urlInput.value);
        });

        backBtn.addEventListener('click', () => {
            if (currentIndex > 0) {
                currentIndex--;
                loadURL(history[currentIndex]);
            }
        });

        forwardBtn.addEventListener('click', () => {
            if (currentIndex < history.length - 1) {
                currentIndex++;
                loadURL(history[currentIndex]);
            }
        });

        refreshBtn.addEventListener('click', () => {
            frame.src = frame.src;
        });

        homeBtn.addEventListener('click', () => {
            welcome.style.display = 'flex';
            frame.style.display = 'none';
            urlInput.value = '';
        });

        cards.forEach(card => {
            card.addEventListener('click', () => {
                const url = card.getAttribute('data-url');
                urlInput.value = url;
                loadURL(url);
            });
        });

        // Make frame visible when needed
        const observer = new MutationObserver(() => {
            if (frame.src && frame.src !== 'about:blank') {
                frame.style.display = 'block';
            }
        });

        observer.observe(frame, { attributes: true });

        urlInput.focus();
        updateNavButtons();
    </script>
</body>
</html>
    `);
});

// ============================================
// Routes - Proxy
// ============================================
app.all(['/b/:encoded(*)', '/b/:encoded(*)/'], async (req, res, next) => {
    try {
        const encoded = req.params.encoded;
        let targetURL = decodeURL(encoded);

        if (!targetURL) {
            return res.status(400).send('Invalid URL encoding');
        }

        if (!isValidURL(targetURL) || !preventSSRF(targetURL)) {
            return res.status(403).send('Access denied');
        }

        // Handle query string
        if (req.url.includes('?')) {
            const queryString = req.url.split('?')[1];
            targetURL += (targetURL.includes('?') ? '&' : '?') + queryString;
        }

        console.log(`[PROXY] ${req.method} ${targetURL}`);

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0'
        };

        // Forward necessary headers
        if (req.headers.referer) {
            const refererDecoded = decodeURL(req.headers.referer.split('/b/')[1]);
            if (refererDecoded) headers['Referer'] = refererDecoded;
        }

        if (req.headers.cookie) {
            headers['Cookie'] = req.headers.cookie;
        }

        if (req.headers['accept-language']) {
            headers['Accept-Language'] = req.headers['accept-language'];
        }

        if (req.headers['user-agent']) {
            headers['User-Agent'] = req.headers['user-agent'];
        }

        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const fetchOptions = {
            method: req.method,
            headers,
            redirect: 'follow',
            timeout: 30000,
            compress: true,
            follow: 10
        };

        // Handle POST/PUT/PATCH body
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            if (Buffer.isBuffer(req.body)) {
                fetchOptions.body = req.body;
            } else if (typeof req.body === 'string' && req.body.length > 0) {
                fetchOptions.body = req.body;
            } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
                fetchOptions.body = JSON.stringify(req.body);
            }
        }

        const fetch = require('node-fetch');
        const response = await fetch(targetURL, fetchOptions);
        const contentType = (response.headers.get('content-type') || 'text/html').toLowerCase();

        // Set response headers
        for (const [key, value] of response.headers.entries()) {
            if (!UNSAFE_HEADERS.includes(key.toLowerCase())) {
                res.set(key, value);
            }
        }

        // Handle Set-Cookie properly
        const setCookies = response.headers.raw()['set-cookie'];
        if (setCookies) {
            res.set('Set-Cookie', setCookies);
        }

        res.set('X-Proxy-Server', 'ProxyBrowser/1.0');
        res.set('Cache-Control', 'public, max-age=3600');

        // Handle HTML
        if (contentType.includes('text/html')) {
            let html = await response.text();
            
            // Rewrite HTML
            html = rewriteHTML(html, targetURL);
            
            // Inject script before closing head
            if (html.includes('</head>')) {
                html = html.replace('</head>', CLIENT_INJECTION + '</head>');
            } else if (html.includes('<body')) {
                html = html.replace('<body', CLIENT_INJECTION + '<body');
            } else {
                html = CLIENT_INJECTION + html;
            }

            res.set('Content-Type', 'text/html; charset=utf-8');
            res.send(html);
        }
        // Handle CSS
        else if (contentType.includes('text/css')) {
            let css = await response.text();
            css = rewriteCSS(css, targetURL);
            res.set('Content-Type', 'text/css; charset=utf-8');
            res.send(css);
        }
        // Handle JavaScript
        else if (contentType.includes('javascript')) {
            let js = await response.text();
            js = rewriteJavaScript(js, targetURL);
            res.set('Content-Type', 'application/javascript; charset=utf-8');
            res.send(js);
        }
        // Handle JSON
        else if (contentType.includes('application/json')) {
            const json = await response.json();
            res.json(json);
        }
        // Stream everything else
        else {
            if (response.status === 206) {
                res.status(206);
            }
            
            res.setHeader('Content-Type', contentType);
            response.body.pipe(res);
        }
    } catch (error) {
        console.error('[PROXY ERROR]', error);
        res.status(500).send('Proxy error: ' + error.message);
    }
});

// ============================================
// Error Handling
// ============================================
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
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════╗
║  🌐 Proxy Browser - Production Ready       ║
║  📡 http://localhost:${PORT}                ║
║  ✅ All major websites supported            ║
║  🔒 Full HTML/CSS/JS rewriting              ║
║  ⚡ Streaming & Range requests enabled      ║
╚════════════════════════════════════════════╝
    `);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down...');
    process.exit(0);
});
