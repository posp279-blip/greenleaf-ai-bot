from pathlib import Path

V2_PATH = Path("artifacts/api-server/src/bot/engine-v2.ts")
LEGACY_PATH = Path("artifacts/api-server/src/bot/engine.ts")

v2 = V2_PATH.read_text(encoding="utf-8")
legacy = LEGACY_PATH.read_text(encoding="utf-8")


def replace_once(source: str, label: str, before: str, after: str) -> str:
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return source.replace(before, after, 1)


v2 = replace_once(
    v2,
    "accept only active referral code for existing session",
    '''      if (refCode && !storedRefCode) {
        const partner = (await tx
          .select({ id: partnersTable.id })
          .from(partnersTable)
          .where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)))
          .limit(1))[0];
        partnerId = partner?.id || null;
        storedRefCode = refCode;
      }''',
    '''      if (refCode && !storedRefCode) {
        const partner = (await tx
          .select({ id: partnersTable.id })
          .from(partnersTable)
          .where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)))
          .limit(1))[0];
        if (partner) {
          partnerId = partner.id;
          storedRefCode = refCode;
        }
      }''',
)

v2 = replace_once(
    v2,
    "accept only active referral code for new session",
    '''    let partnerId: number | null = null;
    if (refCode) {
      const partner = (await tx
        .select({ id: partnersTable.id })
        .from(partnersTable)
        .where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)))
        .limit(1))[0];
      partnerId = partner?.id || null;
    }

    const [created] = await tx
      .insert(userSessionsTable)
      .values({
        telegramUserId: userId,
        username,
        firstName: null,
        lastName,
        refCode,
        partnerId,''',
    '''    let partnerId: number | null = null;
    let acceptedRefCode: string | undefined;
    if (refCode) {
      const partner = (await tx
        .select({ id: partnersTable.id })
        .from(partnersTable)
        .where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)))
        .limit(1))[0];
      if (partner) {
        partnerId = partner.id;
        acceptedRefCode = refCode;
      }
    }

    const [created] = await tx
      .insert(userSessionsTable)
      .values({
        telegramUserId: userId,
        username,
        firstName: null,
        lastName,
        refCode: acceptedRefCode,
        partnerId,''',
)

v2 = replace_once(
    v2,
    "menu follows current stage rather than historical lead flag",
    '''  if (session.isCompleted) rows.push([{ text: "📊 Расчёт экономии", callback_data: "menu_calc" }]);
  else rows.push([{ text: "▶️ Продолжить", callback_data: "menu_continue" }]);''',
    '''  if (normalizeStoredStage(session.currentStage) === "completed") {
    rows.push([{ text: "📊 Расчёт экономии", callback_data: "menu_calc" }]);
  } else {
    rows.push([{ text: "▶️ Продолжить", callback_data: "menu_continue" }]);
  }''',
)

v2 = replace_once(
    v2,
    "persist normalized stage when continuing",
    '''async function sendCurrentPrompt(bot: TelegramBot, chatId: number, session: BotSession): Promise<void> {
  const stage = normalizeStoredStage(session.currentStage);
  if (stage === "intro") {''',
    '''async function sendCurrentPrompt(bot: TelegramBot, chatId: number, session: BotSession): Promise<void> {
  const stage = normalizeStoredStage(session.currentStage);
  if (stage !== session.currentStage) await updateStage(session.id, stage);
  if (stage === "intro") {''',
)

v2 = replace_once(
    v2,
    "explicit full decline handling",
    '''  if (intent === "question") {
    await answerUserQuestion(bot, chatId, session, stage, text);
    return true;
  }''',
    '''  if (
    /не интересно|отстань/i.test(text) ||
    (["laundry_brand", "dish_brand", "toilet_brand"].includes(stage) && /^не хочу/i.test(text.trim()))
  ) {
    await saveMessage(session.id, "user", text, stage, "soft_decline");
    await updateStage(session.id, "doubt");
    await sendBotText(bot, chatId, session.id, "doubt", await getV2Text("soft_decline"));
    return true;
  }

  if (intent === "question") {
    await answerUserQuestion(bot, chatId, session, stage, text);
    return true;
  }''',
)

legacy = replace_once(
    legacy,
    "protect Telegram admin callbacks",
    '''export async function handleAdminCallback(bot: TelegramBot, query: CallbackQuery) {
  const chatId = query.message?.chat.id;
  const userId = query.from.id;
  if (!chatId) return;
  const data = query.data || "";
  await bot.answerCallbackQuery(query.id);

  if (data === "admin_leads") {''',
    '''export async function handleAdminCallback(bot: TelegramBot, query: CallbackQuery) {
  const chatId = query.message?.chat.id;
  const userId = query.from.id;
  if (!chatId) return;
  const data = query.data || "";

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    logger.warn({ err, callbackId: query.id }, "Failed to answer admin callback query");
  }

  if (!(await isAdmin(userId))) {
    logger.warn({ userId, data }, "Unauthorized Telegram admin callback blocked");
    await bot.sendMessage(chatId, "Доступ к админке запрещён.");
    return;
  }

  if (data === "admin_leads") {''',
)

V2_PATH.write_text(v2, encoding="utf-8")
LEGACY_PATH.write_text(legacy, encoding="utf-8")
print("Applied final v2 safety fixes")
