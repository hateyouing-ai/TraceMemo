import crypto from 'crypto'
import { getChatDb, isReady } from './chat-service'

/**
 * 本机 2.6.0 已安装的只读会话元数据接口。
 * 只返回 username、指纹和 last_timestamp，不返回消息正文。
 */
export interface InquirySessionRow {
  username?: string
  raw?: Record<string, unknown> | null
}

export interface InquirySessionClient {
  invalidateSessionCache: () => void
  getSessionsAsync: (options: { hydrateDisplayNames: false }) => Promise<InquirySessionRow[]>
  getMyUsernameCandidates: () => string[]
}

export interface InquirySessionItem {
  username: string
  fingerprint: string
  last_timestamp: number
}

export interface InquirySessionFeedResult {
  items: InquirySessionItem[]
  selfNames: string[]
  timestamp: number
  version: 1
}

export function createInquirySessionFeed(dependencies: {
  ready: () => boolean
  getClient: () => InquirySessionClient | null | undefined
  hash: (value: string) => string
  now?: () => number
}): () => Promise<InquirySessionFeedResult> {
  let snapshot: InquirySessionFeedResult | null = null
  let snapshotAt = 0
  let owner: InquirySessionClient | null = null
  let inFlight: Promise<InquirySessionFeedResult> | null = null
  const now = dependencies.now ?? Date.now

  return async function inquirySessionFeed(): Promise<InquirySessionFeedResult> {
    if (!dependencies.ready()) throw new Error('not_ready')
    const client = dependencies.getClient()
    if (!client?.getSessionsAsync) throw new Error('sessions_unavailable')
    if (owner !== client) {
      snapshot = null
      inFlight = null
      owner = client
    }
    if (snapshot && now() - snapshotAt < 4000) return snapshot
    if (inFlight) return inFlight
    const task = (async (): Promise<InquirySessionFeedResult> => {
      client.invalidateSessionCache()
      const rows = await client.getSessionsAsync({ hydrateDisplayNames: false })
      const result: InquirySessionFeedResult = {
        items: rows
          .filter((session) => session.username)
          .map((session) => ({
            username: session.username as string,
            fingerprint: dependencies.hash(JSON.stringify(session.raw || session)),
            last_timestamp: Number(session.raw?.last_timestamp) || 0
          })),
        selfNames: client.getMyUsernameCandidates(),
        timestamp: now(),
        version: 1
      }
      if (owner === client) {
        snapshot = result
        snapshotAt = now()
      }
      return result
    })()
    inFlight = task
    try {
      return await task
    } finally {
      if (inFlight === task) inFlight = null
    }
  }
}

export const inquirySessionFeed = createInquirySessionFeed({
  ready: isReady,
  getClient: () => getChatDb()?.getWcdb4Client(),
  hash: (value) => crypto.createHash('sha256').update(value).digest('hex')
})
