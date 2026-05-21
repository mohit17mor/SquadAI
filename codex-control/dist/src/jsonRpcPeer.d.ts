import { type AppServerTransport, type JsonRpcMessage } from "./types.js";
export type ServerRequestHandler = (message: JsonRpcMessage) => Promise<unknown>;
export type NotificationHandler = (message: JsonRpcMessage) => void;
export declare class JsonRpcPeer {
    private readonly transport;
    private readonly requestTimeoutMs;
    private nextId;
    private readonly pending;
    private serverRequestHandler;
    private notificationHandler;
    private closed;
    constructor(transport: AppServerTransport, requestTimeoutMs?: number);
    start(): Promise<void>;
    onServerRequest(handler: ServerRequestHandler): void;
    onNotification(handler: NotificationHandler): void;
    request<T = unknown>(method: string, params: Record<string, unknown> | undefined, timeoutMs?: number): Promise<T>;
    notify(method: string, params?: Record<string, unknown>): void;
    close(): Promise<void>;
    private handleMessage;
    private handleResponse;
    private handleServerRequest;
    private failPending;
}
