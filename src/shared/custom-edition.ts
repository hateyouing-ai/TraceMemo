/**
 * 这个 fork 的可识别定制标记。
 *
 * appId、产品名、可执行文件名和用户数据目录故意保持上游的 TraceMemo，
 * 这样安装器仍指向同一次安装，不会另开一套数据，也不会变成第二个产品名。
 * 版本号放在 package.json，这里只放不会参与安装器比较的说明。
 */
export const CUSTOM_EDITION_ID = 'phase1-no-guide-no-report'
export const CUSTOM_EDITION_LABEL = '定制版 · 无新手引导 · 无日报页'
export const UPSTREAM_REPOSITORY = 'https://github.com/Wxw-Gu/TraceMemo'
export const UPSTREAM_BASE_VERSION = '2.6.0'
export const UPSTREAM_BASE_COMMIT = '804466aad856b5815c59e1b511e30b5cf2c53f0d'
