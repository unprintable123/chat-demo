export type ChatUrlUpdate = 'push' | 'replace'

const chatPathPattern = /^\/chat\/([^/]+)\/?$/
const chatPath = (id: string | null) => (id === null ? '/' : `/chat/${encodeURIComponent(id)}`)

/** 从 SPA 路径中读取当前会话 id；其他路径视为新对话。 */
export const getChatIdFromUrl = (pathname = window.location.pathname): string | null => {
  const match = chatPathPattern.exec(pathname)
  if (!match) {
    return null
  }
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/** 切换会话页面地址，同时保留查询参数与锚点。 */
export const updateChatUrl = (id: string | null, update: ChatUrlUpdate) => {
  const pathname = chatPath(id)
  if (window.location.pathname === pathname) {
    return
  }
  const url = `${pathname}${window.location.search}${window.location.hash}`
  if (update === 'push') {
    window.history.pushState({ chatId: id }, '', url)
  } else {
    window.history.replaceState({ chatId: id }, '', url)
  }
}
