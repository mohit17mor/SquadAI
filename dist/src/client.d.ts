import { CodexSession } from "./session.js";
import type { AppServerTransport, ApprovalHandler, AuditSink, ModelListOptions, ModelListResult, SessionStartOptions } from "./types.js";
export type CodexControlClientOptions = {
    transport?: AppServerTransport;
    requestTimeoutMs?: number;
    auditSink?: AuditSink;
    approvalHandler?: ApprovalHandler;
};
export declare class CodexControlClient {
    private readonly peer;
    private readonly approvalManager;
    private readonly dynamicToolManager;
    private readonly sessions;
    private started;
    constructor(options?: CodexControlClientOptions);
    start(): Promise<void>;
    startSession(options: SessionStartOptions): Promise<CodexSession>;
    resumeSession(threadId: string): Promise<CodexSession>;
    listModels(options?: ModelListOptions): Promise<ModelListResult>;
    close(): Promise<void>;
    private handleNotification;
}
