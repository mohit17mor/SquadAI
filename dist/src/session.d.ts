import { EventEmitter } from "node:events";
import { ApprovalManager } from "./approval.js";
import type { JsonRpcPeer } from "./jsonRpcPeer.js";
import { type AskOptions, type JsonRpcMessage, type SessionStartOptions, type TurnResult } from "./types.js";
export declare class CodexSession extends EventEmitter {
    private readonly peer;
    private readonly approvalManager;
    readonly threadId: string;
    private activeTurn;
    constructor(peer: JsonRpcPeer, approvalManager: ApprovalManager, threadId: string);
    ask(input: string, options?: AskOptions): Promise<TurnResult>;
    handleNotification(message: JsonRpcMessage): boolean;
    compact(): Promise<void>;
    private failActiveTurn;
}
export declare function threadStartParams(options: SessionStartOptions): Record<string, unknown>;
