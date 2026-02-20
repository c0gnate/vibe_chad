const thread = document.getElementById("thread");
const promptInput = document.getElementById("prompt-input");
const ideaForm = document.getElementById("idea-form");
const savedList = document.getElementById("saved-list");
const toast = document.getElementById("toast");
const modeToggleBtn = document.getElementById("mode-toggle-btn");
const MODE_STORAGE_KEY = "vibechad_invert_mode";
const API_BASE =
  window.location.protocol === "file:" ? "http://localhost:3000" : window.location.origin;

const resultByMessageId = new Map();
const savedResults = [];
let selectedMessageEl = null;
let selectedResult = null;
let messageCounter = 0;

document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  renderSavedResults();

  const savedMode = localStorage.getItem(MODE_STORAGE_KEY);
  const shouldInvert = savedMode === "1";
  document.documentElement.classList.toggle("invert-mode", shouldInvert);
  modeToggleBtn.setAttribute("aria-pressed", shouldInvert ? "true" : "false");

  modeToggleBtn.addEventListener("click", () => {
    document.documentElement.classList.toggle("invert-mode");
    const isOn = document.documentElement.classList.contains("invert-mode");
    modeToggleBtn.setAttribute("aria-pressed", isOn ? "true" : "false");
    localStorage.setItem(MODE_STORAGE_KEY, isOn ? "1" : "0");
  });

  ideaForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleLookup();
  });

  thread.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("a,button,input,textarea,select,label")) return;
    const msg = event.target.closest(".msg");
    if (!msg) return;
    event.preventDefault();
    selectMessage(msg);
  });

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target.closest(".msg")) return;
      if (event.target.closest("button, a, input, textarea, select, label, form")) return;
      clearSelection();
    },
    true
  );
});

function applyQuickPrompt(text) {
  promptInput.value = text;
  promptInput.focus();
}

async function scanCurrentLink() {
  await handleLookup();
}

async function handleLookup() {
  const raw = promptInput.value.trim();
  if (!raw) {
    showToast("Paste a URL first.");
    return;
  }

  const normalized = normalizeUrl(raw);
  if (!normalized) {
    showToast("That URL looks invalid.");
    return;
  }

  appendUserMessage(normalized);
  promptInput.value = "";
  appendAiStatus("Extracting files...");

  try {
    const result = await fetchExtractResult(normalized);
    if (!result.files || !result.files.length) {
      appendAiStatus("No downloadable formats found for that URL reatrd.");
      showToast("No files detected.");
      return;
    }

    appendAiResult(result);
    showToast(`Found ${result.files.length} file(s).`);
  } catch (error) {
    const isNetworkError =
      String(error.message || "").toLowerCase().includes("failed to fetch") ||
      String(error.message || "").toLowerCase().includes("networkerror");
    const message = isNetworkError
      ? "Extraction failed: server is unreachable. Go fuck yourself."
      : `Extraction failed: ${error.message}`;
    appendAiStatus(message);
    showToast("Extraction failed.");
  }
}

async function fetchExtractResult(url) {
  const response = await fetch(`${API_BASE}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
}

function normalizeUrl(value) {
  try {
    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(withProtocol).toString();
  } catch {
    return "";
  }
}

function appendUserMessage(text) {
  const user = document.createElement("div");
  user.className = "msg msg-user";
  user.textContent = text;
  user.dataset.messageId = `msg-${++messageCounter}`;
  thread.appendChild(user);
  selectMessage(user);
  thread.scrollTop = thread.scrollHeight;
}

function appendAiStatus(text) {
  const msg = document.createElement("div");
  msg.className = "msg msg-ai";
  msg.dataset.messageId = `msg-${++messageCounter}`;
  msg.innerHTML = `<p class="font-medium">${escapeHtml(text)}</p>`;
  thread.appendChild(msg);
  selectMessage(msg);
  thread.scrollTop = thread.scrollHeight;
}

function appendAiResult(result) {
  const msg = document.createElement("div");
  msg.className = "msg msg-ai";
  const messageId = `msg-${++messageCounter}`;
  msg.dataset.messageId = messageId;

  const fileCards = result.files
    .map((file, idx) => {
      const fallbackName = `download_${idx + 1}.bin`;
      const name = escapeHtml(file.fileName || fallbackName);
      const label = escapeHtml(file.label || "media");
      const size = file.filesize ? ` // ${escapeHtml(formatBytes(file.filesize))}` : "";

      return `
        <div class="idea-pill">
          <strong>File ${idx + 1}</strong>
          <p class="truncate-two">${name}</p>
          <p class="muted mt-1 truncate-two">${label}${size}</p>
          <button class="ghost-btn mt-2" onclick="startDownload('${encodeURIComponent(result.sourceUrl)}','${encodeURIComponent(file.formatId)}','${encodeURIComponent(file.fileName || fallbackName)}')">
            <i data-lucide="download" class="w-4 h-4"></i>
            Download
          </button>
        </div>
      `;
    })
    .join("");

  msg.innerHTML = `
    <p class="font-semibold text-lg">Download results: ${escapeHtml(result.title || "media")}</p>
    <p class="mt-1">Source: ${escapeHtml(result.sourceUrl)}</p>
    <div class="idea-grid">${fileCards}</div>
    <p class="muted mt-3 idea-note">Files provided by PirateCHAD™.</p>
  `;

  thread.appendChild(msg);
  resultByMessageId.set(messageId, {
    sourceUrl: result.sourceUrl,
    title: result.title || "media",
    files: result.files.map((file) => ({ ...file })),
    savedAt: new Date().toLocaleTimeString()
  });
  selectMessage(msg);
  thread.scrollTop = thread.scrollHeight;
  lucide.createIcons();
}

async function startDownload(sourceUrlEncoded, formatEncoded, fileNameEncoded) {
  const sourceUrl = encodeURIComponent(decodeURIComponent(sourceUrlEncoded));
  const format = encodeURIComponent(decodeURIComponent(formatEncoded));
  const rawFileName = decodeURIComponent(fileNameEncoded);
  const filename = encodeURIComponent(rawFileName);
  const href = `${API_BASE}/api/download?url=${sourceUrl}&format=${format}&filename=${filename}`;

  try {
    showToast("Starting download...");

    const response = await fetch(href);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const finalName = getFileNameFromHeaders(response.headers) || rawFileName;

    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = finalName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 2500);
    showToast(`Download started: ${finalName}`);
  } catch (error) {
    try {
      // Fallback: let the browser handle the stream directly in a new tab.
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast("Download opened in new tab.");
    } catch {
      showToast("Download failed.");
      appendAiStatus(`Download failed: ${error.message}`);
    }
  }
}

function getFileNameFromHeaders(headers) {
  const disposition = headers.get("content-disposition") || "";
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const basicMatch = disposition.match(/filename="([^"]+)"/i);
  if (basicMatch && basicMatch[1]) {
    return basicMatch[1];
  }

  return "";
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(Number(bytes))) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function clearSelection() {
  if (!selectedMessageEl) return;
  selectedMessageEl.classList.remove("msg-selected");
  selectedMessageEl = null;
  selectedResult = null;
}

function selectMessage(messageEl) {
  if (selectedMessageEl === messageEl) {
    clearSelection();
    return;
  }

  if (selectedMessageEl) selectedMessageEl.classList.remove("msg-selected");

  selectedMessageEl = messageEl;
  selectedMessageEl.classList.add("msg-selected");

  const id = messageEl.dataset.messageId;
  selectedResult = id ? resultByMessageId.get(id) || null : null;
}

function saveCurrentResult() {
  if (!selectedResult) {
    showToast("Select a download result first.");
    return;
  }

  savedResults.unshift({
    sourceUrl: selectedResult.sourceUrl,
    title: selectedResult.title,
    files: selectedResult.files.map((file) => ({ ...file })),
    savedAt: new Date().toLocaleTimeString()
  });
  renderSavedResults();
  showToast("Download result saved.");
}

function loadSavedResult(index) {
  const result = savedResults[index];
  if (!result) return;
  appendAiResult(result);
  showToast("Saved result loaded.");
}

function clearSavedIdeas() {
  savedResults.length = 0;
  renderSavedResults();
  showToast("Saved downloads cleared.");
}

function renderSavedResults() {
  if (!savedResults.length) {
    savedList.innerHTML = '<p class="muted empty-note">No downloads saved yet.</p>';
    return;
  }

  savedList.innerHTML = savedResults
    .map(
      (result, index) => `
        <button class="history-item text-left" onclick="loadSavedResult(${index})">
          <p class="text-sm font-medium mt-0.5" style="color: var(--cyan);">${escapeHtml(result.title)}</p>
          <p class="text-xs mt-1 truncate-two" style="color: #ffffff;">${escapeHtml(result.sourceUrl)}</p>
          <p class="text-[0.68rem] uppercase tracking-[0.08em] mt-2" style="color: var(--magenta);">${escapeHtml(result.files.length.toString())} file(s) // ${escapeHtml(result.savedAt)}</p>
        </button>
      `
    )
    .join("");
}

function copyCurrentResult() {
  if (!selectedResult) {
    showToast("Select a download result first.");
    return;
  }

  const lines = [
    `Source: ${selectedResult.sourceUrl}`,
    `Files: ${selectedResult.files.length}`,
    ...selectedResult.files.map((file) => `${file.fileName} | format=${file.formatId}`)
  ];

  navigator.clipboard
    .writeText(lines.join("\n"))
    .then(() => showToast("Copied download data."))
    .catch(() => showToast("Copy failed."));
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("opacity-0", "translate-y-3");
  setTimeout(() => {
    toast.classList.add("opacity-0", "translate-y-3");
  }, 1700);
}

function escapeHtml(input) {
  const div = document.createElement("div");
  div.textContent = input;
  return div.innerHTML;
}
