import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject } from '../lib/index.js'

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
  apply(both.ctx, undefined)
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

  assert.match(zh.sections[0].text, /前台等待禁止/)
  assert.doesNotMatch(zh.sections[0].text, /Foreground waiting is forbidden/)
  assert.match(en.sections[0].text, /Foreground waiting is forbidden/)

  assert.throws(() => apply(fakeCtx().ctx, { language: 'fr' }), /language/)
})
