const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// ============================================
// ⚙️ الإعدادات
// ============================================
const CACHE = new NodeCache({ stdTTL: 3600 }); // Cache لمدة ساعة
const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500MB max
const TIMEOUT = 30000; // 30 ثانية timeout
const BUFFER_SIZE = 64 * 1024; // 64KB chunks

// ============================================
// 🔒 Middleware الأمان
// ============================================
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    methods: ['GET', 'POST'],
    credentials: true
}));

app.use(express.static('public'));

// Rate limiting - منع الاستخدام الشرس
const streamLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: 30, // 30 طلب
    message: '❌ تم تجاوز الحد المسموح. حاول بعدين',
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: '❌ طلبات كتير. انتظر شوية'
});

app.use('/api/', apiLimiter);

// ============================================
// 🛡️ Validator Functions
// ============================================
function isValidUrl(url) {
    try {
        const urlObj = new URL(url);
        const validDomains = [
            'youtube.com', 'youtu.be',
            'drive.google.com',
            'vimeo.com',
            'facebook.com',
            'twitter.com',
            'instagram.com'
        ];
        return validDomains.some(domain => urlObj.hostname.includes(domain));
    } catch {
        return false;
    }
}

function sanitizeUrl(url) {
    try {
        const urlObj = new URL(decodeURIComponent(url));
        // Remove tracking parameters
        const params = new URLSearchParams(urlObj.search);
        params.delete('utm_source');
        params.delete('utm_medium');
        params.delete('utm_campaign');
        urlObj.search = params.toString();
        return urlObj.toString();
    } catch {
        return url;
    }
}

// ============================================
// 📊 Logging System
// ============================================
class Logger {
    log(level, msg, data = {}) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level}] ${msg}`, data);
    }
    info(msg, data) { this.log('INFO', msg, data); }
    warn(msg, data) { this.log('WARN', msg, data); }
    error(msg, data) { this.log('ERROR', msg, data); }
    debug(msg, data) { this.log('DEBUG', msg, data); }
}

const logger = new Logger();

// ============================================
// 🎯 Main Stream Endpoint
// ============================================
app.get('/api/stream', streamLimiter, async (req, res) => {
    const { url, quality = 'best', cache = 'true' } = req.query;
    const clientIp = req.ip;

    if (!url) {
        logger.warn('طلب بدون رابط', { ip: clientIp });
        return res.status(400).json({ 
            error: '❌ مطلوب رابط الفيديو',
            code: 'MISSING_URL'
        });
    }

    if (!isValidUrl(url)) {
        logger.warn('رابط غير صحيح', { url: url.substring(0, 50), ip: clientIp });
        return res.status(400).json({ 
            error: '❌ الرابط غير صحيح. تأكد من أنه رابط فيديو',
            code: 'INVALID_URL'
        });
    }

    // Check cache first
    const cacheKey = `video_${Buffer.from(url).toString('base64')}`;
    if (cache === 'true' && CACHE.has(cacheKey)) {
        logger.info('Cache hit ✅', { cacheKey: cacheKey.substring(0, 20) });
        const cachedHeaders = CACHE.get(cacheKey);
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Content-Type', cachedHeaders.contentType);
        res.setHeader('Content-Length', cachedHeaders.contentLength);
        return res.redirect(url);
    }

    try {
        const sanitized = sanitizeUrl(url);
        logger.info('جاري التحميل...', { 
            url: sanitized.substring(0, 60),
            ip: clientIp,
            quality
        });

        const response = await fetch(sanitized, {
            method: 'GET',
            timeout: TIMEOUT,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.youtube.com/',
                'Accept': 'video/*,application/octet-stream',
                'Range': req.headers.range || '',
            },
            redirect: 'follow',
            compress: false
        });

        if (!response.ok) {
            logger.error('خطأ من السرفر البعيد', { 
                status: response.status,
                url: sanitized.substring(0, 50)
            });
            return res.status(response.status).json({ 
                error: `❌ خطأ: ${response.status} ${response.statusText}`,
                code: 'REMOTE_ERROR'
            });
        }

        const contentType = response.headers.get('content-type') || 'video/mp4';
        const contentLength = response.headers.get('content-length');
        
        // Check size
        if (contentLength && parseInt(contentLength) > MAX_VIDEO_SIZE) {
            logger.warn('الفيديو كبير جداً', { 
                size: contentLength,
                max: MAX_VIDEO_SIZE
            });
            return res.status(413).json({ 
                error: '❌ الفيديو كبير جداً (أكثر من 500MB)',
                code: 'FILE_TOO_LARGE'
            });
        }

        // Set response headers
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Accept-Ranges', 'bytes');
        
        if (contentLength) {
            res.setHeader('Content-Length', contentLength);
        }

        // Cache headers info
        if (cache === 'true') {
            CACHE.set(cacheKey, { 
                contentType, 
                contentLength 
            });
        }

        logger.info('تشغيل الفيديو ✅', { 
            type: contentType,
            size: contentLength
        });

        // Stream with buffering
        response.body.pipe(res);

        // Handle errors during streaming
        response.body.on('error', (error) => {
            logger.error('خطأ في البث', { error: error.message });
            if (!res.headersSent) {
                res.status(500).json({ error: '❌ خطأ في البث' });
            }
        });

    } catch (error) {
        logger.error('خطأ في الوكيل', { 
            error: error.message,
            code: error.code
        });

        let statusCode = 500;
        let errorCode = 'PROXY_ERROR';
        let message = '❌ خطأ في الوكيل';

        if (error.code === 'ETIMEDOUT') {
            statusCode = 504;
            errorCode = 'TIMEOUT';
            message = '❌ انقطع الاتصال (Timeout)';
        } else if (error.code === 'ENOTFOUND') {
            statusCode = 502;
            errorCode = 'DNS_ERROR';
            message = '❌ لا يمكن الوصول للموقع';
        }

        if (!res.headersSent) {
            res.status(statusCode).json({ 
                error: message,
                code: errorCode,
                details: process.env.DEBUG === 'true' ? error.message : undefined
            });
        }
    }
});

// ============================================
// 📱 الصفحة الرئيسية
// ============================================
app.get('/', (req, res) => {
    const defaultVideo = 'https://youtu.be/KnuIqBn6UTM?si=qVmGiU_xWJlpQYc1';

    res.send(`
<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="theme-color" content="#1a1a2e">
    <title>🎥 مشغل الفيديو - الوكيل المتقدم</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            -webkit-tap-highlight-color: transparent;
        }
        
        html, body {
            width: 100%;
            height: 100%;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Droid Sans', sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: max(20px, env(safe-area-inset-left));
            overflow-x: hidden;
        }
        
        .container {
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(20px);
            border-radius: 24px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            box-shadow: 0 25px 50px rgba(0, 0, 0, 0.6);
            width: 100%;
            max-width: 900px;
            padding: clamp(20px, 5vw, 50px);
        }
        
        h1 {
            color: #fff;
            font-size: clamp(24px, 6vw, 32px);
            text-align: center;
            margin-bottom: 8px;
            font-weight: 700;
            letter-spacing: -0.5px;
        }
        
        .subtitle {
            color: #aaa;
            text-align: center;
            margin-bottom: 30px;
            font-size: clamp(13px, 3vw, 15px);
            font-weight: 500;
        }
        
        .input-group {
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 8px;
            margin-bottom: 20px;
            align-items: center;
        }
        
        @media (max-width: 640px) {
            .input-group {
                grid-template-columns: 1fr;
            }
        }
        
        .input-group input {
            padding: clamp(12px, 3vw, 16px) 18px;
            border: 2px solid rgba(255, 255, 255, 0.1);
            border-radius: 14px;
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            font-size: 16px;
            transition: all 0.3s ease;
            -webkit-appearance: none;
        }
        
        .input-group input::placeholder {
            color: rgba(255, 255, 255, 0.5);
        }
        
        .input-group input:focus {
            outline: none;
            border-color: #e74c3c;
            background: rgba(255, 255, 255, 0.08);
            box-shadow: 0 0 12px rgba(231, 76, 60, 0.3);
        }
        
        .btn-group {
            display: grid;
            grid-template-columns: auto auto;
            gap: 8px;
        }
        
        @media (max-width: 640px) {
            .btn-group {
                grid-template-columns: 1fr 1fr;
            }
        }
        
        .btn {
            padding: clamp(12px, 3vw, 16px) clamp(16px, 3vw, 24px);
            border: none;
            border-radius: 12px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            white-space: nowrap;
            -webkit-appearance: none;
            text-transform: capitalize;
        }
        
        .btn:active {
            transform: scale(0.95);
        }
        
        .btn-primary {
            background: linear-gradient(135deg, #e74c3c, #c0392b);
            color: white;
            grid-column: 1;
        }
        
        .btn-primary:hover {
            box-shadow: 0 8px 24px rgba(231, 76, 60, 0.4);
            transform: translateY(-2px);
        }
        
        .btn-paste {
            background: linear-gradient(135deg, #3498db, #2980b9);
            color: white;
            grid-column: 2;
        }
        
        .btn-paste:hover {
            box-shadow: 0 8px 24px rgba(52, 152, 219, 0.4);
            transform: translateY(-2px);
        }
        
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 12px;
            margin: 20px 0;
        }
        
        .stat-card {
            background: rgba(255, 255, 255, 0.03);
            padding: 12px;
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.05);
            text-align: center;
        }
        
        .stat-value {
            color: #e74c3c;
            font-size: 18px;
            font-weight: 700;
            margin-bottom: 4px;
        }
        
        .stat-label {
            color: #aaa;
            font-size: 12px;
        }
        
        .player-container {
            background: #000;
            border-radius: 14px;
            overflow: hidden;
            margin-top: 20px;
            aspect-ratio: 16 / 9;
            display: none;
        }
        
        #videoPlayer {
            width: 100%;
            height: 100%;
            display: block;
        }
        
        .error-message {
            color: #e74c3c;
            background: rgba(231, 76, 60, 0.1);
            padding: 14px 16px;
            border-radius: 10px;
            margin-top: 12px;
            display: none;
            border: 1px solid rgba(231, 76, 60, 0.3);
            border-left: 4px solid #e74c3c;
            font-size: 14px;
            animation: slideIn 0.3s ease;
        }
        
        .success-message {
            color: #27ae60;
            background: rgba(39, 174, 96, 0.1);
            padding: 14px 16px;
            border-radius: 10px;
            margin-top: 12px;
            display: none;
            border: 1px solid rgba(39, 174, 96, 0.3);
            border-left: 4px solid #27ae60;
        }
        
        .loading {
            display: none;
            text-align: center;
            margin: 20px 0;
        }
        
        .spinner {
            display: inline-block;
            width: 24px;
            height: 24px;
            border: 3px solid rgba(255, 255, 255, 0.1);
            border-top-color: #e74c3c;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(-10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        
        .info-box {
            background: rgba(52, 152, 219, 0.1);
            padding: 14px 16px;
            border-radius: 10px;
            margin: 15px 0;
            color: #aaa;
            font-size: 13px;
            border: 1px solid rgba(52, 152, 219, 0.2);
            border-right: 4px solid #3498db;
        }
        
        .info-box strong {
            color: #fff;
        }
        
        @supports (padding: max(0px)) {
            body {
                padding-left: max(20px, env(safe-area-inset-left));
                padding-right: max(20px, env(safe-area-inset-right));
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎥 مشغل الفيديو</h1>
        <p class="subtitle">شغل أي فيديو بسهولة وأمان</p>

        <div class="input-group">
            <input 
                type="text" 
                id="videoUrl" 
                placeholder="الصق رابط الفيديو هنا..." 
                value="${defaultVideo}"
                spellcheck="false"
                autocorrect="off"
            />
            <div class="btn-group">
                <button class="btn btn-paste" id="pasteBtn" title="انسخ من الحافظة">📋</button>
                <button class="btn btn-primary" id="playBtn">▶️ تشغيل</button>
            </div>
        </div>

        <div class="loading" id="loading">
            <div class="spinner"></div>
            <p style="color: #aaa; margin-top: 10px; font-size: 14px;">جاري التحميل...</p>
        </div>

        <div id="successMessage" class="success-message"></div>
        <div id="errorMessage" class="error-message"></div>

        <div class="stats" id="stats" style="display: none;">
            <div class="stat-card">
                <div class="stat-value" id="statBuffered">0%</div>
                <div class="stat-label">تحميل</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" id="statTime">0:00</div>
                <div class="stat-label">الوقت</div>
            </div>
        </div>

        <div class="info-box">
            <strong>💡 نصيحة:</strong> استخدم الأزرار للتحكم في الفيديو. الفيديو الافتراضي محمّل تلقائياً
        </div>

        <div id="playerContainer" class="player-container">
            <video id="videoPlayer" controls></video>
        </div>
    </div>

    <script>
        class VideoPlayer {
            constructor() {
                this.videoUrl = document.getElementById('videoUrl');
                this.playBtn = document.getElementById('playBtn');
                this.pasteBtn = document.getElementById('pasteBtn');
                this.playerContainer = document.getElementById('playerContainer');
                this.videoPlayer = document.getElementById('videoPlayer');
                this.errorMsg = document.getElementById('errorMessage');
                this.successMsg = document.getElementById('successMessage');
                this.loading = document.getElementById('loading');
                this.stats = document.getElementById('stats');
                
                this.setupEventListeners();
                this.autoPlay();
            }

            setupEventListeners() {
                this.pasteBtn.addEventListener('click', () => this.handlePaste());
                this.playBtn.addEventListener('click', () => this.playVideo());
                this.videoUrl.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') this.playVideo();
                });
                
                this.videoPlayer.addEventListener('loadedmetadata', () => {
                    this.stats.style.display = 'grid';
                });
                
                this.videoPlayer.addEventListener('timeupdate', () => {
                    this.updateStats();
                });
            }

            async handlePaste() {
                try {
                    const text = await navigator.clipboard.readText();
                    if (text.includes('youtube.com') || text.includes('youtu.be') || text.startsWith('http')) {
                        this.videoUrl.value = text;
                        this.hideError();
                        this.showSuccess('✅ تم النسخ من الحافظة');
                        setTimeout(() => this.hideSuccess(), 2000);
                    } else {
                        this.showError('❌ الحافظة لا تحتوي على رابط صحيح');
                    }
                } catch (err) {
                    this.showError('❌ لا يمكن الوصول إلى الحافظة');
                }
            }

            async playVideo() {
                const url = this.videoUrl.value.trim();
                if (!url) {
                    this.showError('❌ أدخل رابط الفيديو أولاً');
                    return;
                }

                this.loading.style.display = 'block';
                this.hideError();
                this.hideSuccess();
                this.playBtn.disabled = true;

                try {
                    const proxyUrl = \`/api/stream?url=\${encodeURIComponent(url)}\`;
                    
                    const response = await fetch(proxyUrl, {
                        method: 'GET',
                        headers: { 'Accept': 'video/*' }
                    });

                    if (!response.ok) {
                        const error = await response.json().catch(() => ({}));
                        throw new Error(error.error || \`HTTP \${response.status}\`);
                    }

                    this.videoPlayer.src = proxyUrl;
                    this.playerContainer.style.display = 'block';
                    
                    this.videoPlayer.play().catch(e => {
                        console.warn('Autoplay prevented:', e);
                    });
                    
                    this.showSuccess('✅ جاري التشغيل...');
                    setTimeout(() => this.hideSuccess(), 3000);

                } catch (error) {
                    this.showError(error.message);
                    this.playerContainer.style.display = 'none';
                } finally {
                    this.loading.style.display = 'none';
                    this.playBtn.disabled = false;
                }
            }

            updateStats() {
                const current = this.videoPlayer.currentTime;
                const duration = this.videoPlayer.duration;
                
                if (!isNaN(duration)) {
                    const percent = (current / duration * 100).toFixed(0);
                    document.getElementById('statBuffered').textContent = \`\${percent}%\`;
                }
                
                document.getElementById('statTime').textContent = this.formatTime(current);
            }

            formatTime(seconds) {
                if (isNaN(seconds)) return '0:00';
                const mins = Math.floor(seconds / 60);
                const secs = Math.floor(seconds % 60);
                return \`\${mins}:\${secs.toString().padStart(2, '0')}\`;
            }

            showError(msg) {
                this.errorMsg.textContent = msg;
                this.errorMsg.style.display = 'block';
            }

            hideError() {
                this.errorMsg.style.display = 'none';
            }

            showSuccess(msg) {
                this.successMsg.textContent = msg;
                this.successMsg.style.display = 'block';
            }

            hideSuccess() {
                this.successMsg.style.display = 'none';
            }

            autoPlay() {
                window.addEventListener('load', () => {
                    setTimeout(() => this.playVideo(), 300);
                });
            }
        }

        const player = new VideoPlayer();
        console.log('🚀 مشغل الفيديو المتقدم v7.0 - جاهز للعمل');
    </script>
</body>
</html>
    `);
});

// ============================================
// 📊 Health Check
// ============================================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============================================
// ❌ 404 Handler
// ============================================
app.use((req, res) => {
    res.status(404).json({ 
        error: 'مش موجود الصفحة',
        code: 'NOT_FOUND'
    });
});

// ============================================
// 🚀 Server Start
// ============================================
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
    logger.info('🎉 السيرفر بدأ بنجاح', { port, host });
    console.log(`
╔════════════════════════════════════════╗
║  🎥 مشغل الفيديو - الوكيل المتقدم v7 ║
║  🌐 http://localhost:${port.toString().padEnd(27, ' ')}║
║  ✅ آمن · سريع · موثوق                ║
║  📊 /health - صحة الخادم            ║
╚════════════════════════════════════════╝
    `);
});

// ============================================
// 🛡️ Graceful Shutdown
// ============================================
process.on('SIGTERM', () => {
    logger.info('🛑 إيقاف الخادم...');
    process.exit(0);
});

module.exports = app;
