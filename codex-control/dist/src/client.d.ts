import { CodexSession } from "./session.js";
import type { AppServerTransport, ApprovalHandler, AuditSink, CodexRuntimeInfo, ModelListOptions, ModelListResult, SessionResumeOptions, SessionStartOptions, SkillListOptions, SkillListResult } from "./types.js";
export type CodexControlClientOptions = {
    transport?: AppServerTransport;
    requestTimeoutMs?: number;
    auditSink?: AuditSink;
    approvalHandler?: ApprovalHandler;
};
export declare class CodexControlClient {
    private readonly transport;
    private readonly peer;
    private readonly approvalManager;
    private readonly dynamicToolManager;
    private readonly sessions;
    private started;
    private runtimeInfo;
    constructor(options?: CodexControlClientOptions);
    start(): Promise<void>;
    getRuntimeInfo(): Promise<CodexRuntimeInfo>;
    startSession(options: SessionStartOptions): Promise<CodexSession>;
    resumeSession(threadId: string, options?: SessionResumeOptions): Promise<CodexSession>;
    listModels(options?: ModelListOptions): Promise<ModelListResult>;
    listSkills(options: SkillListOptions): Promise<SkillListResult>;
    close(): Promise<void>;
    private handleNotification;
}
