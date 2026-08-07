const express = require('express');
const ytdl = require('ytdl-core');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 3000;

// تفعيل CORS بحيث الموقع يقدر يطلب من البروكسي
app.use(cors());

// حد أقصى للـ timeout
const TIMEOUT = 30000;

/**
 * Endpoint للفيديو: /video?v=VIDEO_ID
 * الموقع يطلب: http://localhost:3000/video?v=dQw4w9WgXcQ
 * البروكسي يجيب الفيديو من YouTube ويرجعه
 */
app.get('/video', async (req, res) => {
  const videoId = req.query.v;
  
  if (!videoId) {
    return res.status(400).json({ error: 'Video ID مطلوب' });
  }

  try {
    // التحقق من أن الـ ID صحيح
    const videoURL = `https://www.youtube.com/watch?v=${videoId}`;
    
    // جلب معلومات الفيديو أولاً
    const info = await ytdl.getInfo(videoURL);
    const title = info.videoDetails.title;
    
    console.log(`🎬 جاري تشغيل: ${title}`);

    // جلب أفضل format متاح (فيديو + صوت معاً)
    const stream = ytdl(videoURL, {
      quality: 'highest',
      requestOptions: {
        timeout: TIMEOUT
      }
    });

    // Set headers للـ response
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `inline; filename="${title}.mp4"`);
    res.setHeader('Accept-Ranges', 'bytes');

    // Stream الفيديو للموقع
    stream.pipe(res);

    // معالجة الأخطاء
    stream.on('error', (err) => {
      console.error('❌ خطأ في Stream:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'تعذّر تشغيل الفيديو' });
      }
    });

    res.on('error', (err) => {
      console.error('❌ خطأ في Response:', err.message);
      stream.destroy();
    });

  } catch (error) {
    console.error('❌ خطأ:', error.message);
    
    // معالجة الأخطاء المختلفة
    if (error.message.includes('video unavailable')) {
      return res.status(404).json({ error: 'الفيديو غير متاح' });
    } else if (error.message.includes('aget_video_info')) {
      return res.status(403).json({ error: 'لا يمكن الوصول للفيديو (محمي)' });
    }
    
    res.status(500).json({ error: 'خطأ في البروكسي', details: error.message });
  }
});

/**
 * Endpoint للمعلومات: /info?v=VIDEO_ID
 * لجلب بيانات الفيديو (العنوان، المدة، الصورة، إلخ)
 * بدون تشغيل الفيديو نفسه
 */
app.get('/info', async (req, res) => {
  const videoId = req.query.v;
  
  if (!videoId) {
    return res.status(400).json({ error: 'Video ID مطلوب' });
  }

  try {
    const videoURL = `https://www.youtube.com/watch?v=${videoId}`;
    const info = await ytdl.getInfo(videoURL);
    const details = info.videoDetails;

    res.json({
      id: videoId,
      title: details.title,
      duration: details.lengthSeconds,
      author: details.author.name,
      keywords: details.keywords || [],
      description: details.description,
      thumbnail: details.thumbnails[details.thumbnails.length - 1].url,
      publishedAt: details.publishDate,
      viewCount: details.viewCount
    });

  } catch (error) {
    console.error('❌ خطأ في جلب المعلومات:', error.message);
    res.status(500).json({ error: 'تعذّر جلب معلومات الفيديو', details: error.message });
  }
});

/**
 * Endpoint لـ Health Check
 */
app.get('/health', (req, res) => {
  res.json({ status: '✅ البروكسي شغّال' });
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  🎬 YouTube Proxy Server شغّال        ║
║  استخدم: http://localhost:${PORT}      ║
║                                        ║
║  🎥 فيديو: /video?v=VIDEO_ID          ║
║  ℹ️  معلومات: /info?v=VIDEO_ID        ║
║  💚 Health: /health                   ║
╚════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 إيقاف البروكسي...');
  process.exit(0);
});
