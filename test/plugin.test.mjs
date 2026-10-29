import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject } from '../lib/index.js'

// 固定测试环境的语言信号：默认 language: auto 在测试里解析为中文。
process.env.DSH_LOCALE = 'zh'

/** 最小 Cordis ctx 替身：记录 guard / systemPrompt.section / effect。 */
function fakeCtx() {
  const guards = []
  const sections = []
  const disposers = []
  const ctx = {
    tools: {
      guard(fn) {
        guards.push(fn)
        return () => {
          const index = guards.indexOf(fn)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    effect(create, label) {
      disposers.push({ label, dispose: create() })
      return () => {}
    },
  }
  return { ctx, guards, sections, disposers }
}

const execFor = (toolName, args) => ({ name: toolName, arguments: args })

test('插件元信息', () => {
  assert.equal(name, 'sleep-not-permitted')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
})

test('前台 sleep 被拒，原因里给出后台重试形态', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  assert.equal(guards.length, 1)
  const reason = guards[0](execFor('bash', { command: 'sleep 30', description: '等半分钟' }))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /前台等待被禁止/)
  assert.match(reason, /run_in_background: true/)
  assert.match(reason, /job_output/)
})

test('run_in_background: true 直接放行', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  assert.equal(guards[0](execFor('bash', { command: 'sleep 30', description: 'x', run_in_background: true })), undefined)
})

test('普通命令放行', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  assert.equal(guards[0](execFor('bash', { command: 'git status', description: 'x' })), undefined)
  assert.equal(guards[0](execFor('bash', { command: 'npm run build', description: 'x' })), undefined)
})

test('terminal_send 的 text 也受管，并给出 terminal_send 的重试形态', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  const reason = guards[0](execFor('terminal_send', { sessionId: 's1', text: 'tail -f app.log' }))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /terminal_send/)
})

test('不受管调用不受影响', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  // 非阻塞读取与普通工具照常放行；只有带 wait 的 job_output 受管。
  assert.equal(guards[0](execFor('job_output', { job_id: 'j1' })), undefined)
  assert.equal(guards[0](execFor('read', { file_path: '/tmp/x' })), undefined)
  assert.equal(guards[0](execFor('list_agents', {})), undefined)
})

test('配置：disabledRules 与 extraRules', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, {
    disabledRules: ['sleep'],
    extraRules: [{ id: 'long-curl', pattern: 'curl\\s+[^|;&]*--max-time\\s+\\d{3,}', reason: '这条 curl 可能挂很久' }],
  })
  assert.equal(guards[0](execFor('bash', { command: 'sleep 30' })), undefined)
  const reason = guards[0](execFor('bash', { command: 'curl --max-time 600 http://x' }))
  assert.match(reason, /这条 curl 可能挂很久/)
})

test('配置校验 fail-loud', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, { disabledRules: ['nope'] }), /unknown rule/)
  assert.throws(() => apply(ctx, { tools: [] }), /must not be empty/)
  assert.throws(() => apply(ctx, { extraRules: [{ id: 'x', pattern: '(' }] }), /not a valid regular expression/)
  assert.throws(() => apply(ctx, { enabled: 'yes' }), /must be a boolean/)
})

test('enabled: false 什么都不挂；announceInPrompt: false 不写系统提示', () => {
  const off = fakeCtx()
  apply(off.ctx, { enabled: false })
  assert.equal(off.guards.length, 0)
  assert.equal(off.sections.length, 0)

  const quiet = fakeCtx()
  apply(quiet.ctx, { announceInPrompt: false })
  assert.equal(quiet.guards.length, 1)
  assert.equal(quiet.sections.length, 0)

  const on = fakeCtx()
  apply(on.ctx, undefined)
  assert.equal(on.sections.length, 1)
  assert.equal(on.sections[0].name, 'rule:sleep-not-permitted')
  assert.match(on.sections[0].text, /run_in_background/)
})

test('等待型工具：默认 30 秒预算——放过短等待、拒绝长等待', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  const long = guards[0](execFor('wait_agent', { timeout_ms: 300000 }))
  assert.equal(typeof long, 'string')
  assert.match(long, /前台阻塞等待被禁止/)
  assert.match(long, /5 分钟/)
  assert.match(long, /结束本轮/)
  // 默认预算 30s：≤30 秒放行（团队协作常见），超过就拒绝。
  assert.equal(guards[0](execFor('wait_agent', { timeout_ms: 30000 })), undefined)
  assert.equal(guards[0](execFor('wait_agent', {})), undefined)
})

test('严格模式：maxBlockingWaitMs 0 连短等待也拒绝', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, { maxBlockingWaitMs: 0 })
  assert.equal(typeof guards[0](execFor('wait_agent', { timeout_ms: 30000 })), 'string')
  assert.equal(typeof guards[0](execFor('job_output', { job_id: 'j1', wait: true })), 'string')
})

test('等待型工具：job_output 只在 wait: true 时算等待', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  // 默认 30 秒预算：wait: true 的默认等待（30s）放行；要等 5 分钟则拒绝。
  assert.equal(guards[0](execFor('job_output', { job_id: 'j1', wait: true })), undefined)
  assert.equal(typeof guards[0](execFor('job_output', { job_id: 'j1', wait: true, timeout_ms: 300000 })), 'string')
  assert.equal(guards[0](execFor('job_output', { job_id: 'j1', wait: false })), undefined)
  assert.equal(guards[0](execFor('job_output', { job_id: 'j1' })), undefined)
})

test('等待预算：maxBlockingWaitMs 只放行不超过预算的前台等待', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, { maxBlockingWaitMs: 60000 })
  assert.equal(guards[0](execFor('wait_agent', { timeout_ms: 30000 })), undefined)
  assert.equal(typeof guards[0](execFor('wait_agent', { timeout_ms: 120000 })), 'string')
  assert.equal(guards[0](execFor('job_output', { job_id: 'j1', wait: true, timeout_ms: 30000 })), undefined)
  assert.equal(typeof guards[0](execFor('job_output', { job_id: 'j1', wait: true, timeout_ms: 300000 })), 'string')
})

test('等待型工具可整体关掉', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, { blockingTools: [], blockingWaitFlagTools: [] })
  assert.equal(guards[0](execFor('wait_agent', { timeout_ms: 300000 })), undefined)
  assert.equal(guards[0](execFor('job_output', { job_id: 'j1', wait: true })), undefined)
})

test('等待预算配置校验 fail-loud', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, { maxBlockingWaitMs: -1 }), /maxBlockingWaitMs/)
  assert.throws(() => apply(ctx, { blockingTools: 'wait_agent' }), /must be an array of strings/)
})

test('系统提示同时覆盖命令等待与工具等待', () => {
  const { ctx, sections } = fakeCtx()
  apply(ctx, undefined)
  assert.match(sections[0].text, /wait_agent/)
  assert.match(sections[0].text, /run_in_background/)
})


test('文案语言：both / zh / en', () => {
  const both = fakeCtx()
  apply(both.ctx, { language: 'both' })
  const bothMsg = both.guards[0](execFor('bash', { command: 'sleep 5' }))
  assert.match(bothMsg, /前台等待被禁止/)
  assert.match(bothMsg, /Foreground waiting is forbidden/)

  const zh = fakeCtx()
  apply(zh.ctx, { language: 'zh' })
  const zhMsg = zh.guards[0](execFor('bash', { command: 'sleep 5' }))
  assert.match(zhMsg, /前台等待被禁止/)
  assert.doesNotMatch(zhMsg, /Foreground waiting is forbidden/)

  const en = fakeCtx()
  apply(en.ctx, { language: 'en' })
  const enMsg = en.guards[0](execFor('bash', { command: 'sleep 5' }))
  assert.match(enMsg, /Foreground waiting is forbidden/)
  assert.doesNotMatch(enMsg, /前台等待被禁止/)
  assert.match(en.guards[0](execFor('wait_agent', { timeout_ms: 300000 })), /5 minutes/)

  assert.match(zh.sections[0].text, /前台等待/)
  assert.doesNotMatch(zh.sections[0].text, /Foreground waiting/)
  assert.match(en.sections[0].text, /Foreground waiting/)

  assert.throws(() => apply(fakeCtx().ctx, { language: 'fr' }), /language/)
})

test('轮询门禁：同一条命令超过阈值被硬拒绝', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  const call = () => guards[0](execFor('bash', { command: 'echo poll-probe', description: 'x' }))
  assert.equal(call(), undefined)
  assert.equal(call(), undefined)
  assert.equal(call(), undefined)
  const denied = call()
  assert.equal(typeof denied, 'string')
  assert.match(denied, /轮询被禁止/)
  assert.match(denied, /run_in_background: true/)
})

test('轮询门禁：不同命令、后台调用、非 shell 工具都不算', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  for (let i = 0; i < 5; i += 1) {
    assert.equal(guards[0](execFor('bash', { command: `echo distinct-${i}`, description: 'x' })), undefined)
  }
  for (let i = 0; i < 5; i += 1) {
    assert.equal(guards[0](execFor('bash', { command: 'echo bg-same', description: 'x', run_in_background: true })), undefined)
  }
  for (let i = 0; i < 5; i += 1) assert.equal(guards[0](execFor('list_agents', {})), undefined)
})

test('轮询门禁：可关闭、阈值可调', () => {
  const off = fakeCtx()
  apply(off.ctx, { antiPolling: false })
  for (let i = 0; i < 5; i += 1) {
    assert.equal(off.guards[0](execFor('bash', { command: 'echo anti-polling-off', description: 'x' })), undefined)
  }

  const strict = fakeCtx()
  apply(strict.ctx, { pollRepeatThreshold: 2, pollWindowMs: 60000 })
  assert.equal(strict.guards[0](execFor('bash', { command: 'echo threshold-two', description: 'x' })), undefined)
  assert.equal(strict.guards[0](execFor('bash', { command: 'echo threshold-two', description: 'x' })), undefined)
  assert.equal(typeof strict.guards[0](execFor('bash', { command: 'echo threshold-two', description: 'x' })), 'string')
})

test('轮询门禁配置校验 fail-loud', () => {
  const { ctx } = fakeCtx()
  assert.throws(() => apply(ctx, { antiPolling: 'yes' }), /antiPolling/)
  assert.throws(() => apply(ctx, { pollRepeatThreshold: 1 }), /pollRepeatThreshold/)
  assert.throws(() => apply(ctx, { pollWindowMs: 0 }), /pollWindowMs/)
})

test('系统提示包含轮询与外部等待的指引', () => {
  const zh = fakeCtx()
  apply(zh.ctx, undefined) // auto + DSH_LOCALE=zh → 只出中文
  assert.match(zh.sections[0].text, /轮询/)
  assert.match(zh.sections[0].text, /run_in_background/)
  assert.doesNotMatch(zh.sections[0].text, /Polling/)

  const both = fakeCtx()
  apply(both.ctx, { language: 'both' })
  assert.match(both.sections[0].text, /Polling|polling/)
})

test('交互式/需确认命令被拒（前台与后台都拒）', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  const commands = [
    'sudo ls /root',
    'ssh example.com uptime',
    'npm login',
    'vim notes.txt',
    'docker run -it ubuntu bash',
    'read -p "name: " name',
    'rm -i file.txt',
  ]
  for (const command of commands) {
    const reason = guards[0](execFor('bash', { command, description: 'x' }))
    assert.equal(typeof reason, 'string', command)
    assert.match(reason, /需要人输入\/确认/)
  }
  // 丢后台同样拒绝：拿不到输入会静默挂住，永远不会有通知。
  const background = guards[0](execFor('bash', { command: 'ssh example.com uptime', description: 'x', run_in_background: true }))
  assert.equal(typeof background, 'string')
  assert.match(background, /静默挂住/)
})

test('非交互形态放行', () => {
  const { ctx, guards } = fakeCtx()
  apply(ctx, undefined)
  assert.equal(guards[0](execFor('bash', { command: 'sudo -n true', description: 'x' })), undefined)
  assert.equal(guards[0](execFor('bash', { command: 'ssh -o BatchMode=yes example.com uptime', description: 'x' })), undefined)
  assert.equal(guards[0](execFor('bash', { command: 'ls -la /tmp', description: 'x' })), undefined)
})

test('交互式门禁可整体关闭 / 规则可按 id 关闭 / 配置 fail-loud', () => {
  const off = fakeCtx()
  apply(off.ctx, { interactiveGuard: false })
  assert.equal(off.guards[0](execFor('bash', { command: 'vim notes.txt', description: 'x' })), undefined)

  const partial = fakeCtx()
  apply(partial.ctx, { disabledInteractiveRules: ['interactive-editor'] })
  assert.equal(partial.guards[0](execFor('bash', { command: 'vim other.txt', description: 'x' })), undefined)
  assert.equal(typeof partial.guards[0](execFor('bash', { command: 'sudo ls /root', description: 'x' })), 'string')

  assert.throws(() => apply(fakeCtx().ctx, { disabledInteractiveRules: ['nope'] }), /unknown interactive rule/)
  assert.throws(() => apply(fakeCtx().ctx, { interactiveGuard: 'yes' }), /interactiveGuard/)
})

test('系统提示覆盖失败处理、看门狗与确认优先', () => {
  const { ctx, sections } = fakeCtx()
  apply(ctx, undefined)
  const text = sections[0].text
  assert.match(text, /completed \/ failed \/ killed/)
  assert.match(text, /看门狗|watchdog/)
  assert.match(text, /输入或确认|input or confirmation/)
  // 提示段保持精简（官方 prompt 段普遍 100~450 字符），细节在拒绝消息里。
  assert.ok(text.length < 1200, `prompt section too long: ${text.length}`)
})
