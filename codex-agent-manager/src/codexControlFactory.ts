import { isAbsolute, resolve } from "node:path";
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
  codexControlModule = process.env.CODEX_CONTROL_PATH ?? "codex-control",
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
      async listModels(options?: { includeHidden?: boolean }) {
        const loaded = await client();
        if (!loaded.listModels) {
          return { models: [] };
        }
        return loaded.listModels(options);
      },
      async close() {
        if (clientPromise) {
          await (await clientPromise).close();
        }
      },
    };

    async function client(): Promise<CodexControlClientLike> {
      clientPromise ??= importCodexControl(codexControlModule).then((module) => {
        const { CodexControlClient } = module as CodexControlModule;
        return new CodexControlClient({
          approvalHandler: context?.approvalHandler,
        });
      });
      return clientPromise;
    }
  };
}

function importCodexControl(specifier: string): Promise<unknown> {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("..")) {
    const path = isAbsolute(specifier) ? specifier : resolve(specifier);
    return import(pathToFileURL(path).href);
  }
  return import(specifier);
}
