# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的服务器聊天应用。浏览器只与同源的 Node.js 服务端通信，服务端把 API Key 和会话历史保存在本仓库内，并代理 DeepSeek 请求。

首次使用时，请在设置中填写 API Key。Key 会写入 `data/config.json`，不会返回浏览器。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090。开发命令会同时启动前端开发服务器和 API/存储服务。

构建并运行生产服务器：

```sh
pnpm build
pnpm start
```

打开 http://127.0.0.1:8091。只有明确需要从其他机器访问时才设置 `HOST=0.0.0.0`；应用没有内置用户登录鉴权。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- 超过当前单次输入上限的 PDF 会在服务端按页拆分、缓存并并行分段分析，其他长文档会通过逐页 OCR 处理。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

API Key 保存在 `data/config.json`，会话和附件原件保存在 `data/chat/`。运行数据默认就在本仓库内，并已被 Git 忽略。浏览器 localStorage 只保存语言、主题、布局等界面偏好。

服务端代理聊天、附件上传、语音识别和语音合成请求时注入 API Key，相应消息和附件内容会通过代理提交给 DeepSeek。首次启动会迁移旧版仅浏览器模式留下的 API Key 和会话，成功后删除浏览器中的旧副本。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部服务端会话和附件；导出包含会话与可用图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空服务端会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和界面设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                  |
| ------------- | --------------------- |
| `pnpm dev`    | 启动开发服务器        |
| `pnpm build`  | 构建到 `dist/`        |
| `pnpm start`  | 启动生产 Web/API 服务 |
| `pnpm server` | 仅启动 API 服务       |
| `pnpm type`   | TypeScript 类型检查   |
| `pnpm lint`   | oxlint 检查           |
| `pnpm format` | oxfmt 格式化          |

浏览器默认请求 `/api/deepseek`，由服务端代理到 `https://api.deepseek.com`。服务端支持 `DEEPSEEK_API_ORIGIN`、`DEEPSEEK_API_KEY`、`CHAT_DATA_DIR`、`HOST` 和 `PORT` 环境变量。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、服务端存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
server/                HTTP API、存储与 DeepSeek 代理
data/                  运行时 API Key、会话与附件（Git 忽略）
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
