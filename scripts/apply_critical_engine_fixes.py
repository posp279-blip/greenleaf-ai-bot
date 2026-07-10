from pathlib import Path

ENGINE_PATH = Path("artifacts/api-server/src/bot/engine.ts")
source = ENGINE_PATH.read_text(encoding="utf-8")


def replace_once(label: str, before: str, after: str) -> None:
    global source
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    source = source.replace(before, after, 1)


replace_once(
    "drizzle sql import",
    'import { eq, desc, and, inArray } from "drizzle-orm";',
    'import { eq, desc, and, inArray, sql } from "drizzle-orm";',
)

replace_once(
    "atomic getOrCreateSession",
    '''async function getOrCreateSession(
  userId: number, username: string | undefined,
  firstName: string | undefined, lastName: string | undefined,
  refCode?: string
): Promise<BotSession> {
  const existing = await db.select().from(userSessionsTable)
    .where(eq(userSessionsTable.telegramUserId, userId));

  if (existing[0]) {
    await db.update(userSessionsTable)
      .set({ username: username || existing[0].username, firstName: firstName || existing[0].firstName, updatedAt: new Date() })
      .where(eq(userSessionsTable.id, existing[0].id));
    // Re-read to get the latest partnerId/refCode if they were updated externally
    const fresh = await db.select().from(userSessionsTable).where(eq(userSessionsTable.id, existing[0].id));
    return fresh[0] || existing[0];
  }

  let partnerId: number | null = null;
  if (refCode) {
    const partners = await db.select().from(partnersTable)
      .where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)));
    if (partners[0]) partnerId = partners[0].id;
  }

  const [session] = await db.insert(userSessionsTable).values({
    telegramUserId: userId,
    username,
    firstName,
    lastName,
    refCode,
    partnerId,
    currentStage: "intro",
  }).returning();
  return session;
}''',
    '''async function getOrCreateSession(
  userId: number, username: string | undefined,
  firstName: string | undefined, lastName: string | undefined,
  refCode?: string
): Promise<BotSession> {
  return db.transaction(async (tx) => {
    // Serialize session creation for the same Telegram user across all app instances.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId}::bigint)`);

    const existing = await tx.select().from(userSessionsTable)
      .where(eq(userSessionsTable.telegramUserId, userId));

    if (existing[0]) {
      await tx.update(userSessionsTable)
        .set({
          username: username || existing[0].username,
          firstName: firstName || existing[0].firstName,
          lastName: lastName || existing[0].lastName,
          updatedAt: new Date(),
        })
        .where(eq(userSessionsTable.id, existing[0].id));
      const fresh = await tx.select().from(userSessionsTable)
        .where(eq(userSessionsTable.id, existing[0].id));
      return fresh[0] || existing[0];
    }

    let partnerId: number | null = null;
    if (refCode) {
      const partners = await tx.select().from(partnersTable)
        .where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)));
      if (partners[0]) partnerId = partners[0].id;
    }

    const [session] = await tx.insert(userSessionsTable).values({
      telegramUserId: userId,
      username,
      firstName,
      lastName,
      refCode,
      partnerId,
      currentStage: "intro",
    }).returning();

    if (!session) throw new Error("Failed to create Telegram user session");
    return session;
  });
}''',
)

replace_once(
    "lead capture re-entry guard",
    '''async function handleLeadCapture(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "lead_capture_name");
  await bot.sendMessage(chatId, TEXTS.leadCaptureName, { parse_mode: "Markdown" });
  await saveMessage(session.id, "bot", TEXTS.leadCaptureName, "lead_capture_name");
}''',
    '''async function handleLeadCapture(bot: TelegramBot, chatId: number, session: BotSession) {
  if (session.isCompleted || session.leadId) {
    await bot.sendMessage(chatId, "Заявка уже создана. Её статус можно посмотреть через пункт «Моя заявка».");
    return;
  }

  if (session.currentStage.startsWith("lead_capture_")) {
    await bot.sendMessage(chatId, "Заявка уже заполняется. Ответь на последний вопрос бота, чтобы продолжить.");
    return;
  }

  await updateStage(session.id, "lead_capture_name");
  await bot.sendMessage(chatId, TEXTS.leadCaptureName, { parse_mode: "Markdown" });
  await saveMessage(session.id, "bot", TEXTS.leadCaptureName, "lead_capture_name");
}''',
)

replace_once(
    "question mode response and restoration",
    '''  const stage = session.currentStage;
  const quickIntent = classifyText(text);

  // Global objection handlers''',
    '''  const stage = session.currentStage;
  const quickIntent = classifyText(text);

  if (stage.startsWith("question_mode_")) {
    const returnStage = stage.slice("question_mode_".length) || "intro";
    await saveMessage(session.id, "user", text, returnStage, "question");

    let aiAnswer: string | null = null;
    try {
      aiAnswer = await answerQuestion(text, returnStage, session.id);
    } catch (err) {
      logger.error({ err, sessionId: session.id }, "Question mode AI answer failed");
    }

    await updateStage(session.id, returnStage);
    const response = aiAnswer || "Не смог сейчас сформулировать ответ через ИИ. Мы сохранили твой этап — можно продолжить с того места, где остановились.";
    await bot.sendMessage(chatId, response);
    await saveMessage(session.id, "bot", response, returnStage, "question_answer");
    return;
  }

  // Global objection handlers''',
)

replace_once(
    "quick savings stage handler",
    '''  // Stage-specific text handling
  switch (stage) {
    case "name_question": {''',
    '''  // Stage-specific text handling
  switch (stage) {
    case "quick_savings": {
      await saveMessage(session.id, "user", text, stage, quickIntent);
      if (quickIntent === "negative" || quickIntent === "soft_decline") {
        await bot.sendMessage(chatId, "Понял. Расчёт можно открыть позже через меню. Продолжим, когда будет удобно.");
        break;
      }
      await updateStage(session.id, "laundry_question");
      await bot.sendMessage(chatId, TEXTS.laundryQuestion, { parse_mode: "Markdown" });
      await saveMessage(session.id, "bot", TEXTS.laundryQuestion, "laundry_question");
      break;
    }
    case "name_question": {''',
)

replace_once(
    "stable question return stage",
    '''  if (data === "menu_question") {
    const prevStage = session.currentStage;
    await db.update(userSessionsTable).set({ currentStage: `question_mode_${prevStage}`, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
    await bot.sendMessage(chatId, "Задай свой вопрос — я отвечу и вернёмся к разбору.");
    return;
  }''',
    '''  if (data === "menu_question") {
    const prevStage = session.currentStage.startsWith("question_mode_")
      ? session.currentStage.slice("question_mode_".length)
      : session.currentStage;
    await db.update(userSessionsTable)
      .set({ currentStage: `question_mode_${prevStage}`, updatedAt: new Date() })
      .where(eq(userSessionsTable.id, session.id));
    await bot.sendMessage(chatId, "Задай свой вопрос — я отвечу и верну тебя к текущему этапу.");
    return;
  }''',
)

replace_once(
    "quick savings callback transition",
    '''  if (data === "depth_savings") {
    await db.update(userSessionsTable).set({ depthMode: "savings", updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
    await bot.sendMessage(chatId, TEXTS.quickSavingsIntro, { parse_mode: "Markdown" });
    return;
  }''',
    '''  if (data === "depth_savings") {
    await db.update(userSessionsTable)
      .set({ depthMode: "savings", currentStage: "quick_savings", updatedAt: new Date() })
      .where(eq(userSessionsTable.id, session.id));
    await bot.sendMessage(chatId, TEXTS.quickSavingsIntro, { parse_mode: "Markdown" });
    return;
  }''',
)

ENGINE_PATH.write_text(source, encoding="utf-8")
print(f"Applied critical fixes to {ENGINE_PATH}")
