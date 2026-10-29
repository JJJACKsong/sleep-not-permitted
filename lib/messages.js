/**
 * 面向模型的双语文案（拒绝原因与系统提示）。
 *
 * 为什么单独一个模块：这些字符串是模型实际读到的东西，公开插件必须同时照顾中英文
 * 会话，而拒绝原因本身又是「操作说明」——它比代码注释更值得集中管理、单独测试。
 *
 * `language: 'both'` 同时输出中英两段（默认，宁可多几行提示也不让另一种语言的会话
 * 读到看不懂的报错）；`'zh'` / `'en'` 只输出对应语言，用于省 token。
 *
 * @module dsh-plugin-sleep-not-permitted/messages
 */

export const LANGUAGES = ['both', 'zh', 'en']

/**
 * 毫秒渲染成人读的时长。
 * @param {number} ms - 毫秒。
 * @param {'zh' | 'en'} lang - 语言。
 * @returns {string} 例如 `5 分钟` / `5 minutes`。
 */
export function formatWait(ms, lang) {
  if (lang === 'en') {
    if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000} minute${ms === 60000 ? '' : 's'}`
    if (ms >= 1000) return `${Math.round(ms / 100) / 10} seconds`
    return `${ms}ms`
  }
  if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000} 分钟`
  if (ms >= 1000) return `${Math.round(ms / 100) / 10} 秒`
  return `${ms} 毫秒`
}

/** 拒绝一条前台等待命令。 */
const denyCommand = {
  zh: (p) => [
    `前台等待被禁止（${p.name}，命中规则：${p.label}）：\`${p.excerpt}\` 会在前台把整个会话阻塞到命令结束。`,
    `重试：把同一条命令改成后台作业 —— ${p.skeleton}。它立即返回 jobId；作业结束时你会收到完成通知，期间继续做别的事，不要用 sleep 轮询；需要输出时用 job_output，停止用 job_kill。`,
    '如果你只是想等某个已有的后台作业，直接结束本轮即可——完成通知会叫醒你。',
    '如果等的是 DSH 没有作业句柄的外部任务（远端机器、外部服务）：把「等它结束」本身包成后台作业再结束本轮——例如 ssh host \'until [ -f done ]; do sleep 5; done\' 加 run_in_background: true（后台作业里的 sleep 是允许的），作业结束会通知你。',
    '后台作业要有界：加 timeout / 看门狗，否则中途死掉或挂住就永远没有通知；执行中需要人确认的步骤先问清楚再启动。',
  ].join('\n'),
  en: (p) => [
    `Foreground waiting is forbidden (${p.name}, rule: ${p.label}): \`${p.excerpt}\` blocks the whole session until it finishes.`,
    `Retry: run the same command as a background job — ${p.skeleton}. It returns a job id immediately, notifies you when it finishes, and leaves the session free; do not poll with sleep, read output with job_output and stop it with job_kill.`,
    'If you are only waiting for an existing background job, just end this turn — the completion notice will wake you.',
    'If what you are waiting for has no DSH job handle (a remote host, an external service): wrap the waiting itself in a background job and end the turn — for example ssh host \'until [ -f done ]; do sleep 5; done\' with run_in_background: true (sleep is allowed inside background jobs); its completion will notify you.',
    'Bound the background job (timeout / watchdog): a job that dies or hangs otherwise never notifies; confirm any mid-flight human decisions before starting it.',
  ].join('\n'),
}

/** 拒绝一次前台阻塞等待型工具调用（wait_agent / job_output(wait) …）。 */
const denyBlockingWait = {
  zh: (p) => {
    const budget = p.budgetMs > 0 ? `前台等待上限 ${formatWait(p.budgetMs, 'zh')}` : '前台不允许任何阻塞等待'
    return [
      `前台阻塞等待被禁止（${p.name}）：\`${p.tool}\` 这次要前台阻塞 ${formatWait(p.requestedMs, 'zh')}（${budget}）。`,
      '这不是睡觉，但效果一样：会话会一直停在这里，而你本来不需要等——队友、子智能体、后台作业完成时都会主动通知并唤醒你。',
      '不要前台等：直接结束本轮，去做别的或等唤醒；要查状态用非阻塞方式（list_agents / team_task_list / job_output 不带 wait）；要某人开始工作就 send_message。',
    ].join('\n')
  },
  en: (p) => {
    const budget = p.budgetMs > 0 ? `foreground wait budget is ${formatWait(p.budgetMs, 'en')}` : 'no blocking foreground wait is allowed'
    return [
      `Blocking foreground wait is forbidden (${p.name}): \`${p.tool}\` would block this turn for ${formatWait(p.requestedMs, 'en')} (${budget}).`,
      'It is not sleep, but the effect is the same: the session stops here while you do not need to wait — teammates, subagents and background jobs notify and wake you when they finish.',
      'Do not wait in the foreground: end this turn, do other work or wait to be woken; check status without blocking (list_agents / team_task_list / job_output without wait); start someone with send_message.',
    ].join('\n')
  },
}

/** 拒绝轮询：同一条检查命令在时间窗内反复出现。 */
const denyPolling = {
  zh: (p) => {
    const window = p.windowMs >= 60000 ? `${Math.round(p.windowMs / 60000)} 分钟` : `${Math.round(p.windowMs / 1000)} 秒`
    return [
      `轮询被禁止（${p.name}）：\`${p.excerpt}\` 在 ${window}内已经跑了 ${p.count} 次。`,
      '这不是等待，是空转——每次检查都烧一轮上下文，却不会让远端或后台任务变快。',
      '正确做法：把「等它结束」包成后台作业，再结束本轮——跨机器也一样：ssh host \'until [ -f done ]; do sleep 5; done\' 加 run_in_background: true（后台作业里的 sleep 是允许的）；或者起一个后台 sleep 定时器再结束本轮。作业完成会通知并唤醒你；读现有作业用不带 wait 的 job_output。',
    ].join('\n')
  },
  en: (p) => {
    const window = p.windowMs >= 60000 ? `${Math.round(p.windowMs / 60000)} minutes` : `${Math.round(p.windowMs / 1000)} seconds`
    return [
      `Polling is forbidden (${p.name}): \`${p.excerpt}\` ran ${p.count} times within ${window}.`,
      'That is not waiting, it is spinning — every check burns a turn of context and does not make the remote or background work any faster.',
      'Do this instead: wrap the waiting itself in a background job and end the turn — cross-machine too: ssh host \'until [ -f done ]; do sleep 5; done\' with run_in_background: true (sleep is allowed inside background jobs); or start a background sleep timer and end the turn. Completion notifies and wakes you; read an existing job with job_output (without wait).',
    ].join('\n')
  },
}

/** 拒绝「会等人输入/确认」的命令（后台拿不到输入会静默挂住）。 */
const denyInteractive = {
  zh: (p) => [
    `需要人输入/确认的命令被拦下（${p.name}，命中规则：${p.label}）：\`${p.excerpt}\` 会等密码、确认或终端交互。`,
    '后台作业拿不到这些输入，会静默挂住、永远不结算也永远不来通知；前台执行则直接卡住会话。',
    '正确做法：先确认——用 ask_user_question 问清楚，或走 DSH 审批；确认后用非交互参数重试（ssh -o BatchMode=yes、sudo -n、-y/--yes、密码/密钥事先配置好）。',
  ].join('\n'),
  en: (p) => [
    `A command that needs human input or confirmation was refused (${p.name}, rule: ${p.label}): \`${p.excerpt}\` waits for a password, a confirmation, or a terminal.`,
    'A background job cannot answer those prompts — it would hang silently, never settle, and never notify; in the foreground it freezes the session.',
    'Confirm first — use ask_user_question or the DSH approval channel — then retry with non-interactive flags (ssh -o BatchMode=yes, sudo -n, -y/--yes) or with credentials/keys configured ahead of time.',
  ].join('\n'),
}

/** 系统提示里的规则段。保持两行以内：官方 prompt 段普遍在 100~450 字符，细节交给拒绝消息。 */
const prompt = {
  zh: [
    '前台等待与轮询禁止：sleep / wait / tail -f / watch、无限循环、反复 check、wait_agent / job_output(wait)，以及需要人输入或确认的命令，都不得前台执行。',
    '要等就丢后台（run_in_background: true）并结束本轮，完成通知会唤醒你；通知只代表结束（completed / failed / killed），先读 status 与输出；后台作业自带超时/看门狗，否则挂住就永远没有通知。',
  ].join('\n'),
  en: [
    'Foreground waiting and polling are forbidden: sleep / wait / tail -f / watch, infinite loops, repeated checks, wait_agent / job_output(wait), and commands that need human input or confirmation must not run in the foreground.',
    'To wait, run it with run_in_background: true and end the turn — completion wakes you; a notice means finished (completed / failed / killed), not succeeded, so read status and output; bound the job with a timeout/watchdog, or a hang never notifies.',
  ].join('\n'),
}

/** 取一种语言的文案：可以是常量字符串，也可以是按参数渲染的函数。 */
function part(entry, lang, params) {
  const value = entry[lang]
  return typeof value === 'function' ? value(params) : value
}

/** 按语言取整段文本；`both` 时中文在前、英文在后。 */
function pick(language, entry, params) {
  if (language === 'both') return `${part(entry, 'zh', params)}\n\n${part(entry, 'en', params)}`
  return part(entry, language, params)
}

/**
 * 渲染「拒绝前台等待命令」的原因。
 * @param {'both'|'zh'|'en'} language - 文案语言。
 * @param {{ name: string, label: string, excerpt: string, skeleton: string }} params - 渲染参数。
 * @returns {string} 模型可见的拒绝原因。
 */
export function renderDenyCommand(language, params) {
  return pick(language, denyCommand, params)
}

/**
 * 渲染「拒绝前台阻塞等待工具」的原因。
 * @param {'both'|'zh'|'en'} language - 文案语言。
 * @param {{ name: string, tool: string, requestedMs: number, budgetMs: number }} params - 渲染参数。
 * @returns {string} 模型可见的拒绝原因。
 */
export function renderDenyBlockingWait(language, params) {
  return pick(language, denyBlockingWait, params)
}

/**
 * 渲染「拒绝轮询」的原因。
 * @param {'both'|'zh'|'en'} language - 文案语言。
 * @param {{ name: string, tool: string, excerpt: string, count: number, windowMs: number }} params - 渲染参数。
 * @returns {string} 模型可见的拒绝原因。
 */
export function renderDenyPolling(language, params) {
  return pick(language, denyPolling, params)
}

/**
 * 渲染「拒绝需要人输入/确认的命令」的原因。
 * @param {'both'|'zh'|'en'} language - 文案语言。
 * @param {{ name: string, tool: string, label: string, excerpt: string }} params - 渲染参数。
 * @returns {string} 模型可见的拒绝原因。
 */
export function renderDenyInteractive(language, params) {
  return pick(language, denyInteractive, params)
}

/**
 * 渲染系统提示里的规则段。
 * @param {'both'|'zh'|'en'} language - 文案语言。
 * @returns {string} 规则段正文。
 */
export function renderPrompt(language) {
  return pick(language, prompt, undefined)
}
