# ShowTalk Taishi

<p align="center">
  <img
    src="docs/assets/brand/showtalk-taishi-concept-v3.png"
    alt="ShowTalk Taishi — AI kamon icon, AI-highlighted wordmark, and an ukiyo-e inspired Taishi listening to six Koe"
    width="100%"
  >
</p>

> **Every Koe gets a channel. Every channel can talk.**

ShowTalk Taishi is a local-first, self-hosted Slack front end and switchboard
for AI coding agents. It makes Slack a daily control surface for Codex while
keeping the Gateway open to Claude Code, Gemini CLI, and other adapters.

The name is inspired by Shotoku Taishi, who is traditionally associated in
Japan with listening to several people at once. Taishi brings several
**Koe（声）**—persistent voices backed by coding agents—into one place and lets
humans supervise them and Koe consult each other.

> [!IMPORTANT]
> ShowTalk Taishi is runnable pre-release software. It is already used in a
> real Slack workspace, but the public release acceptance checklist is still
> in progress and configuration formats may change before v0.1. This public
> source snapshot is a `0.0.1` preview, not a stable v0.1 or an npm release.

## What it is

```text
                              Human
                                │
                                ▼
                              Slack
                                │
                         ShowTalk Taishi
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
            Codex          Claude Code        Gemini CLI
              │                 │                 │
         Implementer         Reviewer          Security
              └──────────── agent.send ──────────┘
```

Slack is the human interface, Koe directory, activity log, and approval
surface. Koe-to-Koe messages travel through Taishi's Gateway rather than Slack
events, keeping routing explicit and avoiding bot loops.

The first adapter uses Codex App Server over stdio. Slack connects through
Socket Mode, so the host Mac or Linux machine does not need a public HTTP
server.

## Core concepts

- **Taishi** is the single Slack App and local switchboard.
- A **Koe** is a persistent AI identity assigned to a Slack channel. Each Koe
  has an adapter, workspace, role, Slack persona, and permission policy.
- A **call name** is an optional human-friendly alias such as `実装係` or
  `レビュー係`; authorization continues to use the canonical Koe ID.
- An **Adapter** connects a Koe to Codex or another coding-agent backend.
- A **channel visit** is an explicit, permission-checked Koe-to-Koe request via
  `agent.send`. It is distinct from a Codex internal sub-agent.

Conversation mapping is configurable per Koe:

- `channel` maps an entire Slack channel to one durable backend thread.
- `slack_thread` maps each Slack root thread to a separate backend thread.

Koe-to-Koe reachability fails closed. A source Koe can consult only targets
listed in its `consultations`, and only within each relationship's configured
scope.

## Highlights

- Slack messages and replies streamed from durable Codex threads;
- channel-wide or Slack-thread-scoped conversation mapping;
- ordinary structured choices plus command, file-change, and exact Git-plan
  approvals in Block Kit;
- Status, Interrupt, and approver-only Gateway restart controls;
- multi-image and audio attachment ingress, plus permission-checked file
  delivery back to Slack;
- direct Koe-to-Koe routing with allowlists, hop limits, busy protection, and
  delayed-result continuation;
- per-Koe Slack display identity, call name, role, and Slack-only persona;
- a loopback-only management UI for mappings and runtime-editable model
  settings;
- `agent.list`, `agent.status`, `agent.send`, `slack.post`, and `slack.reply`
  through an authenticated local MCP server;
- atomic local state and restart/resume support without an external database;
- `taishi init`, `doctor`, `bind`, `start`, and macOS LaunchAgent lifecycle
  commands.

Codex is currently the only implemented adapter; the Gateway Core remains
adapter-neutral.

## Quick start

Prerequisites:

- macOS or Linux;
- Node.js 22 or newer;
- an installed and authenticated `codex` CLI;
- permission to create and install a Slack App.

Install this checkout and create a private local configuration:

```bash
git clone https://github.com/surugawan-ebi/showtalk-taishi.git
cd showtalk-taishi
npm ci
npm run build
npm link
taishi init
```

Create the Slack App from [`slack/manifest.yaml`](slack/manifest.yaml), enable
Socket Mode, create an app-level token with `connections:write`, install the
App, and invite it to each configured Koe channel. Keep all tokens outside
YAML and Git.

Set the environment variables referenced by `config.yaml`:

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

See [Configuration](docs/configuration.md) for the complete setup, conversation
mapping, existing-thread binding, management UI, identities, personas, and
consultation policies. The npm package is intentionally marked private during
this preview; install from a source checkout rather than `npm install -g`.

## Security boundaries

- Taishi is intended for a trusted, self-hosted workstation. It does not turn
  an untrusted local OS account into a safe multi-tenant environment.
- Slack uses Socket Mode; the management UI and per-Koe MCP endpoints bind to
  loopback only. Do not expose them through a proxy or port forward.
- Slack and Codex credentials stay in the local environment or owner-only
  files and are excluded from Git. Agent processes receive only explicitly
  configured environment passthrough values.
- Permission checks and human approvals apply to operations routed through the
  Gateway. They do not revoke capabilities independently granted to the coding
  agent, so keep the backend sandbox and approval policy restrictive. Exact Git
  approvals are bound to one operation, plan, Slack message, approver, and live
  turn. Before Codex resumes, the Gateway records the bound Slack decision
  through workspace-git's model-inaccessible private broker; the resumed turn
  can execute only after the exact operation is re-read as approved.

Exact Git approvals require the separately installed, operator-owned integration
described in [Optional workspace-git integration](docs/workspace-git-integration.md).
Basic Slack and Codex routing works without it.

Read the full [security model](docs/security.md) before connecting real
repositories or enabling Koe-to-Koe consultations. Report vulnerabilities
through the private process in [SECURITY.md](SECURITY.md).

## Documentation

- [Configuration](docs/configuration.md)
- [Operations and Slack behavior](docs/operations.md)
- [Gateway restart verification](docs/gateway-restart-verification.md)
- [Optional workspace-git integration](docs/workspace-git-integration.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Private vulnerability reporting](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Configuration example](examples/config.example.yaml)

## Development

Run the deterministic release checks:

```bash
npm run verify
```

Real-Codex smoke tests are opt-in and do not connect to Slack:

```bash
npm run smoke:codex-mcp
npm run smoke:codex-agent-send
npm run smoke:codex-resume
```

They exercise MCP discovery, two-process delegation, restart persistence, and
cross-client continuation on a durable Codex thread. A full real-Slack
acceptance checklist remains before the first v0.1 release.

## License

Licensed under the [Apache License 2.0](LICENSE).
