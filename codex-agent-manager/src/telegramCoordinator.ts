import type { CodexAgentManager } from "./manager.js";
import type {
  SqliteTelegramMessageStore,
  TelegramCallbackQuery,
  TelegramGroupMessage,
} from "./telegram.js";
import type { TelegramAgentBindingService } from "./telegramBindings.js";
import { TelegramBotMessenger } from "./telegramMessenger.js";
import type {
  SqliteTelegramRequestStore,
  TelegramAgentRequest,
  TelegramMentionIntake,
} from "./telegramRequests.js";
import type { AgentEvent, WorkItem } from "./types.js";
import type { AgentExecutionPolicy } from "./types.js";

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
    const routes: TelegramRequestRoute[] = createdRequests.length
      ? createdRequests.map((request) => {
          const binding = this.bindingForAgent(request.agentId);
          return {
            request,
            targetAgentId: request.agentId,
            executionPolicy: binding.executionPolicy,
            trigger: "mention" as const,
          };
        })
      : this.replyRoutes(message);
    const recoverableRoutes = routes.length
      ? routes
      : this.options.requestStore
        .listRequestsForMessage(message.chatId, message.messageId)
        .filter((request) => request.status === "detected")
        .map((request) => {
          const binding = this.bindingForAgent(request.agentId);
          return {
            request,
            targetAgentId: request.agentId,
            executionPolicy: binding.executionPolicy,
            trigger: "mention" as const,
          };
        });
    if (!recoverableRoutes.length) {
      await this.options.manager.dispatchQueuedWork();
      return [];
    }
    const context = this.options.messageStore.listRecentMessages(message.chatId, 20);
    const queued: TelegramAgentRequest[] = [];
    const failures: string[] = [];
    for (const route of recoverableRoutes) {
      try {
        queued.push(await this.queueRequest(route, message, context));
      } catch (error) {
        const failure = errorMessage(error);
        this.options.requestStore.markFailed(route.request, failure, this.now());
        failures.push(`@${route.request.botUsername}: ${failure}`);
      }
    }

    if (queued.length) {
      const labels = queued.map((request) => {
        const agent = this.options.manager.getAgent(request.effectiveAgentId ?? request.agentId);
        const binding = this.bindingForAgent(request.agentId);
        const instantiated = request.effectiveAgentId !== request.agentId;
        return `${agent.name} (@${binding.botUsername})${instantiated ? " (agent instance)" : ""}`;
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

  async processApprovalCallback(agentId: string, callback: TelegramCallbackQuery): Promise<void> {
    const match = callback.data.match(/^sqa:(approval-\d+):(approve|deny)$/);
    if (!match?.[1] || !match[2]) return;
    const approval = this.options.requestStore.getApproval(match[1]);
    const token = this.options.bindings.getBotToken(agentId);
    if (
      !approval
      || approval.agentId !== agentId
      || approval.chatId !== callback.chatId
      || approval.approvalMessageId !== callback.messageId
    ) {
      await this.messenger.answerCallback(token, callback.id, "This approval is no longer available.", true);
      return;
    }
    if (approval.status !== "pending") {
      await this.messenger.answerCallback(token, callback.id, `This was already ${approval.status}.`, true);
      return;
    }
    if (callback.userId !== approval.requesterUserId) {
      await this.messenger.answerCallback(
        token,
        callback.id,
        `Only ${approval.requesterName}, who started this task, can answer.`,
        true,
      );
      return;
    }

    const approved = match[2] === "approve";
    try {
      await this.options.manager.resolveApproval(
        approval.approvalId,
        approved ? "approved" : "declined",
        `${approved ? "Approved" : "Declined"} in Telegram by ${callback.userName} (${callback.userId}).`,
      );
      this.options.requestStore.resolveTelegramApproval(
        approval.approvalId,
        approved ? "approved" : "declined",
        callback.userId,
        callback.userName,
        this.now(),
      );
      await this.messenger.answerCallback(
        token,
        callback.id,
        approved ? "Approved. The agent is continuing." : "Denied.",
      );
      await this.messenger.resolveApprovalMessage(
        token,
        callback.chatId,
        callback.messageId,
        `${callback.messageText}\n\n${approved ? "✅ Approved" : "❌ Denied"} by ${callback.userName}.`,
      );
    } catch (error) {
      await this.messenger.answerCallback(
        token,
        callback.id,
        errorMessage(error),
        true,
      );
    }
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.options.manager.off("event", this.managerEventListener);
  }

  private async queueRequest(
    route: TelegramRequestRoute,
    latestMessage: TelegramGroupMessage,
    context: TelegramGroupMessage[],
  ): Promise<TelegramAgentRequest> {
    const { request } = route;
    const agent = this.options.manager.getAgent(route.targetAgentId);
    const repliedToMessage = latestMessage.replyToMessageId === undefined
      || latestMessage.replyToMessageId === null
      ? null
      : this.options.messageStore.getMessage(latestMessage.chatId, latestMessage.replyToMessageId);
    const event = await this.options.manager.ingestSensorEvent({
      source: "telegram",
      type: route.trigger === "mention" ? "group.mention" : "group.reply",
      title: `Telegram request for ${agent.name}`,
      body: telegramAgentPrompt(latestMessage, context, repliedToMessage, route.trigger),
      targetAgentId: route.targetAgentId,
      executionPolicy: route.executionPolicy,
      dedupeKey: `telegram:${request.chatId}:${request.messageId}:${request.agentId}`,
      metadata: {
        telegramChatId: request.chatId,
        telegramMessageId: request.messageId,
        telegramAgentId: request.agentId,
        telegramBotUsername: request.botUsername,
        telegramTrigger: route.trigger,
        telegramReplyToMessageId: latestMessage.replyToMessageId ?? null,
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
      await this.sendTelegramApproval(request, event);
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
        this.routeForStoredRequest(request, message),
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
    const messages = await this.messenger.sendText(
      this.options.bindings.getBotToken(request.agentId),
      request.chatId,
      text,
      request.messageId,
    );
    for (const message of messages) {
      this.options.requestStore.saveAgentResponse({
        chatId: message.chatId,
        messageId: message.messageId,
        baseAgentId: request.agentId,
        effectiveAgentId: request.effectiveAgentId ?? request.agentId,
        createdAt: message.receivedAt,
      });
    }
  }

  private async safeSendAgent(request: TelegramAgentRequest, text: string): Promise<void> {
    try {
      await this.sendAgent(request, text);
    } catch (error) {
      this.logger.error(`Telegram agent reply failed: ${errorMessage(error)}`);
    }
  }

  private async sendTelegramApproval(
    request: TelegramAgentRequest,
    event: AgentEvent,
  ): Promise<void> {
    const requester = this.options.messageStore.getMessage(request.chatId, request.messageId);
    if (!requester?.senderId) {
      await this.safeSendAgent(
        request,
        "Approval required. I could not verify who started this task, so please answer it in SquadAI.",
      );
      return;
    }
    const approvalId = String(event.payload.approvalId);
    const text = telegramApprovalText(event.payload);
    const messages = await this.messenger.sendText(
      this.options.bindings.getBotToken(request.agentId),
      request.chatId,
      text,
      request.messageId,
      {
        inline_keyboard: [[
          { text: "Deny", callback_data: `sqa:${approvalId}:deny` },
          { text: "Approve", callback_data: `sqa:${approvalId}:approve` },
        ]],
      },
    );
    const message = messages[0];
    if (!message) throw new Error("Telegram did not return the approval message.");
    this.options.requestStore.saveApproval({
      approvalId,
      chatId: request.chatId,
      requestMessageId: request.messageId,
      agentId: request.agentId,
      approvalMessageId: message.messageId,
      requesterUserId: requester.senderId,
      requesterName: requester.senderName,
      status: "pending",
      resolvedByUserId: null,
      resolvedByName: null,
      createdAt: this.now(),
      resolvedAt: null,
    });
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

  private replyRoutes(message: TelegramGroupMessage): TelegramRequestRoute[] {
    if (message.authoredByBot || message.replyToMessageId === undefined || message.replyToMessageId === null) {
      return [];
    }
    const response = this.options.requestStore.findAgentResponse(
      message.chatId,
      message.replyToMessageId,
    );
    if (!response) return [];
    const binding = this.bindingForAgent(response.baseAgentId);
    const request = telegramReplyRequest(message, response.baseAgentId, binding.botUsername);
    const inserted = this.options.requestStore.appendRequest(request);
    const stored = inserted
      ? request
      : this.options.requestStore.getRequest(request);
    if (!stored || stored.status !== "detected") return [];
    return [{
      request: stored,
      targetAgentId: this.availableReplyTarget(response.effectiveAgentId, response.baseAgentId),
      executionPolicy: "reuse",
      trigger: "reply",
    }];
  }

  private availableReplyTarget(effectiveAgentId: string, baseAgentId: string): string {
    try {
      const agent = this.options.manager.getAgent(effectiveAgentId);
      const lifecycle = agent.metadata.instanceLifecycle;
      if (lifecycle !== "done" && lifecycle !== "cancelled") {
        return effectiveAgentId;
      }
    } catch {
      // The exact instance may have been deleted after its Telegram response was sent.
    }
    this.options.manager.getAgent(baseAgentId);
    return baseAgentId;
  }

  private routeForStoredRequest(
    request: TelegramAgentRequest,
    message: TelegramGroupMessage,
  ): TelegramRequestRoute {
    const binding = this.bindingForAgent(request.agentId);
    if (mentionsUsername(message.text, binding.botUsername)) {
      return {
        request,
        targetAgentId: request.agentId,
        executionPolicy: binding.executionPolicy,
        trigger: "mention",
      };
    }
    const response = message.replyToMessageId === undefined || message.replyToMessageId === null
      ? null
      : this.options.requestStore.findAgentResponse(message.chatId, message.replyToMessageId);
    if (response?.baseAgentId === request.agentId) {
      return {
        request,
        targetAgentId: this.availableReplyTarget(response.effectiveAgentId, response.baseAgentId),
        executionPolicy: "reuse",
        trigger: "reply",
      };
    }
    return {
      request,
      targetAgentId: request.agentId,
      executionPolicy: binding.executionPolicy,
      trigger: "mention",
    };
  }
}

function telegramAgentPrompt(
  latestMessage: TelegramGroupMessage,
  context: TelegramGroupMessage[],
  repliedToMessage: TelegramGroupMessage | null,
  trigger: TelegramRequestRoute["trigger"],
): string {
  const transcript = context.map((message) => {
    const username = message.senderUsername ? ` @${message.senderUsername}` : "";
    const authorType = message.authoredByBot ? "bot" : "human";
    const reply = message.replyToMessageId === undefined || message.replyToMessageId === null
      ? ""
      : ` (reply to message ${message.replyToMessageId})`;
    return `[${authorType}] ${message.senderName}${username}${reply}: ${message.text}`;
  }).join("\n");
  const lines = [
    trigger === "mention"
      ? "You were explicitly tagged by a human in a Telegram group."
      : "A human replied directly to one of your Telegram responses.",
    "Complete the task in the newest conversation-history message. Earlier messages are context only.",
    "Do not trigger or delegate to other Telegram agents.",
    "",
    "Conversation history (oldest to newest, maximum 20 messages):",
    transcript,
  ];
  if (
    repliedToMessage
    && !context.some((message) => message.messageId === repliedToMessage.messageId)
  ) {
    lines.push(
      "",
      `Replied-to message ${repliedToMessage.messageId} (outside the latest 20):`,
      formatTelegramMessage(repliedToMessage),
    );
  }
  lines.push(
    "",
    `The newest human request is message ${latestMessage.messageId}.`,
    "Return a concise final response suitable for posting back into the Telegram group.",
  );
  return lines.join("\n");
}

type TelegramRequestRoute = {
  request: TelegramAgentRequest;
  targetAgentId: string;
  executionPolicy: AgentExecutionPolicy;
  trigger: "mention" | "reply";
};

function telegramReplyRequest(
  message: TelegramGroupMessage,
  agentId: string,
  botUsername: string,
): TelegramAgentRequest {
  return {
    chatId: message.chatId,
    messageId: message.messageId,
    agentId,
    botUsername,
    status: "detected",
    sensorEventId: null,
    workItemId: null,
    effectiveAgentId: null,
    lastError: null,
    lastApprovalId: null,
    responseSentAt: null,
    createdAt: message.receivedAt,
    updatedAt: message.receivedAt,
  };
}

function formatTelegramMessage(message: TelegramGroupMessage): string {
  const username = message.senderUsername ? ` @${message.senderUsername}` : "";
  const authorType = message.authoredByBot ? "bot" : "human";
  return `[${authorType}] ${message.senderName}${username}: ${message.text}`;
}

function mentionsUsername(text: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, "i").test(text);
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "the selected agent";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function telegramApprovalText(payload: Record<string, unknown>): string {
  const params = payload.params && typeof payload.params === "object"
    ? payload.params as Record<string, unknown>
    : {};
  const command = Array.isArray(params.command)
    ? params.command.map((part) => String(part)).join(" ")
    : typeof params.command === "string" ? params.command : "";
  const tool = typeof params.toolName === "string"
    ? params.toolName
    : typeof params.name === "string" ? params.name : "";
  const action = command
    ? `run:\n${command}`
    : tool ? `use ${tool}` : String(payload.kind ?? "perform this action");
  return `Approval required\n\nThe agent wants to ${action}.\n\nOnly the person who started this task can answer.`;
}
