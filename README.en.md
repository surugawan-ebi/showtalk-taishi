# ShowTalk Taishi

<p align="center">
  <img
    src="docs/assets/brand/showtalk-taishi-concept-v3.png"
    alt="ShowTalk Taishi — Prince Taishi listening to several Koe represented by AI kamon"
    width="100%"
  >
</p>

<p align="center">
  <strong>Every Koe gets a channel. Every channel can talk.</strong><br>
  Talk to, coordinate, and supervise local AI coding agents from Slack.
</p>

<p align="center">
  <a href="README.md">日本語</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <img alt="Status: Preview" src="https://img.shields.io/badge/status-preview-B6452C?style=flat-square">
  <img alt="Version: 0.0.1" src="https://img.shields.io/badge/version-0.0.1-263238?style=flat-square">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-3C873A?style=flat-square">
  <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-2D6A8A?style=flat-square">
</p>

ShowTalk Taishi is a local-first, self-hosted Slack front end and switchboard
for AI coding agents. It makes durable Codex threads available as a daily Slack
control surface while preserving an `AgentAdapter` boundary for future Claude
Code, Gemini CLI, and other integrations.

The name is inspired by Prince Shōtoku, traditionally associated in Japan with
listening to several people at once. Taishi calls each persistent AI identity a
**Koe（声）**, or voice. Humans can supervise these voices in one place, and
explicitly permitted Koe can consult one another.

> [!IMPORTANT]
> This is runnable pre-release software. The public source is a `0.0.1`
> preview, not a stable v0.1 or an npm release.
> Configuration formats may still change before v0.1.

## What it does

```text
                              Human
                                │
                                ▼
                              Slack
                                │ Socket Mode
                                ▼
                       ┌─ ShowTalk Taishi ─┐
                       │  Gateway + Policy │
                       └─────────┬─────────┘
                                 │
                 ┌───────────────┼───────────────┐
                 ▼               ▼               ▼
          Implementer Koe    Reviewer Koe     Operator Koe
                 │               │               │
              Codex           Codex           Codex
            App Server      App Server      App Server
                 └── permitted agent.send consultations ──┘
```

Slack is the human interface, Koe directory, activity log, and approval
surface. Koe-to-Koe messages travel directly through the Gateway instead of
Slack events, making routing explicit and avoiding accidental bot loops.

The first implemented adapter runs Codex App Server over stdio. Slack connects
through Socket Mode, so the host Mac or Linux machine does not need a public
HTTP server.

## Highlights

| | Capability | What it provides |
| --- | --- | --- |
| 🗣️ | **Persistent Koe** | Reuse durable Codex threads with channel-wide or Slack-thread-scoped mapping |
| 🔀 | **Koe consultations** | Direct `agent.send` visits protected by allowlists, scopes, hop limits, and busy handling |
| ✅ | **Slack-native decisions** | Clearly separated command, file-change, ordinary-choice, non-Git external-action, and exact Git-plan flows |
| 📎 | **Images and audio** | Native multi-image input, safe audio-file ingress, origin-bound artifact replies, and inline generated-image projection |
| ⏯️ | **Operational controls** | Status, Interrupt, approver-only Gateway restart, and durable backend-thread mappings |
| 🎭 | **Per-Koe presentation** | Call names, roles, Slack display names and icons, and Slack-only personas |
| 🧭 | **Management UI** | A loopback-only UI for mappings and runtime-editable model settings |
| 🔌 | **Local MCP surface** | Permission-checked `agent.list`, `agent.status`, `agent.send`, `slack.post`, and `slack.reply` |

Conversation mapping is configurable per Koe:

- `channel` maps the whole Slack channel to one durable backend thread.
- `slack_thread` creates or resumes a separate backend thread for each Slack
  root thread.

Koe-to-Koe reachability fails closed. A source Koe can consult only targets in
its `consultations` list and only within each relationship's configured scope.
An `agent.send` Koe-to-Koe consultation is distinct from a Codex internal
sub-agent. Audio is exposed to the Koe as a local file in the private spool;
understanding or transcription depends on a separate tool available in its
workspace.

## Quick start

> [!WARNING]
> Run Taishi only on a trusted, self-hosted workstation. Keep the management UI
> and MCP endpoints private, restrict the Codex sandbox and approval policy,
> and read the [security model](docs/security.md) before connecting real
> repositories.

### Requirements

- macOS or Linux
- Node.js 22 or newer
- an installed and authenticated `codex` CLI
- permission to create and install a Slack App

### 1. Install

```bash
git clone https://github.com/surugawan-ebi/showtalk-taishi.git
cd showtalk-taishi
npm ci
npm run build
npm link
taishi init
```

### 2. Prepare the Slack App

Create the App from [`slack/manifest.yaml`](slack/manifest.yaml), enable Socket
Mode, create an app-level token with `connections:write`, install the App, and
invite it to every configured Koe channel.
The bundled v0.1 manifest supports invited public channels only; private
channels and DMs are not supported. Token rotation is not yet enabled, so keep
tokens in an owner-only environment and revoke and reissue them in Slack if
they are exposed.

### 3. Load private configuration and start

Set the environment variables referenced by `config.yaml`. Never add tokens,
real channel IDs, workspace paths, or runtime state to Git.

```bash
export SLACK_APP_TOKEN='xapp-...'
export SLACK_BOT_TOKEN='xoxb-...'
export SLACK_APPROVER_USER_ID='U0123456789'
export TAISHI_STATE_FILE="$HOME/.showtalk-taishi/state.json"
export CODEX_COMMAND='codex'
export IMPLEMENTER_WORKSPACE='/path/to/project-a'
export SLACK_CHANNEL_IMPLEMENTER='C0123456789'
export SLACK_CHANNEL_REVIEWER='C9876543210'

taishi doctor
taishi start
```

See [Configuration](docs/configuration.md) for complete setup, existing Codex
thread binding, Koe identity, personas, consultation policy, and the management
UI. The npm package is intentionally `private` during this preview; install it
from a source checkout rather than with `npm install -g`.

## Decision and approval model

The confirmations displayed in Slack do not all provide the same guarantee.

| Path | What it guarantees |
| --- | --- |
| Codex command / file change | Projects a live App Server approval RPC to Slack and returns the human decision to that request |
| Non-Git external action | Confirms the displayed `Target` / `Scope` / `Impact`; it does not hash-lock or mechanically enforce the later command as an exact plan |
| workspace-git | An optional integration binds the operation, full plan hash, scope, expiry, and HEAD / snapshot, then revalidates before execution |

An ordinary workflow choice never authorizes an external write. See
[Operations and Slack behavior](docs/operations.md) for the exact flows.

## Security boundaries

- Taishi is intended for a trusted, self-hosted workstation. It is not a
  multi-tenant sandbox for untrusted local OS users.
- The management UI and per-Koe MCP endpoints bind to loopback only. Do not
  expose them through a proxy or port forward.
- Keep Slack and Codex credentials in environment variables or owner-only
  files, never in Git.
- Side effects routed through the Gateway are checked by the Permission Engine.
  This cannot revoke permissions independently granted to the backend, so keep
  the Codex sandbox and approval policy restrictive too.
- A non-Git external-action confirmation answers a live request about the
  displayed details. It is not an exact-plan guarantee that mechanically binds
  and revalidates the later command.
- Exact Git approval is bound to an operation, plan hash, Slack message,
  approver, and live turn. When the same App Server turn resumes after the Slack
  answer, only an operation that still exactly matches workspace-git state can
  execute.
- A Gateway restart preserves backend threads and mappings so the next message
  can resume them. Active turns and pending approvals do not survive; they are
  interrupted or expired.

Exact Git approval requires a separately installed, operator-owned
[workspace-git integration](docs/workspace-git-integration.md). Basic Slack and
Codex routing works without it. Read the [security model](docs/security.md)
before connecting real repositories or enabling Koe-to-Koe consultations.
Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

## Documentation

- [Configuration](docs/configuration.md)
- [Operations and Slack behavior](docs/operations.md)
- [Gateway restart and approval-bridge verification](docs/gateway-restart-verification.md)
- [Optional workspace-git integration](docs/workspace-git-integration.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Brand assets](docs/assets/brand/README.md)
- [Contributing](CONTRIBUTING.md)
- [Configuration example](examples/config.example.yaml)

## Development and verification

For normal changes:

```bash
npm run check
```

For release-facing or cross-cutting changes:

```bash
npm run verify
```

Changes to Codex structured input, Slack choices, approvals, continuation,
turn mode, or restart activation must also run:

```bash
npm run verify:approval-bridge
```

This combines deterministic approval-bridge tests with a real Codex App Server
answer round trip. If verification includes a Worker restart, complete the
[public live acceptance gate](docs/gateway-restart-verification.md) as well.

Optional real-Codex smoke tests that do not connect to Slack:

```bash
npm run smoke:codex-mcp
npm run smoke:codex-agent-send
npm run smoke:codex-resume
```

## License

[Apache License 2.0](LICENSE)
