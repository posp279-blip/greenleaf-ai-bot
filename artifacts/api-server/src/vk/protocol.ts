export type VkCallbackBody = {
  type?: string;
  event_id?: string;
  group_id?: number;
  secret?: string;
  v?: string;
  object?: Record<string, unknown> & {
    message?: VkIncomingMessage;
    ref?: string;
    ref_source?: string;
  };
};

export type VkIncomingMessage = {
  id?: number;
  date?: number;
  peer_id?: number;
  from_id?: number;
  text?: string;
  payload?: string;
  ref?: string;
  ref_source?: string;
  conversation_message_id?: number;
};

export type VkCallbackDecision = {
  status: number;
  body: string;
  shouldHandle: boolean;
};

export type VkButton = {
  action: {
    type: "text";
    label: string;
    payload: string;
  };
  color: "primary" | "secondary" | "positive" | "negative";
};

export type VkKeyboard = {
  one_time: boolean;
  inline: boolean;
  buttons: VkButton[][];
};

type TelegramButton = {
  text?: string;
  callback_data?: string;
};

type TelegramReplyMarkup = {
  inline_keyboard?: TelegramButton[][];
  keyboard?: TelegramButton[][];
};

const REF_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function toVkSyntheticUserId(vkUserId: number): number {
  if (!Number.isSafeInteger(vkUserId) || vkUserId <= 0) {
    throw new Error("VK user id must be a positive safe integer");
  }
  return -vkUserId;
}

export function fromVkSyntheticUserId(syntheticUserId: number): number | null {
  if (!Number.isSafeInteger(syntheticUserId) || syntheticUserId >= 0) return null;
  return Math.abs(syntheticUserId);
}

export function sanitizeReferralCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return REF_CODE_PATTERN.test(normalized) ? normalized : undefined;
}

export function extractReferralCode(body: VkCallbackBody, message: VkIncomingMessage): string | undefined {
  const object = body.object || {};
  const directCandidates = [
    message.ref,
    object.ref,
    (body as Record<string, unknown>).ref,
  ];

  for (const candidate of directCandidates) {
    const valid = sanitizeReferralCode(candidate);
    if (valid) return valid;
  }

  const payload = parseVkPayload(message.payload);
  return sanitizeReferralCode(payload?.ref ?? payload?.refCode);
}

export function parseVkPayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "string" || !payload.trim()) return null;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function extractCallbackData(payload: unknown): string | undefined {
  const parsed = parseVkPayload(payload);
  return typeof parsed?.callback_data === "string" ? parsed.callback_data : undefined;
}

export function chooseReferralCode(
  existingRefCode: string | null | undefined,
  candidateRefCode: string | undefined,
  candidateIsActive: boolean,
): string | undefined {
  const existing = sanitizeReferralCode(existingRefCode);
  if (existing) return existing;
  return candidateRefCode && candidateIsActive ? candidateRefCode : undefined;
}

export function evaluateVkCallback(
  body: VkCallbackBody,
  config: {
    callbackSecret?: string;
    confirmationCode?: string;
    groupId?: string | number;
  },
): VkCallbackDecision {
  const expectedSecret = config.callbackSecret?.trim();
  if (expectedSecret && body.secret !== expectedSecret) {
    return { status: 403, body: "forbidden", shouldHandle: false };
  }

  const expectedGroupId = Number(config.groupId || 0);
  if (expectedGroupId > 0 && body.group_id !== expectedGroupId) {
    return { status: 403, body: "wrong group", shouldHandle: false };
  }

  if (body.type === "confirmation") {
    const confirmationCode = config.confirmationCode?.trim();
    if (!confirmationCode) {
      return { status: 503, body: "confirmation code is not configured", shouldHandle: false };
    }
    return { status: 200, body: confirmationCode, shouldHandle: false };
  }

  return { status: 200, body: "ok", shouldHandle: body.type === "message_new" };
}

export function buildVkKeyboard(
  replyMarkup: TelegramReplyMarkup | undefined,
  allowPartnerActions: boolean,
): VkKeyboard | undefined {
  if (!replyMarkup) return undefined;

  const sourceRows = replyMarkup.inline_keyboard || replyMarkup.keyboard;
  if (!sourceRows?.length) return undefined;

  const inline = Boolean(replyMarkup.inline_keyboard);
  const buttons = sourceRows
    .map((row) => row
      .filter((button) => {
        if (!button.text) return false;
        const action = button.callback_data || "";
        return allowPartnerActions || !action.startsWith("partner_");
      })
      .map((button): VkButton => ({
        action: {
          type: "text",
          label: button.text || "Продолжить",
          payload: JSON.stringify({ callback_data: button.callback_data || button.text || "" }),
        },
        color: button.callback_data === "v2_start" ? "positive" : "primary",
      })))
    .filter((row) => row.length > 0);

  if (!buttons.length) return undefined;
  return { one_time: false, inline, buttons };
}

export class VkEventDeduplicator {
  private readonly processed = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  shouldProcess(eventId: string | undefined, now = Date.now()): boolean {
    for (const [id, expiresAt] of this.processed) {
      if (expiresAt <= now) this.processed.delete(id);
    }

    if (!eventId) return true;
    if (this.processed.has(eventId)) return false;
    this.processed.set(eventId, now + this.ttlMs);
    return true;
  }
}
