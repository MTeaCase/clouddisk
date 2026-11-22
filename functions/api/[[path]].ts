/**
 * Pages Functions 反向代理：把同源 /api/* 转发给 Worker。
 *
 * 为什么需要它：中国大陆网络下 `*.workers.dev` 常被 DNS 污染（实测解析到
 * 108.160.167.159），而 `*.pages.dev` 通常仍可访问。浏览器只访问 pages.dev，
 * 由 Cloudflare 边缘内部再做一次同域服务端转发，前端就能在单域名下工作，
 * 也不需要跨域 Cookie/CORS。
 */
interface Env {
  API_ORIGIN?: string;
}

const FALLBACK_ORIGIN = "https://clouddisk-api.xiatianyou53.workers.dev";

export async function onRequest(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;
  const origin = (env.API_ORIGIN || FALLBACK_ORIGIN).replace(/\/+$/, "");
  const incoming = new URL(request.url);
  const target = `${origin}${incoming.pathname}${incoming.search}`;

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    // 让 Workers 侧重新生成这些头，避免与目标请求冲突
    if (/^(host|content-length|connection|keep-alive|transfer-encoding)$/i.test(key)) continue;
    headers.set(key, value);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, message: `无法连接后端服务：${String((err as Error)?.message ?? err)}` }),
      { status: 502, headers: { "content-type": "application/json; charset=utf-8" } },
    );
  }

  const outHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (/^access-control-/i.test(key)) continue;
    outHeaders.set(key, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}