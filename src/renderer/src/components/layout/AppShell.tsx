import React from 'react'
import { CUSTOM_EDITION_LABEL } from '../../../../shared/custom-edition'
import { AccountSummary } from '../account/AccountSummary'
import { PrimaryNavigation } from './PrimaryNavigation'
import { AppPage, PRIMARY_NAV_ITEMS } from './navigation'
import brandIcon from '../../assets/brand-icon.svg'

interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

interface AppShellProps {
  activePage: AppPage
  selfInfo: SelfInfo | null
  dbReady: boolean
  dbConnecting?: boolean
  onPageChange: (page: AppPage) => void
  onOpenSettings: () => void
  appearanceTheme?: 'system' | 'light' | 'dark'
  compactMode?: boolean
  children: React.ReactNode
}

function BrandLogo(): React.ReactElement {
  const label = `TraceMemo（迹忆）${CUSTOM_EDITION_LABEL}`
  return (
    <div className="app-brand" title={label} aria-label={label}>
      <img src={brandIcon} alt="" aria-hidden="true" />
    </div>
  )
}

export function AppShell({
  activePage,
  selfInfo,
  dbReady,
  dbConnecting = false,
  onPageChange,
  onOpenSettings,
  appearanceTheme = 'system',
  compactMode = false,
  children
}: AppShellProps): React.ReactElement {
  React.useEffect(() => {
    document.documentElement.dataset.theme = appearanceTheme
    return () => {
      delete document.documentElement.dataset.theme
    }
  }, [appearanceTheme])

  const activeItem = PRIMARY_NAV_ITEMS.find((item) => item.id === activePage)

  return (
    <div className={`app-shell theme-${appearanceTheme} ${compactMode ? 'is-compact' : ''}`}>
      <aside className="app-primary-rail">
        <BrandLogo />
        <PrimaryNavigation activePage={activePage} onPageChange={onPageChange} />
        <div className="app-rail-account">
          <AccountSummary
            selfInfo={selfInfo}
            dbReady={dbReady}
            dbConnecting={dbConnecting}
            compact
            onClick={onOpenSettings}
          />
        </div>
      </aside>
      <main className="app-shell-main" aria-label={activeItem?.label || '工作区'}>
        {children}
      </main>
    </div>
  )
}
