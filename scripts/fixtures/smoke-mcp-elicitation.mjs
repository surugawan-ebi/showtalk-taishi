import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "showtalk-approval-probe",
  version: "0.0.1",
});

server.registerTool(
  "approval_probe",
  {
    description:
      "Read-only live acceptance probe for Codex MCP tool approval elicitation.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    return {
      content: [{ type: "text", text: "MCP_ELICITATION_ACCEPTED" }],
    };
  },
);

await server.connect(new StdioServerTransport());
