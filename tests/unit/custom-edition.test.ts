import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CURRENT_USER_DATA_NAME } from '../../src/main/app-data-paths'
import {
  CUSTOM_EDITION_ID,
  CUSTOM_EDITION_LABEL,
  UPSTREAM_BASE_COMMIT,
  UPSTREAM_BASE_VERSION
} from '../../src/shared/custom-edition'
import { PRIMARY_NAV_ITEMS } from '../../src/renderer/src/components/layout/navigation'

describe('custom edition identity', () => {
  it('keeps the install identity and user data path of upstream TraceMemo', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const win = readFileSync('electron-builder.win.yml', 'utf8')
    const mac = readFileSync('electron-builder.yml', 'utf8')

    expect(pkg.version).toBe('2.6.1-custom.1')
    expect(pkg.version).not.toBe(UPSTREAM_BASE_VERSION)
    expect(CUSTOM_EDITION_ID).toBe('phase1-no-guide-no-report')
    expect(CUSTOM_EDITION_LABEL).toContain('无新手引导')
    expect(UPSTREAM_BASE_COMMIT).toMatch(/^[0-9a-f]{40}$/)
    expect(CURRENT_USER_DATA_NAME).toBe('TraceMemo')

    for (const config of [win, mac]) {
      expect(config).toMatch(/^appId: com\.tracememo\.app$/m)
      expect(config).toMatch(/^productName: TraceMemo$/m)
    }
    expect(win).toMatch(/executableName: TraceMemo/)
    expect(PRIMARY_NAV_ITEMS.map((item) => item.id)).toEqual([
      'archive',
      'search',
      'exit-monitor',
      'automation',
      'agent-hub',
      'export',
      'api',
      'settings'
    ])
  })
})
