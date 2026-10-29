/**
 * 前台等待检测器 —— 纯函数、零依赖，可在任何 DSH 版本里单测。
 *
 * 目标：从一条 shell 命令文本里判断「这条命令在前台跑会不会把会话睡死」。
 * 只认那些**目的就是等**的命令形态（sleep / wait / tail -f / watch / 无 -c 的
 * ping / yes / 无限循环 / 跟随日志），不猜「这条命令可能很慢」——慢命令由
 * bash 工具自己的 timeout→promote 机制兜底，这里只拦明知会阻塞的等待。
 *
 * 检测复用同一条原则：命令词要出现在**命令位置**（行首、`;` `|` `&` `(` 之后，
 * 或 `sudo`/`then`/`do` 这类包装词之后），引号里的普通文本不算；但
 * `bash -c "..."`、`python -c "...time.sleep(5)"` 这类嵌套载荷单独识别。
 *
 * @module sleep-not-permitted/detect
 */

/**
 * 把 heredoc 正文替换成等长空白（保留换行与下标）。
 *
 * 为什么需要：`git commit -F - <<'EOF' ... EOF`、写脚本的 `cat > x <<'EOF'` 里出现的
 * `sleep` / `read -p` / `ssh host` 只是**数据**，不是这次要执行的命令；不屏蔽会把
 * 「写一份说明」误判成「要睡觉 / 要等人输入」。
 * @param {string} text - 原始命令文本。
 * @returns {string} heredoc 正文被空白覆盖后的文本（长度不变）。
 */
export function maskHeredocBodies(text) {
  const lines = text.split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    out.push(line)
    const start = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w]*))/.exec(line)
    if (start === null) {
      i += 1
      continue
    }
    const stripTabs = start[1] === '-'
    const delimiter = start[2] ?? start[3] ?? start[4]
    i += 1
    while (i < lines.length) {
      const body = lines[i]
      const candidate = stripTabs ? body.replace(/^\t+/, '') : body
      if (candidate === delimiter) {
        out.push(body)
        break
      }
      out.push(' '.repeat(body.length))
      i += 1
    }
    i += 1
  }
  return out.join('\n')
}

/** 这些词出现在命令词前面时，后面的命令词仍算命令位置（包装词）。 */
const WRAPPERS = new Set([
  'sudo', 'do', 'then', 'else', 'elif', 'if', 'while', 'until',
  'time', 'exec', 'command', 'env', 'nohup', 'xargs', 'nice',
  'stdbuf', 'setsid', 'unbuffer', 'builtin', 'eval', 'watch',
])

/** 所有内置规则 id，供配置按 id 关闭。 */
export const RULE_IDS = [
  'sleep',
  'sleep-nested-shell',
  'sleep-script',
  'wait',
  'tail-follow',
  'watch',
  'ping-forever',
  'yes',
  'infinite-loop',
  'follow-logs',
]

const RULE_LABELS = {
  'sleep': 'sleep',
  'sleep-nested-shell': 'sleep（嵌套 shell）',
  'sleep-script': 'sleep（脚本调用）',
  'wait': 'wait',
  'tail-follow': 'tail -f',
  'watch': 'watch',
  'ping-forever': 'ping 无 -c',
  'yes': 'yes',
  'infinite-loop': '无限循环',
  'follow-logs': '跟随日志（-f）',
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'
}

/**
 * 逐字符标记引号区域（单引号、双引号、反引号；反斜杠转义不关闭引号）。
 * @param {string} text - 命令文本。
 * @returns {Uint8Array} 与 text 等长，1 表示该字符处于引号内。
 */
export function buildQuoteMask(text) {
  const mask = new Uint8Array(text.length)
  let quote = null
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (escaped) {
      if (quote !== null) mask[i] = 1
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      if (quote !== null) mask[i] = 1
      continue
    }
    if (quote !== null) {
      mask[i] = 1
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      mask[i] = 1
    }
  }
  return mask
}

/**
 * 判断 text[index] 处的命令词是否处于命令位置。
 * @param {string} text - 命令文本。
 * @param {number} index - 命令词在 text 中的起始下标。
 * @returns {boolean} true 表示位于命令位置。
 */
function atCommandPosition(text, index) {
  let j = index - 1
  // 换行是命令分隔符，不能被当成空白跳过（否则多行脚本的第一行会污染后一行）。
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) j -= 1
  if (j < 0) return true
  const prev = text[j]
  if (prev === ';' || prev === '|' || prev === '&' || prev === '(' || prev === '{' || prev === '\n') {
    return true
  }
  if (prev === ')') return false
  // 读前一个词：`sudo sleep` / `do sleep` / `timeout 30 sleep` 都要认。
  let k = j
  while (k >= 0 && /[\w.-]/.test(text[k])) k -= 1
  const word = text.slice(k + 1, j + 1)
  if (word !== '' && WRAPPERS.has(word)) return true
  if (/^\d+[smhd]?$/.test(word)) {
    // `timeout 30 sleep 30`：数字前面的词是 timeout 才算。
    let m = k
    while (m >= 0 && isSpace(text[m])) m -= 1
    let n = m
    while (n >= 0 && /[\w.-]/.test(text[n])) n -= 1
    if (text.slice(n + 1, m + 1) === 'timeout') return true
  }
  return false
}

/**
 * 在「引号外」查找第一个匹配（引号内的普通文本不算命令）。
 * @param {string} text - 命令文本。
 * @param {Uint8Array} mask - 引号掩码。
 * @param {RegExp} pattern - 带 /g 的正则。
 * @returns {{ index: number, match: string } | undefined} 首个引号外命中。
 */
function findOutsideQuotes(text, mask, pattern) {
  pattern.lastIndex = 0
  let found
  while ((found = pattern.exec(text)) !== null) {
    if (mask[found.index] === 0) return { index: found.index, match: found[0] }
    if (pattern.lastIndex === found.index) pattern.lastIndex += 1
  }
  return undefined
}

/** 截取命中处的命令片段，供拒绝消息展示。 */
function excerpt(text, index, max = 120) {
  const tail = text.slice(index)
  const stop = tail.search(/[;&|\n]/)
  const piece = (stop === -1 ? tail : tail.slice(0, stop)).trim()
  if (piece === '') return text.slice(index, index + max).trim()
  return piece.length > max ? `${piece.slice(0, max - 1)}…` : piece
}

/** 规则：`sleep N`（命令位置、引号外）。 */
function ruleSleep(text, mask) {
  const hit = findOutsideQuotes(text, mask, /(?:^|[^\w])sleep(?=\s|$)/g)
  if (hit === undefined) return undefined
  const index = hit.index + (hit.match.startsWith('sleep') ? 0 : 1)
  if (!atCommandPosition(text, index)) return undefined
  return excerpt(text, index)
}

/** 规则：`bash -c "sleep 10"` 这类嵌套 shell 载荷。 */
function ruleSleepNestedShell(text) {
  const m = /\b(?:ba|z|d|k)?sh\s+(?:-{1,2}[A-Za-z][\w-]*\s+)*-c\s*['"][\s\S]*?\bsleep\s+[0-9.]/.exec(text)
  return m === null ? undefined : excerpt(text, m.index)
}

/** 规则：脚本载荷里的 `time.sleep(30)` / `python -c "...sleep(5)"`（引号内也算，它会被真正执行）。 */
function ruleSleepScript(text) {
  const patterns = [
    /\btime\s*\.\s*sleep\s*\(\s*[0-9]/,
    /\b(?:python[23]?|perl|ruby|node)\s+(?:-{1,2}[A-Za-z][\w-]*\s+)*-c\b[\s\S]*?\bsleep\s*\(\s*[0-9]/,
  ]
  for (const pattern of patterns) {
    const m = pattern.exec(text)
    if (m !== null) return excerpt(text, m.index)
  }
  return undefined
}

/** 规则：shell 内建 `wait`（等前台/后台作业）。 */
function ruleWait(text, mask) {
  const hit = findOutsideQuotes(text, mask, /(?:^|[^\w-])wait(?=\s|$|;|&)/g)
  if (hit === undefined) return undefined
  const index = hit.index + (hit.match.startsWith('wait') ? 0 : 1)
  if (!atCommandPosition(text, index)) return undefined
  return excerpt(text, index)
}

/** 规则：`tail -f` / `tail -F` / `tail --follow`。 */
function ruleTailFollow(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\btail\b/g)
  if (hit === undefined) return undefined
  if (!atCommandPosition(text, hit.index)) return undefined
  const segment = text.slice(hit.index).split(/[;&|\n]/)[0]
  if (!/\s-[A-Za-z]*[fF][A-Za-z]*\b|\s--follow\b/.test(segment)) return undefined
  return excerpt(text, hit.index)
}

/** 规则：`watch <cmd>`（默认每 2 秒重跑，永不结束）。 */
function ruleWatch(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\bwatch\b/g)
  if (hit === undefined) return undefined
  if (!atCommandPosition(text, hit.index)) return undefined
  return excerpt(text, hit.index)
}

/** 规则：`ping` 不带 `-c`（会一直发下去）。 */
function rulePingForever(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\bping6?\b/g)
  if (hit === undefined) return undefined
  if (!atCommandPosition(text, hit.index)) return undefined
  const segment = text.slice(hit.index).split(/[;&|\n]/)[0]
  if (/(?:^|\s)-[A-Za-z]*c[A-Za-z]*\s+\d/.test(segment)) return undefined
  return excerpt(text, hit.index)
}

/** 规则：裸 `yes`（无限输出，只能靠下游 head/超时收住）。 */
function ruleYes(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\byes\b/g)
  if (hit === undefined) return undefined
  if (!atCommandPosition(text, hit.index)) return undefined
  return excerpt(text, hit.index)
}

/** 规则：`while true` / `while :` / `until false` 无限循环。 */
function ruleInfiniteLoop(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\b(?:while\s+(?:true|:)|until\s+false)\b/g)
  if (hit === undefined) return undefined
  return excerpt(text, hit.index)
}

/** 规则：`docker logs -f` / `journalctl -f` / `kubectl logs -f`。 */
function ruleFollowLogs(text, mask) {
  const patterns = [
    /\b(?:docker|podman)\s+logs\b[^;&|\n]*\s(?:-f\b|--follow\b)/g,
    /\bjournalctl\b[^;&|\n]*\s(?:-f\b|--follow\b)/g,
    /\bkubectl\s+logs\b[^;&|\n]*\s(?:-f\b|--follow\b)/g,
  ]
  for (const pattern of patterns) {
    const hit = findOutsideQuotes(text, mask, pattern)
    if (hit !== undefined) return excerpt(text, hit.index)
  }
  return undefined
}

const RULES = {
  'sleep': ruleSleep,
  'sleep-nested-shell': ruleSleepNestedShell,
  'sleep-script': ruleSleepScript,
  'wait': ruleWait,
  'tail-follow': ruleTailFollow,
  'watch': ruleWatch,
  'ping-forever': rulePingForever,
  'yes': ruleYes,
  'infinite-loop': ruleInfiniteLoop,
  'follow-logs': ruleFollowLogs,
}

/**
 * 检测一条命令是不是前台等待。
 * @param {string} command - shell 命令文本。
 * @param {object} [options] - 检测选项。
 * @param {string[]} [options.disabledRules] - 要关闭的内置规则 id。
 * @param {Array<{ id: string, pattern: RegExp, label?: string }>} [options.extraRules] - 追加规则（正则已在调用方编译）。
 * @returns {{ id: string, label: string, excerpt: string } | undefined} 首个命中；未命中返回 undefined。
 */
export function detectForegroundWait(command, options = {}) {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  const disabled = new Set(options.disabledRules ?? [])
  // heredoc 正文是数据，不是命令；先屏蔽再匹配。
  const text = maskHeredocBodies(command)
  const mask = buildQuoteMask(text)
  for (const id of RULE_IDS) {
    if (disabled.has(id)) continue
    const result = RULES[id](text, mask)
    if (result !== undefined) return { id, label: RULE_LABELS[id], excerpt: result }
  }
  for (const rule of options.extraRules ?? []) {
    rule.pattern.lastIndex = 0
    const m = rule.pattern.exec(command)
    if (m !== null) {
      return { id: rule.id, label: rule.label ?? rule.id, excerpt: excerpt(text, m.index) }
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 交互式 / 需要人确认的命令
//
// 后台作业拿不到 stdin：密码提示、确认提示、分页器、交互式编辑器会把它静默挂住，
// 既不会完成也不会报错——于是「丢后台等通知」这条链在最需要的时候断掉。
// 所以这类命令单独识别，前台后台都拒绝，并指示「先确认，或改非交互参数」。
// ---------------------------------------------------------------------------

/** 交互式规则的 id，供配置按 id 关闭。 */
export const INTERACTIVE_RULE_IDS = [
  'sudo-prompt',
  'ssh-prompt',
  'login-flow',
  'interactive-editor',
  'docker-it',
  'read-prompt',
  'confirm-flag',
]

const INTERACTIVE_LABELS = {
  'sudo-prompt': 'sudo 密码提示',
  'ssh-prompt': 'ssh 未开 BatchMode（可能停在密码/主机确认）',
  'login-flow': '登录/密钥交互流程',
  'interactive-editor': '交互式编辑器/分页器',
  'docker-it': 'docker 交互终端',
  'read-prompt': 'read 提示输入',
  'confirm-flag': '带 -i 的覆盖/删除确认',
}

/** 取命令词所在的分段（到下一个控制符为止），用于检查该命令自己的参数。 */
function segmentAt(text, index) {
  return text.slice(index).split(/[;&|\n]/)[0]
}

/** 规则：sudo 未加 -n（可能提示密码）。 */
function ruleSudoPrompt(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\bsudo\b/g)
  if (hit === undefined) return undefined
  if (!atCommandPosition(text, hit.index)) return undefined
  const segment = segmentAt(text, hit.index)
  if (/(?:^|\s)(?:-n|--non-interactive)\b/.test(segment)) return undefined
  return excerpt(text, hit.index)
}

/** 规则：ssh 未加 -o BatchMode=yes（无密钥时会停在密码/主机确认）。 */
function ruleSshPrompt(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\bssh\b/g)
  if (hit === undefined) return undefined
  if (!atCommandPosition(text, hit.index)) return undefined
  const segment = segmentAt(text, hit.index)
  if (/-o\s*BatchMode\s*=\s*yes|-oBatchMode=yes/i.test(segment)) return undefined
  if (/(?:^|\s)(?:-V|-h|--help|-G)\b/.test(segment)) return undefined
  return excerpt(text, hit.index)
}

/** 规则：登录/密钥生成等必定要人输入的流程。 */
function ruleLoginFlow(text, mask) {
  const hit = findOutsideQuotes(
    text,
    mask,
    /\b(?:npm\s+login|gh\s+auth\s+login|docker\s+login|ssh-keygen|passwd|gpg\s+--gen-key|aws\s+configure|heroku\s+login|firebase\s+login|az\s+login|gcloud\s+auth\s+login|op\s+signin)\b/g,
  )
  if (hit === undefined) return undefined
  return excerpt(text, hit.index)
}

/** 规则：交互式编辑器 / 分页器 / 监视器（前台卡会话，后台挂住）。 */
function ruleInteractiveEditor(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\b(?:vim?|nano|emacs|less|more|man|top|htop)\b/g)
  if (hit === undefined) return undefined
  if (!atCommandPosition(text, hit.index)) return undefined
  return excerpt(text, hit.index)
}

/** 规则：docker run/exec 带交互终端标志。 */
function ruleDockerIt(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\bdocker\s+(?:run|exec)\b/g)
  if (hit === undefined) return undefined
  if (!atCommandPosition(text, hit.index)) return undefined
  const segment = segmentAt(text, hit.index)
  const interactive = /\s(?:-it|-ti|--interactive\b|--tty\b)\b/.test(segment) || (/\s-[a-z]*i[a-z]*\b/.test(segment) && /\s-[a-z]*t[a-z]*\b/.test(segment))
  if (!interactive) return undefined
  return excerpt(text, hit.index)
}

/** 规则：read -p（提示输入）。 */
function ruleReadPrompt(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\bread\s+(?:-[a-z]*p|--prompt)\b/g)
  if (hit === undefined) return undefined
  return excerpt(text, hit.index)
}

/** 规则：rm/cp/mv 带 -i（覆盖/删除前等确认）。 */
function ruleConfirmFlag(text, mask) {
  const hit = findOutsideQuotes(text, mask, /\b(?:rm|cp|mv)\b/g)
  if (hit === undefined) return undefined
  if (!atCommandPosition(text, hit.index)) return undefined
  const segment = segmentAt(text, hit.index)
  if (!/\s-[a-z]*i[a-z]*\b/.test(segment)) return undefined
  return excerpt(text, hit.index)
}

const INTERACTIVE_RULES = {
  'sudo-prompt': ruleSudoPrompt,
  'ssh-prompt': ruleSshPrompt,
  'login-flow': ruleLoginFlow,
  'interactive-editor': ruleInteractiveEditor,
  'docker-it': ruleDockerIt,
  'read-prompt': ruleReadPrompt,
  'confirm-flag': ruleConfirmFlag,
}

/**
 * 检测一条命令是否会等待人输入/确认。
 * @param {string} command - shell 命令文本。
 * @param {object} [options] - 检测选项。
 * @param {string[]} [options.disabledRules] - 要关闭的交互式规则 id。
 * @returns {{ id: string, label: string, excerpt: string } | undefined} 首个命中；未命中返回 undefined。
 */
export function detectInteractive(command, options = {}) {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  const disabled = new Set(options.disabledRules ?? [])
  const text = maskHeredocBodies(command)
  const mask = buildQuoteMask(text)
  for (const id of INTERACTIVE_RULE_IDS) {
    if (disabled.has(id)) continue
    const result = INTERACTIVE_RULES[id](text, mask)
    if (result !== undefined) return { id, label: INTERACTIVE_LABELS[id], excerpt: result }
  }
  return undefined
}
