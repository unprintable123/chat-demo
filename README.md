# chat-demo

English | [简体中文](README.zh-CN.md)

A server-backed chat app powered by the DeepSeek API. The browser talks to a same-origin Node.js server, which stores the API key and conversation history inside this repository and proxies DeepSeek requests.

Enter your API key in Settings before your first chat. The key is written to `data/config.json` and is never returned to the browser.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090. The development command starts both the web dev server and the API/storage server.

To build and run the production server:

```sh
pnpm build
pnpm start
```

Open http://127.0.0.1:8091. Set `HOST=0.0.0.0` only when you intentionally want to expose the server to other machines; the app has no built-in user authentication.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

The API key is stored in `data/config.json`. Conversations and original attachments are stored under `data/chat/`. Runtime data is ignored by Git and remains inside this repository by default. Browser localStorage is used only for interface preferences such as language, theme, and layout.

The server injects the API key when proxying requests, uploads, speech recognition, and text-to-speech. Relevant message and attachment content is sent to DeepSeek through that proxy. On first launch, the app migrates an API key and conversations left by the old browser-only version, then removes the old browser copies.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all server conversations and attachments. Exports include conversations and available original images, but exclude the API key, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears server conversations, original attachments, and unsent drafts after confirmation. The API key and interface settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm start`  | Serve the build and API      |
| `pnpm server` | Start the API server only    |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

The browser uses `/api/deepseek` by default; the server proxies it to `https://api.deepseek.com`. Server settings include `DEEPSEEK_API_ORIGIN`, `DEEPSEEK_API_KEY`, `CHAT_DATA_DIR`, `HOST`, and `PORT`.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
server/                HTTP API, storage, and DeepSeek proxy
data/                  Runtime API key, conversations, and attachments (ignored by Git)
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
