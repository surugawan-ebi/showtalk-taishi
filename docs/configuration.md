# Configuration

ShowTalk Taishi keeps user configuration in `config.yaml` and resolves secrets
from environment variables. Start with
[`examples/config.example.yaml`](../examples/config.example.yaml); never commit
the generated local configuration, Slack tokens, runtime state, management
credentials, logs, or attachments.

## Initialize

```bash
npm ci
npm run build
npm link
taishi init
```

`taishi init` creates `config.yaml` with mode `0600` and refuses to overwrite an
existing file. Before validation, create and install the Slack App described in
the next section, invite it to every configured Koe channel, then edit the file
and export its referenced environment variables. Validate the installation:

```bash
taishi doctor
```

`doctor` checks workspaces, the state directory, Codex App Server
initialization, Slack authentication, channel existence and membership, and
archived state. Use `taishi doctor --offline` only when Slack network checks
must be skipped.

## Slack App

Create or update the App using [`slack/manifest.yaml`](../slack/manifest.yaml):

1. Enable Socket Mode.
2. Generate an app-level token with `connections:write`.
3. Install or reinstall the App in the workspace.
4. Invite it to every configured Koe channel.
5. Put the App and bot tokens in environment variables.

The bundled manifest enables Block Kit interactivity without a public Request
URL. Applying new scopes to an existing App may require reauthorization.
Configured human approvers belong in `slack.approver_user_ids` or its
environment-backed value.

### Trusted bot message ingress

Slack `bot_message` events are rejected by default. To accept requests from a
specific installed bot, add its authenticated Slack identity tuple to the
optional allowlist:

```yaml
slack:
  trusted_bot_message_sources:
    - workspace_id: "${SLACK_TRUSTED_BOT_WORKSPACE_ID}"
      user_id: "${SLACK_TRUSTED_BOT_USER_ID}"
      bot_id: "${SLACK_TRUSTED_BOT_ID}"
      external_action_responder_user_id: "${SLACK_TRUSTED_BOT_EXTERNAL_ACTION_RESPONDER_USER_ID}"
```

All three values must match: the workspace comes from the trusted Slack event
envelope, while `user_id` and `bot_id` come from the Slack message event. Text,
display names, profiles, attribution footers, and mentions never establish this
trust. Entries apply only to ordinary request ingestion in already configured
Koe channels. They do not add an approver, authorize approval/rejection text,
or weaken button and permission identity checks. Edited, deleted, hidden, and
nested message events remain rejected. Duplicate tuples and more than 32
entries are rejected during configuration loading.

`external_action_responder_user_id` is optional for request ingestion, but is
required before a trusted bot request may display a non-Git external-action
confirmation. It identifies the one human who may answer that card and must be
a distinct member of `slack.approver_user_ids`. The bot remains the audited
request origin and never becomes an approver. Missing, same-as-bot, or
non-approver mappings fail closed; ShowTalk does not fall back to another
approver or infer a human from message text or display names. This mapping does
not affect Git, native permission, or ordinary-choice cards.

If this setting is omitted or `[]`, all bot messages retain the previous
fail-closed behavior. Existing verified ChatGPT connector attribution handling
continues independently. Older dot notification classification that depended
on a source-code user ID has no implicit fallback; migrate the installed dot
bot by adding its workspace/user/bot tuple only to the private machine-local
configuration. Restart is required after changing this startup setting.

### Work-attention notification channel

To feed an existing Slack `message` event integration, configure one channel:

```yaml
slack:
  work_attention_channel_id: "${SLACK_WORK_ATTENTION_CHANNEL_ID}"
```

The referenced environment variable contains the existing channel ID. Invite
the existing ShowTalk bot to that channel. This uses the App's existing
`chat:write` capability; it adds no webhook, API token, OAuth scope, destination
credential, or approval authority. If the setting is omitted, the monitor emits
only its local machine-readable audit event.


## Conversation mapping

`agents.<id>.slack.conversation_scope` controls backend-thread mapping:

- `channel` is the default. The entire Slack channel shares one durable
  backend thread; Slack root threads are reply destinations, not memory
  boundaries.
- `slack_thread` creates or resumes a distinct backend thread for each Slack
  root. Separate roots do not automatically share conversation memory.

This is a generic mapping choice, not an internal/external review feature. For
example, a reviewer using a product workspace with `channel` scope can retain
product context, while a reviewer-hub workspace with `slack_thread` scope can
isolate each delegated review. Isolation still depends on the configured
workspace and the information sent to the Koe.

```yaml
agents:
  internal_reviewer:
    adapter: codex
    workspace:
      path: "${PRODUCT_WORKSPACE}"
    slack:
      channel_id: "${SLACK_CHANNEL_INTERNAL_REVIEWER}"
      conversation_scope: channel

  blind_reviewer:
    adapter: codex
    workspace:
      path: "${REVIEWER_HUB_WORKSPACE}"
    slack:
      channel_id: "${SLACK_CHANNEL_BLIND_REVIEWER}"
      conversation_scope: slack_thread
```

Changing an existing Koe from `channel` to `slack_thread` removes its previous
Slack-root mappings at the next startup. Existing backend history is retained
but is no longer reused as a shared root.

## Bind an existing Codex thread

A channel-scoped Koe can declare one canonical backend session:

```yaml
agents:
  implementer:
    adapter: codex
    adapter_session_id: "019f0000-0000-7000-8000-000000000000"
    slack:
      channel_id: "${SLACK_CHANNEL_IMPLEMENTER}"
      conversation_scope: channel
```

For the Codex adapter, `adapter_session_id` is the Codex Thread ID. It is
normally used with `conversation_scope: channel`; it remains a legacy
channel-wide declaration and is invalid with `conversation_scope: slack_thread`,
which has no single canonical thread.

If the declared Codex thread has been deleted, the first message does not stop
the Gateway. Taishi creates a new Codex thread for that Slack root and keeps
the Koe in `slack_thread` mode from then on. Existing Slack-root mappings in
that mode are strict: if a mapped Codex thread has been deleted, Taishi posts
an error and does not silently create a replacement. A missing configured
workspace is also reported when that Koe is first used; it does not prevent
Gateway startup.

With Taishi stopped, the equivalent offline operation is:

```text
taishi bind --channel <Slack channel ID> --codex-thread <Codex thread ID> [--replace] [--config path]
```

The command validates the thread through App Server. Rebinding the same ID is
idempotent; replacing another canonical binding requires `--replace` and does
not delete the old backend history.

## Call names and Slack identity

An optional call name lets people refer to a Koe naturally while preserving
the canonical ID as the authorization identity:

```yaml
agents:
  implementer:
    slack:
      channel_id: C0123456789
      call_name: "実装係"
      display_name: "Implementer Koe"
      icon_emoji: ":hammer_and_wrench:"

  reviewer:
    slack:
      channel_id: C9876543210
      call_name: "レビュー係"
      display_name: "Reviewer Koe"
      icon_url: "https://example.com/taishi-reviewer.png"
```

Call names and canonical IDs must be globally unique after normalization. A
call name selects an existing Koe; it never grants access. Configure either
`icon_emoji` or an externally reachable HTTPS `icon_url`, not both. Local file
paths cannot be Slack message icons.

## Slack-only persona

`agents.<id>.slack.persona` adds trusted application context only to turns
started through ShowTalk:

```yaml
agents:
  reviewer:
    slack:
      channel_id: C9876543210
      persona: |
        Lead with concrete findings.
        Separate blocking defects from optional improvements.
```

Direct Codex App turns do not receive this persona. Persona does not grant
tools, consultations, Slack access, or other permissions. Slack conversation
and responses still remain in the durable backend thread selected by the
conversation mapping.

## Koe consultations

Every outbound relationship must be explicitly configured on the source Koe:

```yaml
agents:
  implementer:
    consultations:
      reviewer:
        scope: "Review implementation changes and report concrete findings."

permissions:
  defaults:
    agents:
      send: allow
```

The consultation key is the canonical target ID. `agent.send` accepts that ID
or its configured call name, resolves it back to the canonical ID, and checks
the relationship and scope. An available or idle Koe that is not listed remains
unreachable.

## Claude Code adapter

A Koe can be backed by Claude Code instead of Codex through
`@anthropic-ai/claude-agent-sdk`. Declare an adapter with
`type: claude-code` and point any Koe at it. Codex and Claude Koe can run side
by side in one Gateway.

```yaml
adapters:
  codex:
    type: codex-app-server
    command: "${CODEX_COMMAND}"
    transport: stdio
  claude:
    type: claude-code
    # Optional. Omit to use the binary bundled with the SDK.
    # command: "/opt/claude/bin/claude"
    model: sonnet
    reasoning_effort: medium
    permission_mode: default
    allowed_tools:
      - "Read"
      - "Bash(npm test:*)"
    approval_timeout_minutes: 30

agents:
  implementer:
    adapter: codex
    workspace:
      path: "${IMPLEMENTER_WORKSPACE}"
    slack:
      channel_id: "${SLACK_CHANNEL_IMPLEMENTER}"
    role: "Implementation Koe."

  claude_reviewer:
    adapter: claude
    workspace:
      path: "${REVIEWER_WORKSPACE}"
    slack:
      channel_id: "${SLACK_CHANNEL_CLAUDE_REVIEWER}"
    role: "Review Koe backed by Claude Code."
```

| Field | Meaning |
| --- | --- |
| `command` | Optional explicit `claude` executable. Defaults to the SDK-bundled binary. |
| `model` | Optional model ID or alias (`default`, `opus`, `sonnet`, `haiku`). |
| `reasoning_effort` | Optional `low`, `medium`, `high`, `xhigh`, or `max`. |
| `permission_mode` | `default` (default), `acceptEdits`, or `plan`. `bypassPermissions` is deliberately not accepted. |
| `allowed_tools` | Claude permission rules that skip Slack approval, such as `Read` or `Bash(npm test:*)`. |
| `setting_sources` | Subset of `user`, `project`, `local`. Defaults to all three, so `CLAUDE.md` and the operator's Claude settings apply. |
| `max_turns` | Optional per-turn limit on agentic turns. |
| `approval_timeout_minutes` | How long a Slack approval card waits. Defaults to 30. |
| `env_passthrough` | Extra environment variable names for the child process. |

Authentication reuses the host. The child receives a filtered environment that
includes `HOME`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, and
`CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`, so an existing
`claude login` works. Slack tokens never reach it. `taishi doctor` checks that
the Agent SDK loads, that an explicit `command` runs, and that any configured
Claude session exists. `npm run smoke:claude-mcp` runs a real Claude turn
through the Gateway and its MCP endpoint without connecting to Slack.

Behavior notes:

- Each Slack turn is one Agent SDK query that resumes the persistent Claude
  session (a UUID). Sessions survive a Gateway restart.
  `adapter_session_id` may name an existing Claude session UUID, for
  `conversation_scope: channel` only. `taishi bind` is Codex-only.
- Tool permission prompts appear as Slack approval cards: Allow once, Allow
  session, Deny, Cancel. Allow session adds a session-scoped rule and is never
  written to Claude settings. Text approvals work as for Codex.
- The Gateway MCP tools are mounted as the `showtalk_taishi` MCP server.
- Images are passed as native image input; audio arrives as a local path
  notice. The `AskUserQuestion` tool is disabled, so questions appear in the
  reply text. Structured choices and the workspace-git exact-plan flow are
  Codex-only for now.
- Interrupt and Status work. The Management UI model list shows the aliases
  `default`, `opus`, `sonnet`, and `haiku`.

## Management UI

When `gateway.admin_ui.enabled` is true, open the configured loopback address,
for example `http://127.0.0.1:4781/`, on the host running Taishi.

The page establishes a long-lived HttpOnly, SameSite=Strict browser session
from the owner-only `admin-ui.token` stored beside `state.json`. Reloads, new
tabs, and Gateway restarts do not require copying the token. Bearer auth remains
available for trusted local automation, but the browser does not read the raw
capability.

The UI edits existing Koe entries and never returns Slack tokens or adapter
credentials. Environment-backed fields are displayed as `${NAME}`. Model and
reasoning-effort choices are obtained from each Koe's live Codex App Server;
they are not a hard-coded catalog. Those two settings apply to the Koe's next
turn without a Gateway restart. Process, Slack routing, workspace, identity,
persona, role, and permission changes currently require **Gatewayを再起動**.

The former `automatic_choice_mode` field is accepted only so existing
configuration can still be loaded. The runtime ignores it and always uses
manual choices and approvals.

The UI never rewrites `config.yaml`. Its allowlisted Koe changes are stored in
the owner-only
`admin-config-overrides.v1.json` beside the configured runtime state file and
merged on startup. Each override is bound to a hash of the corresponding raw
`config.yaml` value. An operator edit to a different setting is adopted, while
an operator and the UI editing the same setting produces an explicit conflict
instead of silently choosing one. The sidecar is machine-managed; stop Taishi
and remove it to return completely to the values in `config.yaml`.

The listener is hard-bound to `127.0.0.1`; it has no LAN exposure setting.

The built-in workspace-git flow is manual. Automation-provider and
autonomy-control compositions are rejected by the production Gateway worker.
The former per-Koe `workspace_git_autonomy` field is accepted only for
backward-compatible configuration loading and never authorizes execution.
The version-1 human-only broker remains a separate manual-approval transport;
it does not enable autonomous execution. Set
`SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE` and `WORKSPACE_GIT_STATE_ROOT` only
when a compatible external operator integration is installed. No signing key,
MAC key, private socket, profile, or automation setting is used by this path.
See [Optional workspace-git integration](workspace-git-integration.md) for the
exact contract, metadata checks, and fail-closed behavior.

## Local files

`config.yaml` is operator-owned configuration and is read-only to the
management UI. Its owner-only dynamic override sidecar, runtime mappings, and
durable delegation replay guards are stored beside the configured state file,
normally under `~/.showtalk-taishi/`. Incoming files are stored under
`gateway.attachment_dir`, or beside the state file when omitted. These paths
must remain private and outside Git. Interactive permission and structured Git
approval requests are process-local rather than persisted in that file.
