# ShowTalk Taishi architecture

## Status and scope

This document defines the implemented architecture for the first runnable
milestone. The project is pre-release, so configuration and wire schemas may
still evolve before v0.1.

Three product constraints are fixed:

1. Slack is the primary human front end for local coding agents.
2. Codex App Server is the first backend, but Gateway Core is adapter-neutral.
3. Koe can talk across channels without using Slack as their transport.

## System boundary

```text
┌──────────────────────────── Slack workspace ────────────────────────────┐
│ Human messages · Koe activity · approval blocks · interrupts           │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ Socket Mode
                                ▼
┌──────────────────────── ShowTalk Taishi ────────────────────────────────┐
│                                                                        │
│  Slack ingress ──► Gateway Core ──► Session registry ──► AgentAdapter  │
│                         │                    │                   │       │
│                         ▼                    ▼                   ▼       │
│                 Permission engine      Runtime state      CodexAdapter │
│                         │                                    │ stdio    │
│                         ▼                                    ▼          │
│              loopback MCP server                     Codex App Server   │
│                         │                                               │
│                         └──────────── Agent Router ─────────────────────┤
└────────────────────────────────────────────────────────────────────────┘
```

Slack is outside the trusted execution boundary. Every event is validated and
normalized before it enters Gateway Core. Every Koe-requested side effect is
checked by the permission engine before a Slack API call or adapter approval is
performed.

## Identity and conversation model

### Koe identity

One configured Slack channel maps to one persistent Koe identity. An identity
owns:

- a stable name such as `implementer` or `reviewer`;
- an adapter selection;
- a local workspace reference;
- a default role prompt;
- a Slack channel ID;
- a conversation scope (`channel` or `slack_thread`);
- an optional short human-facing call name;
- an optional trusted-operator persona for ShowTalk-originated turns;
- an outbound consultation allowlist and scope for each permitted target Koe;
- effective permissions and adapter capabilities.

A channel is therefore an addressable service whose backend conversations are
mapped according to its configured scope.

Product terminology deliberately separates the layers: **Taishi** is the single
Slack App and local switchboard, while each channel-owned conversation is a
**Koe（声）**. Slack may render different Koe names and icons, but those messages
are still authored through the one Taishi App installation. Internal code,
configuration, and MCP tools retain the stable `Agent`/`agent.*` terminology.
An operator may add `agents.<id>.slack.call_name` as a conversational alias,
but the canonical Koe ID remains the identity used by configuration, state,
permissions, and causation records.
That internal API name must not be confused with a Codex internal sub-agent.
An internal sub-agent is a backend-local worker within one Koe's task, whereas
`agent.send` crosses into another persistent Koe and creates a Slack-visible
channel visit. The latter cannot fulfill orchestration rules that require an
internal sub-agent.

### Conversation identity

`agents.<id>.slack.conversation_scope` is a generic mapping mode:

- `channel` is the default and uses the Slack channel ID as the conversation
  key. The Koe owns one canonical session and backend thread for the channel;
  root timestamps are reply destinations rather than memory boundaries.
- `slack_thread` uses the Slack root timestamp as the conversation key. Replies
  under one root continue one session, while separate roots map to separate
  sessions and backend threads.

The durable mapping is therefore:

```text
Slack channel ID → Koe (internal Agent) → conversation key → core session → backend thread ID
```

A turn's Slack destination and conversation key are captured when the human
message arrives, so a later message cannot redirect output already in flight.
Separate roots in `slack_thread` mode do not automatically share conversation
memory. Direct `agent.send` traffic uses the target Koe's configured mapping;
a channel visit creates a target Slack root, which is also the target
conversation key in `slack_thread` mode.

This supports two reviewer patterns without hard-coding review behavior into
the mapping. An internal reviewer can use the product workspace with `channel`
scope for repository access and channel-wide continuity. An external or blind
reviewer can use a fixed reviewer-hub workspace with `slack_thread` scope; that
conversation receives only explicitly delegated information plus its fixed
role and project sources. Separate visit roots get separate backend threads.
The scope itself is not an access-control boundary: workspace contents,
configured sources, permissions, and delegation scope still determine access.
When an existing Koe changes from `channel` to `slack_thread`, runtime drops
both its canonical-primary selection and its old root/session mappings. The
backend sessions remain in state as unbound history, but old Slack roots start
fresh backend threads on their next message. This migration intentionally
prefers isolation over silently retaining a formerly shared context.

Changing an existing Koe's Slack channel keeps the Koe identity and backend
session records as unbound history but drops every reply-location and primary
binding from the old channel. The next message therefore creates a fresh Codex
thread unless the operator also declares the exact `adapter_session_id` to
preserve. For `slack_thread` scope each new Slack root creates a fresh backend
thread. A timestamp from one Slack channel is never reused as a reply location
in another.

Changing a Koe's configured workspace drops its primary and Slack-root bindings
before startup. Existing backend sessions remain as unbound history, while the
next message creates a thread in the new workspace. When the operator also
declares an `adapter_session_id`, that explicit thread becomes canonical instead
of creating a fresh one. This avoids silently mixing one product's transcript
into another workspace.

`agents.<id>.slack.persona` defines an optional per-turn configuration contract.
The Codex adapter includes it as application context only when ShowTalk admits
the turn. Turns started directly in Codex App bypass that adapter call and do
not receive the persona. It is not session identity: with `channel` scope both
origins may continue the channel's backend thread, while `slack_thread` scope
has no single channel-wide backend thread.

## Core components

### Slack ingress and projection

Slack ingress owns Socket Mode connectivity, event acknowledgement,
deduplication, Block Kit actions, and translation into core commands. It must
ignore messages authored by Taishi itself.

For a human `file_share` message, ingress extracts the ordered file IDs and
re-fetches metadata through Slack Web API. A dedicated file transport performs
authenticated, bounded downloads into an owner-only local spool. Slack private
URLs and credentials stop at this boundary. Images become adapter-neutral
attachments and the Codex adapter maps each one to a `localImage` turn input.
Audio is retained as a local attachment because normal Codex turns do not
currently expose an audio input item.

Slack projection translates normalized agent events into human-readable
messages, progress updates, and approval blocks. Projected Koe-to-Koe
activity is marked as output and is never re-ingested as a new instruction.
An active turn also drives a best-effort five-second heartbeat on the existing
activity message, even while no tool event is arriving. It shows elapsed time
and a rotating marker, is serialized with event-driven message updates, and is
cancelled before final projection so it cannot overwrite the completion state.

Structured Git approvals are a narrow bridge rather than a generic text
approval parser. The Codex adapter captures one `workspace-git` prepare result
from an `item/completed` notification, binds it to that thread and turn, and
accepts only the fixed two-choice `item/tool/requestUserInput` request that
follows it. Because App Server transport ordering may expose the request just
before the matching completion notification, the adapter can hold that RPC for
a bounded two-second grace period and re-evaluate it only when the exact same
thread and turn plan arrives. Slack receives the exact immutable plan for
display, while button
values carry only an opaque single-use request ID and trusted routing fields.
The callback is returned to the same App Server JSON-RPC ID. workspace-git,
not Slack or model prose, remains responsible for private approval state and
execution-time revalidation.

The current bridge therefore uses the resumed Codex turn as an approval
coordinator between the structured answer and workspace-git's private
prepare/approve/execute state machine. Taishi does not yet have a
model-isolated decision-broker API into workspace-git; adding one is a separate
cross-project hardening step, not something reconstructed from Slack payloads.

Each Koe may also define a Slack presentation (`display_name` plus either an
HTTPS `icon_url` or an `icon_emoji`). Runtime builds a presentation map keyed
by destination channel ID, so normal replies, approvals, delegation activity,
ephemeral controls, MCP-originated posts, and attachment posts all use the
identity configured for the channel receiving the message. The presentation
is attached when a Slack message is created; later `chat.update` calls only
replace its contents and therefore retain that identity.

Slack file posts use the external-upload sequence (`getUploadURLExternal`, byte
upload, then `completeUploadExternal`) so the same channel presentation can be
applied to the completed message. Presentation changes affect only Slack's
rendering and never create, replace, or rebind a backend thread.

The v0.1 Slack manifest intentionally covers joined public channels plus file
read/write for attachments and per-message identity customization. Private
channels and DMs remain opt-in future capabilities.

### Gateway Core

Gateway Core coordinates conversations without importing Slack Bolt, Codex
protocol types, or a model SDK. It works with normalized commands and events:

```ts
type GatewayCommand =
  | { type: "message.send"; agent: string; replyTarget: string; text: string }
  | { type: "turn.interrupt"; agent: string }
  | { type: "approval.resolve"; requestId: string; decision: string };
```

Concrete schemas may change during implementation; the architectural rule is
that transport-specific payloads stop at their boundary.

### Agent adapters

Each adapter translates the common lifecycle into one agent backend. The common
surface covers:

- create and resume a session;
- start a turn and stream normalized events;
- interrupt an active turn;
- answer approval requests;
- answer bounded structured choices;
- report status;
- advertise capabilities.

Capabilities are explicit because not every backend supports streaming,
approval, interruption, resume, or detailed tool events in the same way. Core
must degrade deliberately rather than pretending that all adapters are equal.

### Codex adapter

The v0.1 adapter starts Codex App Server using its stdio JSON-RPC transport. It
owns protocol initialization, request correlation, thread start and resume,
turn start and interrupt, event normalization, and replies to approval
requests. Taishi starts one App Server process per Koe, so each process sees
only that Koe's MCP credential. By default Taishi omits approval-policy,
approval-reviewer, and sandbox overrides, allowing Codex App Server and the
persistent thread to use the same settings as Codex App and CLI. An operator
can explicitly override any of those fields per adapter in `config.yaml`.
Human-reviewed requests are projected into Slack; eligible requests handled by
Codex auto-review do not require a duplicate Slack approval.

For workspace-git publication/Draft PR and PR Ready/merge, the adapter also
recognizes a single exact pending plan in the active turn and bridges the
matching structured choice to Slack. A request that arrives just before its
same-turn plan may remain pending only for the bounded binding grace period.
Pending plan mirrors, App Server RPC IDs,
and Slack action request IDs are process-local and are deliberately absent from
runtime state. A restart invalidates the card instead of reconstructing
authority from stale state.

Codex thread IDs remain adapter data. They are persisted by the session registry
but do not leak into generic Slack or MCP tool contracts.

For cross-client continuity, the adapter reads the thread stored for the mapped
conversation before every turn, waits while another client has an active turn,
and never interrupts a turn it did not observe as its own. The bounded wait
fails safely after 30 minutes. It unsubscribes after a turn and resumes that
conversation's ID before its next turn so completed work added from Codex App
can be incorporated. This is history shared within one mapping key, not live
App-to-Slack stream mirroring or automatic sharing across Slack roots.

### Session registry and runtime state

The session registry maintains the minimum durable state needed for recovery:

- adapter session and backend thread identifiers;
- one canonical session per channel-scoped Koe, or per Slack root for a
  Slack-thread-scoped Koe;
- Slack root timestamps used as reply-location history;
- the latest process-local status needed to report interruption and resume.

The state file is local, contains no OAuth tokens, and is updated atomically.
The state format is versioned so migrations or an explicit refusal can replace
silent corruption. Active turn IDs and pending approvals remain in memory
because they are meaningful only while their Codex RPC or MCP request is live.
On restart, volatile active statuses are persisted as `interrupted`.

#### Offline canonical binding

A channel-scoped Koe may declare `adapter_session_id` in configuration. On
startup, Taishi validates the declared backend session, selects it as canonical,
preserves any older session records, and repoints that Koe's remembered Slack
reply locations. For the Codex adapter this value is the Codex Thread ID. This
declarative path allows a supervised service restart to apply a binding without
editing the state file while a Slack turn owns its exclusive lock. If Slack
startup fails after the selection is staged, Taishi restores the state snapshot
from before that startup attempt.

The schema rejects `adapter_session_id` when `conversation_scope` is
`slack_thread`: separate Slack roots have separate backend threads, so there is
no single canonical backend session to declare or bind.

When no session is declared for a channel-scoped Koe, runtime state remains the
source of the canonical selection. The offline CLI remains available for
operators who prefer to keep that binding only in local runtime state.

An existing Codex thread can be adopted with:

```text
taishi bind --channel <Slack channel ID> --codex-thread <Codex thread ID> [--replace] [--config path]
```

This is an offline state operation for `channel` scope. Taishi must be stopped
because the state lock is exclusive. The command resolves the configured
channel and Koe, then validates the requested thread through Codex App Server
before mutating state.

Binding the current canonical thread again is idempotent. If the Koe already
has a different canonical thread, the command fails unless `--replace` is
present. Replacement retains prior session records and history, selects the
requested thread as canonical, and repoints that Koe's existing Slack
reply-location mappings. After `taishi start`, Codex App and Slack continue the
same persistent thread.

### Agent Router (Koe routing)

The configured agent directory indexes every canonical Koe ID and optional
`agents.<id>.slack.call_name`. At startup, both IDs and call names are compared
after Unicode NFKC normalization and lowercasing. They must be globally unique,
must not collide under the same comparison, and canonical IDs must satisfy the
bounded MCP identifier contract before runtime startup.

`agent.list` returns the optional `call_name` alongside each addressable
canonical ID. `agent.send` accepts either form, resolves it to the canonical ID,
and then requires that ID to be registered under
`agents.<source>.consultations.<target>.scope`. Name resolution never adds a
consultation or changes its scope. An unknown name, or a valid name whose Koe is
not configured in the source's consultations, fails closed. The configured
`scope` remains the operator-defined contract for that source-target
relationship. Target status and idleness are runtime availability signals, not
authorization and not a reason to select an otherwise unconfigured Koe.
Accepted requests are delivered directly to the session selected by the
target's conversation mapping. A `slack_thread` target gets a separate backend
thread for each separate channel-visit root; it receives the delegated payload
and fixed role/workspace sources, not automatic memory from another root. Slack
is notified for observability but does not carry the request.

```text
Implementer
    │ agent.send(target="レビュー係")
    ▼
Agent Router ── resolve to reviewer ──► Reviewer mapped adapter session
    │                              │
    └── Slack activity log ◄───────┘
```

Every accepted routed message gets an internal delegation ID, origin, parent
causation ID, and hop count. The router enforces a finite hop limit as a hard
bound on one causation chain, including accidental cycles between two review
prompts. It is not a guarantee that an open-ended review process will converge.
The controlling Koe must inspect each returned result, decide whether another
call is useful, and bound retries or review rounds. Host-owned routing state
derives nested depth; models cannot submit or reset causation fields.
`agent.send` is non-idempotent at the semantic task level, while Taishi
deduplicates transport retries with the host MCP request identity. A busy target
rejects concurrent independent work. v0.1 also permits only one active turn per
Koe identity so Agent-scoped MCP authentication cannot make the originating
conversation ambiguous.

### MCP server

The Gateway also exposes MCP tools to connected Koe. The stable internal tool
names retain their `agent.*` prefix:

- `agent.list`
- `agent.send`
- `agent.status`
- `slack.post`
- `slack.reply`

`agent.list` entries include the optional configured `call_name`; the value is
presentation and target-selection metadata, not an additional principal.

`slack.post` and `slack.reply` accept optional workspace-relative image/audio
attachments. Runtime resolution follows symlinks before checking containment,
accepts only regular supported media files, and applies the same count and size
limits used by ingress. Slack upload remains subject to the caller's existing
Slack write policy and any resulting human approval.

MCP is a Koe-facing control interface, not a shortcut around policy. Taishi
binds a Streamable HTTP server to `127.0.0.1` on an ephemeral port. Each Koe
gets a random bearer token and a request-local MCP server instance. Caller
identity comes only from the credential, never from tool input, and every
protected call passes through the Permission Engine.

The MCP URL is injected into both `thread/start` and `thread/resume` as a
required Codex server. Only the environment-variable name is included in
thread config; the bearer value remains in the isolated child environment.

### Permission engine

Policy decisions have three outcomes:

- `allow`: execute immediately;
- `deny`: reject with a structured reason;
- `approval`: create a pending request and wait for a human decision.

Slack OAuth scopes set the outer technical limit. Taishi policy narrows that
limit per agent, target, and operation. An adapter cannot expand either layer.
For `agent.send`, the source Koe's `consultations` entries form an additional
target allowlist. The Permission Engine denies a target absent from that list
before a send can proceed. `permissions.defaults.agents.send: allow` controls
the policy result only for allowlisted source-target pairs; it never grants
all-to-all Koe reachability.

Approval actions are single-use and bound to the requesting agent, session,
operation, and payload summary. Replayed, expired, or mismatched actions fail
closed. "Allow session" grants are process-local scoped grants and never update
`config.yaml`. High-impact lifecycle operations such as `gateway.restart` do
not offer or accept an "Allow session" grant.

## Primary flows

### Gateway worker restart

```text
Slack Restart control or Koe gateway.restart
  → require configured-human approval
  → pause new Slack and MCP work
  → wait for accepted MCP operations (including detached calls), active/queued Koe turns,
    and final Slack projection
  → stop Socket Mode, MCP, and Codex children
  → flush state and release the state lock
  → Worker exits with the reserved restart code
  → parent Supervisor starts a fresh Worker with the latest local code
```

The persistent Koe and Codex thread mappings live in state and survive the
Worker replacement. Restart does not create or reset a Koe session.

On macOS, `taishi service install` places the Supervisor behind a per-user
LaunchAgent. The generated plist contains absolute executable, config, and
private environment-file paths, but never copies environment values or Slack
tokens. `RunAtLoad` starts the Supervisor at login and `KeepAlive` restarts only
an unsuccessful top-level exit. Standard output and errors go to the user's
`~/Library/Logs/ShowTalkTaishi` directory. This process boundary keeps Slack
Socket Mode connected when the Codex desktop app is quit or restarted.

### Human message to Codex

```text
Slack event
  → acknowledge and deduplicate
  → capture this message's Slack reply destination
  → resolve the channel Koe and configured conversation key
  → wait in the Koe's FIFO human-input queue
  → acquire a process-local turn lease and record the exact Slack message origin
  → create or resume the adapter session mapped to that key
  → verify that no external client has an active turn
  → start Codex turn
  → normalize streamed events
  → update one activity message in the captured Slack reply destination
  → collapse that activity message to elapsed time on completion
  → post the final answer as a new source-user-mentioned reply
  → persist resumable state
```

`session.status` describes backend activity, not ownership. During a live
Gateway turn, `activeTurn` records either the exact Slack
`channelId/rootThreadTs/messageTs` or a Koe routing turn. Diagnostics classify
activity only when that record agrees with the process-local Koe turn lease.
Persisted `running` without a live lease is `external_or_unknown`; it is never
enough to conclude that another Slack thread is active. Restart normalization
removes stale ownership metadata.

### Koe-to-Koe channel visits

```text
Source Koe calls agent.send
  → identify caller
  → evaluate permission and hop limit
  → resolve target Koe
  → deliver through target adapter
  → stream result to source Koe
  → reopen source Koe if its original turn already ended
  → project an activity record to relevant Slack channels
```

The user-facing form of this flow is called a **channel visit**. The source
Koe posts the visit root in the target channel using the source channel's
configured presentation. The target Koe's streamed response uses the target
channel presentation in the same Slack thread. If the source call originated
from a live Slack turn, completion or failure is also posted back to that exact
source Slack thread using the source presentation. The source Koe receives
the response through MCP and produces its normal final answer there. When a
long target turn outlives the original source turn, Taishi compares the exact
process-local source lease and active-turn identity. If that exact turn is gone,
the Gateway injects one host-owned continuation into the source backend thread
mapped to the originating Slack root and projects it to that root. This
continuation uses the source Koe's FIFO queue, so a newer human message for the
same mapped conversation is never raced. Transport retries share the MCP
request's idempotency entry, while accepted delegation-result IDs are also
persisted in runtime state so restart or cache eviction cannot create a second
continuation. If the continuation fails, Slack receives the bounded target
result directly as a visible fallback. Replaying a result already accepted by
the source is instead a silent no-op.

A controlling Koe can therefore interpret a natural-language sequence such as
"ask 設計係, then pass the result to レビュー係" by issuing one call, consuming
its result, and issuing the next call. Delayed completion uses the same
host-owned continuation before the controlling Koe chooses the next step. This
is conversational orchestration inside the persistent Koe conversation, not
the future declarative Workflow Engine. The controlling Koe remains
responsible for explicit acceptance conditions and bounded retry/review counts.
The router reserves and consumes one continuation when its next delegation
starts; a second sibling send from that same delayed-result turn is rejected.
That consumption record and each accepted completed-result record survive a
Gateway restart. Duplicate delivery is rejected before the source adapter is
called, including when an earlier accepted delivery failed before its first
adapter event.

Only host-owned active-turn state supplies the source Slack destination. Models
cannot choose a stale or unrelated source thread. Nested Koe calls without a
direct Slack origin remain visible in their target channel and return through
the parent Koe result, without guessing a Slack destination.

Slack projections include correlation metadata but cannot trigger another
delegation merely by being observed as Slack messages.

### Approval

```text
Adapter or MCP tool requests a protected action
  → permission decision = approval
  → register an expiring in-memory pending request
  → post Block Kit controls in the originating Slack reply thread
  → human selects allow-once, allow-session, deny, or cancel
  → validate actor, request binding, status, and expiry
  → return the decision to the requesting boundary
```

Session-wide approval is an in-memory grant with explicit scope; it does not
survive a restart or silently rewrite `config.yaml`.

## Configuration and secrets

`config.yaml` declares adapters, agents, channel mappings, roles, and policy.
Environment references are resolved at startup. Missing required variables,
duplicate channel mappings, unknown adapter names, and unsupported capabilities
are startup errors.

An optional `agents.<id>.slack.persona` is trusted operator configuration, not a
new permission or routing policy. It does not modify the Permission Engine or
the source Koe's `consultations` allowlist. The adapter preserves that
separation when applying the persona to ShowTalk-originated turns.

Slack tokens and future provider credentials never belong in configuration or
runtime state. Logs redact environment values and agent content associated with
approval payloads where necessary.

### Local management UI

The optional management server is part of the replaceable Gateway Worker and
binds to `127.0.0.1` only. The configured port is not paired with a configurable
host, so configuration cannot accidentally expose the UI to a LAN interface.
It projects only existing Koe settings: channel and conversation mapping,
adapter session, workspace, role, Slack persona/presentation, and outbound
consultation allowlist. Slack and adapter credentials are never serialized into
the response. Editable YAML values backed by environment references are returned
as their `${NAME}` expressions, not as resolved values.

Configuration writes carry the SHA-256 revision read by the page. The server
rejects stale revisions, applies changes to the YAML document, validates the
entire environment-expanded schema, and atomically replaces the source file.
Unchanged environment-reference nodes remain untouched. Every API request
requires a stable random bearer stored in an owner-only file beside runtime
state. Mutations also require a random page-bound CSRF token, a loopback peer,
a localhost Host header, and a same-origin browser request.

Saving does not mutate a running registry. The separate restart action returns
`scheduled`, then asks the existing Supervisor boundary to drain and replace the
Worker. The replacement reloads the validated configuration through the normal
startup path.

## Release acceptance checklist

Two Codex-backed Koe can be configured on two Slack channels. Local contract
tests and real-Codex smoke tests cover App Server initialization, MCP discovery,
direct two-process `agent.send`, and restart/resume. Real Slack use is ongoing;
before a stable release, record one complete acceptance run covering:

1. `taishi doctor` validates Codex App Server JSON-RPC initialization, Slack bot
   authentication, channel mappings/membership, and writable local paths.
2. `taishi start` connects with Socket Mode and starts Codex App Server over
   stdio.
3. With `channel` scope, the first channel message creates one Codex thread and
   different Slack roots reuse it. With `slack_thread` scope, replies under one
   root reuse its thread and separate roots get separate backend thread IDs.
4. Restarting Taishi and opening a mapped thread from Codex App continue that
   backend thread ID without implying memory sharing with other Slack roots.
5. A command or file approval can be resolved from Slack.
6. `agent.send` asks the second Codex-backed Koe for a review without routing
   the request through Slack, while Slack receives activity projection.
7. Interrupt leaves the mapped session recoverable; no Slack reset action
   exists.
