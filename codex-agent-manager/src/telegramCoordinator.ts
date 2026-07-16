import type { CodexAgentManager } from "./manager.js";
import type { SqliteTelegramMessageStore, TelegramGroupMessage } from "./telegram.js";
import type { TelegramAgentBindingService } from "./telegramBindings.js";
import { TelegramBotMessenger } from "./telegramMessenger.js";
import type {
  SqliteTelegramRequestStore,
  TelegramAgentRequest,
  TelegramMentionIntake,
} from "./telegramRequests.js";
import type { AgentEvent, WorkItem } from "./types.js";

export type TelegramCoordinatorOptions = {
  manager: CodexAgentManager;
  bindings: TelegramAgentBindingService;
  mentionIntake: TelegramMentionIntake;
  requestStore: SqliteTelegramRequestStore;
  messageStore: SqliteTelegramMessageStore;
  controlBotToken: string;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  clock?: () => Date;
  logger?: Pick<Console, "error">;
};

export class TelegramCoordinator {
  private readonly messenger: TelegramBotMessenger;
  private readonly clock: () => Date;
  private readonly logger: Pick<Console, "error">;
  private started = false;
  private readonly managerEventListener = (event: AgentEvent): void => {
    void this.handleManagerEvent(event).catch((error) => {
      this.logger.error(`Telegram manager event failed: ${errorMessage(error)}`);
    });
  };

  constructor(private readonly options: TelegramCoordinatorOptions) {
    if (!options.controlBotToken.trim()) throw new Error("Telegram control bot token is required.");
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger ?? console;
    this.messenger = new TelegramBotMessenger({
      store: options.messageStore,
      clock: this.clock,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.options.manager.on("event", this.managerEventListener);
    for (const request of this.options.requestStore.listRequests()) {
      try {
        await this.recoverRequest(request);
      } catch (error) {
        this.logger.error(`Telegram request recovery failed: ${errorMessage(error)}`);
      }
    }
    await this.options.manager.dispatchQueuedWork();
  }

  async processMessage(message: TelegramGroupMessage): Promise<TelegramAgentRequest[]> {
    const createdRequests = this.options.mentionIntake.processMessage(message);
    const requests = createdRequests.length
      ? createdRequests
      : this.options.requestStore
        .listRequestsForMessage(message.chatId, message.messageId)
        .filter((request) => request.status === "detected");
    if (!requests.length) {
      await this.options.manager.dispatchQueuedWork();
      return [];
    }
    const context = this.options.messageStore.listRecentMessages(message.chatId, 20);
    const queued: TelegramAgentRequest[] = [];
    const failures: string[] = [];
    for (const request of requests) {
      try {
        queued.push(await this.queueRequest(request, message, context));
      } catch (error) {
        const failure = errorMessage(error);
        this.options.requestStore.markFailed(request, failure, this.now());
        failures.push(`@${request.botUsername}: ${failure}`);
      }
    }

    if (queued.length) {
      const labels = queued.map((request) => {
        const agent = this.options.manager.getAgent(request.agentId);
        const binding = this.bindingForAgent(request.agentId);
        return `${agent.name} (@${binding.botUsername})${binding.executionPolicy === "new" ? " as a new instance" : ""}`;
      });
      await this.safeSendControl(
        message.chatId,
        `Queued for ${joinLabels(labels)}.`,
        message.messageId,
      );
    }
    if (failures.length) {
      await this.safeSendControl(
        message.chatId,
        `Could not queue:\n${failures.join("\n")}`,
        message.messageId,
      );
    }
    await this.options.manager.dispatchQueuedWork();
    return queued;
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.options.manager.off("event", this.managerEventListener);
  }

  private async queueRequest(
    request: TelegramAgentRequest,
    latestMessage: TelegramGroupMessage,
    context: TelegramGroupMessage[],
  ): Promise<TelegramAgentRequest> {
    const binding = this.bindingForAgent(request.agentId);
    const agent = this.options.manager.getAgent(request.agentId);
    const event = await this.options.manager.ingestSensorEvent({
      source: "telegram",
      type: "group.mention",
      title: `Telegram request for ${agent.name}`,
      body: telegramAgentPrompt(latestMessage, context),
      targetAgentId: request.agentId,
      executionPolicy: binding.executionPolicy,
      dedupeKey: `telegram:${request.chatId}:${request.messageId}:${request.agentId}`,
      metadata: {
        telegramChatId: request.chatId,
        telegramMessageId: request.messageId,
        telegramAgentId: request.agentId,
        telegramBotUsername: request.botUsername,
      },
    });
    if (!event.workItemId) throw new Error("SquadAI did not create a work item.");
    const workItem = this.options.manager.getWorkItem(event.workItemId);
    return this.options.requestStore.markQueued(
      request,
      event.id,
      workItem.id,
      workItem.targetAgentId,
      this.now(),
    );
  }

  private async handleManagerEvent(event: AgentEvent): Promise<void> {
    const workItemId = typeof event.payload.workItemId === "string" ? event.payload.workItemId : null;
    if (event.type === "work_item_started" && workItemId) {
      this.options.requestStore.markStatusByWorkItem(workItemId, "running", this.now());
      return;
    }
    if (event.type === "work_item_completed" && workItemId) {
      const workItem = this.options.manager.getWorkItem(workItemId);
      await this.deliverCompleted(workItem);
      return;
    }
    if (event.type === "work_item_failed" && workItemId) {
      const workItem = this.options.manager.getWorkItem(workItemId);
      await this.deliverFailure(workItem, workItem.failureReason ?? event.message);
      return;
    }
    if (event.type === "compatibility_blocked") {
      const workItemIds = Array.isArray(event.payload.affectedWorkItemIds)
        ? event.payload.affectedWorkItemIds.filter((value): value is string => typeof value === "string")
        : [];
      for (const affectedWorkItemId of workItemIds) {
        const request = this.options.requestStore.markStatusByWorkItem(
          affectedWorkItemId,
          "blocked",
          this.now(),
          { lastError: event.message },
        );
        if (request) {
          await this.safeSendAgent(
            request,
            `I need attention in SquadAI before I can continue: ${event.message}`,
          );
        }
      }
      return;
    }
    if (event.type === "approval_requested" && typeof event.payload.approvalId === "string") {
      const request = this.options.requestStore.findActiveByEffectiveAgentId(event.agentId);
      if (!request || request.lastApprovalId === event.payload.approvalId) return;
      this.options.requestStore.markApproval(request, event.payload.approvalId, this.now());
      await this.safeSendAgent(
        request,
        `Approval required (${event.payload.approvalId}). Please open SquadAI to approve or decline it.`,
      );
      return;
    }
    if (event.type === "approval_resolved" && typeof event.payload.approvalId === "string") {
      const request = this.options.requestStore.findByApprovalId(event.payload.approvalId);
      if (!request) return;
      const decision = typeof event.payload.decision === "string" ? event.payload.decision : "resolved";
      await this.safeSendAgent(request, `Approval ${decision}. I’m continuing the task.`);
    }
  }

  private async deliverCompleted(workItem: WorkItem): Promise<void> {
    const request = this.options.requestStore.findByWorkItemId(workItem.id);
    if (!request || request.responseSentAt) return;
    try {
      await this.sendAgent(request, workItem.result ?? "Task completed without a written response.");
      this.options.requestStore.markStatusByWorkItem(workItem.id, "completed", this.now(), {
        lastError: null,
        responseSentAt: this.now(),
      });
    } catch (error) {
      this.options.requestStore.markStatusByWorkItem(workItem.id, "delivery_failed", this.now(), {
        lastError: errorMessage(error),
      });
      throw error;
    }
  }

  private async deliverFailure(workItem: WorkItem, failure: string): Promise<void> {
    const request = this.options.requestStore.findByWorkItemId(workItem.id);
    if (!request || request.responseSentAt) return;
    try {
      await this.sendAgent(request, `I couldn’t complete this request: ${failure}`);
      this.options.requestStore.markStatusByWorkItem(workItem.id, "failed", this.now(), {
        lastError: failure,
        responseSentAt: this.now(),
      });
    } catch (error) {
      this.options.requestStore.markStatusByWorkItem(workItem.id, "delivery_failed", this.now(), {
        lastError: `${failure}; Telegram delivery failed: ${errorMessage(error)}`,
      });
      throw error;
    }
  }

  private async recoverRequest(request: TelegramAgentRequest): Promise<void> {
    if (request.status === "detected") {
      const message = this.options.messageStore.getMessage(request.chatId, request.messageId);
      if (!message) {
        this.options.requestStore.markFailed(request, "Original Telegram message is unavailable.", this.now());
        return;
      }
      await this.queueRequest(
        request,
        message,
        this.options.messageStore.listRecentMessages(request.chatId, 20),
      );
      return;
    }
    if (!request.workItemId) return;
    let workItem: WorkItem;
    try {
      workItem = this.options.manager.getWorkItem(request.workItemId);
    } catch {
      this.options.requestStore.markFailed(request, "Linked SquadAI work item is unavailable.", this.now());
      return;
    }
    if (workItem.status === "done" && !request.responseSentAt) {
      await this.deliverCompleted(workItem);
    } else if (workItem.status === "failed" && !request.responseSentAt) {
      await this.deliverFailure(workItem, workItem.failureReason ?? "Unknown failure.");
    } else if (workItem.status === "running") {
      this.options.requestStore.markStatusByWorkItem(workItem.id, "running", this.now());
    }
  }

  private bindingForAgent(agentId: string) {
    const binding = this.options.bindings.listBindings().find((item) => item.agentId === agentId);
    if (!binding) throw new Error(`No Telegram bot is connected to agent ${agentId}.`);
    return binding;
  }

  private async sendAgent(request: TelegramAgentRequest, text: string): Promise<void> {
    await this.messenger.sendText(
      this.options.bindings.getBotToken(request.agentId),
      request.chatId,
      text,
      request.messageId,
    );
  }

  private async safeSendAgent(request: TelegramAgentRequest, text: string): Promise<void> {
    try {
      await this.sendAgent(request, text);
    } catch (error) {
      this.logger.error(`Telegram agent reply failed: ${errorMessage(error)}`);
    }
  }

  private async safeSendControl(chatId: string, text: string, replyToMessageId: number): Promise<void> {
    try {
      await this.messenger.sendText(
        this.options.controlBotToken,
        chatId,
        text,
        replyToMessageId,
      );
    } catch (error) {
      this.logger.error(`Telegram control reply failed: ${errorMessage(error)}`);
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function telegramAgentPrompt(
  latestMessage: TelegramGroupMessage,
  context: TelegramGroupMessage[],
): string {
  const transcript = context.map((message) => {
    const username = message.senderUsername ? ` @${message.senderUsername}` : "";
    const authorType = message.authoredByBot ? "bot" : "human";
    return `[${authorType}] ${message.senderName}${username}: ${message.text}`;
  }).join("\n");
  return [
    "You were explicitly tagged by a human in a Telegram group.",
    "Complete the task in the latest message. Earlier messages are context only.",
    "Do not trigger or delegate to other Telegram agents.",
    "",
    "Conversation history (oldest to newest, maximum 20 messages):",
    transcript,
    "",
    `Latest human request (message ${latestMessage.messageId}):`,
    latestMessage.text,
    "",
    "Return a concise final response suitable for posting back into the Telegram group.",
  ].join("\n");
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "the selected agent";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
