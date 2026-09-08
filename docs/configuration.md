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
`SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE` to the absolute built
`workspace-git-mcp/manual` entrypoint and `WORKSPACE_GIT_STATE_ROOT` to the
private workspace-git state directory. No signing key, MAC key, private socket,
profile, or automation setting is used by this path.

## Local files

`config.yaml` is operator-owned configuration and is read-only to the
management UI. Its owner-only dynamic override sidecar, runtime mappings, and
durable delegation replay guards are stored beside the configured state file,
normally under `~/.showtalk-taishi/`. Incoming files are stored under
`gateway.attachment_dir`, or beside the state file when omitted. These paths
must remain private and outside Git. Interactive permission and structured Git
approval requests are process-local rather than persisted in that file.
