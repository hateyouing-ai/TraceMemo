import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'

/**
 * 社区模板市场的页面入口挂在日报工作区。定制版去掉日报页后，这个标签页不再出现。
 * 模板安装与渲染仍由 report-template-market.spec.ts 和单元测试覆盖。
 */
test('REPORT-TEMPLATE-MARKET-TAB-01 report tabs are not reachable', async () => {
  const fixture = await launchTestApp({ templateMarket: 'fixture' })
  const page = fixture.page
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  try {
    await expect(page.getByRole('navigation', { name: '一级导航' })).toBeVisible()
    await expect(page.getByRole('button', { name: '日报' })).toHaveCount(0)
    await expect(page.getByRole('tab', { name: '社区模板市场' })).toHaveCount(0)
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})
