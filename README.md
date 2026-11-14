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

**Don't click the `.dmg` / binaries on the Releases page.** Browsers stamp every
download with a quarantine flag, and macOS then refuses to run a binary that isn't
notarised — you get "damaged and can't be opened" (for the .app) or "Apple cannot
verify…" (for the CLI), neither of which means anything is wrong with the file. The
two commands above fetch with `curl`, which does not set that flag, so the binaries
run directly. If you already downloaded by hand:

```bash
xattr -d com.apple.quarantine ~/Downloads/uh-darwin-arm64   # the CLI
xattr -cr /Applications/UnitHarness.app                     # the desktop app
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

## How it decides

The system prompt is assembled from sections, not written as one string — the
same structure Codex uses:

| Section | Contents |
|---|---|
| base | identity, how to act, how to report (no "looks right", only "I ran it") |
| `environment_context` | workspace, platform, real sandbox strength, network, date |
| `tool_guidance` | when to use which tool, and when not to |
| `project_instructions` | `AGENTS.md` / `CLAUDE.md` from the workspace upward — nearest wins |

Built-in tools are deliberately few and each has a *contract*:

- **`apply_patch`** — create/edit/move/delete files with `*** Begin Patch` hunks.
  Applied **atomically**: if any hunk fails to match, nothing is written. Context
  matching is forgiving (whitespace-insensitive) because models are imprecise.
- **`run_command`** — argv array, not a shell string; `["sh","-c","..."]` when you
  really want shell syntax. Every call goes through the sandbox.
- **`update_plan`** — the only place the model's plan is visible to you; one step
  in progress at a time.

### Long runs

When the conversation approaches the context window (`--max-context`, default
32000 tokens), early turns are replaced with a summary — the same local-summary
path Codex falls back to when a provider has no remote compaction.

Three rules make it safe:

1. the user's original request survives verbatim — it is the authorization, a
   summary must not rewrite it;
2. failed attempts go into the summary, so the agent does not confidently repeat
   the same mistake;
3. the retained tail always starts at an assistant boundary — otherwise `tool`
   messages lose their matching `tool_calls` and Anthropic rejects the request.

Compaction only happens when there is more work to do; compressing the final
answer's context would just burn a call. Every compaction is a
`session/compacted` event, so a replay shows exactly what the model forgot.

`uh exec -- <cmd>` runs a single command inside the sandbox, which is handy when
you want to check *why* something failed without involving a model.

The model decides the steps; the sandbox decides what it is allowed to touch.

## What the loop does for you

Borrowed deliberately from Codex and DeepSeek Harness, because these are the
things that decide whether an agent finishes a real task:

- **Streaming.** Tokens appear as they arrive (SSE). Reasoning models' thinking goes
  to stderr under `UH_VERBOSE=1`, never mixed into the answer. A server that ignores
  `stream: true` and returns whole JSON is parsed anyway instead of erroring.
- **Middle truncation, not tail loss.** Long tool output keeps its head *and* its
  tail — errors live at the end — with the full text saved to `.uh/output/` and the
  path handed to the model so it can read the omitted part.
- **Tool output budget.** 20k chars reach the model, the rest stays on disk.
- **Compaction** at 70% of the context budget, only when there is still work to do.
- **Interrupt without losing the run.** Ctrl+C aborts the running command, closes the
  step cleanly, records `session/interrupted` and writes state — then exits 130. A
  second Ctrl+C force-quits.
- **Resume.** `uh run --continue` restores the previous conversation from
  `state.json` and carries on; with no new instruction it supplies one rather than
  sending an empty turn.
- **Real file tools.** `read_file` (numbered lines, offset/limit), `list_dir`, `grep`.
  Before this the model had to shell out to `cat`: no line numbers to point at, and a
  big file would flood the context in one go. They run in-process, read-only, and every
  path goes through the same escape check as `apply_patch`.
- **Sub-agents.** `spawn_agent` hands a self-contained subtask to an agent with its own
  context, working in the same sandbox, and gets a written summary back. Depth is capped
  at 2 **and** a run may start at most 8 of them — a depth limit alone does not bound
  cost (6 steps × 6 spawns each reaches 36 agents at depth 2).
- **Checkpoints, as log entries.** Every write the agent makes records `before` and
  `after` as a `checkpoint/file` event — the same log that holds tool calls and
  approvals. `uh undo` reads the last turn's entries and writes the `before` versions
  back. No git, no shadow repo, nothing to install.
  Known boundary, stated in the output rather than hidden: only writes that go through
  the agent's tools are in the log. A `sed -i` inside a shell command is not.
- **Images.** `uh run "..." --image shot.png` — sent as a data URL (OpenAI) or a
  base64 image block (Anthropic). Verified against a local vision model: asked what
  was in a screenshot of this very UI, it named the session list correctly.

```console
$ uh run "这张截图里左侧栏列出了什么？" --image shot.png
左侧栏标题为 **SESSIONS**，列出了两条历史会话记录：…
```

Base64 never goes to disk: `state.json` keeps the path and the media type, and a
resume re-reads the file. Otherwise one screenshot would inflate a session by tens
of megabytes.

## Releasing

Pushing a tag is the whole procedure — no personal access token, no local gh:

```console
$ git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` then picks up the newest green `main` run's
artifacts, generates a `.sha256` next to every binary, creates the release, and
verifies each asset is downloadable **without authentication** — because that is
how `install.sh` fetches it. A local dry run needs no token either:

```console
$ bash scripts/release.sh v0.1.0 --dry-run
```

## Approvals

The positioning says "spending actions need approval". This is that, wired up:

```console
  ⚠ approval needed: destructive — it cannot be undone by the sandbox
    sh -c cd /tmp/uh/ work && chmod -R 777 .
    run it? [y/N] n
  ✗ refused
```

What gets asked, and what doesn't, follows the sandbox:

| Case | Asked? |
|---|---|
| read-only (`ls`, `cat`, `git status`) | never |
| write, **sandbox enforcing** (`npm i`, `mkdir`) | no — it can only touch the workspace |
| write, sandbox **not** enforcing | yes |
| destructive (`rm -rf`, `mkfs`, `chmod -R 777`, `find -delete`) | always |
| remote write / destructive | always — the sandbox does not cover the remote host |

Default is **deny**, not allow: a caller with no terminal (CI, script, API) does not
get permission to run dangerous commands just because nobody answered. `--yes`
approves everything, `--no-ask` refuses everything.

Both outcomes are recorded: `approval/requested` carries the exact command,
`approval/resolved` carries the decision. So the log shows what was attempted, not
just what was allowed.

> In the web UI (`uh serve`) the same gate appears as a modal: the run blocks until you
> answer, and the decision (`allow` / `allow-always` / `deny`) is written to the session
> log. If nobody answers within five minutes the action is denied — "no answer" is never
> treated as "yes".

## Settings in the UI

`uh serve` opens a page with the things you cannot guess from a terminal:

- **Settings** — pick any of the twelve providers, paste a key, override the base URL,
  and hit **List** to ask that provider what models it actually serves (`GET /models`
  with your key; nothing is hardcoded, because model names retire every few months).
  The key is written to `~/.uh/config.json` at 0600 and only ever shown masked.
- **The interactive terminal** — `uh` with no arguments opens a prompt instead of
  printing help. Inside it: the answer streams as it is written, tool calls show up
  as one line each, `@path` inlines a file into the message (a big one becomes a
  pointer rather than burning the context), `$skill` loads that skill's body, and
  `/model`, `/config`, `/skills`, `/files`, `/new`, `/resume`, `/quit` cover the rest.
  ↑/↓ walk your history (kept in `$UH_HOME/history`). Ctrl+C interrupts the running
  turn and keeps the conversation; on an empty prompt it needs a second press to exit.
  Piped input works too (`printf '/help\n' | uh chat`), so it is scriptable.
- **How long a turn may run** — there is no step cap by default. An exploratory task
  (list the tree, read three files, grep once) was already spending twelve steps, and
  being cut off there left the turn with no answer at all. What bounds a turn now is the
  token budget, your **Stop**, and `--max-steps N` when you want a hard ceiling. If a
  turn does get cut off (explicit cap, or a timeout), it is asked once more for a plain
  summary *without* tools, so you always get a sentence instead of an empty answer.
- **Spinning is stopped by evidence, not by a guess** — if the same call (same tool, same
  arguments) fails five times in a row, the turn stops with `stop_reason: 'stuck'` (exit
  code 4) and the model is asked what it tried and what the error actually said. Both
  shapes of failure count: a tool's own `ERROR`/`BLOCKED`, and `run_command` returning
  `exit=7 …`. Without this, removing the step cap lets a model retry the same broken
  command forever.
- **Notes while it works** — anything you send mid-run is queued and injected at the
  next step boundary; the chips above the composer are clickable, so you can take a
  note back into the box, fix the wording, and send it again as a new note (`✕` drops
  it). Withdrawing goes to the server first — otherwise the original would still land.
- **Restarting after a rebuild** — `uh serve --force` (and the desktop shell, which
  passes it to its sidecar) takes the port back from a previous `uh serve` instead of
  exiting with `EADDRINUSE`. It kills **only** a process whose command line is
  `uh serve` / `unitai serve`; anything else on that port is reported and left alone.
  Without `--force` the error says who holds the port and which command frees it.
- **Project** — the workspace is the sandbox root, and `+` next to *Projects* opens a
  folder picker: you click into a directory (breadcrumbs to go back), or create a new
  folder inside it, instead of typing an absolute path from memory. See
  `GET /api/fs`, `POST /api/fs/mkdir`.
- **Voice input** — the mic records locally and posts the audio to this machine
  (`POST /api/transcribe`), where a local engine transcribes it. It does not use the
  browser's `SpeechRecognition`: that runs in the cloud (Chrome sends audio to Google),
  and where that endpoint is unreachable the UI only ever said `speech: network`.
  Run `bash scripts/asr-install.sh` once to install faster-whisper and a model;
  `GET /api/asr` reports whether an engine was found and what to run if not.
- **Follow-ups** — sending another message continues the same conversation: the stored
  messages are replayed as context and the new turn is appended to the same session
  (`turn_index` increments), so the sidebar shows one conversation, not a pile of
  one-shot runs. *New task* starts a fresh one.

All of these are plain local endpoints (`/api/settings`, `/api/projects`, `/api/models`,
`/api/fs`, `/api/transcribe`), so the same controls work from the desktop shell, a
browser, or `curl`.

### Recipes: `uh do`

A recipe is a fixed task plus acceptance checks that we run ourselves. If you stop it
halfway, the checks still run against what is already on disk — a file the agent wrote
is real whether or not the turn finished. `uh do <name> --check` re-runs only the
checks, without calling the model again.

`recipe/started` and `recipe/checked` go into the session log, so a run that was cut
short still says which recipe and which verdict it was judged by.

## Where sessions live

```
~/.uh/sessions/2026/11/13/<session-id>/
  events.jsonl   one JSON event per line, append-only
  meta.json      who/what/when
  state.json     messages, for --continue
  blobs/         any before/after body over 4 KB, by content hash
```

Same shape as Codex's `sessions/YYYY/MM/DD/rollout-*.jsonl`, for the same reason:
listing "the last 20 sessions" should not read a year of disk.

`uh sessions [n]` lists newest-first, `uh session prune --older-than 30d` moves old
ones to `~/.uh/archived_sessions/`. Archive, not delete — the log is the evidence.
Retention is opt-in; nothing is pruned until you ask.

Large bodies move to `blobs/` so an event line stays readable: `cat events.jsonl` and
`grep` still work, and `uh undo` reads the body back when it needs it.

## Hooks

`.uh/hooks.json` in the workspace, no restart needed:

```json
{
  "pre_finish": [{ "run": "npm test" }],
  "pre_tool":   [{ "tool": "run_command", "match": "deploy", "run": "echo not from here >&2; exit 2" }]
}
```

- `pre_tool` — non-zero exit blocks the call; stderr goes back to the model
- `post_tool` — observe only
- `pre_finish` — runs when the model says it is done; non-zero **rejects the finish**
  and feeds the output back as a new instruction, so it has to keep working

That last one is the point. A prompt can say "verify before claiming success" and the
model can ignore it. An exit code it cannot. Every hook run is recorded as
`hook/execution` with its decision.

## Remote hosts

```console
$ uh host add prod ubuntu@203.0.113.10 --key ~/.ssh/id_ed25519
$ uh host test prod
✓ prod  Linux 6.8.0-117-generic x86_64 · ubuntu  (657ms)

$ uh exec --host prod -- df -h /
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda2        40G  7.6G   31G  20% /
```

`hosts.json` stores the **key path**, never the key. The agent gets a `remote_exec`
tool once at least one host exists, so it can inspect and operate a real server.

Three rules, because this is someone's production box:

| Command | Behaviour |
|---|---|
| read-only (`df`, `ps`, `journalctl`, `systemctl status`, `docker ps`) | runs |
| modifies state (`mkdir`, `npm i`, `systemctl restart`, `echo > file`) | refused unless `--allow-remote-write` |
| destructive (`rm -rf /`, `dd`, `mkfs`, `shutdown`, `curl … \| sh`) | refused unless `--allow-remote-destructive` |

Remote execution **bypasses the local sandbox on purpose** — ssh has to read a
private key, and the sandbox deliberately makes `~/.ssh` unreadable. So it is a
separate tool, credentials never reach the model, and every call is logged as
`isolation: "none"`, `scope: "remote"` rather than pretending landlock applied.

Classification is pattern matching and will miss things. It is an extra gate, not
a guarantee. The guarantee is the audit trail: every attempt, including refused
ones, is in the event log.

## Recipes

`uh run "..."` lets the model decide what "done" means. `uh do <recipe>` doesn't:

```console
$ uh do node-service
recipe: node-service
vars:   port=8731

--- deliverables (1) ---
  ✓ server.mjs  1223 B  3/3

--- checks ---
  ✓ server.mjs 已创建   1223 B
  ✓ 服务能起来且 /healthz 返回 200   exit 0
```

The checks are **ours, not the model's**: it starts the server in the sandbox,
polls the port, kills it, and fails the run if nothing answers. A model claiming
"done" is not evidence; a port that responds is.

Built in: `node-service`, `python-cli`. Drop your own JSON into
`~/.uh/recipes/` — same shape as `packages/core/src/recipe/builtin.ts`, and a
user recipe with the same name shadows the builtin.

Directory names, ports and other knobs are `{{vars}}`, overridable with
`--set port=9000`. Built-in checks shell out via `sh`, so they are POSIX-only
today; the failure surfaces as `error`, never as a silent pass.

## Desktop app

| Platform | Installer |
|---|---|
| macOS (Apple Silicon) | `UnitHarness_0.1.0_aarch64.dmg` |
| Windows x64 | `UnitHarness_0.1.0_x64-setup.exe` / `.msi` |
| Linux x64 | `UnitHarness_0.1.0_amd64.deb` / `.AppImage` |

Built with Tauri, ~36 MB on macOS. The shell is deliberately thin: it spawns the
bundled `uh` binary as a sidecar (`uh serve`), waits for the port to open, then
navigates the window to it. **The UI has exactly one implementation** — the same
static page the CLI serves — so the desktop app and the CLI cannot drift apart.
On exit the shell kills the sidecar, so nothing is left holding the port.

The installers are **unsigned**: macOS needs right-click → Open the first time,
Windows shows a SmartScreen prompt. Signing requires certificates we don't have;
that is a distribution problem, not a code one.

## Desktop UI

```console
$ uh desktop
UnitHarness UI  http://127.0.0.1:7878  (opened in your browser)
```

A local UI served by the binary itself — same shape DeepSeek Harness uses
(`apps/web` + `host/webserver`): one HTTP server on `127.0.0.1`, a single static
page, events streamed over SSE. No Electron, no frontend build step, no second
process to supervise, and it behaves identically on macOS, Linux and Windows.

What you see is the evidence, live: each step, each tool call with the exact
argv, plan updates, compaction, and at the end the deliverables with assertion
counts and sha256. Past sessions replay from the same event log the CLI writes.

## Skills

```console
$ tree .uh/skills
.uh/skills/
└── deploy-check/
    └── SKILL.md
```

```markdown
---
name: deploy-check
description: Verify a deployment actually took effect
---

# Deploy check
1. curl the health endpoint
2. compare the git sha in /status with the one you deployed
```

Skills are discovered from `./.uh/skills`, `./.agents/skills`, `~/.uh/skills`
(nearest wins) — the same roots DeepSeek Harness scans.

The **index** (name + one-line description) always sits in the prompt; the
**body** is loaded only when the model calls `use_skill`. That split is the whole
point: fifty skills of full text would eat the window, but fifty one-liners keep
the model aware of what exists.

## MCP

```console
$ uh mcp list
config: ~/.uh/mcp.json

✓ filesystem  (stdio)  14 tool(s)

  mcp__filesystem__read_file
      [MCP:filesystem] Read a file (runs outside the local sandbox)
```

Config is the same shape as Claude Desktop's, so anything you already run there
works here — `~/.uh/mcp.json` globally, `./.uh/mcp.json` per project:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "authorization": "Bearer …" } }
  }
}
```

Both stdio and streamable-HTTP transports are supported.

```console
$ uh mcp add unitai https://unitai.site/mcp --header authorization
authorization value (input hidden): ********
$ uh mcp test unitai
✓ unitai  (http)  7 tool(s)
```

`uh mcp add` asks for the token with echo off, writes `~/.uh/mcp.json` at 0600, and
`uh mcp test` prints the real handshake error (a 401 tells you where to get the
token) instead of a stack trace. See [`docs/unitai.md`](docs/unitai.md).

**MCP servers run outside the sandbox.** They are separate processes with your
full user privileges — nothing landlock or seatbelt does applies to them. So the
tool name is prefixed `mcp__<server>__<tool>`, `uh doctor` lists them under a
warning, and every call is logged with `isolation: "none"` rather than
inheriting the sandbox level. If an MCP call deletes something, the event log
will not pretend it was contained.

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

### Built-in plugins

| Plugin | What it does | Docs |
|---|---|---|
| `@unit-harness/plugin-browser` | Drive a real browser over CDP: snapshot the page as a semantic tree, click, type, all with settle-and-verify | [`docs/browser.md`](docs/browser.md) |
| `@unit-harness/plugin-phone` | Drive a real phone — Android (adb), HarmonyOS (hdc), iOS (WebDriverAgent) — with one element model | [`docs/phone.md`](docs/phone.md) |

Both share `plugins/shared/observe.js`: a semantic-tree observer that keeps element
refs stable across UI changes and reports only the diff, so a second look at the same
screen costs a line instead of a full dump.

```bash
# they live next to the repo; point the loader at them
UH_PLUGIN_DIR=$PWD/plugins uh tool browser_open --json '{"url":"https://example.com"}'
```

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

**One deliberate exception**: interpreter and package-manager directories are
**readable** (`~/.nvm/versions`, `~/.pyenv/versions`, `~/.cargo/bin`, and the venv
root of whatever binary you actually invoke). A sandbox where `python3` cannot
start is not secure, it is useless — the first `pyvenv.cfg` read fails and every
script dies. Credential paths (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.cargo/credentials*`,
`~/.netrc`, `~/.git-credentials`) stay unreadable, and `uh sandbox check` proves it.

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
