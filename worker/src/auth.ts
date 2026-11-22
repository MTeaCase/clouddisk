/**
 * 鉴权：单用户密码登录 → HMAC-SHA256 签名令牌（无状态，不需要 KV/DB）。
 *
 * - session 令牌：Authorization: Bearer <token>，默认 30 天有效
 * - media 令牌：绑定单个对象键，用于 <img>/<video>/<a> 这类无法附加请求头的场景，
 *   也用于对外分享链接（scope=media + 较长有效期）
 */
import {
  type AuthPayload,
  type Env,
  b64urlDecode,
  b64urlEncode,
  b64urlFromString,
  HttpError,
  stringFromB64url,
  timingSafeEqual,
} from "./util";

const encoder = new TextEncoder();
const SESSION_TTL_SECONDS = 30 * 24 * 3600;
const TOKEN_VERSION = "v1";

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keyCache.set(secret, cached);
  }
  return cached;
}

async function sign(env: Env, payload: AuthPayload): Promise<string> {
  const body = b64urlFromString(JSON.stringify(payload));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), encoder.encode(`${TOKEN_VERSION}.${body}`));
  return `${TOKEN_VERSION}.${body}.${b64urlEncode(new Uint8Array(mac))}`;
}

async function verify(env: Env, token: string): Promise<AuthPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, body, sig] = parts;
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(env.SESSION_SECRET),
      b64urlDecode(sig),
      encoder.encode(`${TOKEN_VERSION}.${body}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const payload = JSON.parse(stringFromB64url(body)) as AuthPayload;
    if (!payload || typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createSessionToken(env: Env): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const sid = b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
  const token = await sign(env, { sid, exp: expiresAt, scope: "session" });
  return { token, expiresAt };
}

export async function createMediaToken(
  env: Env,
  key: string,
  ttlSeconds: number,
  download: boolean,
): Promise<{ token: string; expiresAt: number }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sid = b64urlEncode(crypto.getRandomValues(new Uint8Array(8)));
  const token = await sign(env, { sid, exp, scope: "media", key, dl: download ? 1 : 0 });
  return { token, expiresAt: exp };
}

export async function requireSession(request: Request, env: Env): Promise<AuthPayload> {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "unauthorized", "请先登录");
  const payload = await verify(env, token);
  if (!payload || payload.scope !== "session") {
    throw new HttpError(401, "unauthorized", "登录状态已失效，请重新登录");
  }
  return payload;
}

/** 允许 session 令牌或绑定同一对象的 media 令牌。 */
export async function authorizeObject(
  request: Request,
  env: Env,
  key: string,
  mediaToken: string | null,
): Promise<{ viaMediaToken: boolean; download: boolean }> {
  if (mediaToken) {
    const payload = await verify(env, mediaToken);
    if (payload && payload.scope === "media" && payload.key === key) {
      return { viaMediaToken: true, download: payload.dl === 1 };
    }
    throw new HttpError(403, "bad_signature", "分享链接无效或已过期");
  }
  await requireSession(request, env);
  return { viaMediaToken: false, download: false };
}

export async function checkPassword(env: Env, password: string): Promise<boolean> {
  if (!env.ACCESS_PASSWORD || env.ACCESS_PASSWORD.length < 8) {
    throw new HttpError(500, "misconfigured", "服务端未配置登录密码（ACCESS_PASSWORD）");
  }
  // 双方都过一遍 HMAC，保证长度差异不会泄漏时序信息
  const key = await hmacKey(`${env.SESSION_SECRET}:pw`);
  const [a, b] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(password)),
    crypto.subtle.sign("HMAC", key, encoder.encode(env.ACCESS_PASSWORD)),
  ]);
  return timingSafeEqual(
    b64urlEncode(new Uint8Array(a)),
    b64urlEncode(new Uint8Array(b)),
  );
}

/** 极简滑动窗口限流（按 isolate 内存，冷启动会重置，够用）。 */
const attempts = new Map<string, { count: number; resetAt: number }>();

export function throttleLogin(ip: string): void {
  const now = Date.now();
  if (attempts.size > 5000) attempts.clear();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 5 * 60_000 });
    return;
  }
  rec.count++;
  if (rec.count > 10) {
    const wait = Math.ceil((rec.resetAt - now) / 1000);
    throw new HttpError(429, "too_many_attempts", `尝试次数过多，请 ${wait} 秒后再试`);
  }
}

export function resetLoginThrottle(ip: string): void {
  attempts.delete(ip);
}