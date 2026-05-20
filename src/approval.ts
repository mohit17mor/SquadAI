import type {
  ApprovalHandler,
  AskOptions,
  AuditDecision,
  AuditRecord,
  AuditSink,
  JsonRpcMessage,
} from "./types.js";

type JsonObject = Record<string, unknown>;

export class ApprovalManager {
  private activeOptions: AskOptions = {};

  constructor(
    private readonly auditSink?: AuditSink,
    private readonly approvalHandler?: ApprovalHandler,
  ) {}

  setActiveTurnOptions(options: AskOptions): void {
    this.activeOptions = options;
  }

  clearActiveTurnOptions(): void {
    this.activeOptions = {};
  }

  async handle(message: JsonRpcMessage): Promise<unknown> {
    const method = message.method ?? "";
    const params = (message.params ?? {}) as JsonObject;
    let { result, decision } = this.defaultDecision(method, params);

    if (this.approvalHandler && this.isUserApprovalMethod(method)) {
      const response = await this.approvalHandler({
        timestamp: new Date().toISOString(),
        kind: this.auditKind(method) as Exclude<AuditRecord["kind"], "dynamic_tool_call">,
        method,
        params,
        proposedDecision: decision,
        proposedResult: result,
      });
      decision = response.decision;
      result = response.result ?? this.resultForDecision(method, params, decision);
    }

    const auditRecord: AuditRecord = {
      timestamp: new Date().toISOString(),
      kind: this.auditKind(method),
      decision,
      method,
      params,
      result,
    };
    if (this.activeOptions.confirmation?.reason) {
      auditRecord.reason = this.activeOptions.confirmation.reason;
    }
    await this.audit(auditRecord);
    return result;
  }

  private defaultDecision(
    method: string,
    params: JsonObject,
  ): { result: unknown; decision: AuditDecision } {
    if (method === "item/commandExecution/requestApproval") {
      const approved = this.activeOptions.shellCommands === "allow" && this.confirmed();
      return {
        result: { decision: approved ? "accept" : "decline" },
        decision: approved ? "approved" : "declined",
      };
    } else if (method === "item/fileChange/requestApproval") {
      const approved = this.activeOptions.fileWrites === "allow" && this.confirmed();
      return {
        result: { decision: approved ? "accept" : "decline" },
        decision: approved ? "approved" : "declined",
      };
    } else if (method === "item/permissions/requestApproval") {
      const result = this.permissionsResult(params);
      return {
        result,
        decision: Object.keys((result as JsonObject).permissions as JsonObject).length
          ? "approved"
          : "declined",
      };
    } else if (method === "mcpServer/elicitation/request") {
      const result = this.elicitationResult(params);
      return {
        result,
        decision: (result as JsonObject).action === "accept" ? "approved" : "declined",
      };
    } else if (method === "item/tool/requestUserInput") {
      return { result: { answer: null }, decision: "declined" };
    } else if (method === "account/chatgptAuthTokens/refresh") {
      return {
        result: { accessToken: null, idToken: null, accountId: null },
        decision: "declined",
      };
    } else if (method === "item/tool/call") {
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

  private resultForDecision(
    method: string,
    params: JsonObject,
    decision: Exclude<AuditDecision, "failed">,
  ): unknown {
    if (method === "item/commandExecution/requestApproval") {
      return { decision: decision === "approved" ? "accept" : "decline" };
    }
    if (method === "item/fileChange/requestApproval") {
      return { decision: decision === "approved" ? "accept" : "decline" };
    }
    if (method === "item/permissions/requestApproval") {
      return decision === "approved"
        ? { permissions: { ...((params.permissions ?? {}) as JsonObject) }, scope: "turn" }
        : { permissions: {}, scope: "turn" };
    }
    if (method === "mcpServer/elicitation/request") {
      return decision === "approved"
        ? this.acceptedElicitationResult(params)
        : { action: "decline", content: null, _meta: null };
    }
    return {};
  }

  private permissionsResult(params: JsonObject): JsonObject {
    const requested = (params.permissions ?? {}) as JsonObject;
    const permissions: JsonObject = {};

    if (requested.network !== undefined && this.activeOptions.network !== "deny") {
      permissions.network = requested.network;
    }

    if (
      requested.fileSystem !== undefined &&
      this.activeOptions.fileWrites === "allow" &&
      this.confirmed()
    ) {
      permissions.fileSystem = requested.fileSystem;
    }

    return { permissions, scope: "turn" };
  }

  private elicitationResult(params: JsonObject): JsonObject {
    if (
      this.activeOptions.externalWrites !== "allow" ||
      !this.confirmed() ||
      params.mode !== "form"
    ) {
      return { action: "decline", content: null, _meta: null };
    }

    return this.acceptedElicitationResult(params);
  }

  private acceptedElicitationResult(params: JsonObject): JsonObject {
    return {
      action: "accept",
      content: this.elicitationContent((params.requestedSchema ?? {}) as JsonObject),
      _meta: null,
    };
  }

  private elicitationContent(schema: JsonObject): JsonObject {
    const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
    const required = new Set(
      Array.isArray(schema.required) ? schema.required.map(String) : Object.keys(properties),
    );
    const content: JsonObject = {};

    for (const [name, field] of Object.entries(properties)) {
      if (!required.has(name)) {
        continue;
      }
      content[name] = this.elicitationValue(name, field);
    }
    return content;
  }

  private elicitationValue(name: string, field: JsonObject): unknown {
    const fieldType = field.type;
    const label = `${name} ${String(field.title ?? "")} ${String(field.description ?? "")}`
      .trim()
      .toLowerCase();

    if (fieldType === "boolean") {
      return /confirm|approve|send|post|accept/.test(label) ? true : Boolean(field.default ?? true);
    }

    if (fieldType === "string") {
      const values = Array.isArray(field.enum) ? field.enum : [];
      const preferred = values.find((value) =>
        ["yes", "confirm", "approve", "accept"].includes(String(value).toLowerCase()),
      );
      return preferred ?? field.default ?? "";
    }

    if (fieldType === "number" || fieldType === "integer") {
      return field.default ?? 0;
    }

    return field.default ?? null;
  }

  private confirmed(): boolean {
    return this.activeOptions.confirmation?.confirmed === true;
  }

  private auditKind(method: string): AuditRecord["kind"] {
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

  private isUserApprovalMethod(method: string): boolean {
    return this.auditKind(method) !== "dynamic_tool_call";
  }

  private async audit(entry: AuditRecord): Promise<void> {
    await this.auditSink?.record(entry);
  }
}
