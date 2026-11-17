import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createInquirySessionFeed } from '../../src/main/services/inquiry-session-feed'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('inquiry session feed', () => {
  it('caches for 4 seconds, single-flights, and omits message text', async () => {
    let clock = 10_000
    let calls = 0
    let raw: Record<string, unknown> = { last_timestamp: 123, last_message: 'private body' }
    const client = {
      invalidateSessionCache(): void {
        return undefined
      },
      async getSessionsAsync(options: { hydrateDisplayNames: false }) {
        expect(options.hydrateDisplayNames).toBe(false)
        calls += 1
        return [
          { username: 'chat', raw },
          { username: '', raw }
        ]
      },
      getMyUsernameCandidates(): string[] {
        return ['self']
      }
    }
    const feed = createInquirySessionFeed({
      ready: () => true,
      getClient: () => client,
      hash: sha256,
      now: () => clock
    })

    const pending = Promise.all([feed(), feed()])
    const [first, second] = await pending
    expect(calls).toBe(1)
    expect(first.items).toEqual([
      {
        username: 'chat',
        fingerprint: sha256(JSON.stringify(raw)),
        last_timestamp: 123
      }
    ])
    expect(first.items[0].fingerprint).toBe(second.items[0].fingerprint)
    expect(first.selfNames).toEqual(['self'])
    expect(first.version).toBe(1)
    expect(JSON.stringify(first)).not.toContain('private body')

    await feed()
    expect(calls).toBe(1)

    clock += 5000
    raw = { ...raw, last_timestamp: 124 }
    const changed = await feed()
    expect(calls).toBe(2)
    expect(changed.items[0].fingerprint).not.toBe(first.items[0].fingerprint)
    expect(changed.items[0].last_timestamp).toBe(124)
    expect(JSON.stringify(changed)).not.toContain('private body')
  })

  it('throws when the database is not ready or the client cannot list sessions', async () => {
    const notReady = createInquirySessionFeed({
      ready: () => false,
      getClient: () => null,
      hash: sha256,
      now: () => 0
    })
    await expect(notReady()).rejects.toThrow('not_ready')

    const unavailable = createInquirySessionFeed({
      ready: () => true,
      getClient: () => null,
      hash: sha256,
      now: () => 0
    })
    await expect(unavailable()).rejects.toThrow('sessions_unavailable')
  })

  it('drops the cached snapshot when the client instance changes', async () => {
    let calls = 0
    const makeClient = (
      timestamp: number
    ): {
      invalidateSessionCache: () => void
      getSessionsAsync: () => Promise<{ username: string; raw: { last_timestamp: number } }[]>
      getMyUsernameCandidates: () => string[]
    } => ({
      invalidateSessionCache(): void {
        return undefined
      },
      async getSessionsAsync() {
        calls += 1
        return [{ username: 'chat', raw: { last_timestamp: timestamp } }]
      },
      getMyUsernameCandidates(): string[] {
        return ['self']
      }
    })
    let client = makeClient(1)
    const feed = createInquirySessionFeed({
      ready: () => true,
      getClient: () => client,
      hash: sha256,
      now: () => 10_000
    })
    await feed()
    client = makeClient(2)
    const next = await feed()
    expect(calls).toBe(2)
    expect(next.items[0].last_timestamp).toBe(2)
  })
})
