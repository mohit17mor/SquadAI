import type { AppServerTransport, JsonRpcMessage } from "./types.js";
export type StdioTransportOptions = {
    command?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
};
export declare const CODEX_DESKTOP_BINARY = "/Applications/Codex.app/Contents/Resources/codex";
export type CodexBinaryResolutionOptions = {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    isExecutable?: (path: string) => boolean;
};
export type CodexLaunchResolutionOptions = {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
};
export type CodexLaunchSpec = {
    command: string;
    args: string[];
    windowsVerbatimArguments?: boolean;
};
export declare function resolveCodexBinary(options?: CodexBinaryResolutionOptions): string;
export declare function createCodexLaunchSpec(command: string, args: string[], options?: CodexLaunchResolutionOptions): CodexLaunchSpec;
export declare class StdioCodexAppServerTransport implements AppServerTransport {
    private readonly command;
    private readonly args;
    private readonly env;
    private child;
    private messageHandlers;
    private closeHandlers;
    constructor(options?: StdioTransportOptions);
    getCommand(): string;
    start(): Promise<void>;
    send(message: JsonRpcMessage): void;
    onMessage(handler: (message: JsonRpcMessage) => void): void;
    onClose(handler: (error?: Error) => void): void;
    close(): Promise<void>;
    private emitClose;
}
