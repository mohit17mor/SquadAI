import assert from "node:assert/strict";
import test from "node:test";

import { TailscaleService, TailscaleSetupError } from "../src/index.js";

test("Tailscale service finds the standard Windows installation outside PATH", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const service = new TailscaleService({
    platform: "win32",
    environment: { ProgramFiles: "C:\\Program Files", PATH: "" },
    fileExists: async (path) => path === "C:\\Program Files\\Tailscale\\tailscale.exe",
    run: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "control-machine.example.ts.net." },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });

  const access = await service.ensurePrivateAccess(4317);

  assert.deepEqual(access, {
    controlUrl: "https://control-machine.example.ts.net",
    dnsName: "control-machine.example.ts.net",
  });
  assert.deepEqual(calls, [
    {
      executable: "C:\\Program Files\\Tailscale\\tailscale.exe",
      args: ["status", "--json"],
    },
    {
      executable: "C:\\Program Files\\Tailscale\\tailscale.exe",
      args: ["serve", "--bg", "--yes", "4317"],
    },
  ]);
});

test("Tailscale service returns an approval URL when Serve needs enabling", async () => {
  const service = new TailscaleService({
    platform: "linux",
    fileExists: async (path) => path === "/usr/bin/tailscale",
    run: async (_executable, args) => {
      if (args[0] === "status") {
        return {
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "control.example.ts.net." },
          }),
          stderr: "",
        };
      }
      const error = new Error("serve unavailable") as Error & { stderr: string };
      error.stderr = "Enable Serve at https://login.tailscale.com/admin/feature/serve?node=abc";
      throw error;
    },
  });

  await assert.rejects(
    service.ensurePrivateAccess(4317),
    (error: unknown) => {
      assert.ok(error instanceof TailscaleSetupError);
      assert.equal(
        error.approvalUrl,
        "https://login.tailscale.com/admin/feature/serve?node=abc",
      );
      return true;
    },
  );
});

test("Tailscale service explains when Tailscale is not installed", async () => {
  const service = new TailscaleService({
    platform: "linux",
    fileExists: async () => false,
    run: async () => {
      throw new Error("ENOENT");
    },
  });

  await assert.rejects(service.ensurePrivateAccess(4317), /not installed/i);
});
