# Slack approval commands

Approval cards keep their existing buttons. Supported cards also display an
exact, one-line command for an alternative reply in the **same Slack thread**:

```text
承認 <request-id-shown-on-the-card>
拒否 <request-id-shown-on-the-card>
```

Replace the placeholder with the complete ID displayed on that card. Send one
command with exactly one ASCII space. Do not add quotes, code formatting,
mentions, a signature, an attribution footer, another sentence, or a newline.
The one verified ChatGPT connector format described below may be added by the
connector itself; type only the command when sending through that connector.
`承認` alone, natural-language assent, and an operation ID or plan hash copied
from a Git plan are not approval commands.

## Identity and binding

Bolt receives the authenticated Slack event. ShowTalk uses the event's actual
`user` field, never a name, mention, quoted text, or claimed author. That user
must be a configured `slack.approver_user_ids` member. A user-attributed proxy
post follows the same rules as a direct post; ShowTalk does not infer whether
the person typed it. Bot messages are not converted into human approvals.

Only a new, unedited message reply can qualify. Bot metadata, message subtypes,
attachments, forwarded/quoted rich text, and formatted command text are
rejected. The complete raw text must match the command, and any Slack rich-text
blocks must represent exactly that same plain text, except for the one
conjunctive connector format below. Other proxy formats must use the buttons.

### Verified connector format

The Slack-layer installation profile pins the observed publisher app ID and
the ChatGPT attribution user ID. It accepts only their exact combination with:

- fallback `text`: one command, one ASCII space, then
  `*使用して送信されました* <@UCHATGPT>` (synthetic attribution ID shown here);
- exactly one `rich_text` block containing one plain command leaf;
- exactly one following `context` block containing one `mrkdwn` element with
  that exact footer and `verbatim: false`.

The visible line break is produced by the separate context block. A newline
in fallback text, `|ChatGPT` alias, different mention/app ID, extra text or
block, quote, styled command, duplicate command, or missing publisher app ID
is rejected. Plain commands continue to reject publisher `app_id`. All
formats still reject `bot_id`, `bot_profile`, subtypes, edits, and attachments.

This is a deliberately installation-specific syntax profile, not evidence
that ChatGPT authored the message. The footer never supplies the approver ID:
only the authenticated event's `user` can authorize the request. The profile
is not learned from messages, and unknown installations fail closed pending a
reviewed source-profile update. No new Slack scope or persistent runtime
setting is needed. The original Slack post and attribution are left intact.

The interaction audit records `approval_text.binding_validated` with fixed
`plain` or `chatgpt_slack_footer_v1` classification and hashed actor,
attribution-app/user, command-message, card-message, request, and thread
references. Raw text and IDs are not logged. This event records a validated
candidate, **not successful settlement**; existing backend delivery/settlement
events establish that outcome. Failures use `approval_text.failed`. This also
distinguishes a text-path attempt from a button-only round trip.

The process-local registry is populated only after the card is displayed
successfully. It binds the request type, request ID, session where applicable,
channel, root thread, card timestamp, available decisions, and backend expiry.
The reply must be newer than the card and arrive before that expiry. A duplicate
active ID is rejected. The registry is not restored across Gateway restarts.
Unknown, expired, malformed, or unsupported command attempts do not become new
coding-agent turns.

For an external-action confirmation, the original requester restriction still
applies as well as membership in the configured approver list.

## Supported decisions

| Request type | `承認` | `拒否` | Limits |
| --- | --- | --- | --- |
| Codex command/file/permissions and supported MCP tool approval | Existing **Allow once** | Existing **Deny**, or **Cancel** when Deny is unavailable | Only decisions actually offered by that request; adapter must expose its exact deadline. |
| workspace-git plan confirmation | Existing **承認して実行** | Existing **拒否・保留** | Same immutable plan, private decision broker, expiry, and execution-time revalidation. |
| Non-Git external-action confirmation | Existing explicit approval option | Existing reject/hold option | Only the validated two-option `external_action_confirmation`; cannot authorize Git. |
| ShowTalk Permission Engine request | Existing **Allow once** | Existing **Deny** | Same coordinator and one-use grant; does not itself confirm operation completion. |

Session grants, persistent command rules, ordinary choices, free-text answers,
choice continuations, Git recovery controls, and Git autonomy enable/disable
controls remain button-only. Commands never widen a requested permission or
select an unavailable decision.

## Settlement and failures

Button callbacks and text commands converge on the same decision handlers.
The existing backend pending-request checks and one-use settlement still apply.
Git decisions retain their existing serialization and broker-before-App-Server
ordering. Duplicate or competing text/button submissions cannot apply a second
decision after settlement. Receiving text is not a substitute for executing or
revalidating the exact approved operation.

A cosmetic Slack update failure cannot apply the decision again. An uncertain
Git broker result retains the existing pending controls and stable delivery ID
for reconciliation; it must not be reported as definitely rejected or retried
through another approval route. An expired, interrupted, externally resolved,
or restarted request needs the normal fresh-request workflow.

These commands are interpreted only by the Gateway. Quoting one in a Codex
prompt, an attachment, or a tool result supplies no approval authority.

## Verification and activation

The deterministic regression suite exercises synthetic Slack events, fake
Slack clients, and isolated approval coordinators. It must not approve a real
operation or contact Slack. Run `npm run check` and `npm run verify` for the
cross-cutting change, plus the repository's `npm run verify:approval-bridge`
integration gate. The latter uses a real Codex App Server with an isolated
read-only smoke task and simulated answers; it is not a live Slack acceptance
test.

A running Gateway does not acquire this behavior merely because the source was
edited or built. Activation requires the separate Gateway restart workflow and
the live acceptance checks in `gateway-restart-verification.md`. Neither a
development request nor passing tests authorizes pending operations, Git
publication, or a restart.
