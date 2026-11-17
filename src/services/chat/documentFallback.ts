import { createId } from '../../utils/id.js'
import { recognizeDocument, streamMessage, uploadFile } from '../api/client.js'
import type { CreateMessageRequest } from '../api/types.js'
import { getFileErrorCode } from '../api/errors.js'
import { getFileExt, getUploadPurpose } from '../attachments.js'
import { estimateTextTokens } from './reply.js'
import * as db from './db.js'
import type { FileAttachment, UserMessage } from './types.js'

const DOCUMENT_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])
const MAX_DOCUMENT_TOKENS = 180_000
const CHUNK_TOKEN_BUDGET = 20_000
const MAX_CHUNKS = 12
const PART_MAX_TOKENS = 2_500
const NO_RELEVANT_INFORMATION = 'NO_RELEVANT_INFORMATION'
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

export type ContextOverflow = {
  inputTokens?: number
  maxTokens?: number
}

type PreparedChunk = {
  label: string
  text?: string
  fileIds?: string[]
  cache?: {
    key: string
    partId: string
  }
}

type PdfChunkCache = {
  version: 1
  updatedAt: number
  parts: db.CachedDocumentPart[]
}

type Page = {
  document: string
  index: number
  text: string
}

type TextChunk = {
  start: Page
  end: Page
  text: string
}

const loadFile = async (attachment: FileAttachment): Promise<File | undefined> => {
  const blob = await db.loadFile(attachment.id)
  if (!blob) {
    return undefined
  }
  return blob instanceof File
    ? blob
    : new File([blob], attachment.name, {
        type: blob.type || attachment.mimeType,
      })
}

/** OCR 文本中的布局标记不需要回传给模型，仅保留可读文字。 */
const cleanOcrText = (text: string) =>
  text
    .replace(/<｜box｜>\[\[[^\]]+\]\]<｜\/box｜>/g, '')
    .replace(/<｜\/?ref｜>/g, '')
    .trim()

const buildTextChunks = (pages: Page[]): TextChunk[] | undefined => {
  if (pages.length === 0) {
    return undefined
  }
  const chunks: TextChunk[] = []
  let current: Page[] = []
  const flush = () => {
    const first = current[0]
    const last = current.at(-1)
    if (!first || !last) {
      return
    }
    chunks.push({
      start: first,
      end: last,
      text: current
        .map((page) => `[文档：${page.document}，第 ${page.index + 1} 页]\n${page.text}`)
        .join('\n\n'),
    })
    current = []
  }

  for (const page of pages) {
    const candidate = [...current, page]
    const text = candidate
      .map((item) => `[文档：${item.document}，第 ${item.index + 1} 页]\n${item.text}`)
      .join('\n\n')
    if (current.length > 0 && estimateTextTokens(text) > CHUNK_TOKEN_BUDGET) {
      flush()
    }
    current.push(page)
  }
  flush()
  return chunks.length > 0 && chunks.length <= MAX_CHUNKS ? chunks : undefined
}

const prepareOcrChunks = async (
  question: UserMessage,
  signal: AbortSignal
): Promise<PreparedChunk[] | undefined> => {
  if (
    question.files.length === 0 ||
    question.files.some((file) => file.isImage || !DOCUMENT_EXTS.has(getFileExt(file.name)))
  ) {
    return undefined
  }
  const pages: Page[] = []
  for (const attachment of question.files) {
    const file = await loadFile(attachment)
    if (!file) {
      return undefined
    }
    const result = await recognizeDocument(file, 'text_recognition', signal)
    pages.push(
      ...result.pages.map((page) => ({
        document: attachment.name,
        index: page.index,
        text: cleanOcrText(page.text),
      }))
    )
  }
  if (
    pages.length === 0 ||
    pages.reduce((total, page) => total + estimateTextTokens(page.text), 0) > MAX_DOCUMENT_TOKENS
  ) {
    return undefined
  }
  return buildTextChunks(pages)?.map((chunk) => ({
    label: `《${chunk.start.document}》第 ${chunk.start.index + 1}-${chunk.end.index + 1} 页`,
    text: chunk.text,
  }))
}

/**
 * PDF 的拆页、缓存和分段上传全部由服务端完成，浏览器只获取缓存记录。
 */
const preparePdfChunks = async (
  question: UserMessage,
  overflow: ContextOverflow,
  signal: AbortSignal
): Promise<PreparedChunk[] | undefined> => {
  if (
    question.files.length === 0 ||
    question.files.some((file) => file.isImage || getFileExt(file.name) !== 'pdf')
  ) {
    return undefined
  }
  const maxTokens = overflow.maxTokens ?? 32_768
  const prepared = await db.prepareDocumentCache(
    question.files,
    overflow.inputTokens,
    maxTokens,
    signal
  )
  return prepared.parts.map((part) => ({
    label: part.label,
    fileIds: [part.serverId],
    cache: { key: prepared.key, partId: part.id },
  }))
}

const collectText = async (body: CreateMessageRequest, signal: AbortSignal): Promise<string> => {
  let text = ''
  for await (const event of streamMessage(body, signal)) {
    if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      text += event.content_block.text
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
  }
  return text.trim()
}

const askChunk = async (
  question: string,
  chunk: PreparedChunk,
  model: CreateMessageRequest['model'],
  signal: AbortSignal
) => {
  const prompt = [
    '你在处理一份因单次输入上限而分段的长文档。',
    `当前处理范围：${chunk.label}。`,
    `原始问题：\n${question}`,
    '只提取本段中用于回答原始问题的事实和结论，不要编造。',
    `如果本段没有相关信息，只输出 ${NO_RELEVANT_INFORMATION}。`,
  ].join('\n\n')
  const body: CreateMessageRequest = {
    model,
    system: SYSTEM_PROMPT,
    max_tokens: PART_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: chunk.fileIds
          ? [
              ...chunk.fileIds.map(
                (fileId): { type: 'document'; source: { type: 'file'; file_id: string } } => ({
                  type: 'document',
                  source: { type: 'file', file_id: fileId },
                })
              ),
              { type: 'text', text: prompt },
            ]
          : `${prompt}\n\n文档片段：\n${chunk.text ?? ''}`,
      },
    ],
    thinking: { type: 'disabled' },
    tools: [],
    safety_check: { level: 'high' },
  }
  return collectText(body, signal)
}

const refreshCachedChunk = async (chunk: PreparedChunk, signal: AbortSignal) => {
  if (!chunk.cache) {
    return false
  }
  const cache = await db.loadDocumentCache<PdfChunkCache>(chunk.cache.key)
  const part = cache?.parts.find((item) => item.id === chunk.cache?.partId)
  if (!cache || !part) {
    return false
  }
  const blob = await db.loadDocumentCacheFile(part.id)
  if (!blob) {
    return false
  }
  const file = new File([blob], part.name, { type: blob.type || 'application/pdf' })
  const uploaded = await uploadFile(file, getUploadPurpose(part.name, false), signal)
  part.serverId = uploaded.id
  cache.updatedAt = Date.now()
  await db.saveDocumentCache(chunk.cache.key, cache)
  chunk.fileIds = [uploaded.id]
  return true
}

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await run(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 当文档被解析成超过当前请求上限的上下文时，按页拆分 PDF；
 * 非 PDF 文档改用 OCR 逐页识别，再让模型综合各段结果。
 */
export const prepareDocumentFallback = async (
  question: UserMessage,
  model: CreateMessageRequest['model'] | null,
  overflow: ContextOverflow,
  signal: AbortSignal
): Promise<UserMessage | undefined> => {
  const chunks =
    (await preparePdfChunks(question, overflow, signal)) ??
    (await prepareOcrChunks(question, signal))
  if (!chunks) {
    return undefined
  }

  const originalQuestion = question.content.trim() || '请总结这份文档的核心内容。'
  const parts = (
    await mapWithConcurrency(chunks, 3, async (chunk, index) => {
      signal.throwIfAborted()
      let answer: string
      try {
        answer = await askChunk(originalQuestion, chunk, model ?? 'deepseek-flash', signal)
      } catch (error) {
        if (!getFileErrorCode(error) || !(await refreshCachedChunk(chunk, signal))) {
          throw error
        }
        answer = await askChunk(originalQuestion, chunk, model ?? 'deepseek-flash', signal)
      }
      if (!answer || answer === NO_RELEVANT_INFORMATION) {
        return undefined
      }
      return `### 第 ${index + 1} 段（${chunk.label}）\n${answer}`
    })
  ).filter((part): part is string => part !== undefined)

  const extracted =
    parts.length > 0 ? parts.join('\n\n') : '分段读取后没有找到与问题直接相关的内容。'
  return {
    id: createId(),
    role: 'user',
    content: [
      `原始问题：\n${originalQuestion}`,
      `文档因单次输入限制被分为 ${chunks.length} 段读取。以下是各段提取结果：\n\n${extracted}`,
      '请综合以上结果直接回答原始问题。信息不足时明确说明，不要提及分段、OCR 或内部处理过程。',
    ].join('\n\n'),
    files: [],
    createdAt: Date.now(),
  }
}
