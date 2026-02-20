FROM node:20-bookworm-slim

WORKDIR /app

ENV SKIP_YTDLP_DOWNLOAD=1

COPY package*.json ./
COPY scripts ./scripts
RUN npm ci

# Install ffmpeg, curl, and python3 (required by Linux yt-dlp launcher)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && /usr/local/bin/yt-dlp --version

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
EXPOSE 3000

CMD ["npm", "start"]
