# 前台等待守卫 · sleep-not-permitted

中文 · [English](README.md)

DeepSeek Harness（DSH）插件：**禁止前台等待**。Agent 想用 `sleep`、`wait`、`tail -f`、
`watch`、无 `-c` 的 `ping`、无限循环这类命令在前面干等时，或调用 `wait_agent`、
`job_output(wait: true)` 这类阻塞等待工具时，调用会被拒绝——拒绝原因本身就是操作说明：
改成后台作业（`run_in_background: true`），或者结束本轮、等完成通知唤醒。

不会偷偷改写调用：DSH 在分发前就记录并展示了工具参数，守卫只能拒绝、不能伪装成另一次调用。
它拒绝、解释，然后让开。

## 为什么做成插件，而不是 AGENTS.md 或 preset

- **AGENTS.md 是工作区级的**：每个工作区都要写一遍，新工作区还会悄悄漏掉；
- **preset 是 agent 配置级的**：每个组合都要复制一份，而且用户得选它；
- **插件的宿主 guard 是 profile 级的**：装一次，所有工作区、所有会话、所有子代理一起生效；
  还能带配置、能升级、能停用、能卸载。

## 为什么需要它

DSH 的会话是**一次一步**推进的：工具调用在前台跑多久，整个会话就停多久。
`bash({ command: "sleep 60" })` 看着无害，实际是把这一轮对话冻结 60 秒；
`wait_agent(timeout_ms: 300000)` 更直接——五分钟。DSH 对「慢工作」有兜底
（前台命令超过 timeout 会 promote 成后台作业并返回 jobId），但那要先把 timeout 耗完；
而等待根本不是工作。

所以这只守卫做两件事：

1. **事前预防**：在系统提示里紧贴「后台作业」段落写同一条规则，模型第一次就选后台；
2. **事后门禁**：真的前台发了，`ctx.tools.guard()` 同步拒绝，拒绝原因即操作说明。

## 拦什么

- **等待型命令**（`bash` / `pwsh` / `terminal_send`）：`sleep`、`wait`、`tail -f`、`watch`、
  无 `-c` 的 `ping`、`yes`、无限循环、跟随日志；
- **阻塞等待型工具**：`wait_agent`、`job_output` 的 `wait: true`，且请求的等待超过预算
  （默认 **30 秒**）。

## 行为

- 命中前台等待 → 调用**被拒绝**（模型看到 `Error: <原因>`），原因里给出可直接照抄的重试形态。
- 已经带 `run_in_background: true` 的调用 → **放行**（正是守卫要求的形态）。
- 普通命令（`git status`、`npm test`、`curl`、`grep`…）→ 不拦。
- `ask_user_question` 是「问你」，不是等待，永不拦。
- 非阻塞读取（不带 `wait` 的 `job_output`、`list_agents`、`team_task_list`）→ 放行。

默认预算（**30 秒**）是为了开箱即用不误伤短协作等待：DSH 官方的 Agent Teams 指引本来就要求
Lead 用 `wait_agent` 等队友。超过预算的等待——比如五分钟的 `wait_agent(timeout_ms: 300000)`
——会被拒绝。想绝对严格就设 `maxBlockingWaitMs: 0`：一秒钟都不许等。

## 规则

| id | 命中形态 |
|---|---|
| `sleep` | 命令位置的 `sleep N`（含 `sudo sleep`、`timeout 30 sleep`、`do sleep`、`&& sleep`） |
| `sleep-nested-shell` | `bash -c "sleep 10"` 这类嵌套 shell 载荷 |
| `sleep-script` | `time.sleep(30)`、`python -c "...sleep(5)"` |
| `wait` | shell 内建 `wait`（等作业） |
| `tail-follow` | `tail -f` / `tail -F` / `tail --follow` |
| `watch` | `watch <cmd>`（默认每 2 秒重跑，永不结束） |
| `ping-forever` | 不带 `-c` 的 `ping` |
| `yes` | 裸 `yes`（无限输出） |
| `infinite-loop` | `while true` / `while :` / `until false` |
| `follow-logs` | `docker/podman logs -f`、`journalctl -f`、`kubectl logs -f` |

引号里的普通文本不算（`echo "sleep 30"`、`grep 'sleep 30' file` 放行）；
多行脚本按行首算命令位置。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖，或直接改插件自带的 `cordis.patch.yml`：

```yaml
- id: sleep-not-permitted
  name: 'dsh-plugin-sleep-not-permitted'
  config:
    enabled: true                 # false = 整只守卫关闭
    tools: [bash, pwsh, terminal_send]
    blockingTools: [wait_agent]   # 阻塞等待型工具：超过预算才拒
    blockingWaitFlagTools: [job_output]  # wait: true 且超过预算才拒
    maxBlockingWaitMs: 30000      # 0 = 一律拒绝前台等待
    language: both                # both | zh | en（拒绝原因与系统提示的语言）
    announceInPrompt: true        # false = 只保留门禁，不写系统提示
    disabledRules: []             # 按上表 id 关掉个别规则
    extraRules:                   # 追加自定义规则；pattern 是正则字符串
      - id: long-curl
        pattern: 'curl\s+[^|;&]*--max-time\s+\d{3,}'
        label: 长超时 curl
        reason: 这条 curl 可能挂很久，请挂后台。
```

配置错误（未知规则 id、空 `tools`、非法正则、非布尔开关、未知语言）在挂载期 fail-loud 报错，
不会出现「装好了但其实没生效」的静默状态。

## 安装 / 卸载

本包是标准 DSH bundle（`dsh.bundle.patch` → `cordis.patch.yml`）：

```bash
git clone https://github.com/JJJACKsong/sleep-not-permitted.git

# desktop profile（Electron 应用独占）：用会话内 plugin_manager 的 install_bundle，
#   target 传克隆目录的绝对路径
# 其他 profile：
dsh plugin --profile web add /path/to/sleep-not-permitted
```

预构建 tarball（不 clone、不构建）：

```bash
dsh plugin --profile web add https://github.com/JJJACKsong/sleep-not-permitted/releases/download/v0.1.0/dsh-plugin-sleep-not-permitted-0.1.0.tgz
```

卸载：

```bash
dsh plugin --profile web remove dsh-plugin-sleep-not-permitted
# desktop：plugin_manager remove_bundle dsh-plugin-sleep-not-permitted
```

临时停用而不卸载：把配置里的 `enabled` 改成 `false`，或在插件管理页关掉
`sleep-not-permitted` 这一行。

## 测试

```bash
node --test test/detect.test.mjs test/plugin.test.mjs
```

- `test/detect.test.mjs`：检测器正反例（命令位置、引号、嵌套载荷、误伤防护）；
- `test/plugin.test.mjs`：最小 ctx 替身验证拒绝/放行、默认与严格预算、文案语言、配置 fail-loud。

## 验证装好了

- 前台 `sleep 5` → 立刻被拒，`Error: …`；
- `wait_agent(timeout_ms: 300000)` → 立刻被拒（超过 30 秒预算）；
- 后台 `sleep 5`（`run_in_background: true`）→ 立刻拿到 jobId，结束后收到完成通知；
- 系统提示里应出现规则段（`announceInPrompt: true` 时）。

## 兼容性

在 DSH `0.1.5-rc.2` 与 `0.2.1-rc.3` 上验证。依赖两个宿主接缝——`ctx.tools.guard()` 与
`ctx.systemPrompt.section()`；官方若在未来版本改动它们，插件会在挂载期 fail-loud。

## 已知边界

- **不猜「可能很慢」**：`npm install`、`cargo build` 这类有实际推进的长命令照常前台；
  它们超过工具 timeout 时由 DSH 的 promote 机制转后台（默认 120s、封顶 600s）。
- **只拦等待，不拦工作**：`workflow`、`deliver_gate` 这类前台同步执行的长任务不拦。
- **不改写参数**：拒绝会让 Agent 多一次重试往返；系统提示里的事前规则就是为了把往返降到最少。
- **脚本文件里的 sleep 不拦**：`bash script.sh` 内部睡多久无法静态判断，只能靠工具 timeout 兜底。
