# UnitHarness

**The agent that proves its work.**

Every deliverable it hands you has been executed and verified in a sandbox, and
every run is replayable. If it can't be verified, it isn't done.

> Status: `v0.1.0` — landlock enforcement is live on Linux (via a small C helper).
> Filesystem writes are confined to the workspace, `$HOME` is unreadable, and TCP
> can be blocked. macOS/Windows enforcement is still pending and those platforms
> fail closed. Verify it yourself with `uh sandbox check`.

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

## Quick start

```bash
git clone https://github.com/create-info/unit-harness.git
cd unit-harness
npm install
npm run build:native     # compiles the landlock helper -> ~/.uh/bin (needs cc)
npm run build

node dist/uh.cjs doctor
node dist/uh.cjs sandbox check
```

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

| Platform | Priority 1 | Priority 2 | Fallback | State |
|---|---|---|---|---|
| Linux | landlock (`native/landlock-helper`) | bwrap | path-guard + confirm | landlock **implemented** |
| macOS | seatbelt | path-guard + confirm | — | pending |
| Windows | restricted token + Job Object | path-guard + confirm | — | pending |

What landlock actually gives you on Linux:

- writes are allowed **only** inside the workspace (`~/.uh/work` by default) and `~/.uh`
- `$HOME` is **unreadable** unless you pass `--allow-home` — this is what keeps `~/.ssh` and `~/.aws` out of reach
- TCP can be blocked with `--no-net` (landlock cannot block UDP; we say so instead of implying otherwise)
- read access to system paths (`/usr`, `/lib`, `/etc`, `/proc`, …) is required for shells and runtimes to work

If nothing is available, `exec` **fails closed**. We never silently downgrade.

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
| P1 | event log (`session/*`), assertions, replay | next |
| P2 | macOS seatbelt / Windows restricted token, desktop shell | — |
| P2 | desktop shell, data packs, monitors | — |
| P3 | protocol adapters (MCP / ACP / A2A) | — |

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
