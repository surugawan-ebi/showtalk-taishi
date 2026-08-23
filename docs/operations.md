# Operations and Slack behavior

## Slack turns

Post in a configured Koe channel. With `channel` scope, roots and replies
continue the same backend thread. With `slack_thread` scope, replies under one
root stay together and another root uses a different backend thread.

Rapid human messages are queued FIFO per Koe. Each turn replies under the Slack
message that triggered it. One activity message is updated in place with a
progress marker and elapsed time every five seconds. At completion it collapses
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
workspace-git `prepare_*` operation must immediately issue structured choices
named exactly `承認して実行` and `拒否・保留` in that same turn. Taishi binds one
immutable plan to the originating Koe, Slack channel, root thread, Block
message, approver, expiry, operation ID, and full plan hash.

The narrowly scoped `initial_commit_and_push` and `initial_push_existing`
modes use the same binding. They are accepted only for the primary `main`
checkout described by workspace-git; an unborn initial commit is displayed as
`unborn` rather than inventing a HEAD value.

Typed Slack text such as `承認` is never approval. Cards cannot be relayed or
reconstructed through `agent.send`, `slack.post`, or `slack.reply`. A copied,
expired, reused, restarted, wrong-thread, or otherwise unbound action fails
closed. The owning Koe must inspect current status and prepare a fresh exact
plan before requesting approval again.

Selecting `承認して実行` resumes the original Codex request. The resumed turn
must still use workspace-git's status, approval, and execute boundaries;
ShowTalk does not directly perform the Git write from a Slack callback.
The bound Slack button response is the fresh human approval boundary, so the
resumed Codex turn must not stop with an acknowledgement or defer the exact
approved operation to another user message. It revalidates, records and
confirms approval, and calls the matching `execute_approved_*` tool once when
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

Koe can send supported image and audio files with `slack.post` or `slack.reply`:

```text
slack.reply(
  channel="implementer",
  thread_ts="1710000000.000001",
  message="Rendered result and spoken summary.",
  attachments=[
    {path="artifacts/result.png", alt_text="Rendered result"},
    {path="artifacts/summary.m4a", title="Spoken summary"}
  ]
)
```

Paths are relative to the authenticated Koe's configured workspace. Absolute
paths, URLs, traversal, workspace-external symlinks, unsupported formats, and
oversized files are rejected.

## Koe-to-Koe visits

`agent.send` accepts a canonical Koe ID or configured call name, but only a
target explicitly present in the source Koe's `consultations` is eligible.
Slack shows the visit in the target channel; the Gateway—not Slack events—is
the transport.

For an ordered request, the controlling Koe sends one bounded step at a time
and uses the returned result to formulate the next. A review/fix cycle needs an
explicit retry bound and must not loop indefinitely.

If the target finishes after the source turn closes, Taishi resumes the source
Koe on the backend conversation mapped to the original Slack root, queues it
behind newer work, and posts the source Koe's conclusion in that same Slack
thread. Accepted delegation and continuation IDs are persisted so handled
results are not projected twice after a restart.

With `slack_thread` scope, separate visits create separate backend threads in
the target workspace. They receive the delegated request and configured
workspace sources, but not automatic memory from other Slack roots.

## Restart and service operation

`taishi start` runs a parent Supervisor and replaceable Gateway Worker. An
approved restart pauses new work, drains accepted responses and active turns,
flushes state, exits the Worker with a reserved restart code, and starts a fresh
Worker using the latest local code.

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

See [Architecture](architecture.md) for component boundaries and
[Security](security.md) for the trust model.
