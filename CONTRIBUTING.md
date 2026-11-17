# Contributing

Thanks for helping. Two rules matter more than the rest:

1. **Do not bypass the execution layer.** Commands must go through `ctx.exec`,
   never `node:child_process` directly — otherwise there is no isolation record
   and the verification chain breaks. This cannot be enforced mechanically in a
   same-process plugin model, so it is reviewed by humans and violations are
   rejected.
2. **Do not claim guarantees we cannot keep.** Do not describe the plugin
   capability manifest as a security boundary. Do not make `uh doctor` report a
   stronger isolation level than is actually enforced.

## Setup

```bash
npm install
npm run build
npm run typecheck
node dist/uh.cjs doctor
```

## Where to start

Things that are open and self-contained:

- **Windows isolation.** macOS uses seatbelt, Linux uses landlock through a small
  C helper in `native/`. Windows has no enforcement path yet and stays
  fail-closed. A restricted-token job object is the intended route; `uh sandbox
  check` is the contract it has to satisfy.
- **A plugin.** Copy `examples/plugin-*`, keep it dependency-free, export
  `{ name, apiVersion: 1, apply(ctx) }`. Plugins are the cheapest way to add a
  capability without touching the core.
- **An assertion.** If a deliverable can be checked mechanically, that check
  belongs in the verification chain — a test that fails without the change is the
  contribution.
- **Docs.** Any step where the README did not match reality is a bug report we
  want, and usually a one-line fix.

Open an issue with the templates in `.github/ISSUE_TEMPLATE` — the bug form asks
for the run id, because a run replays without you having to reproduce it by hand.

## Layout

```
packages/core     @unit-harness/core — the only public API surface
packages/cli      uh CLI (a shell over the same engine)
examples/         runnable plugin examples
spikes/           verified feasibility spikes (SEA, cordis-in-SEA, musl)
docs/             design records
```

## Dependency rules (CI enforced)

- `packages/core` must not import `packages/cli`.
- Plugins may import **types** from `@unit-harness/core` only — no runtime import,
  no direct cordis import.
- No `vendor/` directory: cordis comes from npm.

## Adding a plugin

1. Create `examples/plugin-<name>/` with `package.json` containing
   `"type": "module"` and `index.js`.
2. Export `{ name, apiVersion: 1, apply(ctx) {} }`.
3. Keep it dependency-free: no imports at runtime.
4. Run `UH_PLUGIN_DIR=$PWD/examples node dist/uh.cjs plugin list`.

## Commits

Conventional-ish messages (`feat:`, `fix:`, `docs:`, `chore:`). One logical
change per commit.
