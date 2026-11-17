import fs from 'fs-extra'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const state = {
    root: `/tmp/wxe-inquiry-sessions-${process.pid}`,
    ready: true,
    calls: 0,
    raw: { last_timestamp: 123, last_message: 'private body' } as Record<string, unknown>,
    client: {
      invalidateSessionCache(): void {
        return undefined
      },
      async getSessionsAsync(options: { hydrateDisplayNames: false }) {
        if (options.hydrateDisplayNames !== false) throw new Error('hydrated')
        state.calls += 1
        return [{ username: 'chat', raw: state.raw }, { raw: state.raw }]
      },
      getMyUsernameCandidates: () => ['self']
    }
  }
  return state
})

vi.mock('electron', () => ({
  app: {
    getPath: () => fixture.root,
    getAppPath: () => fixture.root,
    getVersion: () => 'test-version',
    isPackaged: false
  },
  shell: { openPath: async () => '', openExternal: async () => undefined },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

vi.mock('../../src/main/services/chat-service', () => ({
  isReady: () => fixture.ready,
  getChatDb: () => ({ getWcdb4Client: () => fixture.client }),
  listContacts: () => [],
  listContactsAsync: async () => [],
  listMessages: () => [],
  getGroupSnapshot: () => ({ members: [] }),
  listRecentChat: () => [],
  resolveMd5: () => null
}))

import { startHttpServer, type HttpServerHandle } from '../../src/main/http-server'

const TOKEN = 'valid-token_1'
const handles: HttpServerHandle[] = []

async function start(): Promise<HttpServerHandle> {
  const handle = await startHttpServer('127.0.0.1', 0, { tokenProvider: () => TOKEN })
  handles.push(handle)
  return handle
}

describe('GET /api/v1/inquiry-sessions', () => {
  beforeAll(() => {
    fs.ensureDirSync(fixture.root)
    fs.outputFileSync(
      join(fixture.root, 'docs', 'skill', 'tracememo-reader', 'SKILL.md'),
      '---\nname: tracememo-reader\nversion: 0.0.0\ndescription: fixture\n---\n'
    )
  })

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()))
    fixture.ready = true
    fixture.calls = 0
    fixture.raw = { last_timestamp: 123, last_message: 'private body' }
  })

  afterAll(() => fs.removeSync(fixture.root))

  it('returns 401 without a token and with an invalid token', async () => {
    const handle = await start()
    const url = `http://${handle.host}:${handle.port}/api/v1/inquiry-sessions`
    const missing = await fetch(url)
    expect(missing.status).toBe(401)
    expect(await missing.json()).toMatchObject({
      error: 'unauthorized',
      message: 'Valid API token required'
    })
    const invalid = await fetch(url, { headers: { Authorization: 'Bearer not-the-token' } })
    expect(invalid.status).toBe(401)
    expect(await invalid.json()).toMatchObject({ error: 'unauthorized' })
    expect(fixture.calls).toBe(0)
  })

  it('returns session metadata for a valid token and does not include message text', async () => {
    const handle = await start()
    const url = `http://${handle.host}:${handle.port}/api/v1/inquiry-sessions`
    const [firstResponse, secondResponse] = await Promise.all([
      fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } }),
      fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    ])
    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    const first = await firstResponse.json()
    const second = await secondResponse.json()
    expect(first).toMatchObject({
      version: 1,
      selfNames: ['self'],
      items: [{ username: 'chat', last_timestamp: 123 }]
    })
    expect(first.items[0].fingerprint).toBe(second.items[0].fingerprint)
    expect(fixture.calls).toBe(1)
    expect(JSON.stringify(first)).not.toContain('private body')
    const health = await fetch(`http://${handle.host}:${handle.port}/api/v1/health`)
    expect(health.status).toBe(200)
  })

  it('returns 503 when session metadata cannot be read', async () => {
    fixture.ready = false
    const handle = await start()
    const response = await fetch(`http://${handle.host}:${handle.port}/api/v1/inquiry-sessions`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: 'Session metadata unavailable',
      status: 503
    })
  })
})
