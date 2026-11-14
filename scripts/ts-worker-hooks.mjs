import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 让 worker 在未打包时直接跑 TypeScript 源文件。
 * 只补相对路径的 `.ts`，不改 node_modules。
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !path.extname(specifier) &&
    context.parentURL
  ) {
    const parent = fileURLToPath(context.parentURL)
    const candidate = path.resolve(path.dirname(parent), `${specifier}.ts`)
    if (existsSync(candidate)) return nextResolve(`${specifier}.ts`, context)
  }
  return nextResolve(specifier, context)
}
