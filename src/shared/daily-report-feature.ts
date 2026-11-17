/**
 * 定制版关闭日报的执行开关。
 *
 * 已保存的日报文件、`reports` 目录、`automation/rules.json` 里的
 * `daily_report` / `scheduled_report` 规则都不要删。这个开关只让本进程
 * 不再生成、不再发送。退群通知、通用发送和其它规则类型不读它。
 */
export const DAILY_REPORT_EXECUTION_ENABLED = false

export const DAILY_REPORT_DISABLED_MESSAGE =
  '定制版已关闭日报。已保存的日报文件和「@我生成日报」「定时日报」规则都还在，但不会再生成或发送。退群通知不受影响。'

export function isDailyReportExecutionEnabled(): boolean {
  return DAILY_REPORT_EXECUTION_ENABLED
}
