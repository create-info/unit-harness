## What

<!-- One paragraph. What changed, and for whom. -->

## Why

<!-- The problem this solves. Link the issue if there is one. -->

## Does it touch the execution path?

- [ ] No — docs, tests, UI copy, plugins only.
- [ ] Yes — commands still go through `ctx.exec`; no direct `node:child_process`.
- [ ] Yes — and `uh sandbox check` was run on: <!-- linux / macOS / Windows -->

## Checks

```bash
node scripts/check-constraints.mjs
npm run typecheck
npm run build
npm test
```

- [ ] All four pass locally.
- [ ] If this changes behaviour, a test fails without the change.

## Claims

- [ ] No guarantee is claimed that the code does not enforce (isolation level, capability manifest).
