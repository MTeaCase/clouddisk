/**
 * 通用工具：JSON 响应、CORS、Range 解析、base64url、常量时间比较。
 */

export interface Env {
  BUCKET: R2Bucket;
  /** 登录密码（wrangler secret） */
  ACCESS_PASSWORD: string;
  /** 会话签名密钥（wrangler secret） */
  SESSION_SECRET: string;
  /** R2 S3 凭证，仅用于签发预签名 URL / 服务端分片合并（wrangler secret） */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_ENDPOINT?: string;
  R2_ACCOUNT_ID?: string;
  QUOTA_HARD_BYTES: string;
  QUOTA_SOFT_BYTES: string;
  TRASH_RETENTION_DAYS: string;
  ALLOWED_ORIGINS: string;
}

export interface AuthPayload {
  /** 会话 id，仅用于日志/撤销扩展 */
  sid: string;
  /** 过期时间（Unix 秒） */
  exp: number;
  /** session = 登录态；media = 单文件签名（下载/预览/分享） */
  scope: "session" | "media";
  /** media 签名绑定的对象键 */
  key?: string;
  /** media 签名：1 = 作为附件下载 */
  dl?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes("*")
    ? "*"
    : origin && allowed.includes(origin)
      ? origin
      : allowed[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Expose-Headers":
      "Content-Length,Content-Range,Content-Disposition,ETag,X-Usage-Bytes",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(
  request: Request,
  env: Env,
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
      ...corsHeaders(request, env),
      ...headers,
    },
  });
}

export function errorResponse(request: Request, env: Env, err: unknown): Response {
  if (err instanceof HttpError) {
    return json(request, env, { ok: false, code: err.code, message: err.message }, err.status);
  }
  console.error("unhandled", err instanceof Error ? (err.stack ?? err.message) : String(err));
  return json(
    request,
    env,
    { ok: false, code: "internal_error", message: "服务器内部错误，请稍后重试" },
    500,
  );
}

export function withCommonHeaders(headers: Record<string, string> = {}): Headers {
  const h = new Headers(headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  return h;
}

/** 解析 `Range: bytes=a-b` 请求头，返回 R2 需要的 offset/length。 */
export function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return "invalid";
  if (rawStart === "") {
    // suffix range: bytes=-500 → 最后 500 字节
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || start >= size || end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64_ALPHABET[c & 63];
  }
  return out;
}

export function b64urlDecode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base64url");
    buf = (buf << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function b64urlFromString(s: string): string {
  return b64urlEncode(new TextEncoder().encode(s));
}

export function stringFromB64url(s: string): string {
  return new TextDecoder().decode(b64urlDecode(s));
}

/** 常量时间比较，避免计时侧信道。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatBytes(n: number): string {
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

/**
 * 规范化对象键：去掉开头的 /，拒绝 `..`，保证不越出桶的虚拟根目录。
 * 允许以 `/` 结尾（目录标记）。
 */
export function normalizeKey(input: string): string {
  if (typeof input !== "string") throw new HttpError(400, "bad_key", "路径无效");
  const trimmed = input.replace(/^\/+/, "");
  const segments = trimmed.split("/");
  for (const seg of segments.slice(0, -1)) {
    if (seg === ".." || seg === ".") throw new HttpError(400, "bad_key", "路径中不允许出现 .. 或 .");
  }
  const last = segments[segments.length - 1];
  if (last === ".." || last === ".") throw new HttpError(400, "bad_key", "文件名不允许为 . 或 ..");
  if (trimmed.length === 0 || trimmed.length > 512) throw new HttpError(400, "bad_key", "路径长度无效");
  // 保留目录标记，其余去掉多余的 //
  return segments.filter((s, i) => s.length > 0 || i === segments.length - 1).join("/");
}

export function normalizePrefix(input: string | null): string {
  if (!input) return "";
  const p = input.replace(/^\/+/, "");
  if (p === "") return "";
  if (p.includes("..")) throw new HttpError(400, "bad_prefix", "路径无效");
  return p.endsWith("/") ? p : `${p}/`;
}

export function baseName(key: string): string {
  const noTrailing = key.endsWith("/") ? key.slice(0, -1) : key;
  const idx = noTrailing.lastIndexOf("/");
  return idx >= 0 ? noTrailing.slice(idx + 1) : noTrailing;
}

export function parentPrefix(key: string): string {
  const noTrailing = key.endsWith("/") ? key.slice(0, -1) : key;
  const idx = noTrailing.lastIndexOf("/");
  return idx >= 0 ? noTrailing.slice(0, idx + 1) : "";
}

/** RFC 5987 文件名，兼容中文。 */
export function contentDisposition(name: string, inline: boolean): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function isTextLike(contentType: string, name: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/")) return true;
  if (/(json|xml|javascript|yaml|csv|x-sh|toml)/.test(ct)) return true;
  return /\.(md|markdown|txt|log|conf|ini|yml|yaml|json|ts|js|tsx|jsx|css|html|py|go|rs|java|c|h|cpp|sh|sql|toml)$/i.test(
    name,
  );
}

export const MIME_BY_EXT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function guessContentType(name: string, fallback = "application/octet-stream"): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? fallback;
}