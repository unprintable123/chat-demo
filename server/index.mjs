import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = path.join(ROOT, 'dist')
const DATA_DIR = path.resolve(process.env.CHAT_DATA_DIR || path.join(ROOT, 'data'))
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const CHAT_DIR = path.join(DATA_DIR, 'chat')
const STAGING_DIR = path.join(DATA_DIR, 'chat-staging')
const PREVIOUS_DIR = path.join(DATA_DIR, 'chat-previous')
const DOCUMENT_CACHE_DIR = path.join(DATA_DIR, 'document-cache')
const UPSTREAM_ORIGIN = `${(process.env.DEEPSEEK_API_ORIGIN || 'https://api.deepseek.com').replace(/\/+$/, '')}/`
const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8091)
const API_ONLY = process.argv.includes('--api-only')
const JSON_LIMIT = 64 * 1024 * 1024
const FILE_LIMIT = 128 * 1024 * 1024

class HttpError extends Error {
  constructor(status, message, options) {
    super(message, options)
    this.status = status
  }
}

const exists = async (target) => {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

const locks = new Map()
const withLock = (name, task) => {
  const previous = locks.get(name) || Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  locks.set(name, current)
  return current.finally(() => {
    if (locks.get(name) === current) {
      locks.delete(name)
    }
  })
}

const writeJsonAtomic = async (target, value) => {
  await mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

const readJson = async (target, fallback) => {
  try {
    return JSON.parse(await readFile(target, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return fallback
    }
    throw error
  }
}

const readConfig = () => readJson(CONFIG_PATH, { apiKey: null })

const currentApiKey = async () => {
  const config = await readConfig()
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  return apiKey || process.env.DEEPSEEK_API_KEY?.trim() || ''
}

const apiKeyStatus = async () => {
  const configured = Boolean(await currentApiKey())
  return { apiKeyConfigured: configured, apiKeyMask: configured ? '••••••••' : '' }
}

const ensureStorage = async () => {
  await mkdir(DATA_DIR, { recursive: true })
  if (!(await exists(CHAT_DIR)) && (await exists(PREVIOUS_DIR))) {
    await rename(PREVIOUS_DIR, CHAT_DIR)
  }
  await mkdir(path.join(CHAT_DIR, 'sessions'), { recursive: true })
  await mkdir(path.join(CHAT_DIR, 'files'), { recursive: true })
  await mkdir(path.join(STAGING_DIR, 'sessions'), { recursive: true })
  await mkdir(path.join(STAGING_DIR, 'files'), { recursive: true })
  await mkdir(path.join(DOCUMENT_CACHE_DIR, 'files'), { recursive: true })
}

let storageReady
const ready = () => (storageReady ||= ensureStorage())

const isResourceId = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 512 &&
  !value.includes('\0') &&
  value !== '.' &&
  value !== '..'

const safeId = (value) => {
  let decoded
  try {
    decoded = decodeURIComponent(value)
  } catch {
    throw new HttpError(400, 'Invalid resource id')
  }
  if (!isResourceId(decoded)) {
    throw new HttpError(400, 'Invalid resource id')
  }
  return decoded
}

const resourceFileName = (id) => createHash('sha256').update(id, 'utf8').digest('hex')

const readBody = async (req, limit) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      throw new HttpError(413, 'Request body is too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const readJsonBody = async (req) => {
  const body = await readBody(req, JSON_LIMIT)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
}

const sendJson = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const sendError = (res, error) => {
  if (res.headersSent) {
    res.destroy(error)
    return
  }
  const status = error instanceof HttpError ? error.status : 500
  const message = error instanceof Error ? error.message : String(error)
  if (status >= 500) {
    console.error(error)
  }
  sendJson(res, status, { error: { message } })
}

const sessionFile = (base, id) => path.join(base, 'sessions', `${resourceFileName(id)}.json`)
const chatFile = (id) => path.join(CHAT_DIR, 'files', resourceFileName(id))
const documentCacheFile = (id) => path.join(DOCUMENT_CACHE_DIR, `${resourceFileName(id)}.json`)

const validateSession = (session, expectedId) => {
  if (
    !session ||
    typeof session !== 'object' ||
    typeof session.id !== 'string' ||
    session.id !== expectedId ||
    typeof session.title !== 'string' ||
    !Array.isArray(session.messages) ||
    typeof session.createdAt !== 'number' ||
    typeof session.updatedAt !== 'number'
  ) {
    throw new HttpError(400, 'Invalid session')
  }
  return session
}

const summaryOf = (session) => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

const loadSession = async (id) => readJson(sessionFile(CHAT_DIR, id), undefined)

const listFiles = async (directory) => {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(directory, entry.name))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

const listSessions = async (base = CHAT_DIR) => {
  const files = await listFiles(path.join(base, 'sessions'))
  const sessions = await Promise.all(files.map((file) => readJson(file, undefined)))
  return sessions.filter(Boolean)
}

const listSummaries = async (base = CHAT_DIR) =>
  (await listSessions(base)).map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt)

const fileIdsIn = (session) => {
  const ids = new Set()
  for (const message of session.messages || []) {
    if (message?.role !== 'user' || !Array.isArray(message.files)) {
      continue
    }
    for (const file of message.files) {
      if (isResourceId(file?.id)) {
        ids.add(file.id)
      }
    }
  }
  return ids
}

const writeAttachment = async (base, id, req) => {
  const filePath = path.join(base, 'files', resourceFileName(id))
  const metaPath = `${filePath}.json`
  const body = await readBody(req, FILE_LIMIT)
  const type = req.headers['content-type'] || 'application/octet-stream'
  await withLock(`file:${base}:${id}`, async () => {
    await mkdir(path.dirname(filePath), { recursive: true })
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temp, body, { mode: 0o600 })
    await rename(temp, filePath)
    await writeJsonAtomic(metaPath, { type, size: body.length })
  })
}

const removeAttachment = async (base, id) => {
  const name = resourceFileName(id)
  await Promise.all([
    rm(path.join(base, 'files', name), { force: true }),
    rm(path.join(base, 'files', `${name}.json`), { force: true }),
  ])
}

const cleanupFiles = async (candidates) => {
  const sessions = await listSessions()
  const referenced = new Set()
  for (const session of sessions) {
    for (const id of fileIdsIn(session)) {
      referenced.add(id)
    }
  }
  for (const id of candidates) {
    if (!referenced.has(id)) {
      await removeAttachment(CHAT_DIR, id)
    }
  }
}

const resetStaging = async () => {
  await rm(STAGING_DIR, { recursive: true, force: true })
  await mkdir(path.join(STAGING_DIR, 'sessions'), { recursive: true })
  await mkdir(path.join(STAGING_DIR, 'files'), { recursive: true })
}

const commitStaging = async () => {
  await rm(PREVIOUS_DIR, { recursive: true, force: true })
  const hadChat = await exists(CHAT_DIR)
  try {
    if (hadChat) {
      await rename(CHAT_DIR, PREVIOUS_DIR)
    }
    await rename(STAGING_DIR, CHAT_DIR)
  } catch (error) {
    if (!(await exists(CHAT_DIR)) && (await exists(PREVIOUS_DIR))) {
      await rename(PREVIOUS_DIR, CHAT_DIR)
    }
    throw error
  }
  await rm(PREVIOUS_DIR, { recursive: true, force: true })
  await resetStaging()
  return listSummaries()
}

const updateStagingFileTypes = async (types) => {
  if (!types || typeof types !== 'object' || Array.isArray(types)) {
    throw new HttpError(400, 'Invalid file type map')
  }
  for (const file of await listFiles(path.join(STAGING_DIR, 'sessions'))) {
    const session = await readJson(file, undefined)
    if (!session) {
      continue
    }
    let changed = false
    for (const message of session.messages || []) {
      if (message?.role !== 'user' || !Array.isArray(message.files)) {
        continue
      }
      for (const attachment of message.files) {
        const type = typeof types[attachment.id] === 'string' ? types[attachment.id] : ''
        if (attachment.mimeType !== type) {
          attachment.mimeType = type
          changed = true
        }
      }
    }
    if (changed) {
      await writeJsonAtomic(file, session)
    }
  }
}

const verifyUpstreamApiKey = async (apiKey) => {
  let response
  try {
    response = await fetch(new URL('models', UPSTREAM_ORIGIN), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new HttpError(502, error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text || response.statusText || 'API key verification failed'
    try {
      const body = JSON.parse(text)
      if (typeof body?.error?.message === 'string') {
        message = body.error.message
      }
    } catch {
      // Keep the original upstream response.
    }
    throw new HttpError(response.status, message)
  }
}

const saveApiKey = async (apiKey) => {
  const value = apiKey.trim()
  if (value.length < 8 || value.length > 512 || /\s/.test(value)) {
    throw new HttpError(400, 'Invalid API key')
  }
  await verifyUpstreamApiKey(value)
  await withLock('config', async () => {
    const config = await readConfig()
    await writeJsonAtomic(CONFIG_PATH, {
      ...config,
      apiKey: value,
      updatedAt: new Date().toISOString(),
    })
  })
}

const proxyAllowed = (pathname) =>
  pathname === '/models' ||
  pathname === '/v1/tools/asr' ||
  pathname === '/v1/tools/ocr' ||
  pathname === '/v1/tools/tts' ||
  pathname === '/anthropic/v1/messages' ||
  /^\/anthropic\/v1\/files(?:\/[^/]+)?$/.test(pathname)

const copyUpstreamHeaders = (headers) => {
  const allowed = new Set([
    'accept',
    'content-type',
    'anthropic-beta',
    'cache-control',
    'request-id',
    'retry-after',
  ])
  const copied = {}
  for (const [name, value] of headers) {
    if (allowed.has(name) || name.startsWith('x-ratelimit-')) {
      copied[name] = value
    }
  }
  return copied
}

const proxyDeepSeek = async (req, res, url) => {
  const apiKey = await currentApiKey()
  if (!apiKey) {
    throw new HttpError(401, 'API key is not configured')
  }
  const suffix = url.pathname.slice('/api/deepseek'.length) || '/'
  if (!proxyAllowed(suffix)) {
    throw new HttpError(404, 'Unknown API endpoint')
  }
  const target = new URL(`${suffix.replace(/^\/+/, '')}${url.search}`, UPSTREAM_ORIGIN)
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
  }
  for (const name of ['accept', 'content-type', 'anthropic-beta']) {
    const value = req.headers[name]
    if (typeof value === 'string' && value) {
      headers[name] = value
    }
  }
  const body =
    req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, FILE_LIMIT)
  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  let upstream
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      return
    }
    throw new HttpError(502, error instanceof Error ? error.message : String(error), {
      cause: error,
    })
  }
  res.writeHead(upstream.status, {
    ...copyUpstreamHeaders(new Headers(upstream.headers)),
    'Cache-Control': upstream.headers.get('cache-control') || 'no-store',
  })
  if (!upstream.body) {
    res.end()
    return
  }
  const bodyStream = Readable.fromWeb(upstream.body)
  bodyStream.on('error', (error) => {
    if (!res.destroyed) {
      res.destroy(error)
    }
  })
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort()
    }
  })
  bodyStream.pipe(res)
}

const uploadDocumentPart = async (bytes, name) => {
  const apiKey = await currentApiKey()
  if (!apiKey) {
    throw new HttpError(401, 'API key is not configured')
  }
  const form = new FormData()
  form.append('purpose', 'rich_layout_recognition')
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), name)
  const response = await fetch(new URL('anthropic/v1/files', UPSTREAM_ORIGIN), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      'anthropic-beta': 'files-api-2025-04-14',
    },
    body: form,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text || response.statusText || 'Document part upload failed'
    try {
      const body = JSON.parse(text)
      if (typeof body?.error?.message === 'string') {
        message = body.error.message
      }
    } catch {
      // Keep the original response text.
    }
    throw new HttpError(response.status, message)
  }
  const uploaded = await response.json()
  if (typeof uploaded?.id !== 'string') {
    throw new HttpError(502, 'Invalid document upload response')
  }
  return uploaded.id
}

const mapWithConcurrency = async (items, limit, run) => {
  const results = new Array(items.length)
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

const documentCacheKey = (files, maxTokens) => {
  const source = files
    .map((file) => `${file.id}:${file.serverId ?? ''}:${file.name}:${file.size}`)
    .join('|')
  const signature = `${source}:${maxTokens}`
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(signature, 'utf8')) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return { key: hash.toString(16).padStart(16, '0'), signature }
}

const prepareDocumentCache = async (body) => {
  if (!Array.isArray(body?.files) || body.files.length === 0) {
    throw new HttpError(400, 'Invalid document cache request')
  }
  const files = body.files.map((file) => {
    if (
      !isResourceId(file?.id) ||
      typeof file.name !== 'string' ||
      !file.name.toLowerCase().endsWith('.pdf') ||
      typeof file.size !== 'number'
    ) {
      throw new HttpError(400, 'Invalid PDF attachment')
    }
    return file
  })
  const maxTokens = Number(body.maxTokens || 32_768)
  const inputTokens = Number(body.inputTokens || maxTokens * 2)
  if (!Number.isFinite(maxTokens) || maxTokens < 1_000) {
    throw new HttpError(400, 'Invalid token limit')
  }
  const { key, signature } = documentCacheKey(files, maxTokens)
  const cached = await readJson(documentCacheFile(key), undefined)
  if (
    cached?.version === 1 &&
    cached.source === signature &&
    cached.maxTokens === maxTokens &&
    Array.isArray(cached.parts) &&
    cached.parts.length >= 2 &&
    cached.parts.every((part) => typeof part.serverId === 'string' && part.serverId)
  ) {
    return { key, cached: true, parts: cached.parts }
  }

  const { PDFDocument } = await import('pdf-lib')
  const targetTokens = Math.max(4_000, Math.floor(maxTokens * 0.72))
  const totalChunks = Math.min(12, Math.max(2, Math.ceil(inputTokens / targetTokens)))
  const descriptors = []
  for (const file of files) {
    const sourcePath = path.join(CHAT_DIR, 'files', resourceFileName(file.id))
    const bytes = await readFile(sourcePath)
    const source = await PDFDocument.load(bytes)
    const pageCount = source.getPageCount()
    if (pageCount <= 1) {
      throw new HttpError(400, 'PDF is too small to split')
    }
    const chunksForFile = Math.max(2, Math.ceil(totalChunks / files.length))
    const pagesPerChunk = Math.ceil(pageCount / chunksForFile)
    for (let start = 0, index = 0; start < pageCount; start += pagesPerChunk, index++) {
      const end = Math.min(start + pagesPerChunk, pageCount)
      const chunk = await PDFDocument.create()
      const pages = await chunk.copyPages(
        source,
        Array.from({ length: end - start }, (_, offset) => start + offset)
      )
      for (const page of pages) {
        chunk.addPage(page)
      }
      const data = await chunk.save()
      descriptors.push({
        id: randomUUID(),
        name: `${file.name.replace(/\.pdf$/i, '')}-part-${index + 1}.pdf`,
        label: `《${file.name}》第 ${start + 1}-${end} 页`,
        startPage: start + 1,
        endPage: end,
        size: data.length,
        bytes: data,
      })
    }
  }
  if (descriptors.length < 2 || descriptors.length > 12) {
    throw new HttpError(400, 'Unable to create reusable PDF chunks')
  }

  await Promise.all(
    descriptors.map(async (part) => {
      const target = path.join(DOCUMENT_CACHE_DIR, 'files', resourceFileName(part.id))
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, part.bytes, { mode: 0o600 })
      await rename(temp, target)
      await writeJsonAtomic(`${target}.json`, {
        type: 'application/pdf',
        size: part.bytes.length,
      })
    })
  )
  const uploaded = await mapWithConcurrency(descriptors, 3, async (part) => ({
    ...part,
    serverId: await uploadDocumentPart(part.bytes, part.name),
  }))
  const parts = uploaded.map(({ bytes: _bytes, ...part }) => part)
  const now = Date.now()
  await withLock('document-cache', () =>
    writeJsonAtomic(documentCacheFile(key), {
      version: 1,
      source: signature,
      maxTokens,
      createdAt: now,
      updatedAt: now,
      parts,
    })
  )
  return { key, cached: false, parts }
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const serveStatic = async (req, res, url) => {
  if (API_ONLY) {
    throw new HttpError(404, 'Not found')
  }
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    throw new HttpError(400, 'Invalid path')
  }
  const requested =
    pathname === '/' || /^\/chat\/[^/]+\/?$/.test(pathname) ? '/index.html' : pathname
  const target = path.resolve(DIST_DIR, `.${requested}`)
  if (target !== DIST_DIR && !target.startsWith(`${DIST_DIR}${path.sep}`)) {
    throw new HttpError(403, 'Forbidden')
  }
  let info
  try {
    info = await stat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new HttpError(404, 'Not found')
    }
    throw error
  }
  if (!info.isFile()) {
    throw new HttpError(404, 'Not found')
  }
  const extension = path.extname(target).toLowerCase()
  const immutable = requested.startsWith('/static/')
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(target).pipe(res)
}

const handleChat = async (req, res, url) => {
  const pathname = url.pathname
  if (req.method === 'GET' && pathname === '/api/chat/sessions') {
    sendJson(res, 200, await listSummaries())
    return true
  }
  if (req.method === 'DELETE' && pathname === '/api/chat/staging') {
    await withLock('chat', resetStaging)
    res.writeHead(204)
    res.end()
    return true
  }
  if (req.method === 'POST' && pathname === '/api/chat/staging/sessions') {
    const session = await readJsonBody(req)
    if (!session || typeof session.id !== 'string') {
      throw new HttpError(400, 'Invalid session')
    }
    const id = safeId(session.id)
    validateSession(session, id)
    await withLock('chat', () => writeJsonAtomic(sessionFile(STAGING_DIR, id), session))
    res.writeHead(204)
    res.end()
    return true
  }
  if (req.method === 'POST' && pathname === '/api/chat/staging/file-types') {
    const types = await readJsonBody(req)
    await withLock('chat', () => updateStagingFileTypes(types))
    res.writeHead(204)
    res.end()
    return true
  }
  if (req.method === 'POST' && pathname === '/api/chat/staging/commit') {
    const summaries = await withLock('chat', commitStaging)
    sendJson(res, 200, summaries)
    return true
  }
  if (req.method === 'POST' && pathname === '/api/chat/document-cache/split') {
    const result = await prepareDocumentCache(await readJsonBody(req))
    sendJson(res, 200, result)
    return true
  }

  let match = /^\/api\/chat\/document-cache\/files\/([^/]+)$/.exec(pathname)
  if (match && req.method === 'PUT') {
    const id = safeId(match[1])
    await writeAttachment(DOCUMENT_CACHE_DIR, id, req)
    res.writeHead(204)
    res.end()
    return true
  }
  if (match && (req.method === 'GET' || req.method === 'HEAD')) {
    const id = safeId(match[1])
    const target = path.join(DOCUMENT_CACHE_DIR, 'files', resourceFileName(id))
    let info
    try {
      info = await stat(target)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new HttpError(404, 'Cached document part not found')
      }
      throw error
    }
    const meta = await readJson(`${target}.json`, {})
    res.writeHead(200, {
      'Content-Type':
        typeof meta.type === 'string' && meta.type ? meta.type : 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
    } else {
      createReadStream(target).pipe(res)
    }
    return true
  }

  match = /^\/api\/chat\/document-cache\/([^/]+)$/.exec(pathname)
  if (match && req.method === 'GET') {
    const id = safeId(match[1])
    const cache = await readJson(documentCacheFile(id), undefined)
    if (!cache) {
      throw new HttpError(404, 'Document cache not found')
    }
    sendJson(res, 200, cache)
    return true
  }
  if (match && req.method === 'PUT') {
    const id = safeId(match[1])
    const cache = await readJsonBody(req)
    if (!cache || typeof cache !== 'object' || !Array.isArray(cache.parts)) {
      throw new HttpError(400, 'Invalid document cache')
    }
    await withLock('document-cache', () => writeJsonAtomic(documentCacheFile(id), cache))
    res.writeHead(204)
    res.end()
    return true
  }

  match = /^\/api\/chat\/staging\/files\/([^/]+)$/.exec(pathname)
  if (match && req.method === 'PUT') {
    const id = safeId(match[1])
    await writeAttachment(STAGING_DIR, id, req)
    res.writeHead(204)
    res.end()
    return true
  }

  match = /^\/api\/chat\/files\/([^/]+)$/.exec(pathname)
  if (match && req.method === 'PUT') {
    const id = safeId(match[1])
    await writeAttachment(CHAT_DIR, id, req)
    res.writeHead(204)
    res.end()
    return true
  }
  if (match && (req.method === 'GET' || req.method === 'HEAD')) {
    const id = safeId(match[1])
    const target = chatFile(id)
    let info
    try {
      info = await stat(target)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new HttpError(404, 'Attachment not found')
      }
      throw error
    }
    const meta = await readJson(`${target}.json`, {})
    res.writeHead(200, {
      'Content-Type':
        typeof meta.type === 'string' && meta.type ? meta.type : 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
    } else {
      createReadStream(target).pipe(res)
    }
    return true
  }

  match = /^\/api\/chat\/sessions\/([^/]+)$/.exec(pathname)
  if (match) {
    const id = safeId(match[1])
    if (req.method === 'GET') {
      const session = await loadSession(id)
      if (!session) {
        throw new HttpError(404, 'Session not found')
      }
      sendJson(res, 200, session)
      return true
    }
    if (req.method === 'PUT') {
      const session = validateSession(await readJsonBody(req), id)
      await withLock('chat', () => writeJsonAtomic(sessionFile(CHAT_DIR, id), session))
      res.writeHead(204)
      res.end()
      return true
    }
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req)
      if (!body || typeof body.title !== 'string') {
        throw new HttpError(400, 'Invalid title')
      }
      await withLock('chat', async () => {
        const session = await loadSession(id)
        if (!session) {
          throw new HttpError(404, 'Session not found')
        }
        session.title = body.title
        await writeJsonAtomic(sessionFile(CHAT_DIR, id), session)
      })
      res.writeHead(204)
      res.end()
      return true
    }
    if (req.method === 'DELETE') {
      await withLock('chat', async () => {
        const session = await loadSession(id)
        const candidates = session ? fileIdsIn(session) : new Set()
        await rm(sessionFile(CHAT_DIR, id), { force: true })
        await cleanupFiles(candidates)
      })
      res.writeHead(204)
      res.end()
      return true
    }
  }
  return false
}

const handleSettings = async (req, res, url) => {
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    sendJson(res, 200, await apiKeyStatus())
    return true
  }
  if (url.pathname === '/api/settings/api-key' && req.method === 'PUT') {
    const body = await readJsonBody(req)
    if (!body || typeof body.apiKey !== 'string') {
      throw new HttpError(400, 'Invalid API key')
    }
    await saveApiKey(body.apiKey)
    sendJson(res, 200, await apiKeyStatus())
    return true
  }
  if (url.pathname === '/api/settings/api-key' && req.method === 'DELETE') {
    await withLock('config', async () => {
      const config = await readConfig()
      delete config.apiKey
      await writeJsonAtomic(CONFIG_PATH, config)
    })
    res.writeHead(204)
    res.end()
    return true
  }
  return false
}

const server = http.createServer(async (req, res) => {
  try {
    await ready()
    if (!req.url) {
      throw new HttpError(400, 'Missing URL')
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (url.pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (url.pathname.startsWith('/api/deepseek/')) {
      await proxyDeepSeek(req, res, url)
      return
    }
    if (await handleSettings(req, res, url)) {
      return
    }
    if (url.pathname.startsWith('/api/chat') && (await handleChat(req, res, url))) {
      return
    }
    if (url.pathname.startsWith('/api/')) {
      throw new HttpError(404, 'Not found')
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'Method not allowed')
    }
    await serveStatic(req, res, url)
  } catch (error) {
    sendError(res, error)
  }
})

server.listen(PORT, HOST, () => {
  const mode = API_ONLY ? 'API' : 'web'
  console.log(`[chat] ${mode} server listening on http://${HOST}:${PORT}`)
  console.log(`[chat] data directory: ${DATA_DIR}`)
})

const shutdown = () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
