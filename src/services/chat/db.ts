import {
  toSessionSummary,
  type FileAttachment,
  type Session,
  type SessionSummary,
} from './types.js'

/** Original attachments are persisted by the server, not IndexedDB. */
export type StoredFile = {
  id: string
  blob: Blob
}

export type CachedDocumentPart = {
  id: string
  name: string
  label: string
  startPage: number
  endPage: number
  size: number
  serverId: string
}

export type CachedDocumentResult = {
  key: string
  cached: boolean
  parts: CachedDocumentPart[]
}

const errorFrom = async (response: Response): Promise<Error> => {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text)
    if (typeof body?.error?.message === 'string') {
      return new Error(body.error.message)
    }
  } catch {
    // Use the plain response below.
  }
  return new Error(text || response.statusText || `Request failed (${response.status})`)
}

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw await errorFrom(response)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

const sessionUrl = (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}`

const saveFileTo = async (scope: 'files' | 'staging/files', file: StoredFile): Promise<void> => {
  const response = await fetch(`/api/chat/${scope}/${encodeURIComponent(file.id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': file.blob.type || 'application/octet-stream',
    },
    body: file.blob,
  })
  if (!response.ok) {
    throw await errorFrom(response)
  }
}

const migrateLegacyIndexedDb = async (): Promise<void> => {
  if (!('databases' in indexedDB)) {
    return
  }
  const databases = await indexedDB.databases()
  if (!databases.some((database) => database.name === 'chat-demo')) {
    return
  }

  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('chat-demo')
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })

  const readStore = <T>(name: string): Promise<T[]> => {
    if (!legacy.objectStoreNames.contains(name)) {
      return Promise.resolve([])
    }
    return new Promise<T[]>((resolve, reject) => {
      const result = legacy.transaction(name, 'readonly').objectStore(name).getAll()
      result.onsuccess = () => resolve(result.result as T[])
      result.onerror = () => reject(result.error)
    })
  }

  let sessions: Session[]
  let files: StoredFile[]
  try {
    ;[sessions, files] = await Promise.all([
      readStore<Session>('sessions'),
      readStore<StoredFile>('files'),
    ])
  } finally {
    legacy.close()
  }

  for (const file of files) {
    if (file?.id && file.blob instanceof Blob) {
      await saveFileTo('files', file)
    }
  }
  for (const session of sessions) {
    if (session?.id && Array.isArray(session.messages)) {
      await request<undefined>(sessionUrl(session.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
      })
    }
  }

  await new Promise<void>((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase('chat-demo')
    deletion.onsuccess = () => resolve()
    deletion.onerror = () => reject(deletion.error)
    deletion.onblocked = () => resolve()
  })
}

let legacyMigration: Promise<void> | undefined

/**
 * Migrate chats created by the old browser-only version. IDs are stable and writes are
 * idempotent, so an interrupted migration can safely retry on the next page load.
 */
const prepareStorage = () =>
  (legacyMigration ||= migrateLegacyIndexedDb().catch((error: unknown) => {
    legacyMigration = undefined
    throw error
  }))

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  await prepareStorage()
  return request<SessionSummary[]>('/api/chat/sessions')
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const response = await fetch(sessionUrl(id))
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw await errorFrom(response)
  }
  return (await response.json()) as Session
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  await Promise.all(files.map((file) => saveFileTo('files', file)))
  await request<undefined>(sessionUrl(session.id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session),
  })
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  await request<undefined>(sessionUrl(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

export const deleteSession = async (id: string): Promise<void> => {
  await request<undefined>(sessionUrl(id), { method: 'DELETE' })
}

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  await Promise.all(files.map((file) => saveFileTo('files', file)))
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const response = await fetch(`/api/chat/files/${encodeURIComponent(id)}`)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw await errorFrom(response)
  }
  return response.blob()
}

export const saveDocumentCacheFile = async (file: StoredFile): Promise<void> => {
  const response = await fetch(`/api/chat/document-cache/files/${encodeURIComponent(file.id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': file.blob.type || 'application/octet-stream',
    },
    body: file.blob,
  })
  if (!response.ok) {
    throw await errorFrom(response)
  }
}

export const loadDocumentCacheFile = async (id: string): Promise<Blob | undefined> => {
  const response = await fetch(`/api/chat/document-cache/files/${encodeURIComponent(id)}`)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw await errorFrom(response)
  }
  return response.blob()
}

export const loadDocumentCache = async <T>(key: string): Promise<T | undefined> => {
  const response = await fetch(`/api/chat/document-cache/${encodeURIComponent(key)}`)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw await errorFrom(response)
  }
  return (await response.json()) as T
}

export const saveDocumentCache = async <T>(key: string, value: T): Promise<void> => {
  await request<undefined>(`/api/chat/document-cache/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })
}

export const prepareDocumentCache = async (
  files: FileAttachment[],
  inputTokens: number | undefined,
  maxTokens: number,
  signal?: AbortSignal
): Promise<CachedDocumentResult> =>
  request<CachedDocumentResult>('/api/chat/document-cache/split', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: files.map(({ id, serverId, name, size }) => ({
        id,
        serverId,
        name,
        size,
      })),
      inputTokens,
      maxTokens,
    }),
    signal,
  })

export const clearStaging = async (): Promise<void> => {
  await request<undefined>('/api/chat/staging', { method: 'DELETE' })
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await request<undefined>('/api/chat/staging/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session),
  })
}

export const saveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  await Promise.all(files.map((file) => saveFileTo('staging/files', file)))
}

export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  await request<undefined>('/api/chat/staging/file-types', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(types)),
  })
}

export const commitStaging = async (): Promise<SessionSummary[]> =>
  (
    await request<SessionSummary[]>('/api/chat/staging/commit', {
      method: 'POST',
    })
  ).map(toSessionSummary)

export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[server-storage] ${action} failed`, error)
}
