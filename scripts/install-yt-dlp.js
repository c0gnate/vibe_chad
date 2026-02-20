const fs = require("fs");
const path = require("path");
const https = require("https");

const VERSION = process.env.YTDLP_VERSION || "latest";
const isWindows = process.platform === "win32";
const assetName = isWindows ? "yt-dlp.exe" : "yt-dlp";
const targetPath = path.join(__dirname, "..", "bin", assetName);
const downloadUrl =
  VERSION === "latest"
    ? `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`
    : `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/${assetName}`;

if (process.env.SKIP_YTDLP_DOWNLOAD === "1") {
  console.log("[install-yt-dlp] SKIP_YTDLP_DOWNLOAD=1, skipping.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(targetPath), { recursive: true });

downloadWithRedirects(downloadUrl, targetPath, 6)
  .then(() => {
    if (!isWindows) {
      fs.chmodSync(targetPath, 0o755);
    }
    console.log(`[install-yt-dlp] Installed ${targetPath}`);
  })
  .catch((error) => {
    console.warn(`[install-yt-dlp] Failed: ${error.message}`);
    console.warn("[install-yt-dlp] Extraction will fail until yt-dlp is available.");
  });

function downloadWithRedirects(url, outputPath, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;

      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error("Too many redirects"));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        resolve(downloadWithRedirects(nextUrl, outputPath, redirectsLeft - 1));
        return;
      }

      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      const file = fs.createWriteStream(outputPath);
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", (error) => {
        fs.unlink(outputPath, () => reject(error));
      });
    });

    request.on("error", reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error("Download timed out"));
    });
  });
}
