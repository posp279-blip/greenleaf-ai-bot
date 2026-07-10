from pathlib import Path

PATH = Path("artifacts/api-server/src/bot/engine-v2.ts")
source = PATH.read_text(encoding="utf-8")


def replace_once(label: str, before: str, after: str) -> None:
    global source
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    source = source.replace(before, after, 1)


replace_once(
    "remove external partner resolver",
    '''async function resolvePartnerId(refCode?: string): Promise<number | null> {
  if (!refCode) return null;
  const partner = (await db
    .select({ id: partnersTable.id })
    .from(partnersTable)
    .where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)))
    .limit(1))[0];
  return partner?.id || null;
}

''',
    "",
)

replace_once(
    "ignore Telegram profile name until explicit answer",
    '''  firstName: string | undefined,
  lastName: string | undefined,''',
    '''  _telegramFirstName: string | undefined,
  lastName: string | undefined,''',
)

replace_once(
    "preserve explicitly chosen name",
    '''          username: username || existing.username,
          firstName: existing.firstName || firstName,
          lastName: lastName || existing.lastName,''',
    '''          username: username || existing.username,
          firstName: existing.firstName,
          lastName: lastName || existing.lastName,''',
)

replace_once(
    "transactional partner lookup on creation",
    '''    const partnerId = await resolvePartnerId(refCode);
    const [created] = await tx
      .insert(userSessionsTable)
      .values({
        telegramUserId: userId,
        username,
        firstName,
        lastName,
        refCode,
        partnerId,
        currentStage: "intro",
      })''',
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
        partnerId,
        currentStage: "intro",
      })''',
)

replace_once(
    "valid Telegram reply markup",
    '''  await sendBotText(bot, chatId, session.id, "intro", text, {
    reply_markup: {
      ...getReplyKeyboard(),
      inline_keyboard: [[{ text: "▶️ Начать", callback_data: "v2_start" }]],
    },
  });''',
    '''  await sendBotText(bot, chatId, session.id, "intro", text, {
    reply_markup: {
      inline_keyboard: [[{ text: "▶️ Начать", callback_data: "v2_start" }]],
    },
  });''',
)

replace_once(
    "global price objection without stage jump",
    '''  if (intent === "soft_decline") {
    await saveMessage(session.id, "user", text, stage, intent);
    await updateStage(session.id, "doubt");
    await sendBotText(bot, chatId, session.id, "doubt", await getV2Text("soft_decline"));
    return true;
  }

  if (intent === "question") {''',
    '''  if (
    intent === "objection_price" &&
    !["start_reaction", "price_objection", "final_interest"].includes(stage)
  ) {
    await saveMessage(session.id, "user", text, stage, intent);
    await sendBotText(bot, chatId, session.id, stage, await getV2Text("price_objection"));
    return true;
  }

  if (intent === "question") {''',
)

replace_once(
    "wait for Start callback",
    '''    case "intro":
      await sendBlock(bot, chatId, session, "name_question", "name_question");
      return;''',
    '''    case "intro":
      await sendBotText(bot, chatId, session.id, stage, "Нажми кнопку «Начать» под приветствием — до этого момента я не буду запускать сценарий.");
      return;''',
)

replace_once(
    "clear stored name on explicit refusal",
    '''      if (name) {
        await db.update(userSessionsTable).set({ firstName: name, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
        await sendBlock(bot, chatId, { ...session, firstName: name }, "laundry_brand", "laundry_question_named", { name });
      } else {
        await sendBlock(bot, chatId, session, "laundry_brand", "laundry_question_anonymous");
      }''',
    '''      if (name) {
        await db.update(userSessionsTable).set({ firstName: name, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
        await sendBlock(bot, chatId, { ...session, firstName: name }, "laundry_brand", "laundry_question_named", { name });
      } else {
        await db.update(userSessionsTable).set({ firstName: null, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
        await sendBlock(bot, chatId, { ...session, firstName: null }, "laundry_brand", "laundry_question_anonymous");
      }''',
)

replace_once(
    "remove duplicate video cases",
    '''
    case "laundry_video_reaction":
    case "dish_video_reaction":
    case "pads_video_reaction":
    case "toilet_video_reaction":
      return;
''',
    "",
)

replace_once(
    "preserve completed lead on restart",
    '''        femaleHygieneRelevant: null,
        menuShown: false,
        isCompleted: false,
        updatedAt: new Date(),''',
    '''        femaleHygieneRelevant: null,
        menuShown: false,
        updatedAt: new Date(),''',
)

replace_once(
    "preserve completion in local restart object",
    '''    await sendIntro(bot, chatId, { ...session, currentStage: "intro", isCompleted: false });''',
    '''    await sendIntro(bot, chatId, { ...session, currentStage: "intro" });''',
)

PATH.write_text(source, encoding="utf-8")
print(f"Applied v2 engine fixes to {PATH}")
