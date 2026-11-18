/**
 * FrameCut API 代理（Cloudflare Worker）
 *
 * 作用：
 * - 浏览器只请求这个 Worker，不直接暴露 DeepSeek Key
 * - 由 Worker 注入 Authorization，客户端不发送 Key
 * - 支持 SSE 流式响应（直接把 upstream.body 透传）
 * - 不受用户客户端 IP / CORS 环境影响
 *
 * 部署：
 *   npm i -g wrangler
 *   wrangler secret put DEEPSEEK_API_KEY
 *   wrangler deploy
 *
 * 然后在 FrameCut「API 连接」里：
 *   Base URL = https://<worker>.workers.dev/v1
 *   打开「代理模式」
 *
 * 安全：
 * - 建议设置 ALLOWED_ORIGINS 为你的网页域名，避免别人白嫖你的 Key
 * - 不设置时允许所有来源，仅适合内测
 */

const DEFAULT_UPSTREAM = 'https://api.deepseek.com';

function corsHeaders(origin, allowed) {
  const list = (allowed || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowOrigin = !list.length || list.includes('*')
    ? '*'
    : (origin && list.includes(origin) ? origin : '');
  return {
    'Access-Control-Allow-Origin': allowOrigin || 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);
    const allowed = cors['Access-Control-Allow-Origin'];
    if (allowed === 'null') {
      return new Response(JSON.stringify({ error: { message: 'Origin not allowed' } }), {
        status: 403,
        headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1/')) {
      return new Response(JSON.stringify({ error: { message: 'Not found. Use /v1/...' } }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    if (!env.DEEPSEEK_API_KEY) {
      return new Response(JSON.stringify({ error: { message: 'DEEPSEEK_API_KEY is not configured' } }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const upstream = (env.DEEPSEEK_BASE || DEFAULT_UPSTREAM).replace(/\/+$/, '') + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('origin');
    headers.delete('referer');
    headers.set('authorization', `Bearer ${env.DEEPSEEK_API_KEY}`);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');

    const init = {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body
    };

    try {
      const res = await fetch(upstream, init);
      const out = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) out.set(k, v);
      out.set('Cache-Control', 'no-store');
      out.delete('content-length');
      return new Response(res.body, { status: res.status, headers: out });
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: 'Proxy upstream error: ' + String(e && e.message || e) } }), {
        status: 502,
        headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  }
};
