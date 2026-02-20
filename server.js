const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const LOCAL_YTDLP_PATH = path.join(
  __dirname,
  "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);
const YTDLP_PATH = process.env.YTDLP_PATH || LOCAL_YTDLP_PATH;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
const YTDLP = resolveYtDlpCommand();
const HAS_FFMPEG = isCommandAvailable("ffmpeg", ["-version"]);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    extractor: YTDLP.label,
    message: "Server is running"
  });
});

app.post("/api/extract", async (req, res) => {
  const sourceUrl = normalizeUrl(req.body?.url || "");
  if (!sourceUrl) {
    return res.status(400).json({ error: "Valid URL is required." });
  }

  try {
    const info = await runYtDlpJson(sourceUrl);
    const normalized = normalizeInfo(info);
    res.json(normalized);
  } catch (error) {
    const statusCode = String(error.message || "").includes("yt-dlp") ? 500 : 422;
    res.status(statusCode).json({
      error:
        error.message ||
        "Extractor failed. URL may be unsupported, geo-restricted, login-gated, or DRM-protected."
    });
  }
});

app.get("/api/download", async (req, res) => {
  const sourceUrl = normalizeUrl(req.query.url || "");
  const formatId = String(req.query.format || "").trim();
  const fileName = sanitizeFilename(String(req.query.filename || "download.bin"));

  if (!sourceUrl || !formatId) {
    return res.status(400).json({ error: "Missing url or format." });
  }

  const args = [
    "--no-warnings",
    "--no-playlist",
    "--no-part",
    "--format",
    formatId,
    "--output",
    "-",
    sourceUrl
  ];
  const siteArgs = getSiteSpecificArgs(sourceUrl);

  if (!YTDLP.available) {
    return res.status(500).json({
      error: "yt-dlp is not available. Install it or set YTDLP_PATH."
    });
  }

  if (formatId === "audio_mp3") {
    if (!HAS_FFMPEG) {
      return res.status(422).json({
        error: "MP3 conversion requires ffmpeg on the server."
      });
    }

    const mp3Result = await generateMp3File(sourceUrl, fileName, siteArgs).catch((error) => ({
      ok: false,
      error: error.message
    }));

    if (!mp3Result.ok) {
      return res.status(422).json({
        error: mp3Result.error || "Failed to generate MP3."
      });
    }

    const streamName = ensureExtension(fileName, "mp3");
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", buildContentDisposition(streamName));

    const readStream = fs.createReadStream(mp3Result.path);
    readStream.on("error", () => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to read generated MP3 file." });
      } else {
        res.end();
      }
    });

    res.on("close", () => {
      fs.unlink(mp3Result.path, () => {});
    });
    readStream.on("end", () => {
      fs.unlink(mp3Result.path, () => {});
    });

    readStream.pipe(res);
    return;
  }

  const child = spawn(YTDLP.command, [...YTDLP.prefixArgs, ...siteArgs, ...args], { windowsHide: true });

  let started = false;
  let stderr = "";

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", buildContentDisposition(fileName));

  const timeout = setTimeout(() => {
    if (!started) {
      child.kill("SIGKILL");
      if (!res.headersSent) {
        res.status(504).json({ error: "Timed out waiting for download stream." });
      } else {
        res.end();
      }
    }
  }, REQUEST_TIMEOUT_MS);

  child.stdout.on("data", () => {
    started = true;
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.stdout.pipe(res);

  child.on("error", (error) => {
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.status(500).json({
        error: `Failed to run ${YTDLP.label}: ${error.message}. Install yt-dlp or set YTDLP_PATH.`
      });
    }
  });

  child.on("close", (code) => {
    clearTimeout(timeout);
    if (code !== 0 && !res.headersSent) {
      res.status(422).json({
        error:
          sanitizeError(stderr) ||
          "Download failed. Source may require login, may be blocked, or may use DRM."
      });
    } else if (code !== 0) {
      res.end();
    }
  });
});

function normalizeInfo(rawInfo) {
  const info = rawInfo?._type === "playlist" && Array.isArray(rawInfo.entries)
    ? rawInfo.entries.find(Boolean) || rawInfo
    : rawInfo;

  const title = info.title || info.fulltitle || "media";
  const sourceUrl = info.webpage_url || info.original_url || "";

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const files = buildCuratedFiles(formats, title);

  return {
    sourceUrl,
    title,
    files
  };
}

function buildCuratedFiles(formats, title) {
  const baseName = sanitizeFilename(title).slice(0, 90) || "download";
  const valid = (formats || []).filter((f) => {
    if (!f || !f.format_id) return false;
    const ext = String(f.ext || "").toLowerCase();
    return !["mhtml", "jpg", "jpeg", "png", "webp"].includes(ext);
  });

  const heights = Array.from(
    new Set(
      valid
        .filter((f) => String(f.vcodec || "").toLowerCase() !== "none")
        .map((f) => Number(f.height || 0))
        .filter((n) => n > 0)
    )
  ).sort((a, b) => b - a);

  const maxHeight = heights[0] || 1080;
  const highTarget = Math.min(1080, maxHeight);
  const medTarget = Math.min(720, maxHeight);
  const lowTarget = Math.min(480, maxHeight);

  const files = [
    {
      formatId: buildVideoPresetFormat(highTarget),
      fileName: `${baseName}_${highTarget}p.mp4`,
      label: `video // high (up to ${highTarget}p) // MP4`
    },
    {
      formatId: buildVideoPresetFormat(medTarget),
      fileName: `${baseName}_${medTarget}p.mp4`,
      label: `video // medium (up to ${medTarget}p) // MP4`
    },
    {
      formatId: buildVideoPresetFormat(lowTarget),
      fileName: `${baseName}_${lowTarget}p.mp4`,
      label: `video // low (up to ${lowTarget}p) // MP4`
    },
    {
      formatId: "audio_mp3",
      fileName: `${baseName}_audio.mp3`,
      label: "audio // best // MP3"
    }
  ];

  return dedupePresets(files);
}

function dedupePresets(files) {
  const seen = new Set();
  return files.filter((f) => {
    if (!f || !f.formatId) return false;
    const key = `${f.fileName}|${f.formatId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildVideoPresetFormat(targetHeight) {
  const progressive =
    `best[height<=${targetHeight}][vcodec!=none][acodec!=none]/` +
    `best[vcodec!=none][acodec!=none]`;

  if (!HAS_FFMPEG) {
    return progressive;
  }

  return (
    `bestvideo[height<=${targetHeight}]+bestaudio/` +
    progressive
  );
}

function inferTypeLabel(format) {
  const vcodec = String(format.vcodec || "").toLowerCase();
  const acodec = String(format.acodec || "").toLowerCase();
  if (vcodec !== "none" && acodec !== "none") return "video+audio";
  if (vcodec !== "none") return "video";
  if (acodec !== "none") return "audio";
  return "media";
}

function runYtDlpJson(url) {
  return new Promise((resolve, reject) => {
    const siteArgs = getSiteSpecificArgs(url);
    const args = [
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      url
    ];

    if (!YTDLP.available) {
      reject(new Error("yt-dlp is not available. Install yt-dlp or set YTDLP_PATH."));
      return;
    }

    const child = spawn(YTDLP.command, [...YTDLP.prefixArgs, ...siteArgs, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Extractor timed out."));
    }, REQUEST_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to run ${YTDLP.label}: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            sanitizeError(stderr) ||
              "Extractor failed. URL may be unsupported, login-gated, or DRM-protected."
          )
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Extractor returned invalid JSON output."));
      }
    });
  });
}

function normalizeUrl(input) {
  try {
    const value = String(input || "").trim();
    if (!value) return "";
    const withProto = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(withProto).toString();
  } catch {
    return "";
  }
}

function sanitizeFilename(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function buildContentDisposition(fileName) {
  const safeName = sanitizeFilename(fileName || "download.bin") || "download.bin";
  const asciiFallback = safeName
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_");
  const utf8Name = encodeURIComponent(safeName).replace(/['()]/g, escape).replace(/\*/g, "%2A");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Name}`;
}

function ensureExtension(fileName, ext) {
  const base = sanitizeFilename(fileName || "download") || "download";
  const withoutExt = base.replace(/\.[a-z0-9]{2,5}$/i, "");
  return `${withoutExt}.${ext}`;
}

function generateMp3File(sourceUrl, fileName, siteArgs) {
  return new Promise((resolve, reject) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const base = path.join(os.tmpdir(), `piratechad-${unique}`);
    const outTemplate = `${base}.%(ext)s`;
    const targetPath = `${base}.mp3`;
    const safeTitle = ensureExtension(fileName, "mp3");

    const args = [
      ...siteArgs,
      "--no-warnings",
      "--no-playlist",
      "--no-part",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "--output",
      outTemplate,
      "--",
      sourceUrl
    ];

    const child = spawn(YTDLP.command, [...YTDLP.prefixArgs, ...args], { windowsHide: true });
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("MP3 conversion timed out."));
    }, REQUEST_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to run ${YTDLP.label}: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(sanitizeError(stderr) || "yt-dlp MP3 conversion failed."));
        return;
      }

      fs.access(targetPath, fs.constants.F_OK, (err) => {
        if (err) {
          reject(new Error("MP3 file was not created."));
          return;
        }
        resolve({ ok: true, path: targetPath, fileName: safeTitle });
      });
    });
  });
}

function sanitizeError(stderr) {
  const line = String(stderr || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-1)[0];
  if (!line) return "";
  return line.slice(0, 240);
}

app.listen(PORT, () => {
  console.log(`PirateCHAD downloader backend listening on http://localhost:${PORT}`);
  console.log(`Extractor mode: ${YTDLP.label}${YTDLP.available ? "" : " (unavailable)"}`);
});

function resolveYtDlpCommand() {
  const winDir = process.env.WINDIR || "C:\\Windows";
  const pyLauncher = path.join(winDir, "py.exe");
  const candidates = [
    { command: YTDLP_PATH, prefixArgs: [], label: `YTDLP_PATH (${YTDLP_PATH})` },
    { command: LOCAL_YTDLP_PATH, prefixArgs: [], label: `local yt-dlp (${LOCAL_YTDLP_PATH})` },
    { command: "yt-dlp", prefixArgs: [], label: "yt-dlp" },
    { command: pyLauncher, prefixArgs: ["-m", "yt_dlp"], label: `${pyLauncher} -m yt_dlp` },
    { command: "py", prefixArgs: ["-m", "yt_dlp"], label: "py -m yt_dlp" },
    { command: "python", prefixArgs: ["-m", "yt_dlp"], label: "python -m yt_dlp" }
  ];

  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate.command, [...candidate.prefixArgs, "--version"], {
        windowsHide: true,
        stdio: "pipe",
        encoding: "utf8",
        timeout: 12000
      });
      if (probe.status === 0) {
        return { ...candidate, available: true };
      }
    } catch {
    }
  }

  return { command: YTDLP_PATH, prefixArgs: [], label: `YTDLP_PATH (${YTDLP_PATH})`, available: false };
}

function isCommandAvailable(command, args = []) {
  try {
    const probe = spawnSync(command, args, {
      windowsHide: true,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 10000
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function getSiteSpecificArgs(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("tiktok.com")) {
      return [
        "--extractor-retries",
        "3",
        "--socket-timeout",
        "30",
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "--referer",
        "https://www.tiktok.com/"
      ];
    }
  } catch {
  }

  return [];
}
