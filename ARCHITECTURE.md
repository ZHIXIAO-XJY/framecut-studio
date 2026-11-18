# FrameCut 拆镜台 · 架构说明（上线加固版）

> 交付文件：`framecut-studio.html`  
> 运行方式：双击 HTML，或放在任意静态服务器上打开。视频只在浏览器内解码，不上传。

## 1. 总体架构

```text
┌─────────────────────────────────────────────────────────────────┐
│ 单文件 Web App（HTML + CSS + Vanilla JS）                       │
│                                                                 │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────────┐   │
│  │ 视频输入层   │    │ 抽帧 / 质检层  │    │ 交付物生成层       │   │
│  │ File API     │───▶│ HTML5 Video  │───▶│ Markdown Blob     │   │
│  │ Object URL   │    │ Canvas 2D    │    │ Print-to-PDF      │   │
│  └─────────────┘    │ QC 规则      │    │ HTML 打印页兜底    │   │
│                     └──────┬───────┘    └───────────────────┘   │
│                            │                                    │
│  ┌─────────────────────────▼─────────────────────────────────┐  │
│  │ 内存状态 state.project / state.video / state.chat         │  │
│  │ IndexedDB：最近一次项目 + 480px 帧图 + 标注 + 质检快照       │  │
│  │ localStorage：API 配置、主题                               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  AI：浏览器 fetch → 用户配置的 DeepSeek 端点 / 自有代理          │
└─────────────────────────────────────────────────────────────────┘
```

### 技术取舍

| 需求建议 | 本实现 | 理由 |
|---|---|---|
| React / Vue 3 | Vanilla JS | 单文件可移植，无构建、无依赖 |
| FFmpeg.wasm | HTML5 Video + Canvas 2D | 不引 CDN/WASM，启动快 |
| jsPDF + html2canvas | 独立打印文档 + `window.print()` | 零依赖，帧图内嵌，浏览器原生分页 |
| Tailwind / Ant Design | CSS 变量 + Grid/Flex | 主题与响应式可直接写死在一个文件里 |

> 浏览器解码能力决定兼容性：MP4/H.264、WebM 最稳；部分 MOV/AVI 编码可能无法打开，UI 会报错。

---

## 2. 数据模型

### 2.1 顶层 State

```js
state = {
  settings: {
    apiKey: '',                   // 不再内置真实 Key
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4.1-flash-high',
    stream: true,
    context: true,
    proxyMode: false,             // 代理模式不发送 Authorization
    theme: 'dark'
  },
  selectedMode: 'fast' | 'precision',
  project: Project | null,
  video: {
    el, url, file, ready, duration, width, height
  },
  pendingSubs: SubtitleCue[],
  ui: {
    filter, query, extracting, cancelRequested,
    qcBusy, aiBusy: Set, activeShotId, modal,
    restoreDismissed
  },
  chat: { messages: ChatMessage[], controller, streaming }
}
```

### 2.2 项目

```ts
interface Project {
  id: string;
  code: string;                 // FC-YYMMDD
  title: string;
  desc: string;
  summary: string;              // 导出摘要
  style: string;
  theme: string;
  author: string;
  createdAt: Date;
  mode: 'fast' | 'precision';
  source: 'demo' | 'local';
  fileName: string;
  fileSize: number;
  fileType: string;
  duration: number;
  width: number;
  height: number;
  poster: string;               // data:image/jpeg;base64,…
  shots: Shot[];
  demo: boolean;
  restored?: boolean;           // 从 IndexedDB 恢复、当前无原视频
}
```

### 2.3 分镜

```ts
interface Shot {
  id: string;
  index: number;
  start: number;
  end: number;
  thumb: string;                // 480px JPEG data URI
  width: number;
  height: number;

  description: string;
  dialogue: string;
  dialogueSource: '' | 'manual' | 'subtitle' | 'ai';
  camera: string;
  shotSize: string;
  emotion: string;
  notes: string;

  metrics: {
    brightness: number;
    contrast: number;
    sharpness: number;          // Laplacian 方差
    colorfulness: number;
    darkRatio: number;
    hash: string;               // dHash
  } | null;

  qc: QCSnapshot;
  manualPass: boolean;
  aiAnalyzed: boolean;

  aiUndo?: {                    // AI 覆盖前的快照
    description; dialogue; dialogueSource;
    camera; shotSize; emotion;
    aiAnalyzed; qc;
  } | null;
}
```

### 2.4 质检快照

```ts
interface QCSnapshot {
  status: 'pending' | 'checking' | 'pass' | 'warn' | 'fail';
  score: number | null;
  issues: Array<{ level: 'warn' | 'fail'; text: string }>;
  checkedAt: number | null;
  method: 'auto' | 'manual';
  metrics?: Metrics;
}
```

### 2.5 本机持久化

- **IndexedDB** `framecut.local.v1` / store `project` / key `current`
  - 保存最近一次非示例项目的 `Project`、`pendingSubs`、`selectedMode`
  - 保存内容包含帧图（480px JPEG），因此刷新后可恢复质检与标注
  - **不保存原始视频**；恢复后需要重新载入原视频才能重新取帧或重新拆解
- **localStorage** `framecut.settings.v1`
  - 只保存 API 配置和主题
- 清除入口：API 设置 →「清除本地项目缓存」

---

## 3. 核心代码

### 3.1 快拆 / 精拆

```js
const MODES = {
  fast:      { fps: 2, interval: 0.5  },
  precision: { fps: 4, interval: 0.25 }
};

function expectedTimes(duration, interval) {
  const times = [];
  for (let t = 0; t < duration - 0.001; t += interval) {
    times.push(Number(t.toFixed(4)));
  }
  return times;
}
```

采样点严格按固定间隔生成；切换模式后必须重新拆解，同时不会改写已有时间轴的原始时间码。

### 3.2 抽帧（播放采样，不再逐帧 seek）

对 11 分钟竖屏视频做过实测：逐个 `currentTime` seek 约需 10 分钟，不可接受。  
现在长视频改为**静音播放 + `requestVideoFrameCallback` 采样**：

```js
const rate = times.length > 800
  ? (mode.interval >= .5 ? 8 : 4)   // 长片：2fps 用 8x，4fps 用 4x
  : (mode.interval >= .5 ? 4 : 2);  // 短片

video.muted = true;
video.playbackRate = rate;
video.requestVideoFrameCallback(onFrame);

function onFrame(now, meta) {
  const vt = meta.mediaTime;
  while (next < times.length && vt + .02 >= times[next]) {
    captureAt(times[next]);  // 时间码用固定采样点
    next++;
  }
  video.requestVideoFrameCallback(onFrame);
}
```

- 时间码仍是严格的 `0, 0.5, 1.0…`，画面取目标时刻最近的一帧。
- 播放结束仍缺少量采样点时，用最后一帧补齐。
- 不支持 rVFC 的浏览器自动降级为 50ms 定时采样。
- 长片帧图降采样：>1600 帧用 300px，>800 帧用 360px，短片 480px；PDF 28mm 宽仍清晰。
- 单次最多 **3200 帧**（2fps 约 26 分钟，4fps 约 13 分钟）。

```js
function captureVideoFrame(video, maxWidth) {
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return { canvas, dataUrl: canvas.toDataURL('image/jpeg', .76), width: canvas.width, height: canvas.height };
}
```

### 3.3 质检（画面问题与字段完整度分开）

```js
function evaluateShot(shot) {
  // 画面质检（决定 QC 通过/异常）
  // 黑屏：brightness < 18 && contrast < 10 → fail
  // 极暗且平：brightness < 22 && contrast < 12 → warn
  // 过曝：brightness > 245 && contrast < 4 → warn
  // 明显模糊：Laplacian 方差 < 6 → warn
  // 低对比：contrast < 5 → warn

  // 字段完整度（单独显示，不影响画面通过率）
  // 缺画面描述 / 缺运镜 → fieldIssues，卡片显示“字段待补”
}
```

这样长视频抽完 1376 帧后，画面质检仍能显示真实通过率，不会被“全都还没写描述”淹没。

阈值偏保守，避免把电影暗调、浅景深、固定机位误判为故障。

### 3.4 单镜独立修正

```js
async function runShotQC(id) {
  const shot = findShot(id);
  shot.manualPass = false;
  shot.qc = { ...shot.qc, status: 'checking' };
  replaceShotCard(shot);          // 只重绘当前卡片

  await sleep(360);
  shot.qc = evaluateShot(shot, prevShot(shot));
  replaceShotCard(shot);          // 不重跑视频
  renderStats();
  scheduleAutosave();
}
```

单镜支持：

- 单独质检
- 重新取帧（需要原视频仍在内存中）
- AI 重解读（有内容时先确认覆盖）
- 撤销 AI 修改
- 人工编辑与人工标记通过

### 3.5 会话恢复

```js
// 抽帧、质检、编辑、AI、字幕、文档信息后：
scheduleAutosave();               // 900ms debounce

async function saveProjectSnapshot() {
  const payload = {
    version: 1,
    savedAt: Date.now(),
    selectedMode,
    subs: state.pendingSubs,
    project: { ...state.project, restored: false }
  };
  // IndexedDB put(payload, 'current')
}

// 页面启动：
const saved = await readProjectSnapshot();
if (saved?.project?.shots?.length) {
  state.project = { ...saved.project, restored: true };
  renderAll();
  // 显示“已恢复，原始视频不在内存中”提示
} else {
  loadDemo(true, false);
}
```

### 3.6 AI 代理模式

```js
function apiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (!settings.proxyMode && settings.apiKey) {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }
  return headers;
}
```

- 直连模式：Base URL 指向 DeepSeek 官方端点，发送用户自己的 Key
- 代理模式：Base URL 指向自有代理，代理注入密钥，本页不发送 `Authorization`
- 默认不内置 Key；公开部署建议使用代理模式
- CORS 失败会显示可操作提示，不静默失败

### 3.7 聊天上下文裁剪

```js
const MAX_MESSAGES = 16;
const MAX_CHARS = 12000;

// 从最新消息向前取，超过预算的旧消息直接省略
// 单条消息超过 6000 字符时截断
```

一次请求最多 16 条历史 + system prompt，避免长对话超出模型上下文。

### 3.8 AI 批量补全

单镜 AI 适合精修，但 1376 帧不现实。新增「AI 补全」批量流程：

- 只选**缺字段**的镜头（描述 / 运镜 / 景别 / 情绪）；可勾选覆盖已有字段。
- 单批 12 / 24 / 48 / 96 帧，默认 24。
- 2 个 worker 并发，按顺序消费队列；每组独立失败、独立保留原字段。
- **相似帧合并**：连续帧 dHash 距离 ≤6、时间连续、组内 ≤12 帧 / ≤3.2 秒时合并成「视觉组」，每组只请求一次 AI，再把描述/运镜/景别/情绪回填给组内各帧。
- 支持停止：`AbortController` 打断当前请求，已完成的结果保留。
- 每完成 12 组写一次 IndexedDB，避免频繁写 51MB 大项目。
- 每个镜头仍保留 `aiUndo`，可单独撤销。
- 完成后如果还有缺字段镜头，显示「继续下一批（剩余 N 组 / M 帧）」；按批可以把 1376 帧分多次补完，不必一次付费。

```js
const queue = batchCandidates(overwrite).slice(0, requested);
const worker = async () => {
  while (!state.batchAI.cancel && cursor < queue.length) {
    const shot = queue[cursor++];
    const parsed = await requestShotAnalysis(shot, signal);
    shot.aiUndo = snapshotAIShot(shot);
    applyAIFields(shot, parsed, overwrite);
    shot.qc = evaluateShot(shot, prev);
  }
};
await Promise.all([worker(), worker()]);
```

> 成本边界：每个分镜是一次独立视觉请求。1376 帧全量补全 = 1376 次请求；UI 会提示，建议先 24/48 帧抽样。

### 3.9 PDF 导出：范围与抽样

1376 帧直接打印可能超过 100 页。PDF 导出弹窗支持：

- **范围**：全部 / 当前筛选 / 前 120 帧
- **抽样**：每 1 / 2 / 4 / 8 帧取 1
- 预计帧数与页数实时计算
- 封面标记实际导出帧数，例如 `12 / 24 帧`
- 附录写入 `EXPORT RANGE` 与抽样间隔
- 抽样只影响本次 PDF，不修改项目

默认策略：总帧数 >800 时抽样 8，>300 时抽样 4，短片不抽样。

### 3.10 Markdown 导出：ZIP 打包

长项目不再只能生成巨型单文件 `.md`。导出弹窗提供三种模式：

1. **Markdown + 帧图 ZIP（长项目推荐）**
   - `.md` 中的图片路径为 `frames/001.jpg`
   - 纯前端 ZIP（store 无压缩）打包，不依赖 JSZip/CDN
2. **单文件 Markdown**
   - 帧图转 base64 内嵌
3. **纯文字 Markdown**
   - 无图，最小最快

ZIP 结构：

```text
项目名_分镜脚本_日期.zip
├── 分镜脚本.md
└── frames/
    ├── 001.jpg
    ├── 002.jpg
    └── …
```

ZIP 使用 UTF-8 文件名标志位，中文文件名在 Windows/macOS/Linux 解压正常。

### 3.11 逐帧复核模式

长项目不再只靠网格翻页。工具栏「逐帧复核」打开全屏复核：

- 左/上：完整帧图，`object-fit: contain`，不裁切竖屏
- 右/下：编号、时间码、QC、描述、台词、运镜/景别/时长、表演备注
- 上一帧 / 下一帧
- 一键「标记通过」
- 直接编辑与 AI 重解读
- 键盘：`←/→` 或 `J/K` 切帧，`P` 标记通过，`E` 编辑，`Esc` 关闭
- 复核列表跟随当前筛选（如只看异常镜头）

### 3.12 项目 JSON 备份 / 导入

- 设置 →「导出项目 JSON」：包含 Project、全部帧图、分镜字段、QC、字幕与当前模式
- 「导入」：读取 JSON，确认后替换当前项目，自动进入“已恢复、无视频”状态
- 适用于换设备、备份、交付前存档
- 注意：1376 帧项目 JSON 约 50–60MB，属于正常体积

---

## 4. UI 组件树

```text
App
├─ Topbar
│  ├─ Brand
│  ├─ ProjectStatus
│  └─ TopActions（方法论 / 文档信息 / 主题 / AI 助手）
├─ Workspace
│  ├─ Sidebar
│  │  ├─ SourcePanel
│  │  │  ├─ Dropzone
│  │  │  ├─ VideoCard（封面 / 时长 / 分辨率 / 缓存状态）
│  │  │  └─ SubtitleDetails（SRT 粘贴）
│  │  ├─ ModePanel（快拆 / 精拆 + 预计帧数）
│  │  ├─ RunPanel（开始 / 停止 / 进度 / 示例）
│  │  └─ QualityGatePanel（全部重检）
│  └─ Main
│     ├─ BoardHeader（标题 / 统计 / 筛选 / 导出）
│     ├─ SummaryStrip
│     ├─ RestoreBanner（缓存恢复提示）
│     └─ BoardScroll
│        └─ ShotGrid
│           └─ ShotCard × N
│              ├─ 帧图 / 时间码 / QC 标记
│              ├─ 描述 / 台词 / 运镜 / 景别
│              └─ 定位 / 质检 / 编辑 / AI 重解读
├─ AssistantDrawer（流式对话 / 清空 / 上下文）
├─ SettingsModal
│  ├─ Base URL / Model / Key
│  ├─ 流式 / 上下文 / 代理模式
│  └─ 本机会话自动保存 / 清除缓存
├─ BatchAIModal（12/24/48/96 帧 + 进度 + 停止 + 继续下一批）
├─ MarkdownExportModal（ZIP / 内嵌 / 纯文字）
├─ PDFExportModal（范围 / 抽样 / 预计页数）
├─ ReviewOverlay（逐帧复核 / 键盘切帧 / 标记通过）
├─ ShotModal（预览 + 五维字段 + 局部 QC + 撤销 AI）
├─ InfoModal（封面、摘要、风格、主题）
├─ MethodModal（P0–P7 + 六条铁律）
├─ Lightbox
├─ VideoPreviewModal
└─ ToastStack
```

---

## 5. PDF 模板

PDF 由独立的打印 HTML 生成：iframe 加载后调用 `print()`；若打印被拦截，自动打开独立打印页，弹窗也被拦截则下载 `.html` 打印版。

```html
<section class="cover">            <!-- 封面 -->
  <div class="cover-top">FRAMECUT / STORYBOARD REPORT</div>
  <h1>{{视频名称}}</h1>
  <p>{{主题}}</p>
  <div class="cover-art">…</div>
  <div class="meta-grid">
    <div><span>GENERATED</span><b>{{日期}}</b></div>
    <div><span>MODE</span><b>{{快拆/精拆}}</b></div>
    <div><span>DURATION</span><b>{{时长}}</b></div>
    <div><span>RESOLUTION</span><b>{{分辨率}}</b></div>
    <div><span>SHOTS</span><b>{{分镜数}}</b></div>
    <div><span>AUTHOR</span><b>{{署名}}</b></div>
  </div>
</section>

<section class="page">             <!-- 摘要 -->
  <h2>摘要</h2>
  <p>{{整体概述}}</p>
  <div class="info-card">风格 / 主题</div>
  <div class="qc-overview">总数 / 通过 / 待确认 / 异常 / 通过率</div>
</section>

<section class="page">             <!-- 分镜表 -->
  <table class="report-table">
    <thead>
      <tr>
        <th>#</th><th>时间码</th><th>帧预览</th>
        <th>画面描述</th><th>台词/字幕</th>
        <th>运镜</th><th>质检</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>{{序号}}</td>
        <td>{{start}}<br>{{duration}}s</td>
        <td><img src="{{data:image/jpeg;base64,…}}"></td>
        <td>{{画面描述}}<br>{{景别/情绪}}<br>{{问题}}</td>
        <td>{{台词}}</td>
        <td>{{运镜}}</td>
        <td><span class="badge">{{质检状态}}</span></td>
      </tr>
    </tbody>
  </table>
</section>

<section class="page appendix">    <!-- 附录强制新页 -->
  <h2>附录</h2>
  <table>原始文件 / 大小 / 分辨率 / 时长 / 采样模式 / 导出时间</table>
</section>
```

```css
@page { size: A4; margin: 12mm 10mm; }
.cover { height: 270mm; page-break-after: always; break-after: page; }
.appendix { page-break-before: always; break-before: page; }
tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
.report-table { table-layout: fixed; width: 100%; }
.frame img { width: 28mm; height: 16mm; object-fit: contain; }
```

---

## 6. 已验证项

| 测试 | 结果 |
|---|---|
| 6 秒 / 8 秒 MP4，快拆 | 12 / 16 帧，0.5s 间隔，自动质检完成 |
| 6 秒 MP4，精拆 | 24 帧，0.25s 间隔 |
| **11:27 竖屏 / 720×1280，快拆** | **1376 帧，89 秒完成，360×640 帧图，0 帧取帧失败** |
| 竖屏分镜布局 | 4:5 卡片 + `object-fit: contain`，完整保留人物与字幕 |
| 长列表分页 | 首屏 120 张，「加载更多」每次追加 120 张 |
| 长视频 IndexedDB | 1376 帧约 51MB，刷新后恢复，显示恢复提示 |
| 单镜编辑、人工通过、重新取帧 | 只更新目标卡片 |
| SRT 导入 | 按起始时间挂载到对应采样帧 |
| AI 代理模式 | 无 `Authorization` 请求，流式与非流式都正常 |
| AI 覆盖保护 | 二次重解读弹确认；编辑弹窗可撤销 |
| AI 批量补全 | 24 帧项目自动合并为 7 个视觉组，7 次请求补全 24/24 帧 |
| 相似帧合并 | 纯静态 12 帧项目合并为 2 组，请求从 12 次降到 2 次，字段 12/12 |
| 逐帧复核 | 12 帧项目打开复核、→ 切帧、P 标记通过、Esc 关闭均正常 |
| 项目 JSON | 12 帧项目导出 JSON 约 200KB，导入后恢复 12 帧 |
| 继续下一批 | 分组前 24 帧 / 12+12 分批验证通过；分组后按组消费 |
| Markdown + ZIP | 12 帧 ZIP 含 1 个 .md + 12 张 JPEG，`frames/001.jpg` 路径正确，`testzip()` 通过 |
| PDF 抽样 | 24 帧项目按每 2 帧抽 1，PDF 表格 12 行，封面显示 `12 / 24 帧` |
| 聊天上下文 | 18 轮后仅发送最近 16 条，约 1.8k 字符 |
| 无 Key 保护 | 提示并打开 API 设置，不发起请求 |
| PDF | 封面 / 摘要 / 分镜表 / 附录，A4 4 页 |
| 430px 移动端 | 无横向溢出 |

> 真实 DeepSeek 端点的连通性未用示例 Key 实测；流式协议通过本地 SSE mock 验证。实际使用需确认网络与 CORS。

### 6.1 网页版部署形态（PWA）

- 应用是纯静态单页，无后端、无固定 IP、无 Windows 路径。
- `manifest.webmanifest` + `sw.js`：HTTPS 下可安装、可离线打开。
- Service Worker 只缓存同源应用壳，不拦截外部 API；导航网络优先，断网回退 `index.html`。
- 所有资源使用相对路径，支持部署在域名根目录或 `/framecut/` 子目录。
- 跨设备数据不自动同步；用「项目 JSON」导入/导出迁移。

### 6.2 API 代理（可选）

`worker/` 提供 Cloudflare Worker 模板：

- 浏览器只连 Worker，Worker 注入 `Authorization`
- 支持 `/v1/*` 与 SSE 透传
- 通过 `ALLOWED_ORIGINS` 限制来源
- 适合公开部署，避免前端暴露 Key，也绕开客户端 CORS/网络限制

---

## 7. 已知边界

- 浏览器无法解码的 MOV/AVI 编码会失败，建议转 MP4/H.264。
- 单次最多 3200 帧（2fps 约 26 分钟，4fps 约 13 分钟）；超出会二次确认并截断。
- 长视频播放采样在 8x 下时间码仍固定，但画面取“目标时刻最近呈现帧”，可能有单帧级偏差；需要逐帧精确考据时请用精拆并人工复核关键镜头。
- 自动质检只覆盖机械问题；台词归属、角色身份、同脸复用、中途换装仍需人工复核。
- IndexedDB 可能被浏览器清理或受配额限制；重要项目请及时导出 Markdown/PDF。
- 恢复项目不包含原视频；无法在恢复后重新取帧，必须先重新载入。
- Markdown 内嵌 base64 帧图会让文件变大；长项目请使用“Markdown + 帧图 ZIP”。
- 批量 AI 默认按相似帧合并，每个视觉组一次请求，单批最多 96 次请求；实际请求数取决于画面变化密度。
- 合并只对连续、dHash 相近的帧生效；快速运动、频繁切镜会退化成逐帧请求。
- 1376 帧 ZIP 约 50MB，浏览器打包时会有短暂主线程占用。
- 项目 JSON 同样包含 51MB 级帧图，导入/导出会占用较多内存；超大项目优先用 ZIP 或 IndexedDB 恢复。
- 大项目 PDF 建议使用「当前筛选」或 1/4、1/8 抽样；全量 1376 帧仍可能生成上百页。
- PDF 由浏览器打印引擎生成，需在打印对话框中勾选“背景图形”以保留封面深色块。
- 公开部署前请使用代理模式并移除任何真实 Key。
