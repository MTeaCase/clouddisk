/**
 * 内存版 R2Bucket，语义尽量贴近真实 R2：
 * head/get(含 range)/put/delete/list(prefix+delimiter+cursor)/multipart。
 * 仅用于本地逻辑联调（真实 R2 的验收在部署后用 HTTP 跑）。
 */

function toStream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

let etagCounter = 0;

export class R2BucketMock {
  constructor() {
    this.objects = new Map();
    this.uploads = new Map();
    this.ops = { put: 0, get: 0, list: 0 };
  }

  #record(key, value, options = {}) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    const obj = {
      body: bytes,
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
      uploaded: new Date(),
      etag: `"${(++etagCounter).toString(16).padStart(16, "0")}"`,
    };
    this.objects.set(key, obj);
    return obj;
  }

  #meta(key, obj, extra = {}) {
    return {
      key,
      version: "1",
      size: obj.body.length,
      etag: obj.etag,
      httpEtag: obj.etag,
      uploaded: obj.uploaded,
      httpMetadata: obj.httpMetadata,
      customMetadata: obj.customMetadata,
      ...extra,
    };
  }

  async head(key) {
    const obj = this.objects.get(key);
    return obj ? this.#meta(key, obj) : null;
  }

  async get(key, options = {}) {
    this.ops.get++;
    const obj = this.objects.get(key);
    if (!obj) return null;
    if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== obj.etag) return null;
    if (options.range) {
      const { offset = 0, length } = options.range;
      const slice = obj.body.slice(offset, length === undefined ? obj.body.length : offset + length);
      return {
        ...this.#meta(key, obj, { range: { offset, length: slice.length } }),
        body: toStream(slice),
        async arrayBuffer() {
          return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
        },
        async text() {
          return new TextDecoder().decode(slice);
        },
      };
    }
    const bytes = obj.body;
    return {
      ...this.#meta(key, obj),
      body: toStream(bytes),
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      async text() {
        return new TextDecoder().decode(bytes);
      },
    };
  }

  async put(key, value, options = {}) {
    this.ops.put++;
    const obj = this.#record(key, value, options);
    return this.#meta(key, obj);
  }

  async delete(keys) {
    if (Array.isArray(keys)) {
      let n = 0;
      for (const k of keys) if (this.objects.delete(k)) n++;
      return n;
    }
    this.objects.delete(keys);
  }

  async list(options = {}) {
    this.ops.list++;
    const prefix = options.prefix ?? "";
    const delimiter = options.delimiter;
    const limit = options.limit ?? 1000;
    const offset = options.cursor ? Number(options.cursor) : 0;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const folders = new Set();
    const files = [];
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      if (delimiter) {
        const idx = rest.indexOf(delimiter);
        if (idx >= 0) {
          folders.add(prefix + rest.slice(0, idx + 1));
          continue;
        }
      }
      files.push(this.#meta(key, this.objects.get(key)));
    }
    const all = files.slice(offset, offset + limit);
    const truncated = offset + limit < files.length;
    return {
      objects: all,
      delimitedPrefixes: [...folders].sort(),
      truncated,
      cursor: truncated ? String(offset + limit) : undefined,
    };
  }

  async createMultipartUpload(key, options = {}) {
    const uploadId = `upload-${Math.random().toString(36).slice(2, 10)}`;
    this.uploads.set(uploadId, { key, options, parts: new Map() });
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, value) => {
        const u = this.uploads.get(uploadId);
        if (!u) throw new Error("upload not found");
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        u.parts.set(partNumber, bytes);
        return { partNumber, etag: `"part-${partNumber}-${bytes.length}"` };
      },
      complete: async (parts) => {
        const u = this.uploads.get(uploadId);
        if (!u) throw new Error("upload not found");
        const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        let total = 0;
        for (const p of ordered) total += u.parts.get(p.partNumber).length;
        const merged = new Uint8Array(total);
        let at = 0;
        for (const p of ordered) {
          merged.set(u.parts.get(p.partNumber), at);
          at += u.parts.get(p.partNumber).length;
        }
        this.uploads.delete(uploadId);
        const obj = this.#record(key, merged, u.options);
        return this.#meta(key, obj);
      },
      abort: async () => {
        this.uploads.delete(uploadId);
      },
    };
  }

  resumeMultipartUpload(key, uploadId) {
    const existing = this.uploads.get(uploadId);
    const self = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, value) {
        if (!existing) throw new Error("upload not found");
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        existing.parts.set(partNumber, bytes);
        return { partNumber, etag: `"part-${partNumber}-${bytes.length}"` };
      },
      async complete(parts) {
        if (!existing) throw new Error("upload not found");
        const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        let total = 0;
        for (const p of ordered) total += existing.parts.get(p.partNumber).length;
        const merged = new Uint8Array(total);
        let at = 0;
        for (const p of ordered) {
          merged.set(existing.parts.get(p.partNumber), at);
          at += existing.parts.get(p.partNumber).length;
        }
        self.uploads.delete(uploadId);
        const stored = { body: merged, httpMetadata: existing.options.httpMetadata ?? {}, customMetadata: existing.options.customMetadata ?? {}, uploaded: new Date(), etag: `"mp-${Math.random().toString(16).slice(2, 10)}"` };
        self.objects.set(key, stored);
        return {
          key,
          size: merged.length,
          etag: stored.etag,
          uploaded: stored.uploaded,
          httpMetadata: stored.httpMetadata,
          customMetadata: stored.customMetadata,
        };
      },
      async abort() {
        self.uploads.delete(uploadId);
      },
    };
  }
}