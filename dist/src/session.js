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
            let resolveTurnId;
            let rejectTurnId;
            const turnIdReady = new Promise((turnResolve, turnReject) => {
                resolveTurnId = turnResolve;
                rejectTurnId = turnReject;
            });
            turnIdReady.catch(() => { });
            this.activeTurn = {
                options,
                turnId: null,
                turnIdReady,
                resolveTurnId,
                rejectTurnId,
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
            const started = await this.peer.request("turn/start", {
                threadId: this.threadId,
                input: [{ type: "text", text: input }],
            });
            const active = this.activeTurn;
            if (active) {
                const turnId = started.turn?.id ?? null;
                active.turnId = turnId;
                if (turnId) {
                    active.resolveTurnId(turnId);
                }
                else {
                    active.rejectTurnId(new CodexControlError("App Server did not return a turn id."));
                }
            }
            return await resultPromise;
        }
        catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            this.failActiveTurn(normalized);
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
                turnId: typeof turn.id === "string" ? turn.id : active.turnId,
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
    async interrupt() {
        const active = this.activeTurn;
        if (!active) {
            throw new CodexControlError("No active Codex turn to interrupt.");
        }
        const turnId = active.turnId ?? await active.turnIdReady;
        await this.peer.request("turn/interrupt", {
            threadId: this.threadId,
            turnId,
        });
    }
    failActiveTurn(error) {
        const active = this.activeTurn;
        if (!active) {
            return;
        }
        this.activeTurn = null;
        active.rejectTurnId(error);
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