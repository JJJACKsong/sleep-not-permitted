import test from 'node:test'
import assert from 'node:assert/strict'

import { detectForegroundWait, detectInteractive } from '../lib/detect.js'

const hit = (command, options) => detectForegroundWait(command, options)?.id

test('sleep 命中：各种命令位置', () => {
  assert.equal(hit('sleep 30'), 'sleep')
  assert.equal(hit('sleep 0.5'), 'sleep')
  assert.equal(hit('sudo sleep 30'), 'sleep')
  assert.equal(hit('timeout 30 sleep 30'), 'sleep')
  assert.equal(hit('until curl -sf http://x; do sleep 5; done'), 'sleep')
  assert.equal(hit('for i in 1 2 3; do sleep 1; done'), 'sleep')
  assert.equal(hit('npm run build && sleep 10 && echo done'), 'sleep')
  assert.equal(hit('set -e\nsleep 3\necho ok'), 'sleep')
  assert.equal(hit('cmd & sleep 1'), 'sleep')
})

test('sleep 不误伤：普通文本、引号、文件名、非命令位置', () => {
  assert.equal(hit('echo "sleep 30"'), undefined)
  assert.equal(hit("grep -rn 'sleep 30' README.md"), undefined)
  assert.equal(hit('cat sleep-guide.md'), undefined)
  assert.equal(hit('echo sleep time'), undefined)
  assert.equal(hit('npm install'), undefined)
  assert.equal(hit('git status'), undefined)
})

test('sleep 嵌套载荷与脚本调用', () => {
  assert.equal(hit('bash -c "sleep 10"'), 'sleep-nested-shell')
  assert.equal(hit("sh -c 'sleep 5; echo done'"), 'sleep-nested-shell')
  assert.equal(hit('python3 -c "import time; time.sleep(5)"'), 'sleep-script')
})

test('wait 内建', () => {
  assert.equal(hit('wait'), 'wait')
  assert.equal(hit('cmd & wait'), 'wait')
  assert.equal(hit('docker compose up --wait'), undefined)
})

test('tail -f / watch / ping / yes / 无限循环 / 跟随日志', () => {
  assert.equal(hit('tail -f /var/log/system.log'), 'tail-follow')
  assert.equal(hit('tail -n 20 app.log -F'), 'tail-follow')
  assert.equal(hit('tail -n 20 app.log'), undefined)
  assert.equal(hit('watch -n 1 ls'), 'watch')
  assert.equal(hit('ping example.com'), 'ping-forever')
  assert.equal(hit('ping -c 3 example.com'), undefined)
  assert.equal(hit('yes | head -1'), 'yes')
  assert.equal(hit('while true; do date; done'), 'infinite-loop')
  assert.equal(hit('docker logs -f web'), 'follow-logs')
  assert.equal(hit('journalctl -f'), 'follow-logs')
  assert.equal(hit('kubectl logs -f deploy/web'), 'follow-logs')
  assert.equal(hit('kubectl logs deploy/web'), undefined)
})

test('引号内的跟随/等待不算（普通输出文本）', () => {
  assert.equal(hit('echo "tail -f app.log"'), undefined)
  assert.equal(hit('echo "watch ls"'), undefined)
})

test('disabledRules 按 id 关闭', () => {
  assert.equal(hit('sleep 5', { disabledRules: ['sleep'] }), undefined)
  assert.equal(hit('tail -f app.log', { disabledRules: ['sleep'] }), 'tail-follow')
})

test('extraRules 追加自定义规则', () => {
  const extraRules = [{ id: 'long-curl', pattern: /curl\s+[^|;&]*--max-time\s+\d{3,}/g }]
  assert.equal(hit('curl --max-time 600 http://x', { extraRules }), 'long-curl')
  assert.equal(hit('curl --max-time 5 http://x', { extraRules }), undefined)
})

test('空命令不命中', () => {
  assert.equal(hit(''), undefined)
  assert.equal(hit('   '), undefined)
  assert.equal(hit(undefined), undefined)
})

test('heredoc 正文是数据，不算命令（不误伤 commit message / 写脚本）', () => {
  const commit = "git commit -F - <<'EOF'\nfeat: no read -p, no ssh without BatchMode, no sleep 5\nEOF"
  assert.equal(detectForegroundWait(commit), undefined)
  assert.equal(detectInteractive(commit), undefined)

  const writeScript = "cat > run.sh <<'SH'\nsleep 5\nread -p \"x: \" y\nsudo ls\nSH"
  assert.equal(detectForegroundWait(writeScript), undefined)
  assert.equal(detectInteractive(writeScript), undefined)
})

test('heredoc 之后的真实命令仍然被检测', () => {
  const command = "cat > note.txt <<'EOF'\nsleep 5 is not a command here\nEOF\nsleep 7"
  assert.equal(detectForegroundWait(command)?.id, 'sleep')
})
