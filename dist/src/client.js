import { ApprovalManager } from "./approval.js";
import { DynamicToolManager } from "./dynamicTools.js";
import { JsonRpcPeer } from "./jsonRpcPeer.js";
import { CodexSession, threadStartParams } from "./session.js";
import { StdioCodexAppServerTransport } from "./stdioTransport.js";
export class CodexControlClient {
    peer;
    approvalManager;
    dynamicToolManager = new DynamicToolManager();
    sessions = new Map();
    started = false;
    constructor(options = {}) {
        const transport = options.transport ?? new StdioCodexAppServerTransport();
        this.peer = new JsonRpcPeer(transport, options.requestTimeoutMs);
        this.approvalManager = new ApprovalManager(options.auditSink, options.approvalHandler);
        this.peer.onServerRequest((message) => this.dynamicToolManager.canHandle(message)
            ? this.dynamicToolManager.handle(message)
            : this.approvalManager.handle(message));
        this.peer.onNotification((message) => this.handleNotification(message));
    }
    async start() {
        if (this.started) {
            return;
        }
        await this.peer.start();
        await this.peer.request("initialize", {
            clientInfo: {
                name: "codex_control",
                title: "Codex Control",
                version: "0.1.0",
            },
            capabilities: {
                experimentalApi: true,
            },
        });
        this.peer.notify("initialized", {});
        this.started = true;
    }
    async startSession(options) {
        await this.start();
        const result = await this.peer.request("thread/start", threadStartParams(options));
        const threadId = result.thread?.id;
        if (!threadId) {
            throw new Error("App Server did not return a thread id.");
        }
        const session = new CodexSession(this.peer, this.approvalManager, threadId);
        this.dynamicToolManager.register(threadId, options.dynamicTools);
        this.sessions.set(threadId, session);
        return session;
    }
    async resumeSession(threadId) {
        await this.start();
        await this.peer.request("thread/resume", { threadId });
        const session = new CodexSession(this.peer, this.approvalManager, threadId);
        this.sessions.set(threadId, session);
        return session;
    }
    async listModels(options = {}) {
        await this.start();
        const models = [];
        let cursor;
        do {
            const response = await this.peer.request("model/list", {
                includeHidden: options.includeHidden === true,
                cursor: cursor ?? null,
            });
            models.push(...(response.data ?? []));
            cursor = response.nextCursor ?? null;
        } while (cursor);
        return { models: models.map(normalizeModelOption) };
    }
    async close() {
        await this.peer.close();
    }
    handleNotification(message) {
        const params = (message.params ?? {});
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        if (threadId) {
            this.sessions.get(threadId)?.handleNotification(message);
            return;
        }
        for (const session of this.sessions.values()) {
            if (session.handleNotification(message)) {
                return;
            }
        }
    }
}
function normalizeModelOption(value) {
    const record = isRecord(value) ? value : {};
    return {
        id: stringValue(record.id),
        model: stringValue(record.model),
        displayName: stringValue(record.displayName),
        description: stringValue(record.description),
        hidden: record.hidden === true,
        supportedReasoningEfforts: Array.isArray(record.supportedReasoningEfforts)
            ? record.supportedReasoningEfforts.map(normalizeReasoningEffortOption)
            : [],
        defaultReasoningEffort: reasoningEffortValue(record.defaultReasoningEffort),
        additionalSpeedTiers: Array.isArray(record.additionalSpeedTiers)
            ? record.additionalSpeedTiers.map(String)
            : [],
        serviceTiers: Array.isArray(record.serviceTiers)
            ? record.serviceTiers.map(normalizeServiceTier)
            : [],
        isDefault: record.isDefault === true,
    };
}
function normalizeReasoningEffortOption(value) {
    const record = isRecord(value) ? value : {};
    return {
        reasoningEffort: reasoningEffortValue(record.reasoningEffort),
        description: stringValue(record.description),
    };
}
function normalizeServiceTier(value) {
    const record = isRecord(value) ? value : {};
    return {
        id: stringValue(record.id),
        name: stringValue(record.name),
        description: stringValue(record.description),
    };
}
function reasoningEffortValue(value) {
    return isReasoningEffort(value) ? value : "medium";
}
function isReasoningEffort(value) {
    return value === "none" ||
        value === "minimal" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh";
}
function stringValue(value) {
    return typeof value === "string" ? value : "";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=client.js.map