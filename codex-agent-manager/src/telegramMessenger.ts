import type { SqliteTelegramMessageStore, TelegramGroupMessage } from "./telegram.js";

export type TelegramBotMessengerOptions = {
  store: SqliteTelegramMessageStore;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  clock?: () => Date;
};

export class TelegramBotMessenger {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;
  private readonly clock: () => Date;

  constructor(private readonly options: TelegramBotMessengerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.clock = options.clock ?? (() => new Date());
  }

  async sendText(
    token: string,
    chatId: string,
    text: string,
    replyToMessageId?: number,
  ): Promise<TelegramGroupMessage[]> {
    const messages: TelegramGroupMessage[] = [];
    const chunks = splitTelegramText(text);
    for (let index = 0; index < chunks.length; index += 1) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: chunks[index],
      };
      if (index === 0 && replyToMessageId !== undefined) {
        body.reply_parameters = {
          message_id: replyToMessageId,
          allow_sending_without_reply: true,
        };
      }
      const response = await this.fetchImpl(`${this.apiBaseUrl}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as unknown;
      if (!response.ok || !isRecord(payload) || payload.ok !== true || !isRecord(payload.result)) {
        throw new Error(telegramApiError(payload, response.status));
      }
      const message = outgoingGroupMessage(payload.result, this.clock());
      await this.options.store.appendMessage(message);
      messages.push(message);
    }
    return messages;
  }
}

function outgoingGroupMessage(value: Record<string, unknown>, receivedAt: Date): TelegramGroupMessage {
  const chat = isRecord(value.chat) ? value.chat : null;
  const sender = isRecord(value.from) ? value.from : null;
  if (
    !chat
    || !Number.isSafeInteger(value.message_id)
    || (typeof chat.id !== "number" && typeof chat.id !== "string")
    || (chat.type !== "group" && chat.type !== "supergroup")
    || typeof value.text !== "string"
  ) {
    throw new Error("Telegram sendMessage returned an invalid group message.");
  }
  const senderName = [sender?.first_name, sender?.last_name]
    .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
    .join(" ")
    .trim()
    || (typeof sender?.username === "string" ? sender.username : "SquadAI bot");
  const sentAt = typeof value.date === "number"
    ? new Date(value.date * 1_000).toISOString()
    : receivedAt.toISOString();
  return {
    updateId: 0,
    chatId: String(chat.id),
    messageId: Number(value.message_id),
    chatType: chat.type,
    chatTitle: typeof chat.title === "string" ? chat.title : null,
    senderId: sender?.id === undefined ? null : String(sender.id),
    senderName,
    senderUsername: typeof sender?.username === "string" ? sender.username : null,
    authoredByBot: true,
    text: value.text,
    sentAt,
    receivedAt: receivedAt.toISOString(),
  };
}

function splitTelegramText(text: string): string[] {
  const normalized = text.trim() || "Task completed without a written response.";
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 4_000) {
    let splitAt = remaining.lastIndexOf("\n", 4_000);
    if (splitAt < 2_000) splitAt = remaining.lastIndexOf(" ", 4_000);
    if (splitAt < 2_000) splitAt = 4_000;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function telegramApiError(value: unknown, status: number): string {
  if (isRecord(value) && typeof value.description === "string") return value.description;
  return `Telegram API returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
