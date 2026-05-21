import { EventEmitter } from "node:events";

import { ApprovalManager } from "./approval.js";
import type { JsonRpcPeer } from "./jsonRpcPeer.js";
import {
  CodexControlError,
  CodexTurnTimeoutError,
  type AskOptions,
  type JsonRpcMessage,
  type SessionStartOptions,
  type TurnResult,
} from "./types.js";

type ActiveTurn = {
  options: AskOptions;
  turnId: string | null;
  turnIdReady: Promise<string>;
  resolveTurnId: (turnId: string) => void;
  rejectTurnId: (error: Error) => void;
  finalText: string;
  items: unknown[];
  lastActivity: string;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
};

type ItemWithText = {
  type?: string;
  text?: string;
};

export class CodexSession extends EventEmitter {
  private activeTurn: ActiveTurn | null = null;

  constructor(
    private readonly peer: JsonRpcPeer,
    private readonly approvalManager: ApprovalManager,
    readonly threadId: string,
  ) {
    super();
  }

  async ask(input: string, options: AskOptions = {}): Promise<TurnResult> {
    if (this.activeTurn) {
      throw new CodexControlError("A Codex turn is already in progress for this session.");
    }

    const timeoutMs = options.timeoutMs ?? 240_000;
    this.approvalManager.setActiveTurnOptions(options);

    let timeout: NodeJS.Timeout | null = null;
    const resultPromise = new Promise<TurnResult>((resolve, reject) => {
      let resolveTurnId!: (turnId: string) => void;
      let rejectTurnId!: (error: Error) => void;
      const turnIdReady = new Promise<string>((turnResolve, turnReject) => {
        resolveTurnId = turnResolve;
        rejectTurnId = turnReject;
      });
      turnIdReady.catch(() => {});
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
        this.failActiveTurn(
          new CodexTurnTimeoutError(
            `Timed out waiting for Codex turn after ${timeoutMs}ms. Last activity: ${lastActivity}`,
          ),
        );
      }, timeoutMs);
    });

    try {
      const started = await this.peer.request<{ turn?: { id?: string } }>("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: input }],
      });
      const active = this.activeTurn as ActiveTurn | null;
      if (active) {
        const turnId = started.turn?.id ?? null;
        active.turnId = turnId;
        if (turnId) {
          active.resolveTurnId(turnId);
        } else {
          active.rejectTurnId(new CodexControlError("App Server did not return a turn id."));
        }
      }
      return await resultPromise;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.failActiveTurn(normalized);
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      this.approvalManager.clearActiveTurnOptions();
    }
  }

  handleNotification(message: JsonRpcMessage): boolean {
    const method = message.method ?? "";
    const params = (message.params ?? {}) as Record<string, unknown>;
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
      const item = (params.item ?? {}) as ItemWithText;
      active.items.push(item);
      if (item.type === "agentMessage" && item.text) {
        active.finalText = item.text;
      }
      this.emit("item.completed", item);
      return true;
    }

    if (method === "turn/completed") {
      const turn = (params.turn ?? {}) as Record<string, unknown>;
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

  async compact(): Promise<void> {
    await this.peer.request("thread/compact/start", { threadId: this.threadId });
  }

  async interrupt(): Promise<void> {
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

  private failActiveTurn(error: Error): void {
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

export function threadStartParams(options: SessionStartOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model: options.model,
    serviceTier: options.serviceTier,
    cwd: options.cwd,
    approvalPolicy: options.approvalPolicy,
    sandbox: options.sandbox,
    baseInstructions: options.baseInstructions,
    developerInstructions: options.developerInstructions,
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  };
  if (options.reasoningEffort) {
    params.config = {
      model_reasoning_effort: options.reasoningEffort,
    };
  }
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
