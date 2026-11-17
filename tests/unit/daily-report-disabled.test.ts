import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

const chat = vi.hoisted(() => ({
  listContacts: vi.fn(),
  getSelfAccountInfo: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/tracememo-daily-report-disabled' } }))
vi.mock('../../src/main/services/chat-service', () => chat)

import { AutomationService } from '../../src/main/services/automation-service'
import { AutomationActionRunner } from '../../src/main/services/automation-action-runner'
import { ScheduledReportService } from '../../src/main/services/scheduled-report-service'
import type { AutomationExecutionLogService } from '../../src/main/services/automation-execution-log-service'
import type { AutomationRuleStore } from '../../src/main/services/automation-rule-store'
import {
  createDefaultDailyReportRule,
  createDefaultLeaveNotificationRule,
  createDefaultScheduledReportRule,
  normalizeScheduledReportConfig,
  type AutomationExecution,
  type AutomationRule
} from '../../src/shared/automation'
import { DAILY_REPORT_EXECUTION_ENABLED } from '../../src/shared/daily-report-feature'
import type { GroupMemberExitedEvent } from '../../src/shared/group-exit-event'
import { normalizeWechatSendRequest } from '../../src/shared/wechat-send'
import type { WechatActionRequest } from '../../src/shared/wechat-action'
import type { NormalizedIncomingMessage } from '../../src/main/services/message-listener-service'

const SELF = 'wxid_self'
const GROUP_ID = 'room@chatroom'
const NOW = Date.parse('2026-08-27T18:31:00+08:00')

function dailyMessage(): NormalizedIncomingMessage {
  return {
    sessionId: GROUP_ID,
    localId: '100',
    createTime: 1_789_900_000,
    messageType: 1,
    isSelf: false,
    senderId: 'wxid_sender',
    senderNickname: '张三',
    content: '今日日报',
    isGroup: true,
    mentionTargets: [SELF]
  }
}

describe('定制版日报执行开关', () => {
  it('产品默认关闭，已保存规则到点也不会被调度', async () => {
    expect(DAILY_REPORT_EXECUTION_ENABLED).toBe(false)
    const storageDir = await mkdtemp(join(tmpdir(), 'tracememo-report-off-'))
    const rule = createDefaultScheduledReportRule(Date.parse('2026-08-27T08:00:00+08:00'), {
      id: 'rule-kept',
      name: '保留的定时日报',
      config: normalizeScheduledReportConfig({
        schedule: { time: '18:30' },
        report: { sourceConversationId: GROUP_ID, messageTypes: ['text'] }
      })
    })
    const before = JSON.stringify(rule)
    const executeRule = vi.fn()
    const sendNotification = vi.fn()
    const service = new ScheduledReportService({
      storageDir,
      listRules: () => [rule],
      executeRule,
      sendNotification,
      isDatabaseReady: () => true,
      now: () => new Date(NOW)
    })

    await service.start()
    await service.tick(new Date(NOW))
    await service.settle()
    const manual = await service.runScheduledReportNow(rule.id)

    expect(executeRule).not.toHaveBeenCalled()
    expect(sendNotification).not.toHaveBeenCalled()
    expect(manual.success).toBe(false)
    expect(manual.error).toContain('已关闭日报')
    expect(JSON.stringify(rule)).toBe(before)
    const entries = await readFile(join(storageDir, 'tasks.json'), 'utf8').catch(() => '')
    expect(entries).not.toContain('rule-kept')
  })

  it('@我生成日报的消息不再进入动作链，规则内容保持原样', async () => {
    const rule = createDefaultDailyReportRule(NOW)
    rule.conditions.conversationIds = [GROUP_ID]
    const before = JSON.stringify(rule)
    const runs: unknown[] = []
    const store = {
      listRules: () => [rule],
      getRule: (id: string) => (rule.id === id ? rule : undefined)
    } as unknown as AutomationRuleStore
    const service = new AutomationService(
      {
        getMyUsernameCandidates: () => [SELF],
        getSessions: () => [{ username: GROUP_ID, nickname: '产品测试群' }]
      } as never,
      {
        ruleStore: store,
        executionLog: {
          record: () => undefined,
          list: () => [],
          countSince: () => ({ total: 0, success: 0 })
        } as never,
        runner: {
          run: async (input: unknown) => {
            runs.push(input)
            return { steps: [], status: 'success' }
          }
        } as never,
        getCapability: async () =>
          ({
            supported: true,
            ready: true,
            status: 'ready',
            capabilities: { text: true, image: true, voice: false },
            message: 'ready',
            senderStatus: {}
          }) as never
      }
    )

    await service.handleMessage(dailyMessage())

    expect(runs).toHaveLength(0)
    expect(JSON.stringify(rule)).toBe(before)
    const scheduled = await service.executeScheduledRule('rule-kept', { trigger: 'manual' })
    expect(scheduled).toMatchObject({ executed: false, reason: 'feature_disabled' })
  })

  it('退群通知仍走原来的发送 mock，普通文本发送契约不变', async () => {
    chat.listContacts.mockReturnValue([
      { m_nsUsrName: 'wxid_friend', m_nsNickName: '好友', remark: '好友备注', type: 'user' }
    ])
    chat.getSelfAccountInfo.mockReturnValue({ wxid: SELF })
    const requests: WechatActionRequest[] = []
    const executions: AutomationExecution[] = []
    const rule: AutomationRule | undefined = createDefaultLeaveNotificationRule(NOW)
    const service = new AutomationService({} as never, {
      ruleStore: {
        listRules: () => (rule ? [rule] : []),
        getRule: (id: string) => (rule && rule.id === id ? rule : undefined)
      } as unknown as AutomationRuleStore,
      executionLog: {
        record: (execution: AutomationExecution) => {
          executions.push(execution)
        },
        list: () => executions,
        countSince: () => ({ total: executions.length, success: 0 })
      } as unknown as AutomationExecutionLogService,
      runner: new AutomationActionRunner({
        executeAction: async (request) => {
          requests.push(request)
          return {
            actionId: 'action-1',
            status: 'sent',
            decision: 'allow',
            startedAt: new Date(NOW).toISOString(),
            finishedAt: new Date(NOW).toISOString()
          }
        },
        now: () => NOW
      }),
      getCapability: async () =>
        ({
          supported: true,
          ready: true,
          status: 'ready',
          capabilities: { text: true, image: true, voice: true },
          message: 'ready',
          senderStatus: {}
        }) as never,
      now: () => NOW
    })
    const event: GroupMemberExitedEvent = {
      eventId: 'room@chatroom:wxid_member:1700000000000:1',
      conversationId: GROUP_ID,
      groupName: '产品测试群',
      memberId: 'wxid_member',
      memberName: '张三',
      wechatNickname: '张三',
      previousCount: 3,
      currentCount: 2,
      occurredAt: NOW
    }

    await service.handleGroupExit(event)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      origin: 'automation',
      purpose: 'automation_leave_notification',
      content: { type: 'text' }
    })
    expect(requests[0].purpose).not.toBe('automation_report')

    expect(
      normalizeWechatSendRequest({
        request_id: 'send-1',
        to: 'room@chatroom',
        type: 'text',
        msg: '普通通知',
        is_group: true
      })
    ).toMatchObject({
      request_id: 'send-1',
      to: 'room@chatroom',
      type: 'text',
      msg: '普通通知',
      is_group: true
    })
  })
})
