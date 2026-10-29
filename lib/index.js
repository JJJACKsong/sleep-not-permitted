/**
 * sleep-not-permitted —— 前台等待守卫（Host 半）。
 *
 * 一条挂载在 `tools.guard()` 上的同步门禁：只要 Agent 打算在前台跑
 * 「等待型命令」（sleep / wait / tail -f / watch / 无 -c 的 ping / 无限循环 …），
 * 或调用「阻塞等待型工具」（wait_agent / job_output(wait: true)），
 * 就直接拒绝这次调用，并把「改成后台 / 结束本轮等唤醒」的完整做法写进拒绝原因——
 * 模型读到的是可执行指令，不是一句「不允许」。
 *
 * 为什么是插件而不是 AGENTS.md 或 preset：AGENTS.md 是工作区级的，每个工作区都要写一遍；
 * preset 是 agent 配置级的，每个组合都要复制一份。插件的宿主 guard 是 profile 级的——
 * 装一次，所有工作区、所有会话、所有子代理一起生效，还能带配置、能升级、能卸载。
 *
 * 为什么是 guard 而不是重写参数：`tools/pre-execute` / `tools/execute` 明确不做
 * 参数改写（参数已被记录并展示给用户），所以无法把 `sleep 30` 偷偷改成后台调用；
 * 能做的、也最诚实的是拒绝前台形态，让 Agent 用 `run_in_background: true` 重发。
 *
 * @module dsh-plugin-sleep-not-permitted
 */

import { execFileSync } from 'node:child_process'
import { INTERACTIVE_RULE_IDS, RULE_IDS, detectForegroundWait, detectInteractive } from './detect.js'
import { LANGUAGE_SETTINGS, resolveLanguage } from './language.js'
import { renderDenyBlockingWait, renderDenyCommand, renderDenyInteractive, renderDenyPolling, renderPrompt } from './messages.js'

/** Cordis 插件名，用于 Loader 诊断。 */
export const name = 'sleep-not-permitted'

/** 硬依赖：没有工具注册表就无处挂 guard；没有系统提示就只做一半。 */
export const inject = ['tools', 'systemPrompt']

/** 默认受管的 shell 工具：能起命令的那些。 */
const DEFAULT_TOOLS = ['bash', 'pwsh', 'terminal_send']

/** 默认受管的「阻塞等待型工具」：一调用就是前台阻塞，不产生任何工作。 */
const DEFAULT_BLOCKING_TOOLS = ['wait_agent']

/** 默认受管的「带 wait 开关的工具」：只在 `wait: true` 时算阻塞等待。 */
const DEFAULT_BLOCKING_WAIT_FLAG_TOOLS = ['job_output']

/**
 * 公开版默认前台等待预算：30 秒。
 *
 * 为什么不直接全禁：DSH 官方的 Agent Teams 指引要求 Lead 用 wait_agent 等队友，
 * 一装就全禁会让陌生用户的 team 流程当场报错。默认放过 30 秒内的短等待、
 * 拦住 5 分钟那种真正的冻结；想要绝对严格（一秒钟都不许等）就设成 0。
 */
const DEFAULT_MAX_BLOCKING_WAIT_MS = 30000

/** 工具 schema 未写 timeout 时的默认等待：wait_agent / job_output 都是 30s。 */
const ASSUMED_DEFAULT_WAIT_MS = 30000

/** 默认文案语言：跟随系统语言（中文环境只出中文，省一半提示词）。 */
const DEFAULT_LANGUAGE = 'auto'

/**
 * 轮询门禁默认值。
 *
 * 为什么需要它：禁掉 sleep 之后，模型会用「反复 check 进度」代替等待——实测一个会话
 * 10 分钟内把同一条检查命令跑了 28 次，DSH 自带的重复提醒（建议性）也拦不住。
 * 这里把它变成硬拒绝：同一条命令在窗口内出现超过 `阈值` 次就拒，并教它把等待包成后台作业。
 */
const DEFAULT_ANTI_POLLING = true
const DEFAULT_POLL_REPEAT_THRESHOLD = 3
const DEFAULT_POLL_WINDOW_MS = 120000

/** 提示段名与排序：紧贴 TOOL_JOBS(1600) 之后，与「后台作业」上下文相邻。 */
const PROMPT_SECTION = 'rule:sleep-not-permitted'
const PROMPT_ORDER = 1650

function fail(message) {
  throw new Error(`sleep-not-permitted: ${message}`)
}

function asStringArray(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`\`${field}\` must be an array of strings`)
  }
  return value
}

/** 读取 macOS 系统语言偏好（GUI 应用通常拿不到 LANG，只能问系统）。 */
function readAppleLanguages() {
  if (process.platform !== 'darwin') return undefined
  try {
    const raw = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], {
      encoding: 'utf8',
      timeout: 500,
      windowsHide: true,
    })
    return [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  } catch {
    return undefined
  }
}

/** 收集语言信号，交给 resolveLanguage 决定渲染语言。 */
function collectLanguageSignals() {
  let intlLocale
  try {
    intlLocale = new Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    intlLocale = undefined
  }
  return { env: process.env, intlLocale, appleLanguages: readAppleLanguages() }
}

/**
 * 校验并归一化 Loader 传下来的原始配置。fail-loud：错配置在挂载期就炸，
 * 不让一个「看起来装好了其实没生效」的守卫静默存在。
 * @param {unknown} raw - Loader 传入的 config。
 * @returns {object} 归一化配置。
 */
function normalizeConfig(raw) {
  const config = raw === undefined || raw === null ? {} : raw
  if (typeof config !== 'object' || Array.isArray(config)) fail('config must be an object')

  const enabled = config.enabled ?? true
  if (typeof enabled !== 'boolean') fail('`enabled` must be a boolean')

  const tools = new Set(config.tools === undefined ? DEFAULT_TOOLS : asStringArray(config.tools, 'tools'))
  if (tools.size === 0) fail('`tools` must not be empty (the guard would protect nothing)')

  const disabledRules = new Set(asStringArray(config.disabledRules, 'disabledRules'))
  for (const id of disabledRules) {
    if (!RULE_IDS.includes(id)) fail(`unknown rule "${id}" in \`disabledRules\`; known rules: ${RULE_IDS.join(', ')}`)
  }

  const extraRules = []
  if (config.extraRules !== undefined) {
    if (!Array.isArray(config.extraRules)) fail('`extraRules` must be an array')
    config.extraRules.forEach((rule, index) => {
      if (rule === null || typeof rule !== 'object') fail(`\`extraRules[${index}]\` must be an object`)
      if (typeof rule.id !== 'string' || rule.id.trim() === '') fail(`\`extraRules[${index}].id\` must be a non-empty string`)
      if (typeof rule.pattern !== 'string' || rule.pattern.trim() === '') fail(`\`extraRules[${index}].pattern\` must be a non-empty string`)
      let pattern
      try {
        pattern = new RegExp(rule.pattern, 'g')
      } catch (error) {
        fail(`\`extraRules[${index}].pattern\` is not a valid regular expression: ${String(error)}`)
      }
      if (rule.label !== undefined && typeof rule.label !== 'string') fail(`\`extraRules[${index}].label\` must be a string`)
      if (rule.reason !== undefined && typeof rule.reason !== 'string') fail(`\`extraRules[${index}].reason\` must be a string`)
      extraRules.push({ id: rule.id.trim(), pattern, label: rule.label, reason: rule.reason })
    })
  }

  const announceInPrompt = config.announceInPrompt ?? true
  if (typeof announceInPrompt !== 'boolean') fail('`announceInPrompt` must be a boolean')

  const language = config.language ?? DEFAULT_LANGUAGE
  if (!LANGUAGE_SETTINGS.includes(language)) {
    fail(`\`language\` must be one of ${LANGUAGE_SETTINGS.join(' / ')}`)
  }

  const blockingTools = new Set(
    config.blockingTools === undefined ? DEFAULT_BLOCKING_TOOLS : asStringArray(config.blockingTools, 'blockingTools'),
  )
  const blockingWaitFlagTools = new Set(
    config.blockingWaitFlagTools === undefined
      ? DEFAULT_BLOCKING_WAIT_FLAG_TOOLS
      : asStringArray(config.blockingWaitFlagTools, 'blockingWaitFlagTools'),
  )
  const maxBlockingWaitMs = config.maxBlockingWaitMs ?? DEFAULT_MAX_BLOCKING_WAIT_MS
  if (!Number.isFinite(maxBlockingWaitMs) || maxBlockingWaitMs < 0) {
    fail('`maxBlockingWaitMs` must be a finite number >= 0 (0 = 一律拒绝前台阻塞等待)')
  }

  const antiPolling = config.antiPolling ?? DEFAULT_ANTI_POLLING
  if (typeof antiPolling !== 'boolean') fail('`antiPolling` must be a boolean')

  const pollRepeatThreshold = config.pollRepeatThreshold ?? DEFAULT_POLL_REPEAT_THRESHOLD
  if (!Number.isInteger(pollRepeatThreshold) || pollRepeatThreshold < 2) {
    fail('`pollRepeatThreshold` must be an integer >= 2 (同一条命令允许出现的次数上限)')
  }

  const pollWindowMs = config.pollWindowMs ?? DEFAULT_POLL_WINDOW_MS
  if (!Number.isFinite(pollWindowMs) || pollWindowMs <= 0) fail('`pollWindowMs` must be a positive number of milliseconds')

  const interactiveGuard = config.interactiveGuard ?? true
  if (typeof interactiveGuard !== 'boolean') fail('`interactiveGuard` must be a boolean')

  const disabledInteractiveRules = new Set(
    asStringArray(config.disabledInteractiveRules, 'disabledInteractiveRules'),
  )
  for (const id of disabledInteractiveRules) {
    if (!INTERACTIVE_RULE_IDS.includes(id)) {
      fail(`unknown interactive rule "${id}" in \`disabledInteractiveRules\`; known: ${INTERACTIVE_RULE_IDS.join(', ')}`)
    }
  }

  return {
    enabled,
    tools,
    disabledRules,
    extraRules,
    announceInPrompt,
    language,
    blockingTools,
    blockingWaitFlagTools,
    maxBlockingWaitMs,
    antiPolling,
    pollRepeatThreshold,
    pollWindowMs,
    interactiveGuard,
    disabledInteractiveRules,
  }
}

/** 从一次工具调用里取出真正会被 shell 执行的命令文本。 */
function extractCommand(toolName, args) {
  if (typeof args.command === 'string') return args.command
  if (typeof args.text === 'string') return args.text
  return undefined
}

/** 拒绝原因里给模型的可复制重试形态：按工具给出正确字段名。 */
function retrySkeleton(toolName, command) {
  const quoted = JSON.stringify(command.length > 160 ? `${command.slice(0, 159)}…` : command)
  if (toolName === 'bash') return `bash({ command: ${quoted}, description: <原描述>, run_in_background: true })`
  if (toolName === 'pwsh') return `pwsh({ command: ${quoted}, description: <原描述>, run_in_background: true })`
  if (toolName === 'terminal_send') return `terminal_send({ sessionId: <原 sessionId>, text: ${quoted}, run_in_background: true })`
  return `${toolName}(<原参数>, run_in_background: true)`
}

/** 从等待型工具的入参里取它要阻塞多久（毫秒）；没写就用工具默认 30s。 */
function requestedWaitMs(args) {
  const raw = args.timeout_ms ?? args.timeoutMs
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  return ASSUMED_DEFAULT_WAIT_MS
}

const POLL_HISTORY = new Map()
const GLOBAL_POLL_KEY = Symbol('sleep-not-permitted.global')

/** 归一化命令文本：轮询检测只认「实质相同」的命令。 */
function normalizeCommand(command) {
  return command.replace(/\s+/g, ' ').trim()
}

/**
 * 判断同一条检查命令是否已在窗口内反复出现（轮询）。
 * @param {object} config - 归一化配置。
 * @param {object} exec - 工具执行上下文（用 agent 区分会话/子代理）。
 * @param {string} command - 命令文本。
 * @returns {string | undefined} 拒绝原因；未超阈值时返回 undefined。
 */
function pollingReason(config, exec, command) {
  if (!config.antiPolling) return undefined
  const normalized = normalizeCommand(command)
  if (normalized === '') return undefined
  const key = exec.agent ?? GLOBAL_POLL_KEY
  const now = Date.now()
  let history = POLL_HISTORY.get(key)
  if (history === undefined) {
    history = new Map()
    POLL_HISTORY.set(key, history)
  }
  const times = (history.get(normalized) ?? []).filter((at) => now - at <= config.pollWindowMs)
  if (times.length >= config.pollRepeatThreshold) {
    history.set(normalized, times)
    return renderDenyPolling(config.language, {
      name,
      tool: exec.name,
      excerpt: normalized.length > 120 ? `${normalized.slice(0, 119)}…` : normalized,
      count: times.length,
      windowMs: config.pollWindowMs,
    })
  }
  times.push(now)
  history.set(normalized, times)
  if (history.size > 100) {
    for (const [commandKey, stamps] of history) {
      const kept = stamps.filter((at) => now - at <= config.pollWindowMs)
      if (kept.length === 0) history.delete(commandKey)
      else history.set(commandKey, kept)
    }
  }
  return undefined
}

/**
 * 判断一次调用是不是「前台阻塞等待型工具调用」，并给出拒绝原因。
 * @param {object} config - 归一化后的配置。
 * @param {string} toolName - 工具名。
 * @param {object} args - 已解析参数。
 * @returns {string | undefined} 拒绝原因；不是阻塞等待或未超预算时返回 undefined。
 */
function blockingWaitReason(config, toolName, args) {
  const always = config.blockingTools.has(toolName)
  const flagWait = config.blockingWaitFlagTools.has(toolName) && args.wait === true
  if (!always && !flagWait) return undefined
  const requested = requestedWaitMs(args)
  // maxBlockingWaitMs = 0：一律拒绝；>0：只拒绝超过预算的等待。
  if (config.maxBlockingWaitMs > 0 && requested <= config.maxBlockingWaitMs) return undefined
  return renderDenyBlockingWait(config.language, {
    name,
    tool: toolName,
    requestedMs: requested,
    budgetMs: config.maxBlockingWaitMs,
  })
}

/**
 * 安装守卫。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文（宿主平面 → guard 全局生效）。
 * @param {object} [rawConfig] - Loader 配置。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  // auto → 跟随系统语言；解析一次，拒绝消息与提示词共用。
  config.language = resolveLanguage(config.language, collectLanguageSignals())

  const extraRules = config.extraRules.map((rule) => ({
    id: rule.id,
    pattern: new RegExp(rule.pattern.source, 'g'),
    label: rule.label,
    reason: rule.reason,
  }))

  const guard = (exec) => {
    const args = exec.arguments
    if (args === null || typeof args !== 'object') return undefined
    // 第一类：等待型工具——一次调用就是阻塞。
    const waitReason = blockingWaitReason(config, exec.name, args)
    if (waitReason !== undefined) return waitReason
    // 第二类：shell 工具里的命令。先拦「等人输入/确认」的——这类丢后台会静默挂住。
    if (!config.tools.has(exec.name)) return undefined
    const command = extractCommand(exec.name, args)
    if (command === undefined) return undefined
    if (config.interactiveGuard) {
      const interactive = detectInteractive(command, {
        disabledRules: [...config.disabledInteractiveRules],
      })
      if (interactive !== undefined) {
        return renderDenyInteractive(config.language, {
          name,
          tool: exec.name,
          label: interactive.label,
          excerpt: interactive.excerpt,
        })
      }
    }
    // 已经是后台调用：放行（这正是本守卫要求的形态）。
    if (args.run_in_background === true) return undefined
    const hit = detectForegroundWait(command, {
      disabledRules: [...config.disabledRules],
      extraRules,
    })
    if (hit === undefined) {
      const polled = pollingReason(config, exec, command)
      return polled
    }
    const base = renderDenyCommand(config.language, {
      name,
      label: hit.label,
      excerpt: hit.excerpt,
      skeleton: retrySkeleton(exec.name, command),
    })
    const extra = extraRules.find((rule) => rule.id === hit.id)
    return extra?.reason === undefined ? base : `${base}\n${extra.reason}`
  }

  ctx.effect(() => ctx.tools.guard(guard), 'sleep-not-permitted.guard')

  if (config.announceInPrompt) {
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: PROMPT_SECTION,
        order: PROMPT_ORDER,
        text: renderPrompt(config.language),
      }),
      'sleep-not-permitted.prompt',
    )
  }
}
