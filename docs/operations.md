# Operations and Slack behavior

## Slack turns

Post in a configured Koe channel. With `channel` scope, roots and replies
continue the same backend thread. With `slack_thread` scope, replies under one
root stay together and another root uses a different backend thread.

Rapid human messages are queued FIFO per Koe. Each turn replies under the Slack
message that triggered it. One activity message is updated in place with a
progress marker and elapsed time at most every thirty seconds. At completion it collapses
to the thinking duration, and the final answer is posted separately with a
fresh mention of the source user.

Every root receives Status and Interrupt controls. Interrupt and Gateway
restart actions are restricted to configured approvers. There is intentionally
no control that deletes or resets a mapped backend thread.

## Approvals

Command and file-change requests stay in the Slack thread that started the
turn. A protected request can offer Allow once, Allow session, Deny, or Cancel
according to the adapter capability and policy.

Git publication approvals are stricter. The Koe that called the matching
workspace-git plan-producing operation (`prepare_*` or
`update_repository_main`) must immediately issue structured choices
under question ID `git_approval`, named exactly `承認して実行` and `拒否・保留`,
in that same turn. Taishi binds one
immutable plan to the originating Koe, Slack channel, root thread, Block
message, approver, expiry, operation ID, and full plan hash.

The fixed labels are reserved. A non-Git external write that needs a human
confirmation must instead use question ID `external_action_approval`. Slack
renames its buttons and prominently states that the response does not approve
workspace-git or change Git approval state. Any other question ID that uses a
reserved label fails closed after the plan-binding grace period.

Ordinary workflow decisions remain flexible and may use two or three
task-specific choices. Selecting a choice does not itself authorize an external
write; if the selected path needs one, Codex follows it with exactly one
`external_action_approval` question whose wire options are, in order,
`承認して実行` and `拒否・保留`. Target, scope, and impact belong in the question
as three non-empty `Target:`, `Scope:`, and `Impact:` lines; both option
descriptions are also required. Taishi replaces the model-provided header with
an explicit non-Git confirmation header and never puts those details in renamed
authority-bearing labels. The final confirmation must be blocking; a
non-blocking request or `answers: {}` never authorizes the operation. On the first
malformed external-action request in a turn, Taishi returns a bounded repair
instruction to App Server without projecting an error to Slack. A corrected
request may be retried once; a second malformed request is rejected visibly.
The interaction audit records only a fixed rejection classifier (blocking,
question shape, option shape, descriptions, details, or another invalid field),
never the question, option text, answer, or raw routing identifiers.
After that bounded retry is exhausted, further external-action confirmations
in the same turn are refused and cannot produce an approval answer.
Requests that already carry a reserved approval label still wait through the
short Git plan-binding grace, even with the external-action ID, so notification
ordering cannot downgrade a late exact Git plan into a non-Git confirmation.

The sanitized interaction audit traces the prepare side of this boundary as
well as the structured-input side. `workspace_git.plan_notification_received`
records whether a plan-producing completion was seen for the active turn, a
different turn, or an unrecognized MCP server spelling.
`workspace_git.plan_registered` confirms that one normalized plan reached the
same-turn lifecycle registry. `workspace_git.plan_binding_failed` classifies a
request as `plan_not_received`, `plan_received_different_turn`,
`plan_expired_before_binding`, or `plan_capture_invalid`. These records contain
only hashed routing references and fixed classifiers; they never contain the
operation ID, plan hash, plan payload, prompt, or answer.

A complex turn may request multiple external writes sequentially. Each write
must receive a fresh blocking `external_action_approval` with its current
Target, Scope, and Impact after the previous confirmation has resolved. Only one
confirmation may be pending at once, and no approval carries forward as blanket
authority for later writes.

Store release operations no longer use an AppOps proof or MCP execute path.
When Codex needs to run a repo-local fastlane lane for App Store Connect or
Google Play, it must present a normal blocking `external_action_approval` with
the exact target app, platform, working directory, command, version/build, track,
metadata scope, and automatic-release setting. Taishi records only the approval
answer for that displayed command; it does not mint Store-specific proofs,
rewrite tool arguments, call Store MCP tools, or inspect Store credentials.
After approval, Codex runs only the displayed fastlane command in the target app
repository. Operators must supply credentials and release configuration outside
the repository.

The retired AppOps hook installer and live proof smoke are no longer public
commands. The standard runtime does not configure an AppOps signer or broker;
retained AppOps source and tests cover legacy fail-closed compatibility only.
Operators who previously activated the old hook must inspect their private
Codex configuration and remove only the generated ShowTalk AppOps hook/trust
entry. Taishi does not modify user configuration automatically.

If `request_user_input` returns `answers: {}`, the gated action remains blocked.
A bare empty answer establishes only that the model received no answer. It is
not evidence that Slack controls were absent or broken. Diagnosis must keep
card display (`choice.controls_attached`), expiry (`choice.expired`), approval
or rejection (`choice.answer_recorded`), Slack action failure
(`choice.action_failed`), and App Server delivery failure
(`choice.delivery_failed`) distinct. When the correlated lifecycle evidence is
unavailable, report the cause as unconfirmed instead of carrying a prior UI
failure claim forward.
A Koe with `showtalk` in its consultations immediately sends sanitized context
there to determine whether the empty result was expected for the request mode
and to request a bounded diagnosis and fix when it was not. The consultation
must omit credentials, private approval authority, and hidden plan state.

The narrowly scoped `initial_commit_and_push` and `initial_push_existing`
modes use the same binding. They are accepted only for the primary `main`
checkout described by workspace-git; an unborn initial commit is displayed as
`unborn` rather than inventing a HEAD value.

Typed Slack text such as `承認` is never approval. Cards cannot be relayed or
reconstructed through `agent.send`, `slack.post`, or `slack.reply`. A copied,
expired, reused, restarted, wrong-thread, or otherwise unbound action fails
closed. The owning Koe must inspect current status and prepare a fresh exact
plan before requesting approval again.
An unbound-plan recovery notice is inert and is posted only after the original
turn's final response. It never starts a turn or authorizes Git. Buttons from an
older deployed notice provide guidance only. If the original turn is still
running when one is used, its final response arrives separately from that
guidance.

Selecting `承認して実行` first records the exact decision through the
model-inaccessible workspace-git private broker, then resumes the original
Codex request. The standard OSS bootstrap optionally loads an operator-selected
manual composition module from `SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE` inside
an isolated worker. The module must be an absolute, same-owner, non-symlink,
non-group/world-writable file implementing the version-1 human-only contract.
ShowTalk has no compile-time local-mcp dependency and rejects any composition
that exposes automation or control factories. Without that module, Git
decisions fail closed instead of manufacturing authority.
See [Optional workspace-git integration](workspace-git-integration.md) for the
external contract, metadata-only diagnostics, and availability boundary.

Each human decision also carries a delivery ID derived from the exact Slack
channel, root thread, Block message, request, approver, decision, operation,
and plan hash. Retrying the same authenticated callback is idempotent, while a
different message or request cannot replay a recorded approval. workspace-git
recomputes the persisted plan hash while holding its state lock before it
accepts the decision.

Every prepare result includes a bounded `approval_scope`; public
`approval_authority_id` is rejected as a private-authority leak. ShowTalk sends
only the exact public operation identifiers, decision delivery ID, and
authenticated Slack caller, Koe, channel, root thread, and App Server session.
It never sends scope, authority, signing material, profiles, or automation
state. workspace-git re-reads the persisted operation, scope, and private
authority before recording the decision. An inconclusive result keeps the App
Server request and Slack card pending so the same bound button can reconcile
idempotently; it is not rewritten as a rejection.

The resumed turn must still use workspace-git's status and execute boundaries;
ShowTalk does not directly perform the Git write from a Slack callback.
The bound Slack button response is the fresh human approval boundary, so the
resumed Codex turn must not stop with an acknowledgement or defer the exact
approved operation to another user message. It revalidates and confirms the
broker-recorded approval, and calls the matching `execute_approved_*` tool once when
the immutable plan still matches. Rejection, expiry, mismatch, an already
rejected or executed operation, or an inconclusive state remains fail-closed.
If the approved turn nevertheless ends before the exact execute tool is
observed, ShowTalk first checks the complete final App Server item snapshot.
Only when it contains neither an execute attempt nor a terminal workspace-git
status does ShowTalk start one bounded continuation turn carrying the same
in-memory binding. Failed, incomplete, already terminal, or incompletely loaded
results are never retried automatically. A second non-executing completion is
surfaced as an error.

## Attachments

A Slack message may contain up to 10 supported files, with limits of 25 MiB per
file and 50 MiB per message. PNG, JPEG, GIF, and WebP are passed to Codex as
ordered image inputs. MP3, M4A, WAV, OGG, FLAC, and AAC are downloaded into the
private attachment spool and exposed as local files. Audio transcription
depends on tools available in the Koe workspace.

Koe can send supported image, audio, and UTF-8 Markdown (`.md`) files with
`slack.post` or `slack.reply`:

```text
slack.reply(
  channel="implementer",
  thread_ts="1710000000.000001",
  message="Rendered result and spoken summary.",
  attachments=[
    {path="artifacts/result.png", alt_text="Rendered result"},
    {path="artifacts/summary.m4a", title="Spoken summary"},
    {path="artifacts/report.md", title="Result report"}
  ]
)
```

During a Slack-originated turn, `slack.reply` may omit both `channel` and
`thread_ts`. The Gateway then binds the upload to that exact active originating
thread and rejects the call if the turn has ended or no Slack turn is active.
Use this form when the Koe creates a screenshot or other workspace artifact for
the user who requested it. That explicit request authorizes the bound,
attachment-only upload; no separate attachment approval is required. Adding a
`message`, specifying a destination, or using `slack.post` keeps the configured
approval behavior. An explicit `deny` Slack policy still rejects the operation:

```text
slack.reply(
  attachments=[
    {path="artifacts/screenshots/result.png", alt_text="Requested screenshot"}
  ]
)
```

Paths are relative to the authenticated Koe's configured workspace. Markdown
files must contain valid UTF-8 text without NUL bytes. Absolute paths, URLs,
traversal, workspace-external symlinks, unsupported formats, and oversized
files are rejected.

Inline images returned by App Server dynamic tools are also projected to the
originating Slack thread. Only validated `data:image/...;base64,...` content is
accepted; remote URLs and local paths from tool output are never fetched or
read by this projection path.

## Koe-to-Koe visits

`agent.send` accepts a canonical Koe ID or configured call name, but only a
target explicitly present in the source Koe's `consultations` is eligible.
Slack shows the visit in the target channel; the Gateway—not Slack events—is
the transport.

Koe visits may include up to 10 PNG, JPEG, GIF, or WebP images from the
sending Koe's workspace. The same 25 MiB per-file and 50 MiB combined limits
apply. Images are validated, copied into the private Gateway spool before the
request is accepted, and delivered to the target adapter as native image
input. Audio is not accepted by `agent.send`:

```text
agent.send(
  target="reviewer",
  message="Review the attached screen against the specification.",
  attachments=[
    {path="artifacts/home-screen.png", alt_text="Home screen under review"}
  ]
)
```

For an ordered request, the controlling Koe sends one bounded step at a time
and waits for its delayed result before formulating the next. A live
`agent.send` call durably records the request, returns `queued` with a stable
delegation ID, and releases the caller to finish its current turn. The target
runs accepted work FIFO while retaining the one-active-turn-per-Koe boundary.
The queued acknowledgement is not the target's result and must not be resent.
A review/fix cycle needs an explicit retry bound and must not loop indefinitely.
When a causation chain reaches the Router's hop limit, admission fails before a
job or delegation ID is created with `DELEGATION_DEPTH_EXCEEDED`. This is a
deliberate safety stop, not a switchboard outage: do not resend or restart the
Gateway. Continue only from a new human-originated turn, which starts a new
causation chain.

If the target finishes after the source turn closes, Taishi resumes the source
Koe on the backend conversation mapped to the original Slack root, queues it
behind newer work, and posts the source Koe's conclusion in that same Slack
thread. Accepted delegation and continuation IDs are persisted so handled
results are not projected twice after a restart.

Queued requests, parent/child ownership, and exact return bindings are durable.
After replacement, requests that were certainly still queued resume. Work that
was already running is not executed again because its external outcome may be
unknown; that outcome is returned visibly instead. Queue admission is bounded
per target and globally, and requests expire rather than waiting forever.
If durable state or Slack result delivery fails after acceptance, Taishi keeps
the affected job but blocks automatic retries for that worker process to avoid
a hot loop. `agent.status` then reports `queue_status: blocked` with queued and
pending-delivery counts. After repairing the underlying dependency, restart the
Gateway through `gateway.restart`; the replacement worker reloads the saved job
and makes one safe recovery attempt. It never re-runs a target turn whose
execution or source-continuation outcome is uncertain.

With `slack_thread` scope, separate visits create separate backend threads in
the target workspace. They receive the delegated request and configured
workspace sources, but not automatic memory from other Slack roots.

## Work-attention monitoring

The Worker classifies Koe activity from adapter events, fixed interaction-audit
events, explicit adapter connection observations, and a deterministic 15-second
state reconciliation. A normal Codex transport close requests a worker restart
immediately, so that path can stop reconciliation before the 30-second
connection-loss grace and is not guaranteed to emit a connection-loss notice.
It does not call a model. States distinguish queued, running, tool-running,
waiting for input, failed, terminal, and unknown. A lack of text alone is not a
failure: running work is only suspected after 15 minutes without a progress
event, and a known tool call has a separate 60-minute threshold.
Reconciliation treats a volatile persisted session status as unknown unless the
current Worker also holds the process-local turn lease; stale `running` state is
never used by itself as proof that work is active.

Waiting input becomes visible only after the corresponding Slack controls event.
A callback-bound request without that event for 30 seconds is classified as a
hidden approval/input wait. Displayed waits, hidden waits, failure, observed
connection loss, and recovery have separate incident reasons. Each reason is emitted once
per incident; recovery closes it, and a later recurrence receives a new
occurrence number. This bounded deduplication state survives Worker replacement.

Every transition also remains available as a machine-readable log record with
`component: "showtalk.work_attention"`. When
`slack.work_attention_channel_id` is configured, actionable transitions are
posted as new Slack root messages (never edits, deletes, or thread replies).
Normal `visible_approval_wait` detection and recovery remain in the local audit
but are not posted to Slack. Hidden waits, progress stalls, execution failures,
connection loss, and their recoveries use this exact eight-line contract:

```text
SHOWTALK_WORK_ATTENTION_V1
incident_id: <16 lowercase hex characters>
status: <detected|recovered>
target_koe: <configured Koe ID>
source_thread: <Slack channel ID>/<root timestamp>|unavailable
reason: <fixed work-attention reason>
last_progress_at: <ISO-8601 timestamp>
next_safe_action: <fixed safe-action classifier>
```

Slack markdown is disabled. The incident ID identifies one occurrence and is
the same on its detection and recovery messages; duplicate reconciliation does
not repost it. A later recurrence has a new incident ID. Bot-authored Slack
messages remain excluded from human-message routing, so this notification does
not start a Codex turn.

The contract never contains approval text, prompts, answers, tool input/output,
request IDs, logs, or credentials. Notification-delivery failure emits a
separate fixed local record and is not retried automatically. No webhook, Slack
scope, approval authority, interrupt, restart, or automatic approval is added.

## Restart and service operation

The Worker observes Socket Mode connection, close, and reconnect events and
checks the live socket every 30 seconds. It writes payload-free
`showtalk.slack_connection` transitions (`connected`, `disconnected`,
`degraded`, `recovered`) once per change. A disconnection lasting three minutes
becomes `degraded`. The authenticated localhost `/api/health` response includes
`slack_connection` and reports `status: "degraded"` for that condition. This
distinguishes a live Gateway process from a usable Slack connection. Detection
does not post to Slack or automatically restart the Worker; investigate network
and SDK errors before a human requests a restart.

Use the public [Gateway restart and approval-bridge verification](gateway-restart-verification.md)
gate whenever restart or structured-input behavior changes.

`taishi start` runs a parent Supervisor and replaceable Gateway Worker. An
approved restart pauses new work, drains accepted responses and active turns,
flushes state, exits the Worker with a reserved restart code, and starts a fresh
Worker using the latest local code.

The Worker logs payload-free idle status for Gateway turns, Slack handlers, MCP
operations, and MCP HTTP requests while draining. Every five minutes it also
checks whether an idle waiter missed its final wakeup. It keeps waiting while
any component has accepted work and never interrupts that work to accelerate
replacement. Replacement occurs only after the normal shutdown and state
flushing succeed. A blocked or failed shutdown does not request replacement and
needs investigation. The restart does not use process signals to force
replacement. Work-attention polling stops when draining begins so it cannot add
new Slack posts to the pending work.

For `gateway.restart`, the permission card is terminalized before authorization
is released, a bounded replay receipt is persisted, and the restart callback is
deferred until the MCP HTTP response has finished. A replacement Worker that
sees the same authenticated request receipt returns `scheduled` without another
approval card or Worker replacement. Permission cards that could not be updated
before replacement are replayed from the durable outbox and closed fail-safe at
startup.

On macOS, a per-user LaunchAgent can keep Taishi independent of the Codex App:

```bash
npm run build
node dist/cli.js service install
node dist/cli.js service status
```

Put runtime values in a private mode-`0600` `.env` beside `config.yaml`. The
plist records only its path. Logs are written under
`~/Library/Logs/ShowTalkTaishi/`. Do not run a foreground `taishi start` against
the same state file. To remove the service without deleting its logs:

```bash
node dist/cli.js service uninstall
```

### Maintenance stop of an already-updated service

`taishi service stop` requests a graceful stop of the existing registered
LaunchAgent. The Supervisor forwards one SIGTERM; the Worker closes admission
synchronously, waits for accepted turns, Slack handlers and MCP work to become
idle, then performs normal shutdown. The Supervisor does not replace the Worker.
Repeated stop signals do not interrupt the drain. This affects every Koe sharing
the Gateway. It requires a separately approved maintenance window and the
existing per-user launchd permissions; it grants no Git or deployment authority.

The command performs at most 40 polls with 250ms waits (ten seconds of requested
waiting). This is not a wall-clock deadline: each launchctl operation also has
to return, and the existing launchctl runner has no command timeout. A hung
command leaves the result unconfirmed, never successfully stopped. Exhausting
the polls means **pending**, not stopped: the Worker continues draining, and no stronger signal, bootout, plist
rewrite or retry is performed. The normal five-minute drain checkpoint only
reports progress. Do not use uninstall/install, a forced signal or a second
Worker to accelerate it. If the Worker exits uncleanly during a requested stop,
the Supervisor remains alive, reports that stop is unconfirmed, and prevents
launchd's failure policy from silently starting another Worker. Investigate that
fault; `service start` refuses a still-running Supervisor.

After a clean stop, the job remains registered without a running Supervisor.
`taishi service start` explicitly kickstarts that existing job without `-k` or
changing its plist, config or environment. A failed registration/status read,
unknown state or nonzero exit is not accepted as a clean stop. The result reports
the registered process state; it does not prove Slack readiness or that all
descendants have exited.

**First activation:** these guarantees require both the running Supervisor and
Worker to contain this implementation. Running a newer CLI against an old Worker
still sends SIGTERM to the old immediate-shutdown implementation. Neither
`service stop` nor `gateway.restart` installs this fix or updates the Supervisor.
Establish and approve the initial service-update method separately; these
commands do not resolve that bootstrap problem.

For a later artifact update, first confirm the supported running generation,
the accepted-work drain, clean Supervisor/Worker exit and absence of relevant
remaining child processes. Hold the service stopped and exclude concurrent
writers while validating and replacing `dist` and `node_modules` as one
generation. Check the complete before/after manifests and backup immediately
before use; two directory renames alone are not a transaction. Unknown entries,
partial or mixed generations stop the procedure. Resume only after both trees
match the approved target. Rollback requires the exact complete target generation
and revalidated original backup; do not automatically overwrite an uncertain
partial state. Source, package/lock, config, credentials, runtime state and Git
metadata are outside that artifact replacement.

## State and continuity

ShowTalk requires no external database. Runtime state is versioned and written
atomically. It stores the minimum mappings needed to resume Koe sessions,
backend thread IDs, Slack reply locations, and delegation continuations.
Interactive permission and structured Git approval requests remain
process-local and expire or resolve to rejection during shutdown.

After a ShowTalk-owned turn, the Codex App Server subscription is released but
the durable thread remains. The next Slack or Codex App turn resumes that same
thread. If another client is actively using it, Slack input waits rather than
racing or interrupting the external turn. App-side streaming is not mirrored
into Slack.

After restart, process-local active statuses are normalized to interrupted.
Pending approval UI does not survive because the originating RPC no longer
exists. A `running` value in persisted state alone is never proof that another
Slack turn is active; live attribution also requires the current process's turn
lease.

Received files remain in the private spool for durable thread access. Automatic
retention cleanup is not implemented; a per-Koe quota bounds growth and older
files may need manual removal. Before cleanup, stop the foreground Gateway or
uninstall its LaunchAgent, confirm no Taishi process is using the configured
`gateway.attachment_dir`, and remove only files inside that exact private spool.
Do not delete the state file or a parent directory as part of attachment
cleanup.

## Verification

For normal changes:

```bash
npm run check
```

For release-facing or cross-cutting changes:

```bash
npm run verify
```

Optional real-Codex smoke tests:

```bash
npm run smoke:codex-mcp
npm run smoke:codex-agent-send
npm run smoke:codex-resume
```

Approval-bridge changes also run `npm run verify:approval-bridge`, followed by
the live acceptance gate when a Worker restart is part of verification.

See [Architecture](architecture.md) for component boundaries and
[Security](security.md) for the trust model.
