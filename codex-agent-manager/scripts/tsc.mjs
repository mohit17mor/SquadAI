import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const candidates = [
  "node_modules/typescript/bin/tsc",
  "../codex-control/node_modules/typescript/bin/tsc",
];

const tsc = candidates.find((candidate) => existsSync(candidate));
if (!tsc) {
  console.error("TypeScript compiler not found. Run npm install first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
