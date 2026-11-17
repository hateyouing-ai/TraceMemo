import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AppShell } from '../../src/renderer/src/components/layout/AppShell'
import { PrimaryNavigation } from '../../src/renderer/src/components/layout/PrimaryNavigation'
import { PRIMARY_NAV_ITEMS } from '../../src/renderer/src/components/layout/navigation'

describe('PrimaryNavigation', () => {
  it('shows every real top-level page exactly once and emits the selected page', async () => {
    const onPageChange = vi.fn()
    render(<PrimaryNavigation activePage="archive" onPageChange={onPageChange} />)

    const navigation = screen.getByRole('navigation', { name: '一级导航' })
    expect(navigation).toBeInTheDocument()
    for (const item of PRIMARY_NAV_ITEMS) {
      expect(screen.getAllByRole('button', { name: item.label })).toHaveLength(1)
    }

    await userEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(onPageChange).toHaveBeenCalledWith('settings')
    expect(screen.queryByRole('button', { name: '日报' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新手引导' })).not.toBeInTheDocument()
  })

  it('does not offer the first-use guide from the app shell', () => {
    render(
      <AppShell
        activePage="archive"
        selfInfo={null}
        dbReady={false}
        onPageChange={vi.fn()}
        onOpenSettings={vi.fn()}
      >
        <div>workspace</div>
      </AppShell>
    )

    expect(screen.queryByRole('button', { name: '新手引导' })).not.toBeInTheDocument()
    expect(
      screen.getByLabelText('TraceMemo（迹忆）定制版 · 无新手引导 · 无日报页')
    ).toBeInTheDocument()
  })
})
