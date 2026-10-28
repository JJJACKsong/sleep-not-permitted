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
  ].join('\n'),
  en: (p) => [
    `Foreground waiting is forbidden (${p.name}, rule: ${p.label}): \`${p.excerpt}\` blocks the whole session until it finishes.`,
    `Retry: run the same command as a background job — ${p.skeleton}. It returns a job id immediately, notifies you when it finishes, and leaves the session free; do not poll with sleep, read output with job_output and stop it with job_kill.`,
    'If you are only waiting for an existing background job, just end this turn — the completion notice will wake you.',
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

/** 系统提示里的规则段。 */
const prompt = {
  zh: [
    '前台等待禁止：sleep / wait / tail -f / watch / 不带 -c 的 ping / 无限循环这类命令不得在前台执行——它们会把整个会话阻塞到命令结束。',
    '等待型工具同样禁止前台阻塞：wait_agent（等待子智能体）和 job_output 的 wait: true 都会把会话停住；不要用它们等结果。',
    '要等就挂后台：给命令加 run_in_background: true，立刻拿到 jobId；作业结束时你会收到完成通知，期间去做别的事，不要用 sleep 轮询；读输出用 job_output（不带 wait），停止用 job_kill。队友、子智能体完成时也会主动发消息唤醒你——直接结束本轮即可，需要状态就 list_agents / team_task_list 非阻塞地查。几秒内返回的普通命令照常前台跑。',
  ].join('\n'),
  en: [
    'Foreground waiting is forbidden: commands whose purpose is to wait (sleep, wait, tail -f, watch, ping without -c, infinite loops) must not run in the foreground — they freeze the whole session until they finish.',
    'Waiting tools are equally forbidden in the foreground: wait_agent and job_output with wait: true both stop the session; do not use them to await results.',
    'To wait, use the background: start the command with run_in_background: true and you get a job id immediately; you are notified when it finishes, so keep working on something else instead of polling with sleep. Read output with job_output (without wait), stop it with job_kill. Teammates and subagents also notify you when they finish — just end the turn, or check list_agents / team_task_list without blocking. Ordinary commands that return in seconds still run in the foreground.',
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
 * 渲染系统提示里的规则段。
 * @param {'both'|'zh'|'en'} language - 文案语言。
 * @returns {string} 规则段正文。
 */
export function renderPrompt(language) {
  return pick(language, prompt, undefined)
}
