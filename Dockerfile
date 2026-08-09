FROM node:18-slim

# Install system packages
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    wget \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ضروري: بنحط ARG بتاريخ البناء عشان نكسر الـ Docker layer cache بتاع سطر
# تثبيت yt-dlp في كل مرة نعمل فيها build جديد — من غير السطر ده، Railway
# ممكن يفضل مستخدم نفس نسخة yt-dlp القديمة المخزّنة (cached) للأبد حتى لو
# عدّلنا كود السيرفر بس، ويوتيوب بيغيّر شكله باستمرار فده بيكسر التشغيل.
ARG CACHEBUST=1
RUN pip3 install --break-system-packages --no-cache-dir --upgrade yt-dlp

# Working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --omit=dev

# Copy project files
COPY . .

# Railway Port
ENV PORT=3000
EXPOSE 3000

# Health Check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Start server
CMD ["npm", "start"]
