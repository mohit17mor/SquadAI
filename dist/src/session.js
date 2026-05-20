import { EventEmitter } from "node:events";
import { CodexControlError, CodexTurnTimeoutError, } from "./types.js";
export class CodexSession extends EventEmitter {
    peer;
    approvalManager;
    threadId;
    activeTurn = null;
    constructor(peer, approvalManager, threadId) {
        super();
        this.peer = peer;
        this.approvalManager = approvalManager;
        this.threadId = threadId;
    }
    async ask(input, options = {}) {
        if (this.activeTurn) {
            throw new CodexControlError("A Codex turn is already in progress for this session.");
        }
        const timeoutMs = options.timeoutMs ?? 240_000;
        this.approvalManager.setActiveTurnOptions(options);
        let timeout = null;
        const resultPromise = new Promise((resolve, reject) => {
            this.activeTurn = {
                options,
                finalText: "",
                items: [],
                lastActivity: "turn/start",
                resolve,
                reject,
            };
            timeout = setTimeout(() => {
                const lastActivity = this.activeTurn?.lastActivity ?? "unknown";
                this.failActiveTurn(new CodexTurnTimeoutError(`Timed out waiting for Codex turn after ${timeoutMs}ms. Last activity: ${lastActivity}`));
            }, timeoutMs);
        });
        try {
            await this.peer.request("turn/start", {
                threadId: this.threadId,
                input: [{ type: "text", text: input }],
            });
            return await resultPromise;
        }
        catch (error) {
            this.failActiveTurn(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        finally {
            if (timeout) {
                clearTimeout(timeout);
            }
            this.approvalManager.clearActiveTurnOptions();
        }
    }
    handleNotification(message) {
        const method = message.method ?? "";
        const params = (message.params ?? {});
        const active = this.activeTurn;
        if (!active) {
            return false;
        }
        active.lastActivity = method;
        if (method === "item/agentMessage/delta") {
            active.finalText += String(params.delta ?? "");
            this.emit("message.delta", params.delta ?? "");
            return true;
        }
        if (method === "item/completed") {
            const item = (params.item ?? {});
            active.items.push(item);
            if (item.type === "agentMessage" && item.text) {
                active.finalText = item.text;
            }
            this.emit("item.completed", item);
            return true;
        }
        if (method === "turn/completed") {
            const turn = (params.turn ?? {});
            if (turn.status === "failed") {
                this.failActiveTurn(new CodexControlError(JSON.stringify(turn.error ?? turn)));
                return true;
            }
            active.resolve({
                threadId: String(params.threadId ?? this.threadId),
                finalText: active.finalText.trim(),
                turn,
                items: active.items,
            });
            this.activeTurn = null;
            this.emit("turn.completed", turn);
            return true;
        }
        if (method === "thread/compacted") {
            this.emit("thread.compacted", params);
            return true;
        }
        if (method === "error") {
            this.failActiveTurn(new CodexControlError(JSON.stringify(params)));
            return true;
        }
        return false;
    }
    async compact() {
        await this.peer.request("thread/compact/start", { threadId: this.threadId });
    }
    failActiveTurn(error) {
        const active = this.activeTurn;
        if (!active) {
            return;
        }
        this.activeTurn = null;
        active.reject(error);
        this.emit("turn.failed", error);
    }
}
export function threadStartParams(options) {
    const params = {
        model: options.model,
        cwd: options.cwd,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        baseInstructions: options.baseInstructions,
        developerInstructions: options.developerInstructions,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
    };
    if (options.dynamicTools?.length) {
        params.dynamicTools = options.dynamicTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            deferLoading: tool.deferLoading ?? false,
        }));
    }
    return params;
}
//# sourceMappingURL=session.js.map