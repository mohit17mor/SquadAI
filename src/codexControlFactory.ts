import { pathToFileURL } from "node:url";

import type {
  CodexControlClientContext,
  CodexControlClientFactory,
  CodexControlClientLike,
} from "./types.js";

type CodexControlModule = {
  CodexControlClient: new (options?: Record<string, unknown>) => CodexControlClientLike;
};

export function createDefaultClientFactory(
  codexControlPath = process.env.CODEX_CONTROL_PATH ??
    "/home/developer/scratch/codex-control/dist/src/index.js",
): CodexControlClientFactory {
  return (context?: CodexControlClientContext) => {
    let clientPromise: Promise<CodexControlClientLike> | null = null;
    return {
      async startSession(options: Record<string, unknown>) {
        return (await client()).startSession(options);
      },
      async resumeSession(threadId: string) {
        return (await client()).resumeSession(threadId);
      },
      async close() {
        if (clientPromise) {
          await (await clientPromise).close();
        }
      },
    };

    async function client(): Promise<CodexControlClientLike> {
      clientPromise ??= import(pathToFileURL(codexControlPath).href).then((module) => {
        const { CodexControlClient } = module as CodexControlModule;
        return new CodexControlClient({
          approvalHandler: context?.approvalHandler,
        });
      });
      return clientPromise;
    }
  };
}
