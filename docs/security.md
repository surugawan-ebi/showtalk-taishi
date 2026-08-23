# ShowTalk Taishi security model

Product UI and general documentation call each channel-owned conversation a
**Koe（声）**. This document retains **Agent** where it refers specifically to
the internal authenticated principal, configuration record, or API boundary.

## Trust boundary

ShowTalk Taishi is local-first software for a trusted developer workstation. It
assumes the operating-system account running Taishi, the configured local
workspaces, the installed Codex binary, and the selected Slack workspace are
under the operator's control. It is not a multi-tenant hosted control plane.

The main untrusted inputs are:

- Slack messages and interactive action payloads;
- model-generated MCP tool arguments;
- Codex App Server notifications and approval requests;
- `config.yaml` and previously persisted runtime state;
- local HTTP requests that reach the loopback MCP listener;
- local browser and HTTP requests that reach the optional management UI.

## Credential isolation

Slack app and bot tokens are read from environment references in the Gateway
configuration. Taishi removes:

- the exact configured Slack token values;
- environment names matching `SLACK_*TOKEN`;
- any previous `SHOWTALK_TAISHI_MCP_TOKEN` value

before spawning Codex App Server. Each configured Koe gets a separate child
process and a newly generated 256-bit MCP bearer token. The child receives only
its own token, so compromising one Koe identity does not grant another Koe's
permissions.

Taishi constructs a minimal child environment containing standard process
runtime variables, Codex/OpenAI authentication, proxy/CA settings, and locale.
Cloud, database, SCM, signing, and deployment credentials are denied unless the
operator deliberately names an additional variable in adapter
`env_passthrough`. Slack and Taishi MCP token names cannot be passed through by
that setting.

A Koe can necessarily access its own MCP credential because Codex must use it.
That credential authenticates only the Koe identity and does not contain
Slack credentials. The Permission Engine still evaluates every protected tool
operation.

## MCP boundary

The MCP Streamable HTTP server:

- binds only to IPv4 loopback `127.0.0.1`;
- selects an ephemeral port by default;
- requires exactly one valid bearer authorization header per request;
- derives caller identity from a SHA-256 token digest lookup;
- rejects unexpected Host headers, browser Origin headers, query strings,
  unsupported methods, invalid content types, and oversized bodies;
- creates request-local MCP server and transport instances so concurrent
  callers do not share mutable identity state;
- never accepts source Agent ID, hop depth, or causation ID as tool arguments.

MCP JSON-RPC request identity is combined with the authenticated Agent, tool,
canonical arguments, and the process-local active Gateway turn to deduplicate
retried side-effecting calls. JSON-RPC IDs are only client-local, so reconnects
and separate backend threads may reuse them with different arguments without
colliding. Outside a live Gateway-owned turn, an exact request-ID and argument
match may still be treated as a retry within the bounded cache. The cache is
process-local, so Taishi does not promise restart-spanning exactly-once
execution.

The per-Koe MCP server is injected into both new and resumed Codex threads as
a required server. Taishi does not write its bearer token to `config.yaml`, the
Codex thread configuration object, or runtime state; Codex resolves it through
the dedicated child-process environment variable.

## Local management boundary

The optional management UI binds to IPv4 loopback `127.0.0.1` at an
operator-selected port. Its host is not configurable, it sends no CORS headers,
and it rejects non-loopback peers and non-local Host headers. Every page load
receives a random process-local CSRF token; configuration saves and restart
requests require that token and reject cross-site browser requests. Responses
also use a nonce-bound Content Security Policy, frame denial, no-referrer, and
no-store headers.

Every `/api/*` request also requires either a trusted local Bearer capability or
a host-only browser session cookie. The stable 256-bit capability remains stored
beside runtime state in owner-only `admin-ui.token`; it is not placed in the
management URL or browser JavaScript storage. A normal loopback page load sets a
deterministically derived, long-lived cookie with `HttpOnly`, `SameSite=Strict`,
and `Path=/`. The derived value remains valid across Gateway restarts while the
underlying token is unchanged, and token rotation invalidates older cookies.
Because the listener uses plain loopback HTTP, the cookie intentionally omits
`Secure`; this UI must not be exposed through a proxy or non-loopback listener.
Cross-site writes still require the page-bound CSRF token and same-origin request
metadata, and SameSite prevents the browser session from accompanying cross-site
requests. Trusted local automation may continue to use the owner-only token as a
Bearer credential without affecting the browser flow.

This boundary follows the product's trusted-workstation model: a local browser
or process that can reach the loopback listener is trusted to open an
authenticated browser session. Another process running as the same OS user can
already read or edit the private configuration file and is not treated as a
separate tenant. The convenience-oriented browser flow is therefore not
suitable for shared hosts, port forwarding, reverse proxies, or remote
administration.

The authenticated browser receives only an allowlisted projection of existing Koe settings.
Slack tokens, approver configuration, adapter commands and environment
pass-through settings, global permissions, and runtime MCP bearer credentials
are omitted. Workspace paths, roles, Slack personas, presentation settings,
channel IDs, adapter session IDs, and consultation allowlists are visible
because they are the explicit operator-managed purpose of the screen.
When any editable value is backed by an environment reference, the projection
shows the raw `${NAME}` expression instead of the resolved value.

Writes carry a composite SHA-256 revision of `config.yaml` and the management
sidecar, reject stale updates, and validate the complete merged candidate
against the normal schema. The UI never writes `config.yaml`; it stores only
allowlisted Koe fields in owner-only `admin-config-overrides.v1.json` beside
runtime state. Each entry is bound to the hash of its raw canonical value.
Unrelated operator edits are preserved, while a same-field edit is an explicit
fail-closed conflict. The sidecar schema cannot address tokens, adapter
commands, permissions, or environment pass-through settings and never stores
resolved credential values. Sidecar updates use a same-directory synchronized
temporary file and atomic rename. Saving does not hot-patch the running
registry.
The separate restart action enters the existing Supervisor drain-and-replace
path after its HTTP response completes; it never sends a process signal.

## Slack boundary

Slack is the human interface and activity log, not the Koe-to-Koe transport.
`agent.send` delivers directly through the in-process Agent Router. Messages
projected to Slack cannot be re-ingested as instructions because Bolt ignores
self-authored messages and Taishi also rejects bot/subtype events.

The bundled manifest requests joined-public-channel history/read access,
message write access, `chat:write.customize`, and `files:read`/`files:write`.
The customization scope lets Taishi select the configured display name and
icon for messages it authors; it does not grant permission to post as an
arbitrary Slack user. Presentation values come only from operator-controlled
configuration, never from model output or Slack message text. The bot should
be invited only to configured Koe channels. Private channels, DMs, and
unrestricted workspace reads are not enabled by the v0.1 manifest.

The optional `agents.<id>.slack.persona` is likewise trusted operator
configuration and must never be sourced from Slack message text or model
output. The Codex adapter applies it as per-turn application context to turns
admitted by ShowTalk, but not to turns started directly in Codex App. A persona
does not alter the Permission Engine, grant tools, or add targets to
`consultations`; those authorization checks remain independent. It also does
not create a new conversation: the configured Slack channel remains bound to
the same persistent backend thread.

Configured icon URLs must use HTTPS and are fetched by Slack, so operators
should use a public image URL that contains no credentials or secret query
parameters. Taishi does not upload or expose a local icon file implicitly.
Changing a presentation changes only future Slack message rendering and cannot
replace the Koe's canonical Codex thread or session binding.

`adapter_session_id` is an operator-controlled canonical-session declaration.
At startup it is validated by the configured adapter before Slack begins
receiving messages. It can repoint existing Slack reply locations for that Koe,
but old session records and backend history are retained. Session IDs received
from Slack messages or model output are never used as configuration.

Inbound attachment handling never gives the Slack bot token or a private Slack
URL to a Koe. Taishi re-fetches each file by ID, permits only HTTPS downloads
from `files.slack.com`, denies redirects, applies time/count/per-file/total-size
limits, validates the declared MIME against file magic, and writes files and
spool directories with owner-only permissions. A serialized per-Koe 1 GiB
spool quota bounds persistent disk use. Unsupported formats are not downloaded.

Koe-originated uploads accept only relative paths beneath that Koe's
configured workspace. Every symbolic-link component is rejected; the canonical
file and each parent directory are checked again around descriptor-based reads,
and immutable bytes are captured before Slack upload. Only regular supported
image or audio files are allowed. A process-wide byte lease bounds concurrent
captures until Slack finishes or compensates the upload. Uploads occur only
after Slack write policy allows them. Model text is never scanned for paths to
upload implicitly.

Interactive payloads are parsed with strict action prefixes, key sets, size
limits, channel binding, and request IDs. Only configured approver Slack user
IDs may:

- approve or reject Codex command/file requests;
- approve Permission Engine requests;
- interrupt a turn.

Socket Mode actions arrive through Bolt's authenticated WebSocket envelope;
there is no public HTTP action endpoint in the default deployment. After that
transport check, Git-plan callbacks must also match the expected Slack app/team
shape, configured approver, channel, root thread, and Block message timestamp.
The action value contains no operation ID, plan hash, repository, path, HEAD,
or worktree data—only a random process-local request ID and routing metadata.

For workspace-git publication, Draft PR, Ready, and merge approvals, Taishi
accepts only one host-observed `awaiting_human_approval` prepare result in the
same Codex thread and turn. If the structured request is observed before the
matching prepare completion notification, Taishi keeps the RPC pending for at
most two seconds and binds it only when that same thread and turn plan arrives.
A timeout, turn completion, or different-turn plan is rejected. Taishi copies
only bounded public fields: full operation
ID/hash, repository, branch, mode/action, exact repo-relative paths, expected
HEAD/snapshot, opaque worktree ID, commit message, push target, Draft PR
title/body/base, PR metadata, merge method, and authoritative expiry. Control
characters and bidirectional overrides are escaped visibly. Draft PR plans
without an explicit base branch are not offered in Slack because Taishi cannot
inspect workspace-git's private default.
Absolute/traversal paths, malformed fields, multiple plans, unsupported
choices, and plans too large to display exactly are rejected. The immutable
binding lives only while the originating App Server RPC is live, including its
bounded same-turn binding grace period.

The Slack choice is returned to that same `item/tool/requestUserInput` RPC.
Taishi does not expose a second text parser and does not treat messages such as
`承認` as authorization. The existing workspace-git private approval state
remains authoritative: after the structured answer, Codex must re-read status,
record the exact approval, verify the approved state, and call the matching
`execute_approved_*` tool once. workspace-git performs its own hash, expiry,
snapshot/worktree or PR HEAD/state revalidation before any external write.
The authenticated structured answer is a human interaction boundary inside
the resumed App Server turn. It is not assistant self-approval, and an accepted
exact plan must not be deferred merely because prepare and execute appear in
the same App Server turn. A rejection or failed revalidation never reaches the
execute boundary.

If the Codex turn ends after the bound approval but before the exact execute
tool is observed, the Adapter reconciles the complete final turn item snapshot.
It starts at most one continuation turn only when no execute attempt and no
terminal workspace-git status is present. It does not create a new approval,
change scope, or select another operation. Missing execution after that bounded
continuation, incomplete final items, and failed or unfinished execute calls are
reported as errors and are not retried. Already rejected, executing, applied,
partial, failed, outcome-uncertain, or expired operations are terminal and are
not replayed.

This means v0.1 still trusts the resumed Codex turn to coordinate the private
approval-record step. Taishi does not possess a model-isolated workspace-git
decision broker. Operators whose threat model includes a malicious model
should approve through Codex App until a dedicated authenticated broker can
atomically bind the Slack decision to workspace-git's operation ID and plan
hash without model mediation.

Ordinary structured questions are classified only after the bounded
same-turn Git-plan race window. They use a separate Slack action namespace and
carry only opaque request-local question/option IDs plus message routing.
Model-provided labels and prompts are displayed but never placed in action
values. A direct Slack question is answerable only by the user who started the
turn; a Koe-to-Koe question without a source user falls back to configured
operators. Secret questions are not projected. Free text is accepted only
when the App Server question explicitly allows `Other`, is length bounded,
and is returned as an answer—not as approval authority.

Status inspection is available to members who can see the Koe channel.

## Permission Engine

Policy has three outcomes:

- `allow`: perform the operation immediately;
- `deny`: fail without side effects;
- `approval`: post a single-use Slack approval and wait.

Slack write policy is evaluated against `own_channel`, `agent_channels`, or
`other_channels`. Koe routing is evaluated per source Koe and target. A routing
pair exists only when `agents.<source>.consultations.<target>.scope` registers
the target and states the operator-approved consultation purpose. The
Permission Engine denies an unknown or unregistered target even if
`permissions.defaults.agents.send` is `allow`; that default applies only after
the source-target allowlist gate. Missing policy leaves fail closed.

Koe availability is not an authorization signal. Callers must not select an
unconfigured target because it appears idle in `agent.list` or `agent.status`,
and the request must remain within the configured consultation `scope`.

"Allow session" grants are held only in the current Taishi process and are
scoped with host-generated keys such as the source/target Koe pair or the
source/target Slack channel pair. They never rewrite configuration and are
cleared at shutdown. Gateway restart is excluded and requires a fresh
single-use approval every time.

## Concurrency and delegation safety

The Router's delegation terminology describes a cross-Koe routing operation,
not Codex internal sub-agent delegation. `agent.send` enters another persistent
Koe and is projected as a visible Slack channel visit; it cannot satisfy a
repository rule requiring backend-local internal sub-agents.

The Router owns delegation IDs, parent causation, and depth. Nested tool calls
derive their context from active routing state; models cannot reset the hop
counter. Self-routing is denied unless a Koe definition explicitly opts
in, and a busy target rejects a second delegated turn.

MCP authentication is Koe-scoped. Each Koe has one canonical backend
thread, and v0.1 runs at most one active turn for that identity. Rapid human
Slack inputs wait in FIFO order. Direct routing to a busy Koe fails fast;
queuing nested Koe-to-Koe work could deadlock a routing cycle.

If a routed result outlives its originating Slack turn, only the trusted
process-local lease and exact active-turn coordinates may trigger delivery back
to that Slack thread. Taishi queues a host-owned continuation on the source
Koe's canonical session; models cannot supply or redirect that return route.
The continuation is covered by the originating MCP request's idempotency entry.
Accepted delegation-result IDs and used delayed-continuation IDs are additionally
stored in `state.json`. This provides restart-spanning replay rejection for the
Koe-result delivery path even though general MCP request idempotency remains
process-local. Acceptance is at-most-once: after the durable record is written,
an adapter failure or crash does not make that same result replayable.
Cancellation before `delegation.started` aborts admission. After that event,
loss of the source MCP transport detaches the caller but does not interrupt the
accepted target turn; an uncontrolled Gateway shutdown still interrupts it.

Before starting a turn, the Codex adapter reads the persisted thread status. If
another Codex client has an active turn, Taishi waits up to 30 minutes without
starting or interrupting it. Ambiguous cleanup only interrupts a turn ID
observed from Taishi's own start; otherwise the isolated App Server process is
closed rather than touching a possibly external turn.

## State and restart behavior

Gateway restart is an approver-only lifecycle operation. Koe-triggered
restart requests always pass through a single-use Slack approval; Koe cannot
provide the approver identity or bypass the parent Supervisor with a supported
tool. The Worker drains accepted work, flushes state, and releases the exclusive
lock before its parent starts a replacement. Draining closes admission before
the idle check and waits until accepted MCP HTTP responses and Slack handlers
have completed. Duplicate restart requests are
coalesced, and unexpected Worker exits are not placed in an automatic crash
loop.

The state file contains Agent definitions, local workspace paths, canonical
session IDs, backend thread IDs, statuses, and Slack reply-location mappings. It does not
store Slack tokens, MCP bearer tokens, Slack message text, or model response
text. The file, randomized temporary replacement, and process lock are created
with owner-only modes. Writes are serialized and atomically renamed. Taishi
holds an exclusive adjacent lock for the runtime lifetime and rejects a second
live process that targets the same state file; a dead-PID lock can be recovered.

Pending approvals, structured Git choices, and ordinary structured questions
are bound to live RPC/tool requests and remain in memory. They are single-use,
expire, and resolve to denial, rejection, or cancellation during shutdown.
After a restart, stale `starting`, `running`, `waiting_for_approval`, and
`waiting_for_input` statuses become
`interrupted`; the persistent Codex thread can then be resumed by the next
message.

## Operational guidance

- Keep `config.yaml`, `.env`, runtime state, and logs out of version control.
- The macOS LaunchAgent plist stores only paths and a non-secret `PATH`; tokens
  remain in a mode-0600 `.env` file. Installation rejects config or environment
  files readable by group or other users.
- Run either the LaunchAgent or a foreground `taishi start`, not both. The state
  lock prevents concurrent runtimes from sharing a persistent state file.
- Use least-privilege Slack channels and approver lists.
- Prefer `workspace-write` or `read-only`; use `danger-full-access` only when the
  operator accepts Codex's broader local impact.
- Review role prompts and Permission Engine overrides before enabling
  Koe-to-Koe routing.
- Treat anyone with access to the same local OS account as inside the local
  trust boundary.
- Do not expose the MCP listener through a reverse proxy or port forward.

Report security issues through the private process in the repository's
[`SECURITY.md`](../SECURITY.md). Do not include sensitive details in a public issue.
