# FrameCut 拆镜台 · 网页版（PWA）

**在线使用**：https://zhixiao-xjy.github.io/framecut-studio/  
**图文教程**：https://zhixiao-xjy.github.io/framecut-studio/guide.html

纯静态网页，零构建、无后端、无数据库。部署到任意 HTTPS 静态主机即可用；页面不绑定本机 IP，不依赖 Windows/本机路径，手机、平板、Mac、Windows 浏览器都能打开。

## 特性

- 视频抽帧、快拆/精拆、分镜质检、逐帧复核
- 批量 AI 补全、人物档案、台词时间线、景别/视角/环境/神态全表
- 统一交付文档：Markdown / PDF / ZIP / 项目 JSON
- 文字/图片双接口测试，批量失败直接显示具体原因
- 深色/浅色、桌面/移动端响应式
- **PWA**：HTTPS 下可安装、可离线打开（首次加载后缓存应用壳）
- **API 代理模板**：Cloudflare Worker，隐藏 Key，绕开 CORS / 客户端 IP 限制
- 数据只存在浏览器 IndexedDB；跨设备用「项目 JSON」迁移

## 本地运行

```bash
# 任意静态服务器
python -m http.server 8080
# 或
npx serve .
```

访问 `http://127.0.0.1:8080/`。

> 双击 `index.html` 也能打开；但 `file://` 下 Service Worker 不注册，外部 API 的 CORS 也更严格。正式使用建议 HTTPS 或本地静态服务器。

## 部署到公网

把整个 `framecut-web/` 目录上传即可，无 build command：

- **Netlify**：拖入目录，或连接 Git，Publish directory 填 `framecut-web`
- **Cloudflare Pages**：上传目录
- **Vercel**：Framework 选 Other，Output Directory 填 `framecut-web`
- **GitHub Pages**：把目录内容放到仓库根/`docs`，Settings → Pages
- **Nginx / Apache**：指向 `index.html` 所在目录即可

部署后是 `https://你的域名/`，不再是 `127.0.0.1`；任何设备访问同一个域名，看到同一个应用（数据各自存在本机）。

### 子目录部署

所有资源都是相对路径，可以部署在：

```text
https://example.com/framecut/
```

不需要改代码。

## 为什么说“不受 IP / 设备影响”

- 没有 `localhost`、`127.0.0.1` 或 Windows 绝对路径硬编码
- 没有后端、没有固定服务器 IP、没有 IP 白名单
- 纯静态：任何静态主机、对象存储、CDN 都能托管
- 响应式：手机/平板/桌面共用一套页面
- 跨设备迁移：设置 →「导出项目 JSON / 导入」

**需要说清楚的两点：**

1. **公网访问仍然需要一个托管地址**。`http://127.0.0.1:8899` 只是本机预览，不是公网地址；要让别人访问，必须部署到静态主机/域名。
2. **浏览器能力有边界**。视频解码取决于浏览器和系统编解码器；建议最新版 Chrome / Edge / Safari。MOV/AVI 等浏览器不支持的编码，换设备也可能打不开。

## API 配置

右上角「AI 未配置 → API 连接」。

### 方式 A：直连（个人使用）

- Base URL：`https://api.deepseek.com/v1`
- 视觉模型：`deepseek-flash`（批量看图）
- 文本模型：`deepseek-v4-pro`（对话/摘要）
- 填自己的 API Key
- Key 只存本机 localStorage

直连会受浏览器 CORS、公司网络、地区网络影响。

### 方式 B：代理（公开部署推荐）

使用 `worker/` 里的 Cloudflare Worker：

```bash
cd worker
npm i -g wrangler
wrangler login
wrangler secret put DEEPSEEK_API_KEY
wrangler deploy
```

然后在页面里：

- Base URL：`https://framecut-api.<你的账号>.workers.dev/v1`
- 打开「代理模式」
- 不需要在前端填 Key

这样客户端不直接连 DeepSeek，**不受客户端 IP、CORS、公司网络限制影响**，也不会把 Key 暴露在网页里。详见 [worker/README.md](worker/README.md)。

## PWA / 离线

- 首次通过 HTTPS 打开后，Service Worker 缓存应用壳
- 断网后仍能打开页面、使用已加载的功能
- 浏览器菜单可「安装 FrameCut」到桌面/手机主屏
- 版本更新：修改 `sw.js` 里的 `VERSION`，重新部署

## 数据与隐私

- 视频只在浏览器内解码，不上传
- 项目帧图/标注存 IndexedDB
- 桌面版与网页版数据独立
- 换设备：导出项目 JSON，再在新设备导入
- 不做账号云同步；如需多设备自动同步，需要额外后端

## 目录

```text
framecut-web/
├── index.html            # 应用本体
├── guide.html            # 图文使用教程
├── guide-main.png        # 教程截图：主界面
├── guide-api.png         # 教程截图：API 设置
├── guide-export.png      # 教程截图：Markdown 导出
├── guide-review.png      # 教程截图：逐帧复核
├── sw.js                 # PWA 离线缓存
├── manifest.webmanifest  # PWA 元数据
├── icon-192.png
├── icon-512.png
├── apple-touch-icon.png
├── favicon.svg
├── preview.png
├── worker/               # 可选 Cloudflare Worker API 代理
│   ├── index.js
│   ├── wrangler.toml
│   └── README.md
├── ARCHITECTURE.md
└── README.md
```

## 验证

- 静态资源相对路径，无本机绝对路径
- PWA manifest + Service Worker 注册
- 首页、manifest、icon 均返回 200
- 断网重载可回退到缓存的应用壳
- 代理 Worker 支持 `OPTIONS`、`/v1/*`、SSE 透传
