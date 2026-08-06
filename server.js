const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YouTube Proxy</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background: #1a1a2e;
            color: white;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            padding: 20px;
        }
        .container {
            background: #16213e;
            padding: 30px;
            border-radius: 15px;
            width: 100%;
            max-width: 600px;
        }
        input, button {
            width: 100%;
            padding: 12px;
            margin: 8px 0;
            border: none;
            border-radius: 8px;
            font-size: 16px;
        }
        input {
            background: #0f3460;
            color: white;
        }
        button {
            background: #e74c3c;
            color: white;
            font-weight: bold;
            cursor: pointer;
        }
        button:hover {
            background: #c0392b;
        }
        .info {
            color: #aaa;
            font-size: 14px;
            margin-top: 15px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="container">
        <h2>🎥 YouTube Proxy</h2>
        <p>الصق رابط الفيديو وافتحه</p>
        <input type="text" id="urlInput" placeholder="https://youtu.be/..." value="https://youtu.be/KnuIqBn6UTM?si=qVmGiU_xWJlpQYc1">
        <button onclick="openVideo()">▶️ افتح الفيديو</button>
        <div class="info">⏳ الفيديو هيفتح في علامة تبويب جديدة</div>
    </div>
    <script>
        function openVideo() {
            const url = document.getElementById('urlInput').value.trim();
            if (url) {
                window.open(url, '_blank');
            } else {
                alert('من فضلك ادخل رابط الفيديو');
            }
        }
    </script>
</body>
</html>
    `);
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ شغال على http://localhost:${port}`);
});
