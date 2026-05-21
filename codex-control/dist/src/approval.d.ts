import type { ApprovalHandler, AskOptions, AuditSink, JsonRpcMessage } from "./types.js";
export declare class ApprovalManager {
    private readonly auditSink?;
    private readonly approvalHandler?;
    private activeOptions;
    constructor(auditSink?: AuditSink | undefined, approvalHandler?: ApprovalHandler | undefined);
    setActiveTurnOptions(options: AskOptions): void;
    clearActiveTurnOptions(): void;
    handle(message: JsonRpcMessage): Promise<unknown>;
    private defaultDecision;
    private resultForDecision;
    private permissionsResult;
    private elicitationResult;
    private acceptedElicitationResult;
    private elicitationContent;
    private elicitationValue;
    private confirmed;
    private auditKind;
    private isUserApprovalMethod;
    private audit;
}
