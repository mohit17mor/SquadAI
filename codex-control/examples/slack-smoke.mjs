import { CodexControlClient } from "../dist/src/index.js";

const message =
  process.argv.slice(2).join(" ") ||
  "Codex Control Slack smoke test. This message was sent through the app-server control layer.";

const auditSink = {
  record(entry) {
    if (
      entry.kind === "permission_approval" ||
      entry.kind === "mcp_elicitation" ||
      entry.kind === "dynamic_tool_call"
    ) {
      console.error(`[audit] ${entry.method}: ${entry.decision}`);
    }
  },
};

const client = new CodexControlClient({ auditSink });

try {
  const session = await client.startSession({
    cwd: process.cwd(),
    model: process.env.CODEX_CONTROL_MODEL || "gpt-5.5",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });

  const result = await session.ask(
    [
      "Use Slack to send a direct message to Project User.",
      `Message text: ${JSON.stringify(message)}`,
      "The user explicitly confirmed this external write for this test.",
      "After the Slack action is complete, reply with a short status.",
    ].join("\n"),
    {
      timeoutMs: Number(process.env.CODEX_CONTROL_TIMEOUT_MS ?? 300_000),
      externalWrites: "allow",
      network: "allow",
      confirmation: {
        confirmed: true,
        reason: "Project User explicitly requested a Slack smoke test to himself.",
      },
    },
  );

  console.log(result.finalText);
} finally {
  await client.close();
}
