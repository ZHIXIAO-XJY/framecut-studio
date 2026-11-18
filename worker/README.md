# FrameCut API 代理（Cloudflare Worker）

用途：网页版公开部署后，浏览器不直接连 DeepSeek，也不暴露 Key；由 Worker 注入 `Authorization` 并透传 SSE。这样网页不受客户端 IP、CORS、公司网络限制影响。

## 部署

```bash
cd framecut-web/worker
npm i -g wrangler
wrangler login
wrangler secret put DEEPSEEK_API_KEY
wrangler deploy
```

部署成功后会得到一个地址：

```text
https://framecut-api.<你的账号>.workers.dev
```

## 在 FrameCut 里配置

打开「AI 未配置 → API 连接」：

- Base URL：`https://framecut-api.<你的账号>.workers.dev/v1`
- 模型：`deepseek-v4.1-flash-high`（或你的实际模型）
- 打开「代理模式」
- 不需要填 API Key（Key 在 Worker 的 secret 里）

## 限制来源（强烈建议）

在 Cloudflare Dashboard → Worker → Settings → Variables 添加：

```text
ALLOWED_ORIGINS = https://your-site.pages.dev,https://your-domain.com
```

支持多个域名，逗号分隔；`*` 表示允许所有来源，只适合内测。

## 说明

- 支持 `POST /v1/chat/completions`、`/v1/models` 等 `/v1/*` 路径。
- 支持流式 SSE：上游 `body` 直接透传。
- 默认上游 `https://api.deepseek.com`，可通过 `DEEPSEEK_BASE` 环境变量替换。
- 不记录请求内容；如需审计，请自行加日志，并注意隐私。
- 免费额度/并发以 Cloudflare 账户为准。
