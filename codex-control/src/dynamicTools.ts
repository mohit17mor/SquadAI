import type {
  DynamicTool,
  DynamicToolCallResponse,
  DynamicToolSpec,
  JsonRpcMessage,
} from "./types.js";

type JsonObject = Record<string, unknown>;

export class DynamicToolManager {
  private readonly handlers = new Map<string, DynamicTool["handler"]>();

  register(threadId: string, tools: DynamicTool[] = []): void {
    for (const tool of tools) {
      if (tool.handler) {
        this.handlers.set(this.key(threadId, tool.name), tool.handler);
      }
    }
  }

  specs(tools: DynamicTool[] = []): DynamicToolSpec[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      deferLoading: tool.deferLoading ?? false,
    }));
  }

  canHandle(message: JsonRpcMessage): boolean {
    if (message.method !== "item/tool/call") {
      return false;
    }
    const params = (message.params ?? {}) as JsonObject;
    return this.handlers.has(this.key(String(params.threadId ?? ""), String(params.tool ?? "")));
  }

  async handle(message: JsonRpcMessage): Promise<DynamicToolCallResponse> {
    const params = (message.params ?? {}) as JsonObject;
    const threadId = String(params.threadId ?? "");
    const tool = String(params.tool ?? "");
    const handler = this.handlers.get(this.key(threadId, tool));
    if (!handler) {
      return {
        contentItems: [
          { type: "inputText", text: `No dynamic tool handler registered for ${tool}.` },
        ],
        success: false,
      };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      return await handler(args, params);
    } catch (error) {
      return {
        contentItems: [
          {
            type: "inputText",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        success: false,
      };
    }
  }

  private key(threadId: string, tool: string): string {
    return `${threadId}:${tool}`;
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
