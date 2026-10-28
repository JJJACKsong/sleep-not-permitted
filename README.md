<img src="assets/icon-180.png" width="88" alt="sleep-not-permitted icon" align="right">

# sleep-not-permitted

[中文](README.zh.md) · English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that forbids
**foreground waiting**. When an agent tries to run a command whose purpose is waiting
(`sleep`, `wait`, `tail -f`, `watch`, `ping` without `-c`, infinite loops), or calls a blocking
wait tool (`wait_agent`, `job_output` with `wait: true`), the call is rejected — and the rejection
is a set of instructions: run it in the background (`run_in_background: true`), or end the turn and
let the completion notice wake you.

Nothing is silently rewritten: DSH logs and shows tool arguments before dispatch, so a guard can
only refuse, not impersonate a different call. The plugin refuses, explains, and gets out of the way.

## Why a plugin, and not AGENTS.md or a preset

- **AGENTS.md is per-workspace.** You would have to write the rule into every workspace, and every
  new workspace silently misses it.
- **A preset is per-agent configuration.** Every composition needs its own copy, and the user has to
  pick it.
- **A host plugin is profile-level.** Install once and every workspace, session, and subagent is
  covered. It can carry configuration, be upgraded, disabled, and removed.

## Why it is needed

A DSH session moves one step at a time: however long a foreground tool call runs, the session stops
with it. `bash({ command: "sleep 60" })` looks harmless but freezes the conversation for a minute,
and a five-minute `wait_agent` freezes it for five. DSH has a safety net for slow *work* (a
foreground command that exceeds its timeout is promoted to a background job), but that still burns
the timeout first — and waiting is not work at all.

So the plugin does two things:

1. **Prevention** — a rule in the system prompt, next to the existing background-jobs section, so
   the model picks the background form first;
2. **Enforcement** — a synchronous `ctx.tools.guard()` denial when the foreground form is used
   anyway, with the retry spelled out.

## What gets blocked

- **Waiting commands** in `bash` / `pwsh` / `terminal_send`: `sleep`, `wait`, `tail -f`, `watch`,
  `ping` without `-c`, `yes`, infinite loops, log-follow modes — see the rule table below.
- **Blocking wait tools**: `wait_agent` and `job_output` with `wait: true`, when the requested wait
  exceeds the budget (default **30 seconds**).

## Behavior

- A foreground wait is rejected with `Error: <reason>`; the reason contains the exact retry form.
- A call that already has `run_in_background: true` passes — that is the shape this plugin wants.
- Ordinary commands (`git status`, `npm test`, `curl`, `grep`, …) pass untouched.
- `ask_user_question` is not a wait — it is you being asked — and is never blocked.
- Non-blocking reads (`job_output` without `wait`, `list_agents`, `team_task_list`) pass.

The default budget (**30 s**) exists so short coordination waits keep working out of the box (DSH's
own Agent Teams guidance has the Lead wait for teammates). Waits above the budget — the five-minute
`wait_agent(timeout_ms: 300000)` case — are rejected. Set `maxBlockingWaitMs: 0` for strict mode:
not a single second of foreground waiting.

## Rules

| id | matches |
|---|---|
| `sleep` | `sleep N` in command position (`sudo sleep`, `timeout 30 sleep`, `do sleep`, `&& sleep`, …) |
| `sleep-nested-shell` | nested shell payloads such as `bash -c "sleep 10"` |
| `sleep-script` | `time.sleep(30)`, `python -c "...sleep(5)"` |
| `wait` | the shell builtin `wait` |
| `tail-follow` | `tail -f` / `tail -F` / `tail --follow` |
| `watch` | `watch <cmd>` (re-runs forever) |
| `ping-forever` | `ping` without `-c` |
| `yes` | bare `yes` (endless output) |
| `infinite-loop` | `while true` / `while :` / `until false` |
| `follow-logs` | `docker/podman logs -f`, `journalctl -f`, `kubectl logs -f` |

Plain text inside quotes does not count (`echo "sleep 30"`, `grep 'sleep 30' file` pass);
in multi-line scripts, command position is evaluated per line.

## Configuration

Override the bundle patch row from the profile's `cordis.patch.yml`, or edit the plugin's
`cordis.patch.yml`:

```yaml
- id: sleep-not-permitted
  name: 'dsh-plugin-sleep-not-permitted'
  config:
    enabled: true                 # false = turn the whole guard off
    tools: [bash, pwsh, terminal_send]
    blockingTools: [wait_agent]   # blocking wait tools: reject above the budget
    blockingWaitFlagTools: [job_output]  # reject when wait: true and above the budget
    maxBlockingWaitMs: 30000      # 0 = reject every foreground wait
    language: both                # both | zh | en (message + system-prompt language)
    announceInPrompt: true        # false = enforcement only, no prompt rule
    disabledRules: []             # switch off individual rule ids from the table
    extraRules:                   # add your own rules; pattern is a regex string
      - id: long-curl
        pattern: 'curl\s+[^|;&]*--max-time\s+\d{3,}'
        label: long-timeout curl
        reason: This curl can hang for a long time — run it in the background.
```

Invalid configuration fails loud at mount time (unknown rule id, empty `tools`, invalid regex,
non-boolean switch, unknown `language`) — there is no "installed but silently inactive" state.

## Install / uninstall

The package is a standard DSH bundle (`dsh.bundle.patch` → `cordis.patch.yml`).

```bash
git clone https://github.com/JJJACKsong/sleep-not-permitted.git

# desktop profile (managed by the Electron app): use plugin_manager install_bundle
#   with the absolute path of the cloned directory
# other profiles:
dsh plugin --profile web add /path/to/sleep-not-permitted
```

Prebuilt tarball (no clone, no build):

```bash
dsh plugin --profile web add https://github.com/JJJACKsong/sleep-not-permitted/releases/download/v0.1.0/dsh-plugin-sleep-not-permitted-0.1.0.tgz
```

Uninstall:

```bash
dsh plugin --profile web remove dsh-plugin-sleep-not-permitted
# desktop: plugin_manager remove_bundle dsh-plugin-sleep-not-permitted
```

Disable without uninstalling: set `enabled: false`, or toggle the `sleep-not-permitted` row in the
plugin manager.

## Tests

```bash
node --test test/detect.test.mjs test/plugin.test.mjs
```

- `test/detect.test.mjs` — detector positives and negatives (command position, quotes, nested
  payloads, false-positive protection);
- `test/plugin.test.mjs` — a minimal ctx double checks deny/pass, defaults, strict mode, message
  language, and fail-loud configuration.

## Verify it works

- Foreground `sleep 5` → rejected immediately with `Error: …`;
- `wait_agent(timeout_ms: 300000)` → rejected (budget 30 s);
- Background `sleep 5` (`run_in_background: true`) → returns a job id at once, notify on completion;
- The system prompt contains the rule block (`announceInPrompt: true`).

## Compatibility

Tested against DSH `0.1.5-rc.2` and `0.2.1-rc.3`. It relies on two host seams —
`ctx.tools.guard()` and `ctx.systemPrompt.section()` — and fails loud at mount if they change.

## Boundaries

- **Does not guess "might be slow".** `npm install`, `cargo build` and other commands that make
  progress still run in the foreground; the tool timeout promotes them to a background job
  (default 120 s, capped at 600 s).
- **Does not block work.** Long synchronous tasks such as `workflow` or `deliver_gate` are not
  waits and are left alone.
- **Does not rewrite arguments.** A denied call costs one retry round trip; the system-prompt rule
  is there to keep that rare.
- **Does not inspect script files.** How long `bash script.sh` sleeps inside cannot be judged
  statically; the tool timeout is the backstop.
