# Security

## Reporting a vulnerability

Open a private security advisory at
https://github.com/create-info/unit-harness/security/advisories/new
or email the maintainer. Please do not open a public issue for a vulnerability.

## Plugin trust model

Plugins run in the same process as the host, with the same privileges as your
user account. **Installing a plugin is equivalent to running its code.**

Mitigations we actually provide:

- First-party plugins ship with signed checksums verified at install time.
- Third-party plugins are marked `unverified` in `uh plugin list`, with author
  and source URL shown; they are never auto-installed or auto-updated.
- The capability manifest is displayed before install **for your information
  only**. It is a declaration, not a boundary — a plugin can bypass it with a
  direct `node:` import.

We do **not** claim sandboxing of plugins. If you need that, isolate at the OS
level (container, VM, separate user).

This is a deliberate, documented limitation, not an oversight. The
`@unit-harness/core` facade exists so that a future RPC-isolated plugin host can
be introduced without changing plugin code.

## Sandbox trust model

`exec` runs commands under the highest isolation the platform offers
(landlock → bwrap → path-guard). The current level is always reported in
`uh doctor` and on every `ExecResult.isolation`; it is never silently upgraded
or downgraded.

If no isolation is available, `exec` **fails closed**: it refuses to run unless
the user passes `--allow-unconfined` explicitly.

The build you are running states its own enforcement level. If `doctor` says
`[available landlock-v1, NOT enforced]`, that means exactly what it says.

## Out of scope

- A plugin deliberately exfiltrating your data (see trust model above).
- Attacks requiring an already-compromised user account.
- Denial of service by a plugin consuming all memory/CPU.
