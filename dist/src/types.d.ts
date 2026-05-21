export type JsonRpcId = number | string;
export type JsonRpcMessage = {
    id?: JsonRpcId;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
};
export interface AppServerTransport {
    start(): Promise<void>;
    send(message: JsonRpcMessage): void;
    onMessage(handler: (message: JsonRpcMessage) => void): void;
    onClose(handler: (error?: Error) => void): void;
    close(): Promise<void>;
}
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ExternalWritePolicy = "deny" | "allow";
export type MutationPolicy = "deny" | "allow";
export type SessionStartOptions = {
    cwd: string;
    model?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    baseInstructions?: string;
    developerInstructions?: string;
    dynamicTools?: DynamicTool[];
};
export type Confirmation = {
    confirmed: boolean;
    reason?: string;
};
export type AskOptions = {
    timeoutMs?: number;
    externalWrites?: ExternalWritePolicy;
    shellCommands?: MutationPolicy;
    fileWrites?: MutationPolicy;
    network?: MutationPolicy;
    confirmation?: Confirmation;
};
export type AuditDecision = "approved" | "declined" | "failed";
export type ApprovalRequest = {
    timestamp: string;
    kind: "command_approval" | "file_approval" | "permission_approval" | "mcp_elicitation";
    method: string;
    params: unknown;
    proposedDecision: AuditDecision;
    proposedResult: unknown;
};
export type ApprovalResponse = {
    decision: Exclude<AuditDecision, "failed">;
    reason?: string;
    result?: unknown;
};
export type ApprovalHandler = (request: ApprovalRequest) => ApprovalResponse | Promise<ApprovalResponse>;
export type AuditRecord = {
    timestamp: string;
    kind: "command_approval" | "file_approval" | "permission_approval" | "mcp_elicitation" | "dynamic_tool_call";
    decision: AuditDecision;
    reason?: string;
    method: string;
    params: unknown;
    result: unknown;
};
export interface AuditSink {
    record(entry: AuditRecord): void | Promise<void>;
}
export type TurnResult = {
    threadId: string;
    turnId: string | null;
    finalText: string;
    turn: Record<string, unknown>;
    items: unknown[];
};
export type DynamicToolSpec = {
    name: string;
    description: string;
    inputSchema: unknown;
    deferLoading?: boolean;
};
export type DynamicToolCallOutputContentItem = {
    type: "inputText";
    text: string;
} | {
    type: "inputImage";
    imageUrl: string;
};
export type DynamicToolCallResponse = {
    contentItems: DynamicToolCallOutputContentItem[];
    success: boolean;
};
export type DynamicToolHandler = (args: Record<string, unknown>, params: Record<string, unknown>) => DynamicToolCallResponse | Promise<DynamicToolCallResponse>;
export type DynamicTool = DynamicToolSpec & {
    handler?: DynamicToolHandler;
};
export declare class CodexControlError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export declare class CodexTurnTimeoutError extends CodexControlError {
    constructor(message: string);
}
