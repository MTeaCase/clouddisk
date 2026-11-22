// 云盘前端：无框架、无构建步骤，直接由 Cloudflare Pages 托管。
// 鉴权：登录后拿到 HMAC 令牌，存 localStorage，所有请求带 Authorization 头。
import { CONFIG } from "./config.js";

/* ============================ 常量与工具 ============================ */

const MiB = 1024 * 1024;
const GiB = 1024 * 1024 * 1024;
const TOKEN_KEY = "clouddisk.token";
const THEME_KEY = "clouddisk.theme";
const VIEW_KEY = "clouddisk.view";

const ICONS = {
  folder: "i-folder",
  image: "i-image",
  video: "i-video",
  audio: "i-audio",
  archive: "i-archive",
  pdf: "i-pdf",
  doc: "i-doc",
  text: "i-doc",
  file: "i-file",
};

const state = {
  token: null,
  usage: null,
  mode: "files", // files | trash | search
  path: "",
  entries: [],
  cursor: null,
  truncated: false,
  view: localStorage.getItem(VIEW_KEY) || "list",
  selection: new Set(),
  lastIndex: -1,
  sortBy: "name",
  sortDir: 1,
  query: "",
  trash: [],
  loading: false,
  theme: localStorage.getItem(THEME_KEY) || "auto",
  uploads: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const apiBase = () => {
  if (CONFIG.apiBase) return CONFIG.apiBase.replace(/\/+$/, "");
  if (location.protocol === "file:") return "http://127.0.0.1:8787";
  return location.origin;
};

const apiUrl = (path) => apiBase() + path;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtBytes(n) {
  if (n === 0) return "0 B";
  if (!n && n !== 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `昨天 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diff < 365 * 86400_000) return dateFmt.format(d).replace(/^\d{4}\//, "");
  return dateFmt.format(d);
}

const extOf = (name) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

function fileKind(name, contentType = "") {
  const ext = extOf(name);
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico", "heic"].includes(ext) || contentType.startsWith("image/")) return "image";
  if (["mp4", "webm", "mov", "mkv", "m4v", "avi"].includes(ext) || contentType.startsWith("video/")) return "video";
  if (["mp3", "wav", "flac", "m4a", "ogg", "aac"].includes(ext) || contentType.startsWith("audio/")) return "audio";
  if (ext === "pdf" || contentType === "application/pdf") return "pdf";
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(ext)) return "archive";
  if (["txt", "md", "markdown", "json", "yml", "yaml", "csv", "log", "ini", "conf", "js", "mjs", "ts", "css", "html", "htm", "xml", "sh", "py", "go", "rs", "java", "c", "h", "cpp", "sql", "toml"].includes(ext)) return "text";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key"].includes(ext)) return "doc";
  return "file";
}

const isPreviewable = (kind) => ["image", "video", "audio", "pdf", "text"].includes(kind);

/* ============================ 主题 ============================ */

function applyTheme() {
  const resolved =
    state.theme === "auto"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : state.theme;
  document.documentElement.dataset.theme = resolved;
}

function cycleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, state.theme);
  applyTheme();
}

/* ============================ API ============================ */

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function handleUnauthorized() {
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带重试的 fetch：中国大陆到 pages.dev 的链路会出现偶发连接重置，
 * 网络错误与 5xx 自动重试（幂等读请求与上传分片都是安全的）。
 */
async function fetchWithRetry(url, init, { retries = 2, baseDelay = 500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && attempt < retries) {
        await sleep(baseDelay * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(baseDelay * (attempt + 1));
    }
  }
  throw lastError ?? new Error("网络请求失败");
}

async function api(path, { method = "GET", json, headers = {}, raw = false, skipAuthRedirect = false } = {}) {
  const finalHeaders = { ...headers };
  if (state.token) finalHeaders.Authorization = `Bearer ${state.token}`;
  const init = { method, headers: finalHeaders };
  if (json !== undefined) {
    finalHeaders["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetchWithRetry(apiUrl(path), init);
  } catch {
    throw new ApiError("网络连接失败，请检查网络后重试", 0, "network");
  }
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    if (res.status === 401 && !skipAuthRedirect) handleUnauthorized();
    throw new ApiError(data?.message || `请求失败（HTTP ${res.status}）`, res.status, data?.code);
  }
  return data;
}

/* ============================ 提示与弹层 ============================ */

function toast(message, type = "info", duration = 3200) {
  const container = $("#toasts");
  while (container.children.length >= 3) container.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " is-error" : ""}`;
  el.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${type === "error" ? "i-alert" : "i-check"}"/></svg><span>${escapeHtml(message)}</span>`;
  container.append(el);
  setTimeout(() => {
    el.style.transition = "opacity 180ms ease, transform 180ms ease";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 200);
  }, duration);
}

let modalCloser = null;

function closeModal() {
  const root = $("#modal-root");
  root.innerHTML = "";
  modalCloser = null;
  if (!state.modalOpen) document.body.style.overflow = "";
}

function openModal(html, { className = "", onClose = null, onMount = null } = {}) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="overlay ${className}" role="dialog" aria-modal="true"><div class="modal ${className.includes("is-preview") ? "" : ""}">${html}</div></div>`;
  if (className.includes("is-preview")) {
    root.innerHTML = `<div class="overlay is-preview" role="dialog" aria-modal="true">${html}</div>`;
  }
  const overlay = root.firstElementChild;
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeModal();
  });
  modalCloser = onClose;
  if (onMount) onMount(overlay);
  return overlay;
}

function confirmDialog({ title, text, confirmLabel = "确定", danger = false }) {
  return new Promise((resolve) => {
    openModal(
      `<h2 class="modal-title">${escapeHtml(title)}</h2>
       <p class="modal-text">${text}</p>
       <div class="modal-actions">
         <button class="btn btn-ghost" data-act="cancel">取消</button>
         <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="ok">${escapeHtml(confirmLabel)}</button>
       </div>`,
      {
        onClose: () => resolve(false),
        onMount: (overlay) => {
          overlay.querySelector('[data-act="cancel"]').onclick = () => {
            closeModal();
            resolve(false);
          };
          overlay.querySelector('[data-act="ok"]').onclick = () => {
            closeModal();
            resolve(true);
          };
          overlay.querySelector('[data-act="ok"]').focus();
        },
      },
    );
  });
}

function promptDialog({ title, label, value = "", confirmLabel = "确定", hint = "" }) {
  return new Promise((resolve) => {
    openModal(
      `<h2 class="modal-title">${escapeHtml(title)}</h2>
       <p class="modal-text">${escapeHtml(label)}</p>
       <input type="text" id="prompt-input" value="${escapeHtml(value)}" spellcheck="false" />
       ${hint ? `<p class="modal-text" style="margin:8px 0 0;font-size:12px">${escapeHtml(hint)}</p>` : ""}
       <div class="modal-actions">
         <button class="btn btn-ghost" data-act="cancel">取消</button>
         <button class="btn btn-primary" data-act="ok">${escapeHtml(confirmLabel)}</button>
       </div>`,
      {
        onClose: () => resolve(null),
        onMount: (overlay) => {
          const input = overlay.querySelector("#prompt-input");
          input.focus();
          const dot = input.value.lastIndexOf(".");
          if (dot > 0) input.setSelectionRange(0, dot);
          else input.select();
          const ok = () => {
            const v = input.value.trim();
            if (!v) return;
            closeModal();
            resolve(v);
          };
          overlay.querySelector('[data-act="ok"]').onclick = ok;
          overlay.querySelector('[data-act="cancel"]').onclick = () => {
            closeModal();
            resolve(null);
          };
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") ok();
          });
        },
      },
    );
  });
}

/* ============================ 登录 ============================ */

function showLogin() {
  $("#login-view").hidden = false;
  $("#shell").hidden = true;
  $("#login-view").classList.add("is-visible");
  setTimeout(() => $("#password")?.focus(), 30);
  refreshIcons();
}

function showApp() {
  $("#login-view").hidden = true;
  $("#shell").hidden = false;
}

function refreshIcons() {
  // <use> 在现代浏览器里会自动渲染；这里只处理动态插入的占位
}

async function doLogin(password) {
  const btn = $("#login-submit");
  const err = $("#login-error");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "正在验证…";
  try {
    const res = await api("/api/auth/login", {
      method: "POST",
      json: { password },
      skipAuthRedirect: true,
    });
    state.token = res.token;
    localStorage.setItem(TOKEN_KEY, res.token);
    state.usage = res.usage;
    showApp();
    await boot();
  } catch (e) {
    err.textContent = e.message || "登录失败";
    err.hidden = false;
    err.classList.remove("shake");
    void err.offsetWidth;
    err.classList.add("shake");
    $("#password").select();
  } finally {
    btn.disabled = false;
    btn.textContent = "进入云盘";
  }
}

/* ============================ 启动与导航 ============================ */

async function boot() {
  applyTheme();
  setViewButtons();
  bindShellEvents();
  const initial = parseHash();
  if (initial === "trash") {
    activateNav("trash");
    await openTrash();
    refreshUsage();
  } else {
    activateNav("files");
    await Promise.all([loadDir(initial), refreshUsage()]);
  }
  refreshTrashBadge();
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return "";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* 保留原样 */
  }
  if (decoded === "trash") return "trash";
  return normalizePrefix(decoded);
}

function syncHash(value) {
  const desired =
    value === "trash"
      ? "#/trash"
      : value
        ? `#/${value.split("/").filter(Boolean).map(encodeURIComponent).join("/")}/`
        : "#/";
  if (location.hash !== desired) history.replaceState(null, "", desired);
}

function activateNav(name) {
  $$(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.nav === name));
}

function bindShellEvents() {
  if (bindShellEvents.done) return;
  bindShellEvents.done = true;

  $("#upload-btn").onclick = () => $("#file-picker").click();
  $("#empty-upload").onclick = () => $("#file-picker").click();
  $("#new-folder").onclick = createFolder;
  $("#logout").onclick = logout;
  $("#theme-toggle").onclick = cycleTheme;
  $("#sidebar-toggle").onclick = () => $("#shell").classList.toggle("nav-open");
  $("#view-list").onclick = () => setView("list");
  $("#view-grid").onclick = () => setView("grid");
  $("#quota-free").onclick = () => purgeTrash(null);
  $("#banner-action").onclick = () => purgeTrash(null);
  $("#load-more-btn").onclick = () => loadDir(state.path, { append: true });
  $("#select-all").onchange = (e) => toggleSelectAll(e.target.checked);
  $("#selection-clear").onclick = clearSelection;
  $("#selection-delete").onclick = () => deleteSelection();
  $("#selection-download").onclick = () => downloadSelection();
  $("#uploads-collapse").onclick = () => $("#uploads").classList.toggle("is-collapsed");
  $("#uploads-clear").onclick = () => {
    state.uploads = state.uploads.filter((u) => u.status === "uploading" || u.status === "queued");
    renderUploads();
  };

  $$(".nav-item").forEach((btn) => {
    btn.onclick = () => {
      activateNav(btn.dataset.nav);
      $("#shell").classList.remove("nav-open");
      if (btn.dataset.nav === "trash") openTrash();
      else {
        state.mode = "files";
        loadDir("");
        refreshUsage();
      }
    };
  });

  window.addEventListener("hashchange", () => {
    const target = parseHash();
    if (target === "trash") {
      if (state.mode !== "trash") {
        activateNav("trash");
        openTrash();
      }
      return;
    }
    if (state.mode === "files" && target === state.path) return;
    activateNav("files");
    $("#search-input").value = "";
    loadDir(target);
  });

  $$(".sortable").forEach((th) => {
    th.onclick = () => {
      const by = th.dataset.sort;
      if (state.sortBy === by) state.sortDir *= -1;
      else {
        state.sortBy = by;
        state.sortDir = 1;
      }
      renderEntries();
    };
  });

  const search = $("#search-input");
  let searchTimer = null;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = search.value.trim();
    if (!q) {
      if (state.mode === "search") {
        state.mode = "files";
        loadDir(state.path);
      }
      return;
    }
    searchTimer = setTimeout(() => runSearch(q), 320);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(searchTimer);
      const q = search.value.trim();
      if (q) runSearch(q);
    }
    if (e.key === "Escape") {
      search.value = "";
      search.blur();
      if (state.mode === "search") {
        state.mode = "files";
        loadDir(state.path);
      }
    }
  });

  $("#file-picker").onchange = (e) => {
    if (e.target.files?.length) enqueueFiles([...e.target.files], state.path, "");
    e.target.value = "";
  };
  $("#folder-picker").onchange = (e) => {
    if (e.target.files?.length) {
      const files = [...e.target.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
      enqueueFiles(files, state.path, "");
    }
    e.target.value = "";
  };

  const rows = $("#rows");
  rows.addEventListener("click", onRowClick);
  rows.addEventListener("dblclick", onRowDblClick);
  rows.addEventListener("contextmenu", onRowContextMenu);
  rows.addEventListener("change", (e) => {
    if (e.target.matches('input[type="checkbox"]')) {
      e.stopPropagation();
    }
  });

  const grid = $("#grid");
  grid.addEventListener("click", onRowClick);
  grid.addEventListener("dblclick", onRowDblClick);
  grid.addEventListener("contextmenu", onRowContextMenu);

  $("#trash-badge").parentElement.addEventListener("contextmenu", (e) => e.preventDefault());

  document.addEventListener("keydown", onKeydown);
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#menu")) hideMenu();
    if (!e.target.closest(".upload-item")) $("#uploads").classList.remove("is-collapsed");
  });

  bindDragAndDrop();
}

function logout() {
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  state.entries = [];
  state.selection.clear();
  showLogin();
  $("#password").value = "";
}

/* ============================ 目录 / 列表 ============================ */

function normalizePrefix(p) {
  if (!p) return "";
  const t = p.replace(/^\/+/, "");
  return t && !t.endsWith("/") ? `${t}/` : t;
}

function pathFromNodes(path) {
  return normalizePrefix(path);
}

async function loadDir(prefix, { append = false } = {}) {
  state.mode = "files";
  state.loading = true;
  if (!append) {
    state.path = normalizePrefix(prefix);
    state.cursor = null;
    state.truncated = false;
    clearSelection();
    renderLoading(true);
  }
  try {
    const q = new URLSearchParams({ prefix: state.path, limit: "500" });
    if (append && state.cursor) q.set("cursor", state.cursor);
    const res = await api(`/api/list?${q}`);
    const folders = (res.folders || []).map((f) => ({
      type: "folder",
      name: f.name,
      key: f.prefix,
      prefix: f.prefix,
      size: null,
      uploaded: null,
    }));
    const files = (res.files || []).map((f) => ({
      type: "file",
      name: f.name,
      key: f.key,
      size: f.size,
      uploaded: f.uploaded,
      contentType: f.contentType,
    }));
    state.entries = append ? [...state.entries, ...folders, ...files] : [...folders, ...files];
    state.cursor = res.cursor;
    state.truncated = Boolean(res.truncated);
    if (!append) syncHash(state.path);
    renderBreadcrumb();
    renderEntries();
  } catch (e) {
    if (e.status !== 401) {
      toast(e.message, "error");
      renderEmpty("加载失败", e.message);
    }
  } finally {
    state.loading = false;
    renderLoading(false);
  }
}

async function runSearch(q) {
  state.mode = "search";
  state.query = q;
  state.loading = true;
  renderLoading(true);
  try {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    state.entries = (res.files || []).map((f) => ({
      type: "file",
      name: f.name,
      key: f.key,
      size: f.size,
      uploaded: f.uploaded,
      contentType: f.contentType,
      path: f.key.slice(0, f.key.length - f.name.length),
    }));
    clearSelection();
    renderBreadcrumb();
    renderEntries();
    if (res.limited) toast("结果较多，仅显示前 200 条", "info");
  } catch (e) {
    if (e.status !== 401) toast(e.message, "error");
  } finally {
    state.loading = false;
    renderLoading(false);
  }
}

async function openTrash() {
  state.mode = "trash";
  syncHash("trash");
  state.loading = true;
  state.entries = [];
  clearSelection();
  renderBreadcrumb();
  renderLoading(true);
  try {
    const res = await api("/api/trash");
    state.trash = res.entries || [];
    state.usage = res.usage;
    renderEntries();
    renderQuota();
    refreshTrashBadge();
  } catch (e) {
    if (e.status !== 401) toast(e.message, "error");
  } finally {
    state.loading = false;
    renderLoading(false);
  }
}

function sortedEntries() {
  const items = [...state.entries];
  const dir = state.sortDir;
  items.sort((a, b) => {
    if (state.mode === "files" && a.type !== b.type) return a.type === "folder" ? -1 : 1;
    let cmp = 0;
    if (state.sortBy === "name") cmp = a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
    else if (state.sortBy === "size") cmp = (a.size ?? -1) - (b.size ?? -1);
    else if (state.sortBy === "date") cmp = (a.uploaded ?? "").localeCompare(b.uploaded ?? "");
    if (state.mode === "trash") {
      const ta = new Date(state.trash.find((t) => t.id === a.id)?.deletedAt || 0).getTime();
      const tb = new Date(state.trash.find((t) => t.id === b.id)?.deletedAt || 0).getTime();
      return (tb - ta) * dir;
    }
    return cmp * dir;
  });
  return items;
}

function renderEntries() {
  const isTrash = state.mode === "trash";
  const isEmpty = isTrash ? state.trash.length === 0 : state.entries.length === 0;
  $("#table").hidden = state.view !== "list" || isEmpty;
  $(".table-wrap").hidden = state.view !== "list" || isEmpty;
  $("#grid").hidden = state.view !== "grid" || isEmpty;
  $("#empty").hidden = !isEmpty;
  $("#load-more").hidden = isTrash || !state.truncated;
  $("#select-all").checked = false;
  renderStatus();

  if (isEmpty) {
    if (isTrash) renderEmpty("回收站是空的", "删除的文件会先放到这里，30 天后自动清理。");
    else if (state.mode === "search") renderEmpty("没有找到文件", `没有与「${state.query}」匹配的结果。`);
    else renderEmpty("这里还是空的", "把文件拖到窗口任意位置，或点击右上角「上传」。");
    renderSelectionInfo();
    return;
  }

  if (isTrash) renderTrashList();
  else if (state.view === "grid") renderGrid();
  else renderTable();
  renderSelectionInfo();
}

function renderStatus() {
  const u = state.usage;
  const count =
    state.mode === "trash" ? state.trash.length : state.entries.length;
  const folderCount = state.entries.filter((e) => e.type === "folder").length;
  const fileCount = state.entries.length - folderCount;
  let left;
  if (state.mode === "trash") left = `回收站 ${count} 项`;
  else if (state.mode === "search") left = `搜索到 ${count} 项`;
  else left = count ? `${folderCount} 个文件夹 · ${fileCount} 个文件` : "空目录";
  if (state.selection.size) left += ` · 已选 ${state.selection.size} 项`;
  $("#status-left").textContent = left;
  $("#status-right").textContent = u
    ? `已用 ${fmtBytes(u.total)} / ${fmtBytes(u.softLimit)}${u.trash > 0 ? `（含回收站 ${fmtBytes(u.trash)}）` : ""}`
    : "";
}

function renderEmpty(title, text) {
  $("#empty-title").textContent = title;
  $("#empty-text").textContent = text;
  $("#empty-upload").hidden = state.mode === "trash" || state.mode === "search";
}

function renderLoading(on) {
  $("#loading").hidden = !on;
  $("#content").classList.toggle("is-loading", on);
}

function fileIconHtml(entry) {
  const kind = entry.type === "folder" ? "folder" : fileKind(entry.name, entry.contentType || "");
  const cls = kind === "folder" ? "is-folder" : `is-${kind}`;
  return `<span class="file-icon ${cls}"><svg class="icon" aria-hidden="true"><use href="#${ICONS[kind] || "i-file"}"/></svg></span>`;
}

function actionsHtml(entry) {
  const isFolder = entry.type === "folder";
  if (state.mode === "trash") {
    return `<div class="row-actions">
      <button class="icon-btn" data-act="restore" title="恢复" aria-label="恢复"><svg class="icon" aria-hidden="true"><use href="#i-restore"/></svg></button>
      <button class="icon-btn" data-act="purge" title="永久删除" aria-label="永久删除"><svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg></button>
    </div>`;
  }
  return `<div class="row-actions">
    ${isFolder ? "" : `<button class="icon-btn" data-act="download" title="下载" aria-label="下载"><svg class="icon" aria-hidden="true"><use href="#i-download"/></svg></button>
    <button class="icon-btn" data-act="share" title="分享" aria-label="分享"><svg class="icon" aria-hidden="true"><use href="#i-share"/></svg></button>`}
    <button class="icon-btn" data-act="more" title="更多" aria-label="更多"><svg class="icon" aria-hidden="true"><use href="#i-more"/></svg></button>
  </div>`;
}

function rowKey(entry) {
  return entry.type === "folder" ? entry.prefix : entry.key;
}

function renderTable() {
  const items = sortedEntries();
  $("#rows").innerHTML = items
    .map((entry) => {
      const key = rowKey(entry);
      const selected = state.selection.has(key) ? " is-selected" : "";
      const sub = state.mode === "search" && entry.path ? `<span class="cell-size" style="margin-left:8px">${escapeHtml(entry.path)}</span>` : "";
      return `<tr data-key="${escapeHtml(key)}" class="${selected.trim()}">
        <td class="col-check"><input type="checkbox" ${state.selection.has(key) ? "checked" : ""} aria-label="选择 ${escapeHtml(entry.name)}" /></td>
        <td class="col-name"><div class="cell-name">${fileIconHtml(entry)}<span class="name">${escapeHtml(entry.name)}</span>${sub}</div></td>
        <td class="cell-size">${entry.type === "folder" ? "—" : fmtBytes(entry.size)}</td>
        <td class="cell-date">${entry.type === "folder" ? "—" : escapeHtml(fmtDate(entry.uploaded))}</td>
        <td>${actionsHtml(entry)}</td>
      </tr>`;
    })
    .join("");
  updateSortIndicators();
}

function renderGrid() {
  const items = sortedEntries();
  $("#grid").innerHTML = items
    .map((entry) => {
      const key = rowKey(entry);
      const selected = state.selection.has(key) ? " is-selected" : "";
      const kind = entry.type === "folder" ? "folder" : fileKind(entry.name, entry.contentType);
      return `<article class="card${selected}" data-key="${escapeHtml(key)}" tabindex="0">
        <input class="card-check" type="checkbox" ${state.selection.has(key) ? "checked" : ""} aria-label="选择 ${escapeHtml(entry.name)}" />
        <button class="icon-btn card-more" data-act="more" aria-label="更多"><svg class="icon" aria-hidden="true"><use href="#i-more"/></svg></button>
        <div class="card-icon is-${kind}"><svg class="icon" aria-hidden="true"><use href="#${ICONS[kind] || "i-file"}"/></svg></div>
        <div>
          <div class="card-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
          <div class="card-meta">${entry.type === "folder" ? "文件夹" : fmtBytes(entry.size)}</div>
        </div>
      </article>`;
    })
    .join("");
  updateSortIndicators();
}

function renderTrashList() {
  const items = [...state.trash].sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  state.entries = items.map((t) => ({
    type: t.isDir ? "folder" : "file",
    name: t.name,
    key: t.origKey,
    id: t.id,
    size: t.size,
    uploaded: t.deletedAt,
    isDir: t.isDir,
  }));
  $("#rows").innerHTML = items
    .map((t) => {
      const entry = state.entries.find((e) => e.id === t.id);
      return `<tr data-key="${escapeHtml(t.id)}" data-orig="${escapeHtml(t.origKey)}" class="${state.selection.has(t.id) ? "is-selected" : ""}">
        <td class="col-check"><input type="checkbox" ${state.selection.has(t.id) ? "checked" : ""} aria-label="选择 ${escapeHtml(t.name)}" /></td>
        <td class="col-name"><div class="cell-name">${fileIconHtml(entry)}<span class="name">${escapeHtml(t.name)}</span>
          <span class="cell-size" style="margin-left:8px">原位置：${escapeHtml(t.origKey.replace(/\/$/, ""))}</span></div></td>
        <td class="cell-size">${fmtBytes(t.size)}</td>
        <td class="cell-date">${escapeHtml(fmtDate(t.deletedAt))}</td>
        <td>${actionsHtml(entry)}</td>
      </tr>`;
    })
    .join("");
}

function updateSortIndicators() {
  $$(".sortable").forEach((th) => {
    th.dataset.dir = state.sortBy === th.dataset.sort ? String(state.sortDir) : "";
  });
  const label = { name: "名称", size: "大小", date: "修改时间" }[state.sortBy];
  $("#sort-info").textContent =
    state.mode === "search" ? `搜索「${state.query}」 · ${state.entries.length} 个结果` : state.entries.length ? `${state.entries.length} 项 · 按${label}${state.sortDir === 1 ? "升序" : "降序"}` : "";
}

function renderBreadcrumb() {
  const el = $("#breadcrumb");
  if (state.mode === "trash") {
    el.innerHTML = `<span class="crumb is-current">回收站</span>`;
    return;
  }
  if (state.mode === "search") {
    el.innerHTML = `<button class="crumb" data-path="">我的文件</button><span class="crumb-sep"><svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg></span><span class="crumb is-current">搜索结果</span>`;
    el.querySelector('[data-path=""]').onclick = () => {
      $("#search-input").value = "";
      loadDir("");
    };
    return;
  }
  const segments = state.path.split("/").filter(Boolean);
  let acc = "";
  const parts = [
    `<button class="crumb${segments.length ? "" : " is-current"}" data-path="">我的文件</button>`,
  ];
  for (const seg of segments) {
    acc += `${seg}/`;
    parts.push(`<span class="crumb-sep"><svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg></span>`);
    parts.push(`<button class="crumb${acc === state.path ? " is-current" : ""}" data-path="${escapeHtml(acc)}">${escapeHtml(seg)}</button>`);
  }
  el.innerHTML = parts.join("");
  $$(".crumb", el).forEach((b) => {
    b.onclick = () => {
      if (b.dataset.path !== state.path) loadDir(b.dataset.path);
    };
  });
  el.scrollLeft = el.scrollWidth;
}

/* ============================ 选择 ============================ */

function renderSelectionInfo() {
  const count = state.selection.size;
  $("#selection-info").hidden = count === 0;
  $("#selection-count").textContent = `已选择 ${count} 项`;
  if (state.mode === "trash") {
    $("#selection-download").hidden = true;
    $("#selection-delete").textContent = "永久删除";
  } else {
    $("#selection-download").hidden = false;
    $("#selection-delete").textContent = "删除";
  }
  const all = state.mode === "trash" ? state.entries.length : state.entries.length;
  $("#select-all").checked = all > 0 && count === all;
  renderStatus();
}

function clearSelection() {
  state.selection.clear();
  $$("#rows tr").forEach((tr) => {
    tr.classList.remove("is-selected");
    const cb = tr.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = false;
  });
  $$("#grid .card").forEach((c) => {
    c.classList.remove("is-selected");
    const cb = c.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = false;
  });
  renderSelectionInfo();
}

function toggleSelection(key, force) {
  if (state.selection.has(key)) state.selection.delete(key);
  else state.selection.add(key);
  syncSelectionDom();
  renderSelectionInfo();
}

function syncSelectionDom() {
  $$("#rows tr, #grid .card").forEach((el) => {
    const key = el.dataset.key;
    const on = state.selection.has(key);
    el.classList.toggle("is-selected", on);
    const cb = el.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = on;
  });
}

function toggleSelectAll(on) {
  state.selection.clear();
  if (on) {
    for (const e of state.entries) state.selection.add(state.mode === "trash" ? e.id : rowKey(e));
  }
  syncSelectionDom();
  renderSelectionInfo();
}

function currentEntriesForRow(el) {
  const key = el.dataset.key;
  if (state.mode === "trash") {
    let entry = state.entries.find((e) => e.id === key);
    if (!entry) {
      const t = state.trash.find((x) => x.id === key);
      if (t) {
        entry = { type: "trash", name: t.name, id: t.id, origKey: t.origKey, isDir: t.isDir, size: t.size };
      }
    }
    return entry;
  }
  return state.entries.find((e) => rowKey(e) === key);
}

function onRowClick(e) {
  const row = e.target.closest("[data-key]");
  if (!row) return;
  const key = row.dataset.key;
  const checkbox = e.target.closest('input[type="checkbox"]');
  if (checkbox) {
    toggleSelection(key);
    e.stopPropagation();
    return;
  }
  const actBtn = e.target.closest("[data-act]");
  if (actBtn) {
    const entry = currentEntriesForRow(row);
    handleRowAction(actBtn.dataset.act, entry, row, e);
    e.stopPropagation();
    return;
  }
  if (e.shiftKey && state.lastIndex >= 0) {
    const items = state.view === "grid" ? $$("#grid .card") : $$("#rows tr");
    const idx = [...items].findIndex((el) => el.dataset.key === key);
    const [from, to] = [state.lastIndex, idx].sort((a, b) => a - b);
    for (let i = from; i <= to; i++) state.selection.add(items[i].dataset.key);
    syncSelectionDom();
    renderSelectionInfo();
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    toggleSelection(key);
  } else {
    clearSelection();
    state.selection.add(key);
    syncSelectionDom();
    renderSelectionInfo();
  }
  const items = state.view === "grid" ? $$("#grid .card") : $$("#rows tr");
  state.lastIndex = [...items].findIndex((el) => el.dataset.key === key);
}

function onRowDblClick(e) {
  const row = e.target.closest("[data-key]");
  if (!row || e.target.closest("[data-act]") || e.target.closest('input[type="checkbox"]')) return;
  const entry = currentEntriesForRow(row);
  if (!entry) return;
  if (state.mode === "trash") return;
  if (entry.type === "folder") {
    closeModal();
    loadDir(entry.prefix || entry.key);
    $("#search-input").value = "";
  } else if (isPreviewable(fileKind(entry.name, entry.contentType))) {
    openPreview(entry);
  } else {
    downloadEntry(entry);
  }
}

function onRowContextMenu(e) {
  const row = e.target.closest("[data-key]");
  if (!row) return;
  e.preventDefault();
  const entry = currentEntriesForRow(row);
  if (!entry) return;
  if (!state.selection.has(row.dataset.key)) {
    clearSelection();
    state.selection.add(row.dataset.key);
    syncSelectionDom();
    renderSelectionInfo();
  }
  if (state.mode === "trash") {
    showMenu(e.clientX, e.clientY, [
      { label: "恢复", icon: "i-restore", act: "restore" },
      { label: "永久删除", icon: "i-trash", act: "purge", danger: true },
    ], entry);
    return;
  }
  if (entry.type === "folder") {
    showMenu(e.clientX, e.clientY, [
      { label: "打开", icon: "i-folder", act: "open" },
      { label: "重命名", icon: "i-edit", act: "rename" },
      { sep: true },
      { label: "删除", icon: "i-trash", act: "delete", danger: true },
    ], entry);
    return;
  }
  const items = [];
  const kind = fileKind(entry.name, entry.contentType);
  if (isPreviewable(kind)) items.push({ label: "预览", icon: "i-image", act: "preview" });
  items.push({ label: "下载", icon: "i-download", act: "download" });
  items.push({ label: "分享链接", icon: "i-share", act: "share" });
  items.push({ sep: true });
  items.push({ label: "重命名", icon: "i-edit", act: "rename" });
  items.push({ label: "删除", icon: "i-trash", act: "delete", danger: true });
  showMenu(e.clientX, e.clientY, items, entry);
}

/* ============================ 操作 ============================ */

async function handleRowAction(act, entry, row, e) {
  if (!entry) return;
  switch (act) {
    case "open":
      loadDir(entry.prefix || entry.key);
      break;
    case "preview":
      openPreview(entry);
      break;
    case "download":
      downloadEntry(entry);
      break;
    case "share":
      openShare(entry);
      break;
    case "rename":
      await renameEntry(entry);
      break;
    case "delete":
      if (state.mode === "trash") await purgeTrash([entry.id]);
      else {
        const ok = await confirmDialog({
          title: "移到回收站？",
          text: `「<strong>${escapeHtml(entry.name)}</strong>」将移入回收站，可随时恢复。30 天后自动清理。`,
          confirmLabel: "移到回收站",
          danger: true,
        });
        if (ok) await doDelete([rowKey(entry)], true);
      }
      break;
    case "restore":
      await restoreTrash([entry.id]);
      break;
    case "purge":
      await purgeTrash([entry.id]);
      break;
    case "more":
      showMenu(e.clientX, e.clientY, [
        { label: "下载", icon: "i-download", act: "download" },
        { label: "分享链接", icon: "i-share", act: "share" },
        { label: "重命名", icon: "i-edit", act: "rename" },
        { sep: true },
        { label: "删除", icon: "i-trash", act: "delete", danger: true },
      ], entry);
      break;
    default:
      break;
  }
}

async function createFolder() {
  const name = await promptDialog({
    title: "新建文件夹",
    label: `位置：${state.path || "我的文件"}`,
    confirmLabel: "创建",
    hint: "名称不能包含 / 或 \\",
  });
  if (!name) return;
  try {
    await api("/api/folder", { method: "POST", json: { prefix: state.path, name } });
    toast("文件夹已创建");
    await loadDir(state.path);
  } catch (e) {
    if (e.status !== 401) toast(e.message, "error");
  }
}

async function renameEntry(entry) {
  const name = await promptDialog({
    title: "重命名",
    label: entry.type === "folder" ? "文件夹名称" : "文件名（含扩展名）",
    value: entry.name,
    confirmLabel: "保存",
  });
  if (!name || name === entry.name) return;
  try {
    await api("/api/rename", { method: "POST", json: { key: rowKey(entry), name } });
    toast("已重命名");
    if (state.mode === "trash") await openTrash();
    else await loadDir(state.path);
  } catch (e) {
    if (e.status !== 401) toast(e.message, "error");
  }
}

async function doDelete(keys, quiet = false) {
  try {
    const res = await api("/api/delete", { method: "POST", json: { keys } });
    if (!quiet) toast(`已删除 ${res.trashed} 项`);
    state.usage = res.usage;
    renderQuota();
    refreshTrashBadge();
    if (state.mode === "trash") await openTrash();
    else await loadDir(state.path);
  } catch (e) {
    if (e.status !== 401) toast(e.message, "error");
  }
}

async function deleteSelection() {
  if (!state.selection.size) return;
  const keys = [...state.selection];
  if (state.mode === "trash") {
    const ok = await confirmDialog({
      title: "永久删除？",
      text: `将永久删除 <strong>${keys.length}</strong> 项，无法恢复。`,
      confirmLabel: "永久删除",
      danger: true,
    });
    if (ok) await purgeTrash(keys);
    return;
  }
  const ok = await confirmDialog({
    title: `删除 ${keys.length} 项？`,
    text: "内容会移入回收站，可随时恢复。",
    confirmLabel: "移到回收站",
    danger: true,
  });
  if (ok) await doDelete(keys);
}

async function downloadEntry(entry) {
  try {
    const res = await api("/api/share", { method: "POST", json: { key: entry.key, hours: 1 } });
    triggerDownload(res.downloadUrl, entry.name);
  } catch (e) {
    if (e.status !== 401) toast(e.message, "error");
  }
}

async function downloadSelection() {
  const files = state.entries.filter((e) => e.type === "file" && state.selection.has(e.key));
  if (!files.length) {
    toast("请选择文件（文件夹暂不支持打包下载）", "error");
    return;
  }
  if (files.length > 6) {
    const ok = await confirmDialog({
      title: `下载 ${files.length} 个文件？`,
      text: "浏览器会依次下载，可能提示“允许多个下载”。",
      confirmLabel: "开始下载",
    });
    if (!ok) return;
  }
  for (const f of files) {
    await downloadEntry(f);
    await new Promise((r) => setTimeout(r, 350));
  }
}

function triggerDownload(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "";
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}

async function restoreTrash(ids) {
  try {
    const res = await api("/api/trash/restore", { method: "POST", json: { ids } });
    toast(`已恢复 ${res.restored} 项`);
    state.usage = res.usage;
    renderQuota();
    await openTrash();
  } catch (e) {
    if (e.status !== 401) toast(e.message, "error");
  }
}

async function purgeTrash(ids) {
  const all = ids === null;
  const entries = all ? state.trash : state.trash.filter((t) => ids.includes(t.id));
  const size = entries.reduce((s, t) => s + t.size, 0);
  if (!all && !entries.length) return;
  const ok = await confirmDialog({
    title: all ? "清空回收站？" : "永久删除？",
    text: all
      ? `将永久删除回收站中的 <strong>${entries.length}</strong> 项（约 ${fmtBytes(size)}），无法恢复。`
      : `将永久删除选中的 <strong>${entries.length}</strong> 项，无法恢复。`,
    confirmLabel: all ? "清空回收站" : "永久删除",
    danger: true,
  });
  if (!ok) return;
  try {
    const res = await api("/api/trash/purge", {
      method: "POST",
      json: all ? { all: true } : { ids },
    });
    toast(all ? "回收站已清空" : "已永久删除");
    state.usage = res.usage;
    renderQuota();
    if (state.mode === "trash") await openTrash();
    else await refreshUsage();
  } catch (e) {
    if (e.status !== 401) toast(e.message, "error");
  }
}

/* ============================ 预览 ============================ */

async function openPreview(entry) {
  const kind = fileKind(entry.name, entry.contentType);
  const overlay = openModal(
    `<div class="preview">
      <div class="preview-head">
        <div class="preview-title"><b>${escapeHtml(entry.name)}</b><span>${fmtBytes(entry.size)} · 加载中…</span></div>
        <div class="preview-actions">
          <button class="icon-btn" data-act="download" aria-label="下载" title="下载"><svg class="icon" aria-hidden="true"><use href="#i-download"/></svg></button>
          <button class="icon-btn" data-act="share" aria-label="分享" title="分享"><svg class="icon" aria-hidden="true"><use href="#i-share"/></svg></button>
          <button class="icon-btn" data-act="close" aria-label="关闭" title="关闭（Esc）"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button>
        </div>
      </div>
      <div class="preview-body"><span class="spinner"></span></div>
    </div>`,
    { className: "is-preview", onClose: () => {} },
  );
  const body = overlay.querySelector(".preview-body");
  const meta = overlay.querySelector(".preview-title span");

  overlay.querySelector('[data-act="close"]').onclick = closeModal;
  overlay.querySelector('[data-act="download"]').onclick = () => downloadEntry(entry);
  overlay.querySelector('[data-act="share"]').onclick = () => openShare(entry);

  try {
    const share = await api("/api/share", { method: "POST", json: { key: entry.key, hours: 2 } });
    meta.textContent = `${fmtBytes(entry.size)} · ${fmtDate(entry.uploaded)}`;
    const url = share.url;
    if (kind === "image") {
      body.innerHTML = `<img alt="${escapeHtml(entry.name)}" src="${url}" />`;
    } else if (kind === "video") {
      body.innerHTML = `<video controls playsinline preload="metadata" src="${url}"></video>`;
    } else if (kind === "audio") {
      body.innerHTML = `<div style="text-align:center"><div class="file-icon is-audio" style="width:64px;height:64px;margin:0 auto 18px;border-radius:16px"><svg class="icon" style="width:30px;height:30px"><use href="#i-audio"/></svg></div><audio controls autoplay src="${url}"></audio></div>`;
    } else if (kind === "pdf") {
      body.innerHTML = `<iframe title="${escapeHtml(entry.name)}" src="${url}"></iframe>`;
    } else if (kind === "text") {
      const res = await fetch(url);
      if (!res.ok) throw new ApiError("读取文件失败", res.status);
      const text = await res.text();
      const snippet = text.length > 400_000 ? `${text.slice(0, 400_000)}\n\n…（文件较大，仅显示前 400KB）` : text;
      body.innerHTML = `<pre>${escapeHtml(snippet)}</pre>`;
    } else {
      body.innerHTML = `<div class="preview-fallback">
        <div class="file-icon" style="width:64px;height:64px;border-radius:16px;background:rgba(255,255,255,.08);color:#dfe6ef"><svg class="icon" style="width:30px;height:30px"><use href="#${ICONS[kind] || "i-file"}"/></svg></div>
        <p>该格式不支持在线预览</p>
        <button class="btn btn-primary" data-act="download2"><svg class="icon" aria-hidden="true"><use href="#i-download"/></svg>下载文件</button>
      </div>`;
      body.querySelector('[data-act="download2"]').onclick = () => downloadEntry(entry);
    }
  } catch (e) {
    if (e.status !== 401) {
      body.innerHTML = `<div class="preview-fallback"><p>${escapeHtml(e.message)}</p></div>`;
    }
  }
}

async function openShare(entry) {
  const hours = 24;
  const overlay = openModal(
    `<h2 class="modal-title">分享链接</h2>
     <p class="modal-text">任何拿到链接的人都可以在有效期内访问「<strong>${escapeHtml(entry.name)}</strong>」。</p>
     <label class="field"><span class="field-label">有效期</span>
       <select id="share-ttl">
         <option value="1">1 小时</option>
         <option value="24" selected>1 天</option>
         <option value="168">7 天</option>
         <option value="720">30 天</option>
       </select>
     </label>
     <label class="field"><span class="field-label">链接</span>
       <span class="field-wrap"><input type="text" id="share-url" readonly value="生成中…" /><button type="button" class="field-action" id="share-copy">复制</button></span>
     </label>
     <p class="modal-text" style="margin-top:10px;font-size:12px">链接到期自动失效；如需提前撤销，请重新生成或删除文件。</p>
     <div class="modal-actions"><button class="btn btn-ghost" data-act="close">关闭</button>
     <button class="btn btn-primary" data-act="regen">重新生成</button></div>`,
    {
      onMount: async (root) => {
        const input = root.querySelector("#share-url");
        const ttl = root.querySelector("#share-ttl");
        const gen = async () => {
          try {
            const res = await api("/api/share", {
              method: "POST",
              json: { key: entry.key, hours: Number(ttl.value) },
            });
            input.value = res.url;
            input.dataset.download = res.downloadUrl;
          } catch (e) {
            input.value = e.message;
          }
        };
        await gen();
        ttl.onchange = gen;
        root.querySelector('[data-act="regen"]').onclick = gen;
        root.querySelector('[data-act="close"]').onclick = closeModal;
        root.querySelector("#share-copy").onclick = async () => {
          try {
            await navigator.clipboard.writeText(input.value);
            toast("链接已复制");
          } catch {
            input.select();
            document.execCommand("copy");
            toast("链接已复制");
          }
        };
      },
    },
  );
  void overlay;
  void hours;
}

/* ============================ 用量 ============================ */

async function refreshUsage(force = false) {
  try {
    const res = await api(`/api/usage${force ? "?refresh=1" : ""}`);
    state.usage = res.usage;
    renderQuota();
  } catch (e) {
    if (e.status !== 401) console.warn("usage failed", e);
  }
}

function renderQuota() {
  const u = state.usage;
  if (!u) return;
  const soft = u.softLimit;
  const pct = Math.min(100, (u.total / soft) * 100);
  const box = $("#quota");
  box.classList.toggle("is-warn", pct >= 80 && pct < 100);
  box.classList.toggle("is-full", pct >= 100);
  $("#quota-fill").style.width = `${pct.toFixed(1)}%`;
  $("#quota-percent").textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  $("#quota-text").innerHTML = `
    <div>${fmtBytes(u.total)} / ${fmtBytes(soft)}</div>
    <div style="opacity:.75">${fmtBytes(soft)} 起停止上传</div>
    ${u.trash > 0 ? `<div style="margin-top:4px;color:var(--warn)">回收站占用 ${fmtBytes(u.trash)}</div>` : ""}`;
  $("#quota-free").hidden = !(u.trash > 0);
  $("#quota-free").textContent = `清空回收站，释放 ${fmtBytes(u.trash)}`;
  renderStatus();

  const banner = $("#banner");
  const blocked = u.total >= soft;
  banner.hidden = !blocked;
  if (blocked) {
    $("#banner-text").textContent = `空间已满：已用 ${fmtBytes(u.total)}，达到 ${fmtBytes(soft)} 上限，上传已停止。`;
    const action = $("#banner-action");
    action.hidden = !(u.trash > 0);
    action.textContent = u.trash > 0 ? `清空回收站释放 ${fmtBytes(u.trash)}` : "";
  }
}

async function refreshTrashBadge() {
  try {
    const res = await api("/api/trash");
    const badge = $("#trash-badge");
    const n = (res.entries || []).length;
    badge.hidden = n === 0;
    badge.textContent = String(n);
    state.usage = res.usage;
    renderQuota();
  } catch {
    /* 忽略：回收站统计不是关键路径 */
  }
}

/* ============================ 上传 ============================ */

class UploadItem {
  constructor(file, targetPrefix, relPath) {
    this.id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.file = file;
    this.name = file.name;
    this.size = file.size;
    this.prefix = targetPrefix;
    this.rel = relPath || "";
    this.key = `${targetPrefix}${this.rel ? `${this.rel}/` : ""}${file.name}`;
    this.loaded = 0;
    this.status = "queued";
    this.error = "";
    this.speed = 0;
    this.lastTick = 0;
    this.lastLoaded = 0;
  }
}

function enqueueFiles(items, targetPrefix, relRoot) {
  const files = items.map((it) => (it instanceof File ? it : it.file));
  const entries = items.map((it) =>
    it instanceof File ? new UploadItem(it, targetPrefix, "") : new UploadItem(it.file, targetPrefix, it.rel),
  );
  if (!entries.length) return;
  const blocked = state.usage && state.usage.total >= state.usage.softLimit;
  if (blocked) {
    toast("空间已满，上传已停止。请先清空回收站。", "error", 5000);
    return;
  }
  state.uploads.push(...entries);
  renderUploads();
  pumpQueue();
  void files;
  void relRoot;
}

const MAX_PARALLEL = 2;
let activeCount = 0;

function pumpQueue() {
  while (activeCount < MAX_PARALLEL) {
    const next = state.uploads.find((u) => u.status === "queued");
    if (!next) break;
    activeCount++;
    next.status = "uploading";
    uploadOne(next)
      .catch(() => {})
      .finally(() => {
        activeCount--;
        pumpQueue();
      });
  }
}

function xhrRequest({ url, body, headers = {}, onProgress, retries = 2 }) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded);
      };
      xhr.onload = () => {
        // 5xx 视为可重试（例如边缘节点临时故障）
        if (xhr.status >= 500 && n < retries) {
          setTimeout(() => attempt(n + 1), 600 * (n + 1));
          return;
        }
        const etag = xhr.getResponseHeader("ETag") || xhr.getResponseHeader("etag") || "";
        resolve({ status: xhr.status, text: xhr.responseText, etag });
      };
      xhr.onerror = () => {
        if (n < retries) setTimeout(() => attempt(n + 1), 600 * (n + 1));
        else reject(new ApiError("网络中断，请重试", 0, "network"));
      };
      xhr.ontimeout = () => {
        if (n < retries) setTimeout(() => attempt(n + 1), 600 * (n + 1));
        else reject(new ApiError("上传超时，请重试", 0, "timeout"));
      };
      xhr.timeout = 30 * 60 * 1000;
      xhr.send(body);
    };
    attempt(0);
  });
}

function parseXhrJson(res) {
  try {
    return JSON.parse(res.text);
  } catch {
    return {};
  }
}

async function uploadOne(item) {
  item.status = "uploading";
  item.error = "";
  item.loaded = 0;
  item.lastTick = performance.now();
  item.lastLoaded = 0;
  renderUploads();

  try {
    await uploadDirect(item);
    finishUpload(item);
    return;
  } catch (err) {
    // 配额/重名等业务错误不重试；网络、5xx、CORS 类问题回退到 Worker 代理通道
    const fallbackable = !err.status || err.status >= 500 || err.status === 403 || err.status === 404;
    if (!fallbackable) {
      failUpload(item, err);
      return;
    }
    console.warn("直连 R2 失败，回退 Worker 代理通道：", err.message);
  }

  try {
    await uploadProxied(item);
  } catch (err) {
    failUpload(item, err);
  }
}

function finishUpload(item) {
  item.status = "done";
  item.loaded = item.size;
  item.speed = 0;
  renderUploads();
  scheduleRefreshAfterUpload();
  refreshUsage(true);
}

function failUpload(item, err) {
  item.status = "error";
  item.error = err?.message || "上传失败";
  item.speed = 0;
  renderUploads();
  if (err?.status === 401) handleUnauthorized();
  else if (err?.status === 507) {
    toast(err.message, "error", 6000);
    refreshUsage(true);
  }
}

function progressTracker(item) {
  return (loaded) => {
    item.loaded = loaded;
    const now = performance.now();
    if (now - item.lastTick > 400) {
      item.speed = ((loaded - item.lastLoaded) / (now - item.lastTick)) * 1000;
      item.lastTick = now;
      item.lastLoaded = loaded;
      updateUploadRow(item);
    }
  };
}

/** 浏览器 ⇄ R2 直连（预签名 URL）。实测比经 Pages 代理快 20 倍以上。 */
async function uploadDirect(item) {
  const contentType = item.file.type || "application/octet-stream";
  const init = await api("/api/pm/init", {
    method: "POST",
    json: { key: item.key, size: item.size, contentType },
  });
  const onProgress = progressTracker(item);

  if (init.mode === "direct-single") {
    const res = await xhrRequest({
      url: init.url,
      body: item.file,
      headers: { "Content-Type": contentType },
      onProgress,
    });
    if (res.status !== 200) {
      throw new ApiError(`直传失败（HTTP ${res.status}）${res.text ? `：${res.text.slice(0, 120)}` : ""}`, res.status || 0);
    }
    return;
  }

  const plan = await api("/api/pm/parts", {
    method: "POST",
    json: { key: item.key, uploadId: init.uploadId, count: init.parts },
  });
  const uploaded = [];
  try {
    for (const p of plan.parts) {
      const start = (p.partNumber - 1) * init.partSize;
      const end = Math.min(item.size, start + init.partSize);
      const res = await xhrRequest({
        url: p.url,
        body: item.file.slice(start, end),
        headers: { "Content-Type": "application/octet-stream" },
        onProgress: (loaded) => onProgress(start + loaded),
      });
      if (res.status !== 200) throw new ApiError(`分片 ${p.partNumber} 直传失败（HTTP ${res.status}）`, res.status || 0);
      if (!res.etag) {
        throw new ApiError("R2 未返回 ETag：请确认存储桶 CORS 暴露了 ETag 头", 0);
      }
      uploaded.push({ partNumber: p.partNumber, etag: res.etag.replace(/^W\//, "") });
      item.loaded = end;
      updateUploadRow(item);
    }
    const done = await api("/api/pm/complete", {
      method: "POST",
      json: { key: item.key, uploadId: init.uploadId, size: item.size, parts: uploaded },
    });
    if (done.usage) {
      state.usage = done.usage;
      renderQuota();
    }
  } catch (err) {
    await api("/api/pm/abort", {
      method: "POST",
      json: { key: item.key, uploadId: init.uploadId },
    }).catch(() => {});
    throw err;
  }
}

/** 旧通道：经 Worker 代理转发（兼容直连不可用的情况，如桶 CORS 未配置）。 */
async function uploadProxied(item) {
  item.status = "uploading";
  item.error = "";
  item.loaded = 0;
  item.lastTick = performance.now();
  item.lastLoaded = 0;
  renderUploads();

  const auth = { Authorization: `Bearer ${state.token}` };
  const onProgress = progressTracker(item);

  const contentType = item.file.type || "application/octet-stream";
  const init = await api("/api/upload/init", {
    method: "POST",
    json: { key: item.key, size: item.size, contentType },
  });

  if (init.mode === "single") {
    const res = await xhrRequest({
      url: apiUrl(`/api/upload/put?key=${encodeURIComponent(item.key)}&ct=${encodeURIComponent(contentType)}`),
      body: item.file,
      headers: auth,
      onProgress,
    });
    const data = parseXhrJson(res);
    if (res.status !== 200) throw new ApiError(data.message || `上传失败（${res.status}）`, res.status, data.code);
  } else {
    const partSize = init.partSize;
    const totalParts = Math.ceil(item.size / partSize);
    const uploaded = [];
    for (let i = 0; i < totalParts; i++) {
      const start = i * partSize;
      const end = Math.min(item.size, start + partSize);
      const base = start;
      const res = await xhrRequest({
        url: apiUrl(
          `/api/upload/part?key=${encodeURIComponent(item.key)}&uploadId=${encodeURIComponent(init.uploadId)}&n=${i + 1}`,
        ),
        body: item.file.slice(start, end),
        headers: auth,
        onProgress: (loaded) => onProgress(base + loaded),
      });
      const data = parseXhrJson(res);
      if (res.status !== 200) {
        await api("/api/upload/abort", { method: "POST", json: { key: item.key, uploadId: init.uploadId } }).catch(() => {});
        throw new ApiError(data.message || `分片 ${i + 1} 上传失败`, res.status, data.code);
      }
      uploaded.push({ partNumber: data.partNumber, etag: data.etag });
      item.loaded = end;
      updateUploadRow(item);
    }
    const done = await api("/api/upload/complete", {
      method: "POST",
      json: { key: item.key, uploadId: init.uploadId, size: item.size, parts: uploaded },
    });
    if (done.usage) {
      state.usage = done.usage;
      renderQuota();
    }
  }

  finishUpload(item);
}

let refreshTimer = null;
function scheduleRefreshAfterUpload() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (state.mode === "files") loadDir(state.path);
  }, 500);
}

function updateUploadRow(item) {
  const row = $(`.upload-item[data-id="${item.id}"]`);
  if (!row) return;
  const pct = item.size ? Math.min(100, (item.loaded / item.size) * 100) : 0;
  row.querySelector(".upload-bar span").style.width = `${pct}%`;
  const status = row.querySelector(".upload-status");
  status.textContent = `${fmtBytes(item.loaded)} / ${fmtBytes(item.size)} · ${fmtBytes(item.speed)}/s`;
  status.className = "upload-status";
}

function renderUploads() {
  const panel = $("#uploads");
  const active = state.uploads;
  if (!active.length) {
    panel.hidden = true;
    return;
  }
  scheduleUploadCleanup();
  panel.hidden = false;
  const running = active.filter((u) => u.status === "uploading" || u.status === "queued").length;
  const done = active.filter((u) => u.status === "done").length;
  const totalSize = active.reduce((s, u) => s + u.size, 0);
  const loadedSize = active.reduce((s, u) => s + u.loaded, 0);
  $("#uploads-title").textContent = running
    ? `正在上传 ${active.length - done} / ${active.length} 项`
    : done === active.length
      ? `已上传 ${done} 项`
      : "上传队列";
  $("#uploads-speed").textContent = `${fmtBytes(loadedSize)} / ${fmtBytes(totalSize)}`;
  $("#uploads-clear").hidden = !active.some((u) => u.status === "done");

  $("#upload-list").innerHTML = active
    .map((u) => {
      const pct = u.size ? Math.min(100, (u.loaded / u.size) * 100) : u.status === "done" ? 100 : 0;
      const cls =
        u.status === "done" ? "is-done" : u.status === "error" ? "is-error" : "";
      const statusText =
        u.status === "done"
          ? "已完成"
          : u.status === "error"
            ? u.error
            : u.status === "queued"
              ? "等待中"
              : `${fmtBytes(u.loaded)} / ${fmtBytes(u.size)}`;
      return `<li class="upload-item ${cls}" data-id="${u.id}">
        <div class="upload-top">
          <span class="upload-name" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}</span>
          <span class="upload-status ${u.status === "error" ? "is-error" : u.status === "done" ? "is-done" : ""}">${escapeHtml(statusText)}</span>
          ${u.status === "error" ? `<button class="text-btn" data-retry="${u.id}">重试</button>` : ""}
        </div>
        <div class="upload-bar"><span style="width:${pct}%"></span></div>
      </li>`;
    })
    .join("");

  $$("[data-retry]").forEach((btn) => {
    btn.onclick = () => {
      const item = state.uploads.find((u) => u.id === btn.dataset.retry);
      if (!item) return;
      item.status = "queued";
      item.error = "";
      renderUploads();
      pumpQueue();
    };
  });
}

/* 全部完成后 6 秒自动收起，失败的条目保留以便重试 */
let cleanupTimer = null;
function scheduleUploadCleanup() {
  clearTimeout(cleanupTimer);
  const all = state.uploads;
  if (!all.length) return;
  if (!all.every((u) => u.status === "done" || u.status === "error")) return;
  if (!all.some((u) => u.status === "done")) return;
  cleanupTimer = setTimeout(() => {
    state.uploads = state.uploads.filter((u) => u.status !== "done");
    renderUploads();
  }, 6000);
}

/* ============================ 菜单 ============================ */

let menuEntry = null;

function showMenu(x, y, items, entry) {
  const menu = $("#menu");
  menuEntry = entry;
  menu.innerHTML = items
    .map((it) =>
      it.sep
        ? `<div class="menu-sep"></div>`
        : `<button class="menu-item${it.danger ? " is-danger" : ""}" data-act="${it.act}">
             <svg class="icon" aria-hidden="true"><use href="#${it.icon}"/></svg>${escapeHtml(it.label)}</button>`,
    )
    .join("");
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  $$(".menu-item", menu).forEach((btn) => {
    btn.onclick = () => {
      hideMenu();
      handleRowAction(btn.dataset.act, menuEntry, null, { clientX: x, clientY: y });
    };
  });
}

function hideMenu() {
  $("#menu").hidden = true;
}

/* ============================ 拖拽与键盘 ============================ */

function bindDragAndDrop() {
  let depth = 0;
  const overlay = $("#drop-overlay");

  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    depth++;
    overlay.hidden = false;
    $("#drop-target").textContent = state.mode === "trash" ? "我的文件" : state.path || "我的文件";
  });

  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });

  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });

  window.addEventListener("drop", async (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    if (state.mode === "trash") {
      toast("回收站中不能上传，请先返回「我的文件」", "error");
      return;
    }
    const items = [...e.dataTransfer.items];
    const plainFiles = [...e.dataTransfer.files];
    if (!plainFiles.length) return;

    if (items.length && items[0].webkitGetAsEntry) {
      const entries = items.map((i) => i.webkitGetAsEntry()).filter(Boolean);
      if (entries.some((en) => en?.isDirectory)) {
        const collected = [];
        await Promise.all(entries.map((en) => walkEntry(en, collected, "")));
        enqueueFiles(collected, state.path, "");
        return;
      }
    }
    enqueueFiles(plainFiles, state.path, "");
  });
}

function walkEntry(entry, out, rel) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => {
          out.push({ file, rel: rel || "" });
          resolve();
        },
        () => resolve(),
      );
      return;
    }
    if (!entry.isDirectory) return resolve();
    const reader = entry.createReader();
    const readAll = () => {
      reader.readEntries(
        async (entries) => {
          if (!entries.length) return resolve();
          await Promise.all(entries.map((en) => walkEntry(en, out, rel ? `${rel}/${entry.name}` : entry.name)));
          readAll();
        },
        () => resolve(),
      );
    };
    readAll();
  });
}

function onKeydown(e) {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable;

  if (e.key === "Escape") {
    if ($("#modal-root").children.length) {
      closeModal();
      return;
    }
    if (!$("#menu").hidden) {
      hideMenu();
      return;
    }
    if (state.selection.size) {
      clearSelection();
      return;
    }
    if (typing) document.activeElement.blur();
    return;
  }

  if (typing) return;

  if (e.key === "/") {
    e.preventDefault();
    $("#search-input").focus();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "u") {
    e.preventDefault();
    $("#file-picker").click();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selection.size) {
      e.preventDefault();
      deleteSelection();
    }
    return;
  }
  if (e.key === "F2" && state.selection.size === 1) {
    const key = [...state.selection][0];
    const entry = state.entries.find((x) => rowKey(x) === key || x.id === key);
    if (entry) {
      e.preventDefault();
      renameEntry(entry);
    }
    return;
  }
  if (e.key === "Enter" && state.selection.size === 1) {
    const key = [...state.selection][0];
    const entry = state.entries.find((x) => rowKey(x) === key);
    if (entry) {
      e.preventDefault();
      if (entry.type === "folder") loadDir(entry.prefix);
      else if (isPreviewable(fileKind(entry.name, entry.contentType))) openPreview(entry);
      else downloadEntry(entry);
    }
  }
}

/* ============================ 启动 ============================ */

async function main() {
  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "auto") applyTheme();
  });

  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const pw = $("#password").value;
    if (pw) doLogin(pw);
  });
  $("#toggle-password").addEventListener("click", () => {
    const input = $("#password");
    const type = input.type === "password" ? "text" : "password";
    input.type = type;
    $("#toggle-password").textContent = type === "password" ? "显示" : "隐藏";
    input.focus();
  });

  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) {
    state.token = saved;
    try {
      const me = await api("/api/auth/me", { skipAuthRedirect: true });
      state.usage = me.usage;
      showApp();
      await boot();
      return;
    } catch (e) {
      if (e.status !== 401) {
        // 网络问题：先进入界面，让用户看到错误
        showApp();
        await boot();
        return;
      }
      state.token = null;
      localStorage.removeItem(TOKEN_KEY);
    }
  }
  showLogin();
}

function setView(view) {
  state.view = view;
  localStorage.setItem(VIEW_KEY, view);
  setViewButtons();
  renderEntries();
}

function setViewButtons() {
  $("#view-list").setAttribute("aria-pressed", String(state.view === "list"));
  $("#view-grid").setAttribute("aria-pressed", String(state.view === "grid"));
}

main();