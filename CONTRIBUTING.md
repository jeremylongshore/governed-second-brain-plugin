# Contributing

This is the installable **Bob's Big Brain** plugin — a local stdio MCP server (read + write)
that drives the engines over a brain that stays 100% on your machine. Contributions to the plugin
itself (the MCP server, its tools, the install/packaging path, docs) are welcome here.

## Where a change belongs

| Change | Repo |
|---|---|
| Plugin MCP server, its tools, packaging, install flow | **here** (`bobs-big-brain-plugin`) |
| The compiler (passes, kernel, `ico` CLI) | [bobs-big-brain-compiler](https://github.com/jeremylongshore/bobs-big-brain-compiler) (Bob's Big Brain Compiler) |
| The governance control plane (dedupe / policy / promotion / audit) | [bobs-big-brain-registrar](https://github.com/jeremylongshore/bobs-big-brain-registrar) (Bob's Big Brain Registrar) |
| On-device retrieval | upstream [qmd](https://github.com/tobi/qmd) (pinned dependency) |

The engines are bundled at pinned versions via `gsb.lock.json` — bumping an engine is a lockfile
change here plus the actual fix in the engine repo.

## Working agreement

- **Open an issue first** for anything beyond a typo or a one-line fix, so the approach can be agreed
  before code is written.
- **Keep the trust model honest.** The audit trail is tamper-**evident** (detects edits/reordering),
  not tamper-proof. Don't introduce copy that implies "immutable", "tamper-proof", or
  "non-repudiation" for local mode — see `SECURITY.md`.
- **The model proposes; deterministic code owns durable state.** Don't add paths where the model
  writes durable state directly, bypassing the govern kernel.
- **Local-first by default.** Don't add network egress or external sharing without an explicit,
  opt-in, clearly-labeled consent surface.
- Match the surrounding code style; include tests where the package has them.

## Pull requests

Branch, commit with a clear message, and open a PR. CI must be green before merge. By contributing
you agree your work is licensed under the repo's [Apache-2.0](./LICENSE) license.

— Jeremy Longshore · [intentsolutions.io](https://intentsolutions.io)
