/**
 * R2 的 S3 接口签名（AWS SigV4）。
 *
 * 用途：把大文件传输从「浏览器 → Pages 代理 → Worker → R2」改成
 * 「浏览器 ⇄ R2 直连」，Worker 只负责签发一次性预签名 URL 并做配额/元数据校验。
 * 实测中国大陆链路：经 pages.dev 代理上传约 60 KB/s，直连 R2 约 1.5 MB/s 且更稳定。
 *
 * 只用 WebCrypto，无第三方依赖；既支持生成预签名 URL（浏览器侧发起），
 * 也支持服务端直接发起（分片初始化/完成、桶 CORS 配置）。
 */
import { type Env, HttpError } from "./util";

const enc = new TextEncoder();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const raw = key instanceof Uint8Array ? key.slice().buffer : key;
  const cryptoKey = await crypto.subtle.importKey("raw", raw as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 对象键 → URL 路径（保留 /，其余逐段编码）。 */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(awsEncode).join("/");
}

export interface R2Config {
  accessKeyId: string;
  secretAccessKey: string;
  accountId: string;
  bucket: string;
  endpoint: string;
}

export function r2Config(env: Env): R2Config {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new HttpError(500, "no_s3_credentials", "未配置 R2 S3 凭证（R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）");
  }
  return {
    accessKeyId,
    secretAccessKey,
    accountId: env.R2_ACCOUNT_ID || "auto",
    bucket: env.R2_BUCKET || "clouddisk",
    endpoint: (env.R2_ENDPOINT || "").replace(/\/+$/, ""),
  };
}

function nowStamp(date = new Date()): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

async function signingKey(cfg: R2Config, dateStamp: string): Promise<ArrayBuffer> {
  const kDate = await hmac(enc.encode(`AWS4${cfg.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, "auto");
  const kService = await hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${awsEncode(k)}=${awsEncode(params[k] ?? "")}`)
    .join("&");
}

/** 生成预签名 URL（浏览器可直接 PUT/GET，URL 本身即凭证）。 */
export async function presign(
  cfg: R2Config,
  opts: {
    method: "GET" | "PUT" | "HEAD" | "DELETE" | "POST";
    key: string;
    expiresIn?: number;
    query?: Record<string, string>;
    responseContentDisposition?: string;
  },
): Promise<string> {
  const { amzDate, dateStamp } = nowStamp();
  const host = new URL(cfg.endpoint).host;
  const path = `/${cfg.bucket}/${encodeKeyPath(opts.key)}`;
  const credential = `${cfg.accessKeyId}/${dateStamp}/auto/s3/aws4_request`;

  const query: Record<string, string> = { ...(opts.query ?? {}) };
  if (opts.responseContentDisposition) {
    query["response-content-disposition"] = opts.responseContentDisposition;
  }
  query["X-Amz-Algorithm"] = "AWS4-HMAC-SHA256";
  query["X-Amz-Credential"] = credential;
  query["X-Amz-Date"] = amzDate;
  query["X-Amz-Expires"] = String(opts.expiresIn ?? 3600);
  query["X-Amz-SignedHeaders"] = "host";

  const canonicalRequest = [
    opts.method,
    path,
    canonicalQuery(query),
    `host:${host}\n`,
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = hex(await hmac(await signingKey(cfg, dateStamp), stringToSign));
  return `${cfg.endpoint}${path}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

export interface S3Response {
  status: number;
  text: string;
  headers: Headers;
}

/** 服务端直接调用 S3 接口（用于分片初始化/完成、桶配置等）。 */
export async function s3Request(
  cfg: R2Config,
  opts: {
    method: "GET" | "PUT" | "POST" | "DELETE";
    key?: string;
    query?: Record<string, string>;
    body?: string;
    contentType?: string;
    /** 额外参与签名的请求头（例如 CopyObject 的 x-amz-copy-source） */
    extraHeaders?: Record<string, string>;
    /** 桶级请求（CORS/Lifecycle 等），key 为空且 path 指定 */
    bucketPath?: string;
  },
): Promise<S3Response> {
  const { amzDate, dateStamp } = nowStamp();
  const host = new URL(cfg.endpoint).host;
  const path = opts.bucketPath
    ? `/${cfg.bucket}${opts.bucketPath}`
    : opts.key
      ? `/${cfg.bucket}/${encodeKeyPath(opts.key)}`
      : `/${cfg.bucket}`;
  const body = opts.body ?? "";
  const payloadHash = opts.body ? await sha256Hex(opts.body) : EMPTY_SHA256;
  const query = opts.query ?? {};

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(opts.extraHeaders ?? {}),
  };
  if (opts.contentType) headers["content-type"] = opts.contentType;

  const signedHeadersList = Object.keys(headers).sort();
  const canonicalHeaders = signedHeadersList.map((k) => `${k}:${headers[k]}\n`).join("");
  const canonicalRequest = [
    opts.method,
    path,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeadersList.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signature = hex(await hmac(await signingKey(cfg, dateStamp), stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeadersList.join(";")}, Signature=${signature}`;

  const qs = canonicalQuery(query);
  const url = `${cfg.endpoint}${path}${qs ? `?${qs}` : ""}`;
  const init: RequestInit = {
    method: opts.method,
    headers: { ...headers, Authorization: authorization },
  };
  if (opts.body) init.body = body;

  const res = await fetch(url, init);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/* ---------- 分片上传封装 ---------- */

export async function createMultipart(cfg: R2Config, key: string, contentType: string) {
  const res = await s3Request(cfg, {
    method: "POST",
    key,
    query: { uploads: "" },
    contentType,
  });
  if (res.status >= 300) throw new HttpError(502, "r2_create_failed", `R2 分片初始化失败：${res.text.slice(0, 200)}`);
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(res.text)?.[1];
  if (!uploadId) throw new HttpError(502, "r2_create_failed", "R2 未返回 uploadId");
  return uploadId;
}

export async function completeMultipart(
  cfg: R2Config,
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
) {
  const xml =
    `<CompleteMultipartUpload>` +
    parts
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
      .join("") +
    `</CompleteMultipartUpload>`;
  const res = await s3Request(cfg, {
    method: "POST",
    key,
    query: { uploadId },
    body: xml,
    contentType: "application/xml",
  });
  if (res.status >= 300) throw new HttpError(502, "r2_complete_failed", `R2 分片合并失败：${res.text.slice(0, 200)}`);
  return res;
}

export async function abortMultipart(cfg: R2Config, key: string, uploadId: string) {
  await s3Request(cfg, { method: "DELETE", key, query: { uploadId } }).catch(() => {});
}

/** R2 服务端复制（CopyObject）：不经过 Worker 搬运字节，大文件重命名/删除几乎瞬时。 */
export async function copyViaS3(cfg: R2Config, srcKey: string, dstKey: string): Promise<S3Response> {
  return s3Request(cfg, {
    method: "PUT",
    key: dstKey,
    extraHeaders: { "x-amz-copy-source": `/${cfg.bucket}/${encodeKeyPath(srcKey)}` },
  });
}

export async function headViaS3(cfg: R2Config, key: string) {
  const res = await s3Request(cfg, { method: "GET", key, query: {} });
  return res;
}