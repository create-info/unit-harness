# Design records

| File | What it decides |
|---|---|
| [design-decisions.md](design-decisions.md) | D1–D16 decision record: positioning, runtime, Cordis dependency, plugin API levels, trust model, sandbox chain, six layers, distribution |
| [core-api.md](core-api.md) | Six-layer module boundaries and the `@unit-harness/core` public API |
| [event-model.md](event-model.md) | `session/*` vs `agent/*` domains, event schema, hook points, replay semantics |
| [protocol-adapters.md](protocol-adapters.md) | MCP / ACP / A2A adapter contracts |
| [release.md](release.md) | Distribution matrix and CI build list |

These are decision records, not marketing. When implementation diverges, update
the record in the same PR.
