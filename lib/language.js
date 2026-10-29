/**
 * 文案语言解析：`auto` 跟随用户系统语言，显式 `zh`/`en`/`both` 保持不变。
 *
 * 为什么不用 DSH 的 locale 设置：那是**客户端**偏好（host 只暴露设置表单，不提供读取
 * 当前 UI 语言的接缝）。插件要的是「用户读得懂哪种语言」，系统语言信号足够且可移植：
 * 环境变量 → macOS 系统语言偏好 → Node Intl 的默认 locale，逐级回退。
 *
 * 解析在挂载期做一次：模型会话的语言不会中途改变，没必要每次调用都探测。
 *
 * @module dsh-plugin-sleep-not-permitted/language
 */

/** 允许的 `language` 配置值。 */
export const LANGUAGE_SETTINGS = ['auto', 'both', 'zh', 'en']

/** 解析后实际使用的渲染语言。 */
export const RENDER_LANGUAGES = ['both', 'zh', 'en']

/** 从 BCP 47 / POSIX locale 串里取主语言：`zh-Hans`、`zh_CN.UTF-8` → `zh`。 */
function primaryLanguage(tag) {
  if (typeof tag !== 'string') return undefined
  const match = /^([A-Za-z]{2,8})/.exec(tag.trim())
  return match === null ? undefined : match[1].toLowerCase()
}

/**
 * 按信号判定系统语言。
 * @param {'auto'|'both'|'zh'|'en'} value - 配置值。
 * @param {object} signals - 探测到的语言信号。
 * @param {Record<string, string | undefined>} [signals.env] - 环境变量（DSH_LOCALE / LC_ALL / LC_MESSAGES / LANG）。
 * @param {string[]} [signals.appleLanguages] - macOS 系统语言优先级列表。
 * @param {string} [signals.intlLocale] - `Intl` 的默认 locale。
 * @returns {'both'|'zh'|'en'} 渲染语言。
 */
export function resolveLanguage(value, signals = {}) {
  if (value === 'zh' || value === 'en' || value === 'both') return value
  const env = signals.env ?? {}
  // 1) 显式覆盖（也用于测试与多语言用户）。
  const explicit = ['DSH_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANG']
  for (const name of explicit) {
    const language = primaryLanguage(env[name])
    if (language === 'zh') return 'zh'
    if (language === 'en') return 'en'
  }
  // 2) macOS 的系统语言偏好（GUI 应用通常拿不到 LANG）。
  for (const tag of signals.appleLanguages ?? []) {
    const language = primaryLanguage(tag)
    if (language === 'zh') return 'zh'
    if (language === 'en') return 'en'
  }
  // 3) Node 的默认 locale。
  const intl = primaryLanguage(signals.intlLocale)
  if (intl === 'zh') return 'zh'
  if (intl === 'en') return 'en'
  // 4) 兜底：英文（公共默认，最不容易读不懂）。
  return 'en'
}
