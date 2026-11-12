# UnitHarness

[![ci](https://github.com/create-info/unit-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/create-info/unit-harness/actions/workflows/ci.yml)

**The agent that proves its work.**

Every deliverable it hands you has been executed and verified in a sandbox, and
every run is replayable. If it can't be verified, it isn't done.

> Status: `v0.1.0` — isolation is enforced on Linux (landlock, via a small C helper
> embedded in the binary) and on macOS (seatbelt). Writes are confined to the
> workspace, `$HOME` is unreadable, TCP can be blocked. Windows has no kernel
> isolation yet and fails closed. Verify it yourself with `uh sandbox check`.

---

## Why

Coding agents stop at *generation*: they write a script and hand it to you.
Whether it works is your problem.

UnitHarness treats **verification as a first-class citizen**:

| | Typical agent | UnitHarness |
|---|---|---|
| Output | text / diff | artifacts + assertions |
| Success | "looks right" | `verification/asserted` events |
| Failure | you discover it | the sandbox discovers it |
| Audit | none | append-only event log, replayable |
| Costly actions | silent | approval-gated |

## Install

```bash
# macOS / Linux — one static binary, no Node required
curl -fsSL https://raw.githubusercontent.com/create-info/unit-harness/main/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/create-info/unit-harness/main/install.ps1 | iex
```

The Linux binary carries the landlock helper inside itself and unpacks it to
`~/.uh/bin/` on first run — nothing else to install. From source instead:

```bash
git clone https://github.com/create-info/unit-harness.git
cd unit-harness
npm i -g .        # builds, then links `uh` into your PATH
uh doctor
```

## Quick start

```console
$ uh doctor
UnitHarness 0.1.0  (node v22.22.3)
platform    darwin/arm64  kernel=24.6.0
isolation   seatbelt
enforcement seatbelt via /usr/bin/sandbox-exec; writes limited to ~/.uh/work; home unreadable
...
model       qwen3.8-27b  @ http://127.0.0.1:1234/v1  (discovered:LM Studio)

$ uh sandbox check
PASS  write inside workspace  (expected ok, got ok)
PASS  write outside workspace (expected deny, got deny)
PASS  read $HOME/.gitconfig   (expected deny, got deny)
PASS  write to /etc           (expected deny, got deny)

4/4 checks passed
```

If `uh doctor` reports `model none`, start LM Studio or Ollama — or export
`UH_BASE_URL` / `UH_MODEL` / `UH_API_KEY`.

`build:native` is optional: without it `exec` reports no isolation and refuses to
run (fail-closed).

```console
$ node dist/uh.cjs doctor
UnitHarness 0.1.0  (node v22.22.3)
platform    linux/arm64  kernel=6.17.0-1008-nvidia
isolation   landlock-v7 (platform=linux/arm64, kernel=6.17.0-1008-nvidia)
enforcement landlock-v7 via ~/.uh/bin/landlock-helper; writes limited to ~/.uh/work; home unreadable

  landlock   available (abi 7)
  bwrap      available — /usr/bin/bwrap
  seatbelt   unavailable — not darwin
```

And prove it rather than trust it:

```console
$ node dist/uh.cjs sandbox check
isolation: landlock-v7 via ~/.uh/bin/landlock-helper; writes limited to ~/.uh/work; home unreadable

PASS  write inside workspace  (expected ok, got ok)
PASS  write outside workspace  (expected deny, got deny)
PASS  read $HOME/.gitconfig  (expected deny, got deny)
PASS  write to /etc  (expected deny, got deny)

4/4 checks passed
```

Without any isolation backend, `exec` refuses to run at all:

```console
$ node dist/uh.cjs tool hello
E_SANDBOX_UNAVAILABLE: current isolation is "none". Refusing to execute (fail-closed).
Re-run with --allow-unconfined if you accept the risk.
```

## Providers

```console
$ uh provider list
config: ~/.uh/config.json

  id           provider              key           model                     state
  deepseek     DeepSeek              (none)        —                         no key
  anthropic    Anthropic (Claude)    (none)        —                         no key
  openai       OpenAI                (none)        —                         no key
  moonshot     Moonshot (Kimi)       (none)        —                         no key
  zhipu        Zhipu (GLM)           (none)        —                         no key
  qwen         Qwen (DashScope)      (none)        —                         no key
  siliconflow  SiliconFlow           (none)        —                         no key
  groq         Groq                  (none)        —                         no key
  openrouter   OpenRouter            (none)        —                         no key
  ollama       Ollama (local)        —             qwen3.6:latest            running
  lmstudio     LM Studio (local)     —             qwen3.8-27b               running
  vllm         vLLM / llama.cpp (loc…—             —                         not running
```

```bash
uh config set deepseek        # API key, hidden input, stored 0600
uh config use deepseek        # make it the default
uh config set deepseek.model deepseek-v4-flash
uh run --provider anthropic "…"
```

**Model names are never hardcoded.** `deepseek-chat` and `deepseek-reasoner` were
retired in July 2026 — a static list rots. The real list is fetched from each
endpoint's `/models` on demand.

**Two wire protocols, not one**: OpenAI-compatible (`/chat/completions`) and
Anthropic Messages (`/v1/messages`). The differences — system as a top-level
param, `input_schema` instead of `parameters`, `tool_use`/`tool_result` content
blocks, `x-api-key` auth — are absorbed in `llm/anthropic.ts`. The kernel only
ever sees its own `CompletionResult`.

**Keys never leak**: stored 0600, masked as `sk-a…1234` in every output, and a
test asserts the key string never appears in the event log.

## Run a task

```console
$ uh run "在工作区创建一个 hello.txt，内容写 hi from unit-harness，然后用 ls 确认"
workspace: /home/you/.uh/work
isolation: landlock-v7 via ~/.uh/bin/landlock-helper; writes limited to ~/.uh/work; home unreadable

· turn start
· step 1
  → qwen3.8-27b
  ← 1 tool call(s), 775 tokens
  ⚙ run_command: sh -c printf 'hi from unit-harness\n' > hello.txt && ls -la
  ✓ exit=0
· step 2
  → qwen3.8-27b
  ← 1 tool call(s), 706 tokens
  ⚙ run_command: cat hello.txt
  ✓ exit=0
· step 3
  → qwen3.8-27b
  ← 0 tool call(s), 837 tokens
· turn end (model, 3 steps)

--- answer ---
完成 ✅
- 已在工作区创建 hello.txt，内容为 hi from unit-harness
- ls -la 确认文件存在

--- deliverables (1) ---
  ✓ hello.txt                    21 B  3/3  sha256=3f2a1b2c9d8e
```

The deliverables section is not self-assessment — it's computed by diffing the
workspace before and after the run, hashing what changed, and executing
assertions in the sandbox:

| File type | Assertions run automatically |
|---|---|
| any | exists · non-empty · sha256 matches |
| `.sh` | `sh -n` (syntax check) |
| `.json` | parses |
| `.py` | `python3 -m py_compile` |

If an assertion fails, `uh run` exits non-zero. Files that were *removed* during
the run are logged as an `error` event.

No API key needed if you have LM Studio (`:1234`) or Ollama (`:11434`) running — `uh`
probes both and picks the first model it finds. Otherwise point it anywhere
OpenAI-compatible:

```bash
export UH_BASE_URL=https://api.deepseek.com/v1
export UH_MODEL=deepseek-chat
export UH_API_KEY=sk-...
uh run "看看工作区里有什么"
```

The model decides the steps; the sandbox decides what it is allowed to touch.

## Every run is evidence

Nothing happens silently. Each session writes an append-only JSONL log:

```console
$ node dist/uh.cjs session show ses_01M77JP1...
#  1  session/start          environment  {"workspace":"~/.uh/work","isolation":"landlock-v7",...}
#  2  tool/call              agent        {"tool":"exec","argv":["sh","-c","echo ok > ./sb-check.txt"],...}
#  3  tool/result            environment  {"tool":"exec","status":"ok","exit_code":0,"isolation":"landlock-v7",...}
#  4  verification/asserted  environment  {"assertion":{"kind":"sandbox-probe","name":"write inside workspace",...}
```

And the assertions can be re-run later, from the log alone:

```console
$ node dist/uh.cjs session replay ses_01M77JP1...
SAME  write inside workspace  recorded=ok now=ok
SAME  write outside workspace  recorded=deny now=deny
SAME  read $HOME/.gitconfig  recorded=deny now=deny
SAME  write to /etc  recorded=deny now=deny

4 reproduced, 0 diverged
```

`replay` never re-runs hooks (they may have side effects); their recorded
decisions are read from the log instead. If a result diverges, it exits non-zero.

## Plugins

Everything is a plugin, loaded from `~/.uh/plugins/<name>/index.js`:

```js
export default {
  name: '@example/hello',
  apiVersion: 1,
  apply(ctx) {
    ctx.tools.register({
      name: 'hello',
      description: 'Say hello',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const r = await ctx.exec.run(['sh', '-c', 'echo hi'])
        return { content: `hi (isolation=${r.isolation})` }
      },
    })
  },
}
```

See [`examples/plugin-hello`](examples/plugin-hello). Plugins have **zero runtime
dependencies** — no `import` of cordis or of this package's runtime values.

## Architecture

```
L1 runtime    agent loop, turns, model calls
L2 execution  exec / fs / net —— the only place with side effects
L3 verification  assertions (exit codes, schemas, hashes)
L4 evidence   append-only event log, content-addressed blobs, replay
L5 plugins    via @unit-harness/core only; can add verifiers, cannot bypass L3
L6 distribution  CLI / desktop shells, signed binaries
```

Dependencies flow one way: `plugins → verification → execution → evidence`.
CI fails the build if a layer reaches backwards.

Read the design records in [`docs/`](docs).

## Sandbox

| Platform | Mechanism | State |
|---|---|---|
| Linux | landlock via `native/landlock-helper` (C) | **implemented**, CI-verified |
| macOS | seatbelt via `/usr/bin/sandbox-exec` (sbpl) | **implemented**, CI-verified on `macos-latest` |
| Windows | restricted token + Job Object | **not implemented** — reports `path-guard`, refuses exec |

What landlock actually gives you on Linux:

- writes are allowed **only** inside the workspace (`~/.uh/work` by default) and `~/.uh`
- `$HOME` is **unreadable** unless you pass `--allow-home` — this is what keeps `~/.ssh` and `~/.aws` out of reach
- TCP can be blocked with `--no-net` (landlock cannot block UDP; we say so instead of implying otherwise)
- read access to system paths (`/usr`, `/lib`, `/etc`, `/proc`, …) is required for shells and runtimes to work

If nothing is available, `exec` **fails closed**. We never silently downgrade.

On macOS the same guarantees hold, built from an sbpl profile: `(deny file-write*)`
with the workspace and `~/.uh` re-allowed, `(deny file-read* …)` on `$HOME`, and
`(deny network*)` under `--no-net`. `uh sandbox check` runs the identical four
probes on both platforms, so the claim is the same claim.

Windows has no kernel isolation yet, so it reports `path-guard` and refuses to
execute unless you pass `--allow-unconfined`. We would rather ship a true "no"
than a comfortable "probably yes".

Note: bwrap is detected but not used as an enforcement path on kernels with
`apparmor_restrict_unprivileged_userns=1` (Ubuntu 23.10+), where it cannot create
user namespaces. landlock has no such requirement.

## Built on Cordis

UnitHarness is built on [Cordis](https://github.com/cordisjs/cordis) (MIT), the
plugin framework also used by DeepSeek Harness. We depend on it as a normal npm
package and do not fork it. Thanks to the DeepSeek team for releasing it openly.

## Status / roadmap

| Phase | Scope | State |
|---|---|---|
| P0 | kernel, plugin loading, sandbox probing, fail-closed exec, CLI | ✅ done |
| P1 | landlock enforcement + `sandbox check` | ✅ done |
| P1 | event log (`session/*`), assertions, replay | ✅ done |
| P1 | agent loop, `uh run`, zero-config local model discovery | ✅ done |
| P1 | deliverable detection + automatic assertions | ✅ done |
| P2 | macOS seatbelt / Windows restricted token, desktop shell | — |
| P2 | desktop shell, data packs, monitors | — |
| P3 | protocol adapters (MCP / ACP / A2A) | — |

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
