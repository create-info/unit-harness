# UnitHarness

**The agent that proves its work.**

Every deliverable it hands you has been executed and verified in a sandbox, and
every run is replayable. If it can't be verified, it isn't done.

> Status: `v0.1.0` — P0 skeleton. The kernel runs, plugins load, sandbox probing
> and fail-closed enforcement are in place. Isolation enforcement (landlock /
> bwrap / seatbelt) lands in P1; until then `exec` reports `none` honestly and
> refuses to run without `--allow-unconfined`.

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
npm run build

node dist/uh.cjs doctor
node dist/uh.cjs --version
```

```console
$ node dist/uh.cjs doctor
UnitHarness 0.1.0  (node v22.22.3)
platform    linux/arm64  kernel=6.17.0-1008-nvidia
isolation   none (platform=linux/arm64, kernel=6.17.0-1008-nvidia)  [available landlock-v1, NOT enforced]
            capability detected but not yet applied by this build

  landlock   available (abi 1)
  bwrap      available — /usr/bin/bwrap
  seatbelt   unavailable — not darwin

  note: lsm: lockdown,capability,landlock,yama,apparmor,ima,evm
```

Note the honesty: this build *detects* landlock but does not yet *enforce* it.
`exec` therefore reports `none` and refuses to run:

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

| Platform | Priority 1 | Priority 2 | Fallback |
|---|---|---|---|
| Linux | landlock | bwrap | path-guard + confirm |
| macOS | seatbelt | path-guard + confirm | — |
| Windows | restricted token + Job Object (P2) | path-guard + confirm | — |

If nothing is available, `exec` **fails closed**. We never silently downgrade.

## Built on Cordis

UnitHarness is built on [Cordis](https://github.com/cordisjs/cordis) (MIT), the
plugin framework also used by DeepSeek Harness. We depend on it as a normal npm
package and do not fork it. Thanks to the DeepSeek team for releasing it openly.

## Status / roadmap

| Phase | Scope | State |
|---|---|---|
| P0 | kernel, plugin loading, sandbox probing, fail-closed exec, CLI | ✅ done |
| P1 | landlock/bwrap/seatbelt enforcement, event log, assertions | next |
| P2 | desktop shell, data packs, monitors | — |
| P3 | protocol adapters (MCP / ACP / A2A) | — |

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
