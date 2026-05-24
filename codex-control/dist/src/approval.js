export class ApprovalManager {
    auditSink;
    approvalHandler;
    activeOptions = null;
    constructor(auditSink, approvalHandler) {
        this.auditSink = auditSink;
        this.approvalHandler = approvalHandler;
    }
    setActiveTurnOptions(options) {
        this.activeOptions = options;
    }
    clearActiveTurnOptions() {
        this.activeOptions = null;
    }
    async handle(message) {
        const method = message.method ?? "";
        const params = (message.params ?? {});
        let { result, decision } = this.defaultDecision(method, params);
        if (this.activeOptions && this.approvalHandler && this.isUserApprovalMethod(method)) {
            const response = await this.approvalHandler({
                timestamp: new Date().toISOString(),
                kind: this.auditKind(method),
                method,
                params,
                proposedDecision: decision,
                proposedResult: result,
            });
            decision = response.decision;
            result = response.result ?? this.resultForDecision(method, params, decision);
        }
        const auditRecord = {
            timestamp: new Date().toISOString(),
            kind: this.auditKind(method),
            decision,
            method,
            params,
            result,
        };
        if (this.activeOptions?.confirmation?.reason) {
            auditRecord.reason = this.activeOptions.confirmation.reason;
        }
        await this.audit(auditRecord);
        return result;
    }
    defaultDecision(method, params) {
        if (method === "item/commandExecution/requestApproval") {
            const approved = this.activeOptions?.shellCommands === "allow" && this.confirmed();
            return {
                result: { decision: approved ? "accept" : "decline" },
                decision: approved ? "approved" : "declined",
            };
        }
        else if (method === "item/fileChange/requestApproval") {
            const approved = this.activeOptions?.fileWrites === "allow" && this.confirmed();
            return {
                result: { decision: approved ? "accept" : "decline" },
                decision: approved ? "approved" : "declined",
            };
        }
        else if (method === "item/permissions/requestApproval") {
            const result = this.permissionsResult(params);
            return {
                result,
                decision: Object.keys(result.permissions).length
                    ? "approved"
                    : "declined",
            };
        }
        else if (method === "mcpServer/elicitation/request") {
            const result = this.elicitationResult(params);
            return {
                result,
                decision: result.action === "accept" ? "approved" : "declined",
            };
        }
        else if (method === "item/tool/requestUserInput") {
            return { result: { answer: null }, decision: "declined" };
        }
        else if (method === "account/chatgptAuthTokens/refresh") {
            return {
                result: { accessToken: null, idToken: null, accountId: null },
                decision: "declined",
            };
        }
        else if (method === "item/tool/call") {
            return {
                result: {
                    success: false,
                    contentItems: [
                        {
                            type: "inputText",
                            text: "codex-control does not execute dynamic client-side tools.",
                        },
                    ],
                },
                decision: "declined",
            };
        }
        return { result: {}, decision: "declined" };
    }
    resultForDecision(method, params, decision) {
        if (method === "item/commandExecution/requestApproval") {
            return { decision: decision === "approved" ? "accept" : "decline" };
        }
        if (method === "item/fileChange/requestApproval") {
            return { decision: decision === "approved" ? "accept" : "decline" };
        }
        if (method === "item/permissions/requestApproval") {
            return decision === "approved"
                ? { permissions: { ...(params.permissions ?? {}) }, scope: "turn" }
                : { permissions: {}, scope: "turn" };
        }
        if (method === "mcpServer/elicitation/request") {
            return decision === "approved"
                ? this.acceptedElicitationResult(params)
                : { action: "decline", content: null, _meta: null };
        }
        return {};
    }
    permissionsResult(params) {
        const requested = (params.permissions ?? {});
        const permissions = {};
        if (requested.network !== undefined && this.activeOptions?.network !== "deny") {
            permissions.network = requested.network;
        }
        if (requested.fileSystem !== undefined &&
            this.activeOptions?.fileWrites === "allow" &&
            this.confirmed()) {
            permissions.fileSystem = requested.fileSystem;
        }
        return { permissions, scope: "turn" };
    }
    elicitationResult(params) {
        if (this.activeOptions?.externalWrites !== "allow" ||
            !this.confirmed() ||
            params.mode !== "form") {
            return { action: "decline", content: null, _meta: null };
        }
        return this.acceptedElicitationResult(params);
    }
    acceptedElicitationResult(params) {
        return {
            action: "accept",
            content: this.elicitationContent((params.requestedSchema ?? {})),
            _meta: null,
        };
    }
    elicitationContent(schema) {
        const properties = (schema.properties ?? {});
        const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : Object.keys(properties));
        const content = {};
        for (const [name, field] of Object.entries(properties)) {
            if (!required.has(name)) {
                continue;
            }
            content[name] = this.elicitationValue(name, field);
        }
        return content;
    }
    elicitationValue(name, field) {
        const fieldType = field.type;
        const label = `${name} ${String(field.title ?? "")} ${String(field.description ?? "")}`
            .trim()
            .toLowerCase();
        if (fieldType === "boolean") {
            return /confirm|approve|send|post|accept/.test(label) ? true : Boolean(field.default ?? true);
        }
        if (fieldType === "string") {
            const values = Array.isArray(field.enum) ? field.enum : [];
            const preferred = values.find((value) => ["yes", "confirm", "approve", "accept"].includes(String(value).toLowerCase()));
            return preferred ?? field.default ?? "";
        }
        if (fieldType === "number" || fieldType === "integer") {
            return field.default ?? 0;
        }
        return field.default ?? null;
    }
    confirmed() {
        return this.activeOptions?.confirmation?.confirmed === true;
    }
    auditKind(method) {
        if (method === "item/commandExecution/requestApproval") {
            return "command_approval";
        }
        if (method === "item/fileChange/requestApproval") {
            return "file_approval";
        }
        if (method === "item/permissions/requestApproval") {
            return "permission_approval";
        }
        if (method === "mcpServer/elicitation/request") {
            return "mcp_elicitation";
        }
        return "dynamic_tool_call";
    }
    isUserApprovalMethod(method) {
        return this.auditKind(method) !== "dynamic_tool_call";
    }
    async audit(entry) {
        await this.auditSink?.record(entry);
    }
}
//# sourceMappingURL=approval.js.map