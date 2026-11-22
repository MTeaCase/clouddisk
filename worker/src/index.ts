/**
 * 个人云盘 API（Cloudflare Worker + R2）
 *
 * 设计要点
 * - 单用户：密码登录换取 HMAC 签名令牌，无 KV / D1 依赖
 * - 所有数据传输都经过 Worker → R2 binding，浏览器不直连 R2，避免跨域/CORS 与
 *   `*.r2.cloudflarestorage.com` 在中国大陆的连通性问题
 * - 大文件走 R2 multipart（16 MiB 分片，在 Worker 100 MiB 请求体上限内），支持进度显示
 * - 配额：10 GiB 硬上限、9.5 GiB 停止上传，基于真实对象列表统计（含回收站）
 */
import {
  checkPassword,
  createMediaToken,
  createSessionToken,
  requireSession,
  resetLoginThrottle,
  throttleLogin,
  authorizeObject,
} from "./auth";
import {
  assertCanUpload,
  beginMultipart,
  createFolder,
  getObject,
  getUsage,
  headObject,
  invalidateUsage,
  listDirectory,
  listTrash,
  PART_SIZE,
  purgeExpiredTrash,
  purgeTrash,
  putSmallObject,
  renameObject,
  restoreFromTrash,
  searchObjects,
  SINGLE_PUT_MAX,
  trashObjects,
} from "./store";
import {
  abortMultipart,
  completeMultipart,
  createMultipart,
  presign,
  r2Config,
  s3Request,
} from "./sigv4";
import type { Env } from "./util";
import {
  contentDisposition,
  corsHeaders,
  errorResponse,
  formatBytes,
  guessContentType,
  HttpError,
  json,
  normalizeKey,
  parseRange,
  withCommonHeaders,
} from "./util";

const VERSION = "1.0.0";
const MAX_PART_BYTES = 32 * 1024 * 1024;
const MAX_BODY_SMALL = SINGLE_PUT_MAX + 1024 * 1024;
/** 超过该大小的文件走浏览器直连 R2（预签名），否则仍由 Worker 流式转发。 */
const DIRECT_MIN_BYTES = 1024 * 1024;
/** 直连单次 PUT 的上限；更大的走 S3 分片。 */
const DIRECT_SINGLE_MAX = 32 * 1024 * 1024;
const DIRECT_URL_TTL = 6 * 3600;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (path === "/" || path === "/api/health") {
        return json(request, env, {
          ok: true,
          service: "clouddisk-api",
          version: VERSION,
          time: new Date().toISOString(),
        });
      }

      if (!path.startsWith("/api/")) {
        throw new HttpError(404, "not_found", "接口不存在");
      }
      const route = path.slice(4); // 去掉 /api
      const ctx: Ctx = { request, env, url, method };

      switch (`${method} ${route}`) {
        case "POST /auth/login":
          return await handleLogin(ctx);
        case "GET /auth/me":
          return await handleMe(ctx);
        case "GET /usage":
          return await handleUsage(ctx);
        case "GET /list":
          return await handleList(ctx);
        case "GET /search":
          return await handleSearch(ctx);
        case "POST /folder":
          return await handleMkdir(ctx);
        case "PUT /upload/put":
          return await handlePut(ctx);
        case "POST /upload/init":
          return await handleInit(ctx);
        case "PUT /upload/part":
          return await handlePart(ctx);
        case "POST /upload/complete":
          return await handleComplete(ctx);
        case "POST /upload/abort":
          return await handleAbort(ctx);
        case "POST /pm/init":
          return await handlePmInit(ctx);
        case "POST /pm/parts":
          return await handlePmParts(ctx);
        case "POST /pm/complete":
          return await handlePmComplete(ctx);
        case "POST /pm/abort":
          return await handlePmAbort(ctx);
        case "GET /file":
        case "HEAD /file":
          return await handleFile(ctx);
        case "GET /stat":
          return await handleStat(ctx);
        case "POST /rename":
          return await handleRename(ctx);
        case "POST /delete":
          return await handleDelete(ctx);
        case "GET /trash":
          return await handleTrashList(ctx);
        case "POST /trash/restore":
          return await handleTrashRestore(ctx);
        case "POST /trash/purge":
          return await handleTrashPurge(ctx);
        case "POST /share":
          return await handleShare(ctx);
        case "POST /admin/cors":
          return await handleEnsureCors(ctx);
        default:
          throw new HttpError(404, "not_found", `不支持的操作：${method} ${route}`);
      }
    } catch (err) {
      return errorResponse(request, env, err);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      purgeExpiredTrash(env).then((r) => console.log("trash purge", JSON.stringify(r))),
    );
  },
} satisfies ExportedHandler<Env>;

interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  method: string;
}

async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new HttpError(415, "bad_content_type", "请使用 application/json 提交");
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "bad_json", "请求体不是合法 JSON");
  }
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local";
}

async function handleLogin({ request, env }: Ctx): Promise<Response> {
  const ip = clientIp(request);
  throttleLogin(ip);
  const body = await readJson<{ password?: string }>(request);
  if (!body.password || typeof body.password !== "string") {
    throw new HttpError(400, "bad_password", "请输入密码");
  }
  const ok = await checkPassword(env, body.password);
  if (!ok) throw new HttpError(401, "wrong_password", "密码错误");
  resetLoginThrottle(ip);
  const session = await createSessionToken(env);
  const usage = await getUsage(env);
  return json(request, env, {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    usage,
  });
}

async function handleMe({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const usage = await getUsage(env);
  return json(request, env, { ok: true, usage, limits: { soft: usage.softLimit, hard: usage.hardLimit } });
}

async function handleUsage({ request, env, url }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const force = url.searchParams.get("refresh") === "1";
  return json(request, env, { ok: true, usage: await getUsage(env, force) });
}

async function handleList({ request, env, url }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const prefix = url.searchParams.get("prefix");
  const cursor = url.searchParams.get("cursor");
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const result = await listDirectory(env, prefix, cursor, limit);
  return json(request, env, { ok: true, ...result });
}

async function handleSearch({ request, env, url }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const q = url.searchParams.get("q") ?? "";
  const result = await searchObjects(env, q, 200);
  return json(request, env, { ok: true, ...result });
}

async function handleMkdir({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ prefix?: string; name?: string }>(request);
  await createFolder(env, body.prefix ?? "", body.name ?? "");
  return json(request, env, { ok: true });
}

/** 小文件：一次 PUT 直接写入（≤ 24 MiB）。 */
async function handlePut({ request, env, url }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const rawKey = url.searchParams.get("key");
  if (!rawKey) throw new HttpError(400, "bad_key", "缺少 key 参数");
  const key = normalizeKey(rawKey);
  const headerLength = Number(request.headers.get("Content-Length") ?? "0");
  if (headerLength > MAX_BODY_SMALL) {
    throw new HttpError(413, "too_large", "小文件直传上限 24 MiB，请改用分片上传");
  }
  const body = await request.arrayBuffer();
  const declared = headerLength || body.byteLength;
  if (!declared) throw new HttpError(400, "bad_size", "文件内容为空");
  if (declared > MAX_BODY_SMALL) {
    throw new HttpError(413, "too_large", "小文件直传上限 24 MiB，请改用分片上传");
  }
  await assertCanUpload(env, declared);
  if (body.byteLength !== declared) throw new HttpError(400, "size_mismatch", "上传数据长度与声明不一致");
  const contentType =
    url.searchParams.get("ct") || request.headers.get("X-File-Type") || guessContentType(key);
  const obj = await putSmallObject(env, key, body, contentType);
  const usage = await getUsage(env, true);
  return json(request, env, {
    ok: true,
    file: { key: obj.key, size: obj.size, etag: obj.etag, uploaded: obj.uploaded.toISOString() },
    usage,
  });
}

async function handleInit({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ key?: string; size?: number; contentType?: string }>(request);
  const key = normalizeKey(body.key ?? "");
  const size = Number(body.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, "bad_size", "文件大小无效");
  if (size <= SINGLE_PUT_MAX) {
    return json(request, env, { ok: true, mode: "single", key, maxBytes: SINGLE_PUT_MAX });
  }
  if (await headObject(env, key)) throw new HttpError(409, "exists", "同名文件已存在");
  const usage = await assertCanUpload(env, size);
  const started = await beginMultipart(env, key, body.contentType ?? guessContentType(key));
  return json(request, env, {
    ok: true,
    mode: "multipart",
    key: started.key,
    uploadId: started.uploadId,
    partSize: started.partSize ?? PART_SIZE,
    parts: Math.ceil(size / (started.partSize ?? PART_SIZE)),
    usage,
  });
}

async function handlePart({ request, env, url }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const key = normalizeKey(url.searchParams.get("key") ?? "");
  const uploadId = url.searchParams.get("uploadId") ?? "";
  const partNumber = Number(url.searchParams.get("n") ?? "0");
  if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
    throw new HttpError(400, "bad_request", "缺少 uploadId 或分片序号");
  }
  const headerLength = Number(request.headers.get("Content-Length") ?? "0");
  if (headerLength > MAX_PART_BYTES) {
    throw new HttpError(413, "part_too_large", "单个分片不能超过 32 MiB");
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) throw new HttpError(400, "empty_part", "分片内容为空");
  if (body.byteLength > MAX_PART_BYTES) {
    throw new HttpError(413, "part_too_large", "单个分片不能超过 32 MiB");
  }
  const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
  const part = await upload.uploadPart(partNumber, body);
  return json(request, env, { ok: true, partNumber: part.partNumber, etag: part.etag });
}

async function handleComplete({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{
    key?: string;
    uploadId?: string;
    size?: number;
    parts?: { partNumber: number; etag: string }[];
  }>(request);
  const key = normalizeKey(body.key ?? "");
  if (!body.uploadId || !Array.isArray(body.parts) || body.parts.length === 0) {
    throw new HttpError(400, "bad_request", "缺少 uploadId / parts");
  }
  const upload = env.BUCKET.resumeMultipartUpload(key, body.uploadId);
  const obj = await upload.complete(body.parts);
  invalidateUsage();
  const usage = await getUsage(env, true);

  // 超硬上限的文件不允许保留（先校验再决定，绝不悄悄突破 10 GiB）
  if (usage.total > usage.hardLimit) {
    await env.BUCKET.delete(key);
    invalidateUsage();
    throw new HttpError(
      507,
      "hard_limit",
      `已超出 ${formatBytes(usage.hardLimit)} 硬上限，本次上传已回滚`,
    );
  }
  if (obj.size !== Number(body.size)) {
    console.warn("size mismatch after complete", key, obj.size, body.size);
  }
  return json(request, env, {
    ok: true,
    file: { key: obj.key, size: obj.size, etag: obj.etag, uploaded: obj.uploaded.toISOString() },
    usage,
  });
}

async function handleAbort({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ key?: string; uploadId?: string }>(request);
  const key = normalizeKey(body.key ?? "");
  if (!body.uploadId) throw new HttpError(400, "bad_request", "缺少 uploadId");
  await env.BUCKET.resumeMultipartUpload(key, body.uploadId).abort().catch(() => {});
  return json(request, env, { ok: true });
}

/* ---------- 浏览器直连 R2（预签名）通道 ---------- */

const PM_PART_SIZE = 16 * 1024 * 1024;
const MAX_PARTS = 700;

async function handlePmInit({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ key?: string; size?: number; contentType?: string }>(request);
  const key = normalizeKey(body.key ?? "");
  const size = Number(body.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, "bad_size", "文件大小无效");
  if (size > 5 * 1024 ** 3) throw new HttpError(413, "too_large", "单个文件不能超过 5 GiB");
  if (await headObject(env, key)) throw new HttpError(409, "exists", "同名文件已存在");
  const usage = await assertCanUpload(env, size);
  const cfg = r2Config(env);

  if (size <= DIRECT_SINGLE_MAX) {
    const url = await presign(cfg, { method: "PUT", key, expiresIn: DIRECT_URL_TTL });
    return json(request, env, {
      ok: true,
      mode: "direct-single",
      key,
      url,
      expiresIn: DIRECT_URL_TTL,
      usage,
    });
  }

  const parts = Math.ceil(size / PM_PART_SIZE);
  if (parts > MAX_PARTS) throw new HttpError(413, "too_many_parts", "文件过大（分片数超过上限）");
  const uploadId = await createMultipart(cfg, key, body.contentType || guessContentType(key));
  return json(request, env, {
    ok: true,
    mode: "direct-multipart",
    key,
    uploadId,
    partSize: PM_PART_SIZE,
    parts,
    expiresIn: DIRECT_URL_TTL,
    usage,
  });
}

async function handlePmParts({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ key?: string; uploadId?: string; count?: number }>(request);
  const key = normalizeKey(body.key ?? "");
  const uploadId = body.uploadId ?? "";
  if (!uploadId) throw new HttpError(400, "bad_request", "缺少 uploadId");
  const count = Math.floor(Number(body.count ?? 0));
  if (!Number.isFinite(count) || count < 1 || count > MAX_PARTS) {
    throw new HttpError(400, "bad_count", "分片数量无效");
  }
  const cfg = r2Config(env);
  const urls: { partNumber: number; url: string }[] = [];
  for (let n = 1; n <= count; n++) {
    urls.push({
      partNumber: n,
      url: await presign(cfg, {
        method: "PUT",
        key,
        expiresIn: DIRECT_URL_TTL,
        query: { partNumber: String(n), uploadId },
      }),
    });
  }
  return json(request, env, { ok: true, parts: urls });
}

async function handlePmComplete({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{
    key?: string;
    uploadId?: string;
    size?: number;
    parts?: { partNumber: number; etag: string }[];
  }>(request);
  const key = normalizeKey(body.key ?? "");
  if (!body.uploadId || !Array.isArray(body.parts) || body.parts.length === 0) {
    throw new HttpError(400, "bad_request", "缺少 uploadId / parts");
  }
  const cfg = r2Config(env);
  await completeMultipart(cfg, key, body.uploadId, body.parts);

  invalidateUsage();
  const head = await headObject(env, key);
  if (!head) throw new HttpError(502, "complete_missing", "分片合并完成但找不到对象");
  const usage = await getUsage(env, true);
  if (usage.total > usage.hardLimit) {
    await env.BUCKET.delete(key);
    invalidateUsage();
    throw new HttpError(507, "hard_limit", `已超出 ${formatBytes(usage.hardLimit)} 硬上限，本次上传已回滚`);
  }
  if (Number(body.size) && head.size !== Number(body.size)) {
    console.warn("size mismatch after direct complete", key, head.size, body.size);
  }
  return json(request, env, {
    ok: true,
    file: { key: head.key, size: head.size, etag: head.etag, uploaded: head.uploaded.toISOString() },
    usage,
  });
}

async function handlePmAbort({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ key?: string; uploadId?: string }>(request);
  const key = normalizeKey(body.key ?? "");
  if (!body.uploadId) throw new HttpError(400, "bad_request", "缺少 uploadId");
  try {
    await abortMultipart(r2Config(env), key, body.uploadId);
  } catch {
    /* 取消失败不影响用户体验 */
  }
  return json(request, env, { ok: true });
}

async function handleFile({ request, env, url }: Ctx): Promise<Response> {
  const rawKey = url.searchParams.get("key");
  if (!rawKey) throw new HttpError(400, "bad_key", "缺少 key 参数");
  const key = normalizeKey(rawKey);
  const mediaToken = url.searchParams.get("t");
  const auth = await authorizeObject(request, env, key, mediaToken);

  const download =
    auth.download || url.searchParams.get("dl") === "1" || url.searchParams.get("inline") === "0";
  const head = await headObject(env, key);
  if (!head) throw new HttpError(404, "not_found", "文件不存在或已被删除");

  const isDirMarker = key.endsWith("/") || head.httpMetadata?.contentType === "application/x-directory";
  if (isDirMarker) throw new HttpError(400, "is_folder", "这是一个文件夹");

  const totalSize = head.size;
  const range = parseRange(request.headers.get("Range"), totalSize);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: withCommonHeaders({ "Content-Range": `bytes */${totalSize}` }),
    });
  }

  const head2 = head.httpMetadata ?? {};
  let contentType = head2.contentType || guessContentType(key);
  const name = key.slice(key.lastIndexOf("/") + 1);

  // 大文件直接 302 到 R2 预签名地址：浏览器 ⇄ R2 直连，绕开 Pages/Worker 中转的跨境瓶颈
  if (totalSize >= DIRECT_MIN_BYTES && url.searchParams.get("stream") !== "1") {
    try {
      const cfg = r2Config(env);
      const location = await presign(cfg, {
        method: "GET",
        key,
        expiresIn: 300,
        responseContentDisposition: contentDisposition(name, !download),
      });
      return new Response(null, {
        status: 302,
        headers: {
          Location: location,
          "Cache-Control": "private, no-store",
          ...corsHeaders(request, env),
        },
      });
    } catch (err) {
      console.warn("presign 不可用，回退为流式转发", err);
    }
  }

  // 用户上传的 HTML/SVG 一律按纯文本预览，防止在 API 域执行脚本
  const dangerous = /html|svg|xml/i.test(contentType) || /\.(html?|svg|xhtml)$/i.test(name);
  if (dangerous) contentType = "text/plain; charset=utf-8";

  const obj = await getObject(env, key, range === null ? undefined : range);
  if (!obj) throw new HttpError(404, "not_found", "文件不存在或已被删除");

  const headers = withCommonHeaders({
    "Content-Type": contentType,
    "Content-Length": String(range === null ? totalSize : range.length),
    "Content-Disposition": contentDisposition(name, !download),
    ETag: head.etag,
    "Accept-Ranges": "bytes",
    "Cache-Control": auth.viaMediaToken ? "public, max-age=300" : "private, no-store",
    "Last-Modified": head.uploaded.toUTCString(),
  });
  if (dangerous) headers.set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  if (range !== null) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${totalSize}`);
  }
  for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);

  return new Response(request.method === "HEAD" ? null : obj.body, {
    status: range === null ? 200 : 206,
    headers,
  });
}

async function handleStat({ request, env, url }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const key = normalizeKey(url.searchParams.get("key") ?? "");
  const head = await headObject(env, key);
  if (!head) throw new HttpError(404, "not_found", "文件不存在");
  return json(request, env, {
    ok: true,
    file: {
      key: head.key,
      name: key.slice(key.lastIndexOf("/") + 1),
      size: head.size,
      contentType: head.httpMetadata?.contentType ?? guessContentType(key),
      uploaded: head.uploaded.toISOString(),
      etag: head.etag,
    },
  });
}

async function handleRename({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ key?: string; name?: string }>(request);
  const key = await renameObject(env, body.key ?? "", body.name ?? "");
  return json(request, env, { ok: true, key });
}

async function handleDelete({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ keys?: string[] }>(request);
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new HttpError(400, "bad_request", "未选择要删除的内容");
  }
  const trashed = await trashObjects(env, body.keys.slice(0, 200));
  const usage = await getUsage(env, true);
  return json(request, env, { ok: true, trashed, usage });
}

async function handleTrashList({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const [entries, usage] = await Promise.all([listTrash(env), getUsage(env)]);
  return json(request, env, { ok: true, entries, usage });
}

async function handleTrashRestore({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ ids?: string[] }>(request);
  if (!Array.isArray(body.ids) || !body.ids.length) throw new HttpError(400, "bad_request", "未选择条目");
  if (body.ids.length > 100) throw new HttpError(400, "too_many", "一次最多恢复 100 项");
  const restored = await restoreFromTrash(env, body.ids);
  return json(request, env, { ok: true, restored, usage: await getUsage(env, true) });
}

async function handleTrashPurge({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ ids?: string[]; all?: boolean }>(request);
  const ids = body.all ? null : Array.isArray(body.ids) ? body.ids.slice(0, 100) : null;
  if (!body.all && !ids?.length) throw new HttpError(400, "bad_request", "未选择条目");
  const removed = await purgeTrash(env, ids);
  return json(request, env, { ok: true, removed, usage: await getUsage(env, true) });
}

/** 一次性运维操作：给桶配置 CORS，让浏览器可以直传/直读 R2（无 Cookie，允许 *）。 */
async function handleEnsureCors({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const xml =
    `<CORSConfiguration><CORSRule>` +
    `<AllowedOrigin>*</AllowedOrigin>` +
    `<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>` +
    `<AllowedHeader>*</AllowedHeader>` +
    `<ExposeHeader>ETag</ExposeHeader><ExposeHeader>Content-Length</ExposeHeader><ExposeHeader>Content-Range</ExposeHeader>` +
    `<MaxAgeSeconds>3600</MaxAgeSeconds>` +
    `</CORSRule></CORSConfiguration>`;
  const res = await s3Request(r2Config(env), {
    method: "PUT",
    query: { cors: "" },
    body: xml,
    contentType: "application/xml",
  });
  if (res.status >= 300) {
    throw new HttpError(502, "cors_failed", `设置 CORS 失败：${res.text.slice(0, 200)}`);
  }
  const check = await s3Request(r2Config(env), { method: "GET", query: { cors: "" } });
  return json(request, env, { ok: true, applied: check.status === 200, current: check.text.slice(0, 400) });
}

async function handleShare({ request, env }: Ctx): Promise<Response> {
  await requireSession(request, env);
  const body = await readJson<{ key?: string; hours?: number }>(request);
  const key = normalizeKey(body.key ?? "");
  const hours = Math.min(Math.max(Number(body.hours ?? 24), 1), 24 * 30);
  const head = await headObject(env, key);
  if (!head) throw new HttpError(404, "not_found", "文件不存在");

  const inline = await createMediaToken(env, key, hours * 3600, false);
  const dl = await createMediaToken(env, key, hours * 3600, true);
  const origin = new URL(request.url).origin;
  const encoded = encodeURIComponent(key);
  return json(request, env, {
    ok: true,
    key,
    expiresAt: inline.expiresAt,
    url: `${origin}/api/file?key=${encoded}&t=${inline.token}`,
    downloadUrl: `${origin}/api/file?key=${encoded}&t=${dl.token}&dl=1`,
    mediaToken: inline.token,
    downloadToken: dl.token,
  });
}
