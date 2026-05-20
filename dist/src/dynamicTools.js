export class DynamicToolManager {
    handlers = new Map();
    register(threadId, tools = []) {
        for (const tool of tools) {
            if (tool.handler) {
                this.handlers.set(this.key(threadId, tool.name), tool.handler);
            }
        }
    }
    specs(tools = []) {
        return tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            deferLoading: tool.deferLoading ?? false,
        }));
    }
    canHandle(message) {
        if (message.method !== "item/tool/call") {
            return false;
        }
        const params = (message.params ?? {});
        return this.handlers.has(this.key(String(params.threadId ?? ""), String(params.tool ?? "")));
    }
    async handle(message) {
        const params = (message.params ?? {});
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
        }
        catch (error) {
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
    key(threadId, tool) {
        return `${threadId}:${tool}`;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=dynamicTools.js.map