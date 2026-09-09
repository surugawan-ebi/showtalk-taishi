# Gateway restart and approval-bridge verification

Use this acceptance gate after changing structured input, Slack approval
buttons, continuation behavior, turn ownership, or restart activation. A
private operator skill may automate these same steps, but this document is the
public source of truth.

## 1. Deterministic checks

From the repository root, record the revision and run:

```bash
git rev-parse --short HEAD
npm run verify
npm run verify:approval-bridge
```

`npm run verify:approval-bridge` invokes an authenticated local Codex App Server
turn. It is not proof of a live Slack callback. The preceding commands are the
deterministic repository checks.

## 2. Identify Supervisor and Worker

Record sanitized process evidence for the current Supervisor and its Gateway
Worker before restart. A macOS LaunchAgent status PID may identify the
Supervisor; `agent.status` describes Koe/session state and does not identify the
Worker process. Use bounded local process inspection and never publish command
lines containing credentials.

## 3. Request one supported restart

Only after an explicit human restart request, invoke the supported
`gateway.restart` capability. Complete its real Slack permission card and call
the restart scheduled only after the capability returns `status: "scheduled"`.
Do not send signals or start a second foreground worker.

Finish the initiating turn so the Worker can drain accepted responses, flush
state, and exit. Confirm the Supervisor starts exactly one replacement Worker,
the previous Worker exits, and a new Slack message receives a response.

## 4. Exercise the live Slack bridge

Start a fresh Slack-originated diagnostic turn after replacement.

1. Request one ordinary blocking question with two distinct labels. Select the
   second option and confirm that exact label returns to the same originating
   conversation.
2. When external-action approval code changed, test both accept and reject with
   separate confirmations using question ID `external_action_approval`, the
   exact two fixed labels, non-empty descriptions, and separate `Target:`,
   `Scope:`, and `Impact:` lines. Use only an explicitly described reversible
   marker in a unique directory created with
   `mktemp -d "${TMPDIR:-/tmp}/showtalk-approval-check.XXXXXX"`. Resolve and
   display the marker's exact absolute path before requesting confirmation. For
   the accept case, create, inspect, and remove that exact marker and directory.
   For the reject case, verify the marker was never created, then remove the
   empty directory.
3. Confirm each Slack card reaches one terminal state and that the accepted
   answer resumes the same App Server turn exactly once.

Do not invent a Git plan for this diagnostic. A live Git approval test requires
a real current workspace-git operation and its normal prepare, bound approval,
revalidation, and execute rules.

## 5. Record the result

Record only sanitized evidence: revision, check results, old/new Worker
identity, returned labels, same-turn continuation, and terminal card state. If
the live Slack interaction, Worker replacement, or exact callback origin could
not be observed, mark that stage unverified rather than inferring success from
unit tests or reconnect logs.
