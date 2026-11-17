import { expect, test } from '@playwright/test'
import { launchTestApp } from './support/electron'

test('SCHEDULED-REPORT-UI-01 daily report automation entries do not start a run', async () => {
  const fixture = await launchTestApp()
  const pageErrors: Error[] = []
  fixture.page.on('pageerror', (error) => pageErrors.push(error))
  const page = fixture.page
  try {
    await page.getByRole('button', { name: '自动化' }).click()
    await expect(page.getByTestId('daily-report-disabled-notice')).toContainText('已关闭日报')
    await expect(page.getByRole('button', { name: '新建自动化' })).toBeDisabled()
    await page.getByRole('button', { name: '管理定时日报 →' }).click()
    await expect(page.getByTestId('scheduled-report-disabled-notice')).toContainText('已关闭日报')
    const createButtons = page.getByRole('button', { name: '+ 新建定时日报' })
    await expect(createButtons.first()).toBeDisabled()
    await expect(page.getByRole('heading', { name: '新建定时日报' })).toHaveCount(0)
    await page.getByRole('radio', { name: '退群通知' }).click()
    await expect(page.getByLabel('退群通知模板内容')).toBeVisible()
    expect(pageErrors).toEqual([])
  } finally {
    await fixture.close()
  }
})
