# Guide for AI coding agents

This repository is written with AI assistance. Follow these rules.

## Never

- Never add a `vendor/` copy of cordis. It is a normal npm dependency.
- Never introduce Bun APIs. The stack is Node-only (D2).
- Never add `remote_id` / `synced_at` / `server_*` columns to core tables.
- Never describe the plugin capability manifest as a security boundary.
- Never make `uh doctor` or `ExecResult.isolation` report a level that is not
  actually enforced.
- Never call `node:child_process` from a plugin; use `ctx.exec`.

## Always

- Side effects go through `ctx.exec` / `ctx.fs` / `ctx.net`.
- Registrations go through `ctx.effect` / `ctx.tools.register` / `ctx.hooks.on`
  so they are reversible.
- `exec` must fail closed when isolation is `none` or `path-guard`.
- SEA build output must stay CommonJS (`format: 'cjs'`); Node 22 cannot run an
  ESM SEA entry.
- Update `docs/` decision records instead of silently diverging from them.

## Verify before claiming done

```bash
npm run build:native          # landlock helper -> ~/.uh/bin
npm run build && node dist/uh.cjs doctor
node dist/uh.cjs sandbox check                                 # must pass 4/4 on Linux
UH_PLUGIN_DIR=$PWD/examples node dist/uh.cjs tool hello        # expect fail-closed WITHOUT helper
```

Never claim an isolation level that `sandbox check` does not demonstrate.
