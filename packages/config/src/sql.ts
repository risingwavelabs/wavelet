import type { SqlFragment } from './types.js'

export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  let text = ''
  for (let i = 0; i < strings.length; i++) {
    text += strings[i]
    if (i < values.length) {
      text += String(values[i])
    }
  }
  return { _tag: 'sql' as const, text: text.trim() }
}
