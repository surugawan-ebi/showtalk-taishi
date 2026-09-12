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
2. For a ShowTalk MCP operation governed by the Permission Engine, identify the
   target channel class and its effective policy before expecting a card. Agent
   overrides take precedence over defaults; an omitted leaf denies. The policy
   must resolve to `approval`, and the process must not already hold a matching
   session grant. Use separate harmless calls: accept one with `allow_once` and
   verify it executes once in the same turn; cancel the other and verify it is
   not executed. Confirm both cards become terminal.

   A routing-free `showtalk_taishi.slack.reply` targets the caller's own channel.
   It therefore displays no permission card when `own_channel.write` resolves
   to `allow`, or when an earlier `allow_session` decision granted that exact
   scope. Treat immediate execution in either case as a preflight mismatch, not
   as evidence that an approval callback was bypassed.
3. When Codex-native MCP tool approval code changed, call
   `showtalk_taishi.diagnostics.approval-probe` with a unique, non-secret
   `probe_id`. First set the target Codex adapter's
   `live_acceptance_mcp_probe: true`; this option is absent/false in normal
   operation. Its per-tool Codex App Server configuration must then set
   `approval_mode: "prompt"`, while the other ShowTalk MCP tools retain the
   server default of `auto`. The adapter must use `approval_policy: on-request`
   and `approvals_reviewer: user`. Confirm the Slack card offers
   `allow_once` and `cancel`. Use separate fresh turns: accept one with
   `allow_once` and verify it returns `status: executed` with the exact
   `probe_id` in the same App Server turn; cancel the other and verify the tool
   returns no result. Confirm both cards become terminal.

   Do not use `showtalk_taishi.slack.reply` as this native MCP approval probe.
   The ShowTalk MCP is configured for App Server `auto` mode, while the Slack
   write itself follows the Permission Engine. An effective `allow` policy or
   process-local session grant therefore executes without an approval card.
   If this diagnostic tool is absent, or either adapter setting differs, mark
   this stage unverified and stop instead of substituting a Slack write,
   Gateway restart, production service, or production data operation.
4. When external-action approval code changed, test both accept and reject with
   separate confirmations using question ID `external_action_approval`, the
   exact two fixed labels, non-empty descriptions, and separate `Target:`,
   `Scope:`, and `Impact:` lines. Use only an explicitly described reversible
   marker in a unique directory created with
   `mktemp -d "${TMPDIR:-/tmp}/showtalk-approval-check.XXXXXX"`. Resolve and
   display the marker's exact absolute path before requesting confirmation. For
   the accept case, create, inspect, and remove that exact marker and directory.
   For the reject case, verify the marker was never created, then remove the
   empty directory.
5. Confirm each Slack card reaches one terminal state and that the accepted
   answer resumes the same App Server turn exactly once.

`npm run verify:approval-bridge` exercises an isolated prompt-configured MCP
probe through a real local Codex App Server. It is deterministic evidence for
the adapter round trip, but it does not replace observation of the live Slack
card after a Worker restart.

Do not invent a Git plan for this diagnostic. A live Git approval test requires
a real current workspace-git operation and its normal prepare, bound approval,
revalidation, and execute rules.

## 5. Record the result

Record only sanitized evidence: revision, check results, old/new Worker
identity, returned labels, same-turn continuation, and terminal card state. If
the live Slack interaction, Worker replacement, or exact callback origin could
not be observed, mark that stage unverified rather than inferring success from
unit tests or reconnect logs.
