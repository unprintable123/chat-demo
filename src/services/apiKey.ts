import { loadApiKeyStatus, storeApiKey } from './api/client.js'
import { setApiKeyConfigured } from './settings.js'

/** 旧版本曾把 API Key 存在这里；迁移成功后立即删除。 */
const LEGACY_API_KEY = 'chat-demo:api-key'

const readLegacyApiKey = () => {
  try {
    return localStorage.getItem(LEGACY_API_KEY)?.trim() || ''
  } catch {
    return ''
  }
}

export const removeLegacyApiKey = () => {
  try {
    localStorage.removeItem(LEGACY_API_KEY)
  } catch {
    // The server is authoritative even when browser storage is unavailable.
  }
}

/**
 * Load API key status from the server. A key left by an older browser-only build is
 * migrated once and removed from localStorage only after the server accepts it.
 */
export const initializeApiKey = async (): Promise<void> => {
  try {
    const status = await loadApiKeyStatus()
    if (status.apiKeyConfigured) {
      removeLegacyApiKey()
      setApiKeyConfigured(true)
      return
    }
    const legacyApiKey = readLegacyApiKey()
    if (!legacyApiKey) {
      setApiKeyConfigured(false)
      return
    }
    const migrated = await storeApiKey(legacyApiKey)
    removeLegacyApiKey()
    setApiKeyConfigured(migrated.apiKeyConfigured)
  } catch {
    setApiKeyConfigured(false)
  }
}
