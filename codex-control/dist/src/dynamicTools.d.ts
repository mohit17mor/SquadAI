import type { DynamicTool, DynamicToolCallResponse, DynamicToolSpec, JsonRpcMessage } from "./types.js";
export declare class DynamicToolManager {
    private readonly handlers;
    register(threadId: string, tools?: DynamicTool[]): void;
    specs(tools?: DynamicTool[]): DynamicToolSpec[];
    canHandle(message: JsonRpcMessage): boolean;
    handle(message: JsonRpcMessage): Promise<DynamicToolCallResponse>;
    private key;
}
