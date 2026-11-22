/**
 * R2 数据层：目录列举、用量统计（含 9.5 GiB 软上限判定）、复制/重命名、
 * 回收站（软删除）、配额检查。全部只依赖 R2 binding，不依赖额外数据库。
 */
import { copyViaS3, r2Config } from "./sigv4";
import type { Env } from "./util";
import {
  baseName,
  guessContentType,
  HttpError,
  normalizeKey,
  normalizePrefix,
} from "./util";

export const TRASH_PREFIX = "_trash/";
const MARKER_CONTENT_TYPE = "application/x-directory";
/** 小于该值用内存缓冲复制（足够快），大于则走分片远程复制。 */
const SINGLE_COPY_MAX = 64 * 1024 * 1024;
const COPY_CHUNK = 16 * 1024 * 1024;
const LIST_PAGE = 1000;

export interface Usage {
  /** 全部对象字节数（含回收站） */
  total: number;
  /** 回收站占用字节数 */
  trash: number;
  /** 正常文件占用 = total - trash */
  live: number;
  /** 对象数量 */
  objects: number;
  softLimit: number;
  hardLimit: number;
  /** 是否已到达软上限，禁止继续上传 */
  uploadBlocked: boolean;
  /** 剩余可上传字节（相对软上限） */
  remaining: number;
  /** 回收站是否还有可清理的内容 */
  canFree: number;
  updatedAt: number;
}

let usageCache: { at: number; value: Promise<Usage> } | null = null;
const USAGE_TTL_MS = 6_000;

export function invalidateUsage(): void {
  usageCache = null;
}

export function softLimit(env: Env): number {
  return Number(env.QUOTA_SOFT_BYTES) || 10200690688;
}

export function hardLimit(env: Env): number {
  return Number(env.QUOTA_HARD_BYTES) || 10737418240;
}

export async function getUsage(env: Env, force = false): Promise<Usage> {
  const fresh = usageCache && Date.now() - usageCache.at < USAGE_TTL_MS ? usageCache.value : null;
  if (fresh && !force) return fresh;
  const value = computeUsage(env);
  usageCache = { at: Date.now(), value };
  try {
    return await value;
  } catch (err) {
    usageCache = null;
    throw err;
  }
}

async function computeUsage(env: Env): Promise<Usage> {
  let cursor: string | undefined;
  let total = 0;
  let trash = 0;
  let objects = 0;
  do {
    const page = await env.BUCKET.list({ cursor, limit: LIST_PAGE });
    for (const obj of page.objects) {
      total += obj.size;
      objects++;
      if (obj.key.startsWith(TRASH_PREFIX)) trash += obj.size;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const soft = softLimit(env);
  const live = total - trash;
  return {
    total,
    trash,
    live,
    objects,
    softLimit: soft,
    hardLimit: hardLimit(env),
    uploadBlocked: total >= soft,
    remaining: Math.max(0, soft - total),
    canFree: trash,
    updatedAt: Date.now(),
  };
}

/** 上传前校验：单文件大小 + 剩余额度（force 刷新，尽量准确）。 */
export async function assertCanUpload(env: Env, size: number): Promise<Usage> {
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, "bad_size", "文件大小无效");
  if (size > 5 * 1024 ** 3) throw new HttpError(413, "too_large", "单个文件不能超过 5 GiB");
  const usage = await getUsage(env, true);
  if (usage.total + size > usage.softLimit) {
    const remaining = Math.max(0, usage.softLimit - usage.total);
    throw new HttpError(
      507,
      "quota_exceeded",
      `空间不足：剩余 ${(remaining / 1024 ** 3).toFixed(2)} GiB，该文件 ${(size / 1024 ** 3).toFixed(2)} GiB。` +
        (usage.trash > 0 ? "可清空回收站释放空间。" : ""),
    );
  }
  return usage;
}

export interface FolderEntry {
  name: string;
  prefix: string;
}

export interface FileEntry {
  key: string;
  name: string;
  size: number;
  uploaded: string;
  contentType: string;
  etag: string;
}

export interface ListResult {
  prefix: string;
  folders: FolderEntry[];
  files: FileEntry[];
  cursor: string | null;
  truncated: boolean;
}

function toFileEntry(obj: R2Object): FileEntry {
  return {
    key: obj.key,
    name: baseName(obj.key),
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
    contentType: obj.httpMetadata?.contentType ?? guessContentType(obj.key),
    etag: obj.etag,
  };
}

export async function listDirectory(
  env: Env,
  rawPrefix: string | null,
  cursor: string | null,
  limit: number,
): Promise<ListResult> {
  const prefix = normalizePrefix(rawPrefix);
  const page = await env.BUCKET.list({
    prefix,
    delimiter: "/",
    cursor: cursor ?? undefined,
    limit: Math.min(Math.max(limit, 1), LIST_PAGE),
  });
  const folders: FolderEntry[] = page.delimitedPrefixes.map((p) => ({
    name: p.slice(prefix.length).replace(/\/$/, ""),
    prefix: p,
  }));
  const files = page.objects
    .filter((o) => !o.key.endsWith("/"))
    .map(toFileEntry);
  return {
    prefix,
    folders,
    files,
    cursor: page.truncated ? page.cursor : null,
    truncated: page.truncated,
  };
}

/** 全桶搜索（按名称子串匹配，最多扫描 20000 个对象）。 */
export async function searchObjects(env: Env, query: string, limit = 200) {
  const needle = query.trim().toLowerCase();
  if (!needle) return { files: [] as FileEntry[], scanned: 0, limited: false };
  let cursor: string | undefined;
  let scanned = 0;
  const files: FileEntry[] = [];
  do {
    const page = await env.BUCKET.list({ cursor, limit: LIST_PAGE });
    for (const obj of page.objects) {
      scanned++;
      if (obj.key.startsWith(TRASH_PREFIX) || obj.key.endsWith("/")) continue;
      if (obj.key.toLowerCase().includes(needle)) files.push(toFileEntry(obj));
      if (files.length >= limit) return { files, scanned, limited: true };
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && scanned < 20000);
  return { files, scanned, limited: scanned >= 20000 };
}

export async function headObject(env: Env, rawKey: string): Promise<R2Object | null> {
  const key = normalizeKey(rawKey);
  return env.BUCKET.head(key);
}

export async function getObject(
  env: Env,
  rawKey: string,
  range?: { offset: number; length: number },
): Promise<R2ObjectBody | null> {
  const key = normalizeKey(rawKey);
  return env.BUCKET.get(key, range ? { range } : undefined);
}

export async function createFolder(env: Env, rawPrefix: string, name: string): Promise<void> {
  const prefix = normalizePrefix(rawPrefix);
  const safeName = name.trim();
  if (!safeName || /[/\\]/.test(safeName) || safeName === "." || safeName === ".." || safeName.length > 200) {
    throw new HttpError(400, "bad_name", "文件夹名称无效（不能包含 / \\ ，长度 1-200）");
  }
  const key = normalizeKey(`${prefix}${safeName}/`);
  const existing = await env.BUCKET.head(key);
  if (existing) throw new HttpError(409, "exists", "同名文件夹已存在");
  await env.BUCKET.put(key, new Uint8Array(0), {
    httpMetadata: { contentType: MARKER_CONTENT_TYPE },
  });
  invalidateUsage();
}

/** 复制对象到新键（保留 content-type 与自定义元数据）。
 *  优先用 R2 服务端 CopyObject（不经 Worker 搬字节）；失败再退回本地读写。 */
export async function copyObject(env: Env, srcKey: string, dstKey: string): Promise<void> {
  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY) {
    try {
      const res = await copyViaS3(r2Config(env), srcKey, dstKey);
      if (res.status < 300) return;
      console.warn("CopyObject 失败，退回本地复制", srcKey, res.status, res.text.slice(0, 160));
    } catch (err) {
      console.warn("CopyObject 异常，退回本地复制", srcKey, err);
    }
  }

  const src = await env.BUCKET.get(srcKey);
  if (!src) throw new HttpError(404, "not_found", `找不到对象：${srcKey}`);
  const httpMetadata = src.httpMetadata;
  const customMetadata = src.customMetadata;

  if (src.size <= SINGLE_COPY_MAX) {
    const body = src.size === 0 ? new Uint8Array(0) : await src.arrayBuffer();
    await env.BUCKET.put(dstKey, body, { httpMetadata, customMetadata });
    return;
  }
  const upload = await env.BUCKET.createMultipartUpload(dstKey, { httpMetadata, customMetadata });
  const uploaded: R2UploadedPart[] = [];
  try {
    let partNumber = 1;
    for (let offset = 0; offset < src.size; offset += COPY_CHUNK) {
      const length = Math.min(COPY_CHUNK, src.size - offset);
      const partObj = await env.BUCKET.get(srcKey, { range: { offset, length } });
      if (!partObj) throw new HttpError(500, "copy_failed", "复制过程中对象分片丢失");
      const buf = await partObj.arrayBuffer();
      uploaded.push(await upload.uploadPart(partNumber++, buf));
    }
    await upload.complete(uploaded);
  } catch (err) {
    await upload.abort().catch(() => {});
    throw err;
  }
}

export async function renameObject(env: Env, rawKey: string, newName: string): Promise<string> {
  const key = normalizeKey(rawKey);
  const cleanName = newName.trim();
  if (!cleanName || /[/\\]/.test(cleanName) || cleanName === "." || cleanName === ".." || cleanName.length > 200) {
    throw new HttpError(400, "bad_name", "名称无效（不能包含 / \\ ，长度 1-200）");
  }
  const isDir = key.endsWith("/");
  const parent = key.slice(0, key.length - baseName(key).length - (isDir ? 1 : 0));
  const dst = normalizeKey(`${parent}${cleanName}${isDir ? "/" : ""}`);
  if (dst === key) return key;
  if (await env.BUCKET.head(dst)) throw new HttpError(409, "exists", "目标名称已存在");

  if (isDir) {
    await createFolder(env, parent, cleanName);
    const moved = await moveTree(env, key, dst);
    if (moved === 0) await env.BUCKET.delete(key);
  } else {
    await copyObject(env, key, dst);
    await env.BUCKET.delete(key);
  }
  invalidateUsage();
  return dst;
}

async function moveTree(env: Env, srcPrefix: string, dstPrefix: string): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  const batch: string[] = [];
  do {
    const page = await env.BUCKET.list({ prefix: srcPrefix, cursor, limit: LIST_PAGE });
    for (const obj of page.objects) {
      if (obj.key === dstPrefix && srcPrefix === dstPrefix) continue;
      const dst = dstPrefix + obj.key.slice(srcPrefix.length);
      await copyObject(env, obj.key, dst);
      batch.push(obj.key);
      count++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (batch.length) await env.BUCKET.delete(batch);
  return count;
}

/**
 * 软删除：把条目移动到 `_trash/<stamp>/<原路径>`，并在 `_trash/<stamp>/` 写一个
 * 目录标记对象保存原始元信息，便于恢复与展示。
 */
export async function trashObjects(env: Env, keys: string[]): Promise<number> {
  let trashed = 0;
  for (const raw of keys) {
    const key = normalizeKey(raw);
    const head = await env.BUCKET.head(key);
    if (!head) continue;
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const root = `${TRASH_PREFIX}${stamp}/`;
    const isDir = key.endsWith("/");
    let size = head.size;
    let count = 1;

    if (isDir) {
      const { objects, bytes } = await listAll(env, key);
      size = bytes;
      count = objects.length;
      for (const obj of objects) {
        const dst = root + obj.key;
        if (obj.key !== key || dst !== root) await copyObject(env, obj.key, dst);
      }
      if (objects.length) await env.BUCKET.delete(objects.map((o) => o.key));
    } else {
      await copyObject(env, key, root + key);
      await env.BUCKET.delete(key);
    }

    await env.BUCKET.put(root, new Uint8Array(0), {
      httpMetadata: { contentType: MARKER_CONTENT_TYPE },
      customMetadata: {
        orig: key,
        name: baseName(key),
        deletedAt: String(Date.now()),
        size: String(size),
        count: String(count),
        isDir: isDir ? "1" : "0",
      },
    });
    trashed++;
  }
  invalidateUsage();
  return trashed;
}

async function listAll(env: Env, prefix: string): Promise<{ objects: R2Object[]; bytes: number }> {
  let cursor: string | undefined;
  const objects: R2Object[] = [];
  let bytes = 0;
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: LIST_PAGE });
    objects.push(...page.objects);
    for (const o of page.objects) bytes += o.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { objects, bytes };
}

export interface TrashEntry {
  id: string;
  origKey: string;
  name: string;
  size: number;
  count: number;
  isDir: boolean;
  deletedAt: string;
}

export async function listTrash(env: Env): Promise<TrashEntry[]> {
  let cursor: string | undefined;
  const entries: TrashEntry[] = [];
  do {
    const page = await env.BUCKET.list({ prefix: TRASH_PREFIX, delimiter: "/", cursor, limit: LIST_PAGE });
    for (const p of page.delimitedPrefixes) {
      const id = p.slice(TRASH_PREFIX.length).replace(/\/$/, "");
      const marker = await env.BUCKET.head(p);
      const meta = marker?.customMetadata ?? {};
      entries.push({
        id,
        origKey: meta.orig ?? "",
        name: meta.name ?? id,
        size: Number(meta.size ?? marker?.size ?? 0),
        count: Number(meta.count ?? 1),
        isDir: meta.isDir === "1",
        deletedAt: new Date(Number(meta.deletedAt ?? 0) || Date.now()).toISOString(),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export async function restoreFromTrash(env: Env, ids: string[]): Promise<number> {
  let restored = 0;
  for (const id of ids) {
    if (!/^[a-z0-9]+$/i.test(id)) throw new HttpError(400, "bad_id", "回收站条目无效");
    const root = `${TRASH_PREFIX}${id}/`;
    const marker = await env.BUCKET.head(root);
    if (!marker) continue;
    const orig = marker.customMetadata?.orig ?? "";
    if (!orig) continue;
    const { objects } = await listAll(env, root);
    for (const obj of objects) {
      if (obj.key === root) continue;
      const dst = obj.key.slice(root.length);
      if (await env.BUCKET.head(dst)) continue; // 不覆盖同名文件
      await copyObject(env, obj.key, dst);
    }
    await env.BUCKET.delete(objects.map((o) => o.key).concat(root));
    restored++;
  }
  invalidateUsage();
  return restored;
}

export async function purgeTrash(env: Env, ids: string[] | null): Promise<number> {
  let removed = 0;
  const targets = ids ?? (await listTrash(env)).map((e) => e.id);
  for (const id of targets) {
    const root = `${TRASH_PREFIX}${id}/`;
    const { objects } = await listAll(env, root);
    if (!objects.length) continue;
    await env.BUCKET.delete(objects.map((o) => o.key));
    removed += objects.length;
  }
  invalidateUsage();
  return removed;
}

/** Cron：清理超过保留期的回收站条目。 */
export async function purgeExpiredTrash(env: Env): Promise<{ purged: number; entries: number }> {
  const days = Number(env.TRASH_RETENTION_DAYS) || 30;
  const cutoff = Date.now() - days * 86400_000;
  const entries = await listTrash(env);
  const stale = entries.filter((e) => new Date(e.deletedAt).getTime() < cutoff).map((e) => e.id);
  if (!stale.length) return { purged: 0, entries: entries.length };
  let purged = 0;
  for (const id of stale) purged += await purgeTrash(env, [id]);
  return { purged, entries: entries.length };
}

/** 新建分片上传；返回 uploadId 与建议分片大小。 */
export const PART_SIZE = 16 * 1024 * 1024;
export const SINGLE_PUT_MAX = 24 * 1024 * 1024;

export async function beginMultipart(env: Env, rawKey: string, contentType: string) {
  const key = normalizeKey(rawKey);
  const upload = await env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: contentType || guessContentType(key) },
  });
  return { key, uploadId: upload.uploadId, partSize: PART_SIZE };
}

export async function putSmallObject(
  env: Env,
  rawKey: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<R2Object> {
  const key = normalizeKey(rawKey);
  if (await env.BUCKET.head(`${key}`)) throw new HttpError(409, "exists", "同名文件已存在");
  const obj = await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: contentType || guessContentType(key) },
  });
  invalidateUsage();
  return obj;
}