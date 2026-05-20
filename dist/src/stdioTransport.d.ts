import type { AppServerTransport, JsonRpcMessage } from "./types.js";
export type StdioTransportOptions = {
    command?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
};
export declare class StdioCodexAppServerTransport implements AppServerTransport {
    private readonly command;
    private readonly args;
    private readonly env;
    private child;
    private messageHandlers;
    private closeHandlers;
    constructor(options?: StdioTransportOptions);
    start(): Promise<void>;
    send(message: JsonRpcMessage): void;
    onMessage(handler: (message: JsonRpcMessage) => void): void;
    onClose(handler: (error?: Error) => void): void;
    close(): Promise<void>;
    private emitClose;
}
