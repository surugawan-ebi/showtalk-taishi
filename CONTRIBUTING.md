# Contributing to ShowTalk Taishi

Thanks for helping improve ShowTalk Taishi. The project is pre-release, so
configuration, tool schemas, and state formats may still change.

## Before you start

- Search the issue tracker before opening a duplicate bug or feature request.
- Report suspected vulnerabilities through the private process in
  [SECURITY.md](SECURITY.md), not in a public issue.
- Never commit credentials, real Slack data, local configuration, runtime
  state, logs, or machine-specific paths. Use placeholders in tests and docs.

## Development setup

Use Node.js 22 or newer and install the locked dependencies:

```bash
npm ci
npm run build
```

## Making changes

- Keep changes focused and explain the user or operator problem they solve.
- Add or update tests for behavior changes. Tests live under `test/` and mirror
  the TypeScript implementation under `src/`.
- Update README or `docs/` content when configuration, permissions, security
  boundaries, or operator workflows change.
- Keep Gateway Core adapter-neutral and preserve fail-closed permission and
  credential boundaries described in `docs/architecture.md` and
  `docs/security.md`.

## Verification

Run the deterministic release checks before submitting a pull request:

```bash
npm run verify
```

This runs the TypeScript check, unit tests, build, and package dry run. The
`smoke:codex` scripts are opt-in: they require a locally authenticated Codex
installation and consume real Codex turns. Run them only when your change
affects the Codex App Server, MCP, routing, or resume paths.

Changes to restart or approval-bridge behavior also follow the public
[Gateway restart and approval-bridge verification](docs/gateway-restart-verification.md)
gate. Report any live stage that was not exercised as unverified.

## Pull requests

In the pull request, summarize the change, its security or compatibility
impact, and the checks you ran. Keep unrelated changes separate and call out
any validation that could not be completed.

Unless explicitly stated otherwise, contributions submitted for inclusion in
this project are provided under the [Apache License 2.0](LICENSE).
