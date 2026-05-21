import { CodexControlClient } from "../dist/src/index.js";

const client = new CodexControlClient();

try {
  const session = await client.startSession({
    cwd: process.cwd(),
    model: process.env.CODEX_CONTROL_MODEL || "gpt-5.5",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });

  const result = await session.ask(
    process.argv.slice(2).join(" ") || "Reply with exactly CODEX_CONTROL_OK.",
  );
  console.log(result.finalText);
} finally {
  await client.close();
}
