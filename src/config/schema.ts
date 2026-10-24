import { z } from "zod";

import {
  MAX_KOE_CALL_NAME_LENGTH,
  MAX_KOE_ID_LENGTH,
  normalizeKoeAddress,
} from "../core/koe-address.js";

const policyDecisionSchema = z.enum(["allow", "deny", "approval"]);
const conversationScopeSchema = z.enum(["channel", "slack_thread"]);
const adapterSessionIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const modelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value === value.trim(),
    "Model ID must not have surrounding whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "Model ID must not contain control characters",
  );
const reasoningEffortSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => value === value.trim(),
    "Reasoning effort must not have surrounding whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "Reasoning effort must not contain control characters",
  );
const claudeReasoningEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const environmentVariableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .refine(
    (name) =>
      name.toUpperCase() !== "SHOWTALK_TAISHI_MCP_TOKEN" &&
      name.toUpperCase() !== "SHOWTALK_APPOPS_APPROVAL_PRIVATE_KEY_FILE" &&
      name.toUpperCase() !== "SHOWTALK_APPOPS_APPROVAL_KEY_ID" &&
      name.toUpperCase() !== "APP_OPS_SHOWTALK_APPROVAL_PUBLIC_KEY" &&
      name.toUpperCase() !== "APP_OPS_SHOWTALK_APPROVAL_KEY_ID" &&
      !/^SLACK_.*TOKEN$/iu.test(name),
    "Gateway or Slack token variables cannot be passed through to a Koe",
  );
const slackUserIdSchema = z
  .string()
  .regex(/^[UW][A-Z0-9]{1,127}$/u, "Invalid Slack user ID");
const slackWorkspaceIdSchema = z
  .string()
  .regex(/^T[A-Z0-9]{1,127}$/u, "Invalid Slack workspace ID");
const slackBotIdSchema = z
  .string()
  .regex(/^B[A-Z0-9]{1,127}$/u, "Invalid Slack bot ID");
const slackChannelIdSchema = z
  .string()
  .regex(/^[CDG][A-Z0-9]{1,127}$/u, "Invalid Slack channel ID");

const consultationScopeSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (value) => value === value.trim(),
    "Consultation scope must not have surrounding whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    "Consultation scope must not contain unsupported control characters",
  );

const koeIdSchema = z
  .string()
  .min(1)
  .max(MAX_KOE_ID_LENGTH)
  .refine(
    (value) => value === value.trim(),
    "Koe ID must not have surrounding whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "Koe ID must not contain control characters",
  );

const consultationsSchema = z
  .record(
    koeIdSchema,
    z.object({ scope: consultationScopeSchema }).strict(),
  )
  .refine(
    (consultations) => Object.keys(consultations).length <= 64,
    "A Koe may configure at most 64 consultation targets",
  );

const slackPolicySchema = z
  .object({
    own_channel: z
      .object({
        read: policyDecisionSchema.optional(),
        write: policyDecisionSchema.optional(),
      })
      .optional(),
    agent_channels: z
      .object({
        read: policyDecisionSchema.optional(),
        write: policyDecisionSchema.optional(),
      })
      .optional(),
    other_channels: z
      .object({
        read: policyDecisionSchema.optional(),
        write: policyDecisionSchema.optional(),
      })
      .optional(),
  })
  .strict();

const agentPolicySchema = z
  .object({
    slack: slackPolicySchema.optional(),
    agents: z.object({ send: policyDecisionSchema }).strict().optional(),
  })
  .strict();

const slackPersonaSchema = z
  .string()
  .min(1, "Slack persona must contain non-whitespace text")
  .max(4_000)
  .refine(
    (value) => value.trim().length > 0,
    "Slack persona must contain non-whitespace text",
  )
  .refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    "Slack persona must not contain unsupported control characters",
  );

const koeCallNameSchema = z
  .string()
  .min(1)
  .max(MAX_KOE_CALL_NAME_LENGTH)
  .refine(
    (value) => value === value.trim(),
    "Koe call name must not have surrounding whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "Koe call name must not contain control characters",
  );

const workspaceGitAutonomyCandidateSchema = z
  .object({
    profile_id: z.string().uuid(),
    profile_revision: z.number().int().min(1),
    requested_ttl_minutes: z.number().int().min(1).max(24 * 60).default(60),
    label: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => value === value.trim(), "Profile label must not have surrounding whitespace")
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Profile label must not contain control characters")
      .optional(),
  })
  .strict();

const slackPresentationSchema = z
  .object({
    channel_id: slackChannelIdSchema,
    conversation_scope: conversationScopeSchema.default("channel"),
    call_name: koeCallNameSchema.optional(),
    persona: slackPersonaSchema.optional(),
    display_name: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => value === value.trim(), "Display name must not have surrounding whitespace")
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Display name must not contain control characters")
      .optional(),
    icon_url: z
      .string()
      .max(2_048)
      .url()
      .refine((value) => new URL(value).protocol === "https:", "Icon URL must use HTTPS")
      .optional(),
    icon_emoji: z
      .string()
      .max(100)
      .regex(/^:[a-z0-9][a-z0-9_+.-]*:$/u, "Icon emoji must be a Slack :shortcode:")
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.icon_url === undefined || value.icon_emoji === undefined,
    "Configure either icon_url or icon_emoji, not both",
  );

const envPassthroughSchema = z
  .array(environmentVariableNameSchema)
  .max(64)
  .refine(
    (names) => new Set(names).size === names.length,
    "Koe environment pass-through names must be unique",
  )
  .default([]);

const codexAdapterSchema = z
  .object({
    type: z.literal("codex-app-server"),
    command: z.string().min(1),
    transport: z.literal("stdio"),
    model: modelIdSchema.optional(),
    reasoning_effort: reasoningEffortSchema.optional(),
    approval_policy: z
      .enum(["on-request", "never"])
      .default("on-request"),
    approvals_reviewer: z
      .enum(["user", "auto_review", "guardian_subagent"])
      .default("auto_review"),
    live_acceptance_mcp_probe: z.boolean().optional(),
    sandbox: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .default("workspace-write"),
    env_passthrough: envPassthroughSchema,
  })
  .strict();

const claudeToolRuleSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => value === value.trim(),
    "Tool rule must not have surrounding whitespace",
  )
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "Tool rule must not contain control characters",
  );

/**
 * Claude Code through the Claude Agent SDK. `bypassPermissions` is
 * intentionally not accepted: every gated tool call must reach Slack.
 */
const claudeAdapterSchema = z
  .object({
    type: z.literal("claude-code"),
    /** Optional explicit `claude` executable; the SDK-bundled binary otherwise. */
    command: z.string().min(1).optional(),
    model: modelIdSchema.optional(),
    reasoning_effort: claudeReasoningEffortSchema.optional(),
    permission_mode: z.enum(["default", "acceptEdits", "plan"]).default("default"),
    allowed_tools: z.array(claudeToolRuleSchema).max(128).default([]),
    setting_sources: z
      .array(z.enum(["user", "project", "local"]))
      .max(3)
      .refine(
        (sources) => new Set(sources).size === sources.length,
        "Claude setting sources must be unique",
      )
      .default(["user", "project", "local"]),
    max_turns: z.number().int().min(1).max(1_000).optional(),
    approval_timeout_minutes: z.number().int().min(1).max(24 * 60).default(30),
    env_passthrough: envPassthroughSchema,
  })
  .strict();

export const taishiConfigSchema = z
  .object({
    version: z.literal(1),
    gateway: z
      .object({
        state_file: z.string().min(1),
        attachment_dir: z.string().min(1).optional(),
        agent_message_max_hops: z.number().int().min(1).max(32).default(4),
        admin_ui: z
          .object({
            enabled: z.boolean().default(false),
            port: z.number().int().min(1_024).max(65_535).default(4_781),
          })
          .strict()
          .default({ enabled: false, port: 4_781 }),
      })
      .strict(),
    slack: z
      .object({
        socket_mode: z.literal(true),
        app_token: z.string().startsWith("xapp-"),
        bot_token: z.string().startsWith("xoxb-"),
        approver_user_ids: z
          .array(slackUserIdSchema)
          .min(1)
          .refine(
            (ids) => new Set(ids).size === ids.length,
            "Slack approver user IDs must be unique",
          ),
        trusted_bot_message_sources: z
          .array(z.object({
            workspace_id: slackWorkspaceIdSchema,
            user_id: slackUserIdSchema,
            bot_id: slackBotIdSchema,
            external_action_responder_user_id: slackUserIdSchema.optional(),
          }).strict())
          .max(32)
          .refine(
            (sources) => new Set(sources.map((source) =>
              `${source.workspace_id}\u0000${source.user_id}\u0000${source.bot_id}`
            )).size === sources.length,
            "Trusted Slack bot message sources must be unique",
          )
          .default([]),
        work_attention_channel_id: slackChannelIdSchema.optional(),
      })
      .strict()
      .superRefine((slack, context) => {
        slack.trusted_bot_message_sources.forEach((source, index) => {
          const responder = source.external_action_responder_user_id;
          if (responder === undefined) return;
          if (responder === source.user_id) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["trusted_bot_message_sources", index,
                "external_action_responder_user_id"],
              message: "Trusted bot external-action responder must differ from the bot user",
            });
          }
          if (!slack.approver_user_ids.includes(responder)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["trusted_bot_message_sources", index,
                "external_action_responder_user_id"],
              message: "Trusted bot external-action responder must be a configured Slack approver",
            });
          }
        });
      }),
    adapters: z
      .record(
        z.string().min(1),
        z.discriminatedUnion("type", [codexAdapterSchema, claudeAdapterSchema]),
      )
      .refine((adapters) => Object.keys(adapters).length > 0, "At least one adapter is required"),
    agents: z
      .record(
        koeIdSchema,
        z
          .object({
            adapter: z.string().min(1),
            adapter_session_id: adapterSessionIdSchema.optional(),
            model: modelIdSchema.optional(),
            reasoning_effort: reasoningEffortSchema.optional(),
            automatic_choice_mode: z
              .enum(["off", "ordinary_top_choice"])
              .default("off"),
            workspace_git_autonomy: workspaceGitAutonomyCandidateSchema.optional(),
            workspace: z.object({ path: z.string().min(1) }).strict(),
            slack: slackPresentationSchema,
            role: z.string().min(1),
            consultations: consultationsSchema.optional(),
          })
          .strict(),
      )
      .refine((agents) => Object.keys(agents).length > 0, "At least one Koe is required"),
    permissions: z
      .object({
        defaults: agentPolicySchema,
        agents: z.record(z.string().min(1), agentPolicySchema).default({}),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [name, adapter] of Object.entries(config.adapters)) {
      if (
        adapter.type !== "codex-app-server" ||
        adapter.live_acceptance_mcp_probe !== true
      ) {
        continue;
      }
      if (adapter.approval_policy !== "on-request") {
        context.addIssue({
          code: "custom",
          path: ["adapters", name, "approval_policy"],
          message:
            "live_acceptance_mcp_probe requires approval_policy: on-request",
        });
      }
      if (adapter.approvals_reviewer !== "user") {
        context.addIssue({
          code: "custom",
          path: ["adapters", name, "approvals_reviewer"],
          message:
            "live_acceptance_mcp_probe requires approvals_reviewer: user",
        });
      }
    }
    const channels = new Map<string, string>();
    const adapterSessions = new Map<string, string>();
    const channelOwnersByNormalizedAddress = new Map<string, string>();
    const idsByNormalizedAddress = new Map<string, string>();
    const callNames = new Map<string, string>();
    for (const [name, agent] of Object.entries(config.agents)) {
      const normalizedId = normalizeKoeAddress(name);
      const normalizedIdOwner = idsByNormalizedAddress.get(normalizedId);
      const normalizedCallNameOwner = callNames.get(normalizedId);
      if (
        normalizedIdOwner !== undefined ||
        normalizedCallNameOwner !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["agents", name],
          message: `Koe ID conflicts after normalization with: ${normalizedIdOwner ?? normalizedCallNameOwner}`,
        });
      } else {
        idsByNormalizedAddress.set(normalizedId, name);
      }
      if (!Object.hasOwn(config.adapters, agent.adapter)) {
        context.addIssue({
          code: "custom",
          path: ["agents", name, "adapter"],
          message: `Unknown adapter: ${agent.adapter}`,
        });
      }
      const configuredAdapter = config.adapters[agent.adapter];
      if (
        configuredAdapter?.type === "claude-code" &&
        agent.reasoning_effort !== undefined &&
        !claudeReasoningEffortSchema.safeParse(agent.reasoning_effort).success
      ) {
        context.addIssue({
          code: "custom",
          path: ["agents", name, "reasoning_effort"],
          message: "Unsupported Claude reasoning effort",
        });
      }
      const existing = channels.get(agent.slack.channel_id);
      if (existing) {
        context.addIssue({
          code: "custom",
          path: ["agents", name, "slack", "channel_id"],
          message: `Slack channel is already assigned to Koe: ${existing}`,
        });
      } else {
        channels.set(agent.slack.channel_id, name);
        channelOwnersByNormalizedAddress.set(
          normalizeKoeAddress(agent.slack.channel_id),
          name,
        );
      }
      if (agent.slack.call_name !== undefined) {
        const normalized = normalizeKoeAddress(agent.slack.call_name);
        const idOwner = idsByNormalizedAddress.get(normalized);
        const callNameOwner = callNames.get(normalized);
        if (idOwner !== undefined || callNameOwner !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["agents", name, "slack", "call_name"],
            message: `Koe call name conflicts with Koe: ${idOwner ?? callNameOwner}`,
          });
        } else {
          callNames.set(normalized, name);
        }
      }
      if (agent.adapter_session_id !== undefined) {
        if (agent.slack.conversation_scope === "slack_thread") {
          context.addIssue({
            code: "custom",
            path: ["agents", name, "adapter_session_id"],
            message: [
              "adapter_session_id cannot be configured with slack_thread conversation scope",
              "because there is no single canonical backend thread",
            ].join(" "),
          });
        }
        const owner = adapterSessions.get(agent.adapter_session_id);
        if (owner !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["agents", name, "adapter_session_id"],
            message: `Adapter session is already assigned to Koe: ${owner}`,
          });
        } else {
          adapterSessions.set(agent.adapter_session_id, name);
        }
      }
      for (const target of Object.keys(agent.consultations ?? {})) {
        if (target === name) {
          context.addIssue({
            code: "custom",
            path: ["agents", name, "consultations", target],
            message: "A Koe cannot configure itself as a consultation target",
          });
        } else if (!Object.hasOwn(config.agents, target)) {
          context.addIssue({
            code: "custom",
            path: ["agents", name, "consultations", target],
            message: `Unknown consultation target: ${target}`,
          });
        }
      }
    }
    for (const [name, agent] of Object.entries(config.agents)) {
      const addresses = [
        ["id", name] as const,
        ...(agent.slack.call_name === undefined
          ? []
          : [["call_name", agent.slack.call_name] as const]),
      ];
      for (const [field, address] of addresses) {
        if (/^[cdg][a-z0-9]{1,127}$/u.test(normalizeKoeAddress(address))) {
          context.addIssue({
            code: "custom",
            path:
              field === "id"
                ? ["agents", name]
                : ["agents", name, "slack", "call_name"],
            message: "Koe addresses must not look like literal Slack channel IDs",
          });
        }
        const channelOwner = channelOwnersByNormalizedAddress.get(
          normalizeKoeAddress(address),
        );
        if (channelOwner !== undefined) {
          context.addIssue({
            code: "custom",
            path:
              field === "id"
                ? ["agents", name]
                : ["agents", name, "slack", "call_name"],
            message: `Koe address conflicts with Slack channel assigned to: ${channelOwner}`,
          });
        }
      }
    }
    for (const policyAgentId of Object.keys(config.permissions.agents)) {
      if (!Object.hasOwn(config.agents, policyAgentId)) {
        context.addIssue({
          code: "custom",
          path: ["permissions", "agents", policyAgentId],
          message: `Permission override references unknown Koe: ${policyAgentId}`,
        });
      }
    }
  });

export type TaishiConfig = z.infer<typeof taishiConfigSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type AdapterConfig = TaishiConfig["adapters"][string];
export type CodexAdapterConfig = Extract<AdapterConfig, { type: "codex-app-server" }>;
export type ClaudeAdapterConfig = Extract<AdapterConfig, { type: "claude-code" }>;
