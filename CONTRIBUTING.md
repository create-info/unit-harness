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
