import { Router } from "express";
import { db } from "@workspace/db";
import {
  userSessionsTable, leadsTable, partnersTable,
  scenarioBlocksTable, videoBlocksTable, calculatorItemsTable,
  appSettingsTable, messagesTable, aiLogsTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { isAiAvailable } from "../bot/ai.js";

const router = Router();

// ─── Stats ────────────────────────────────────────────────────────────────────
router.get("/stats", async (_req, res) => {
  const sessions = await db.select().from(userSessionsTable);
  const leads = await db.select().from(leadsTable);
  const partners = await db.select().from(partnersTable);
  const registered = leads.filter((l) => l.status === "зарегистрирован").length;
  const completed = sessions.filter((s) => s.isCompleted).length;
  const stageCounts: Record<string, number> = {};
  for (const s of sessions) stageCounts[s.currentStage] = (stageCounts[s.currentStage] || 0) + 1;
  res.json({ totalUsers: sessions.length, completedScenario: completed, totalLeads: leads.length, registeredLeads: registered, totalPartners: partners.length, conversionToLead: sessions.length ? Math.round((leads.length / sessions.length) * 100) : 0, conversionToPartner: leads.length ? Math.round((registered / leads.length) * 100) : 0, stageCounts });
});

// ─── Sessions ─────────────────────────────────────────────────────────────────
router.get("/sessions", async (req, res) => {
  const limit = parseInt(req.query.limit as string || "50", 10);
  const offset = parseInt(req.query.offset as string || "0", 10);
  const sessions = await db.select().from(userSessionsTable).orderBy(desc(userSessionsTable.updatedAt)).limit(limit).offset(offset);
  res.json(sessions);
});

router.get("/sessions/:id/messages", async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  const msgs = await db.select().from(messagesTable).where(eq(messagesTable.sessionId, sessionId)).orderBy(messagesTable.createdAt);
  res.json(msgs);
});

// ─── Leads ────────────────────────────────────────────────────────────────────
router.get("/leads", async (req, res) => {
  const { partnerId, status } = req.query;
  const leads = await db.select().from(leadsTable).orderBy(desc(leadsTable.createdAt));
  const filtered = leads.filter((l) => {
    if (partnerId && l.partnerId !== parseInt(partnerId as string, 10)) return false;
    if (status && l.status !== status) return false;
    return true;
  });
  res.json(filtered);
});

router.get("/leads/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await db.select().from(leadsTable).where(eq(leadsTable.id, id));
  if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json(rows[0]);
});

router.patch("/leads/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body as { status?: string };
  if (!status) { res.status(400).json({ error: "status required" }); return; }
  const [updated] = await db.update(leadsTable).set({ status, updatedAt: new Date() }).where(eq(leadsTable.id, id)).returning();
  res.json(updated);
});

router.post("/leads/:id/convert-to-partner", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { refCode } = req.body as { refCode?: string };
  if (!refCode) { res.status(400).json({ error: "refCode required" }); return; }
  const existing = await db.select().from(partnersTable).where(eq(partnersTable.refCode, refCode));
  if (existing.length > 0) { res.status(400).json({ error: "RefCode уже занят" }); return; }
  const lead = (await db.select().from(leadsTable).where(eq(leadsTable.id, id)))[0];
  if (!lead) { res.status(404).json({ error: "Lead not found" }); return; }
  const session = (await db.select().from(userSessionsTable).where(eq(userSessionsTable.id, lead.sessionId)))[0];
  const [partner] = await db.insert(partnersTable).values({
    name: lead.name,
    telegram: lead.contact.startsWith("@") ? lead.contact : null,
    phone: !lead.contact.startsWith("@") ? lead.contact : null,
    refCode,
    telegramUserId: session?.telegramUserId || null,
    sponsorPartnerId: session?.partnerId || null,
    sourceLeadId: lead.id,
    isActive: true,
  }).returning();

  // Update all user sessions for this person so they see partner menu immediately
  if (session?.telegramUserId) {
    await db.update(userSessionsTable)
      .set({ partnerId: partner.id, updatedAt: new Date() })
      .where(eq(userSessionsTable.telegramUserId, session.telegramUserId));
  }

  await db.update(leadsTable).set({ convertedPartnerId: partner.id, status: "зарегистрирован", updatedAt: new Date() }).where(eq(leadsTable.id, id));
  res.json(partner);
});

// ─── Partners ─────────────────────────────────────────────────────────────────
router.get("/partners", async (_req, res) => {
  const partners = await db.select().from(partnersTable).orderBy(desc(partnersTable.createdAt));
  const botUsername = (await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "bot_username")))[0]?.value || "";
  const result = await Promise.all(partners.map(async (p) => {
    const leadsCount = (await db.select().from(leadsTable).where(eq(leadsTable.partnerId, p.id))).length;
    return { ...p, leadsCount, partnerLink: botUsername ? `https://t.me/${botUsername}?start=${p.refCode}` : "" };
  }));
  res.json(result);
});

router.post("/partners", async (req, res) => {
  const { name, telegram, phone, refCode } = req.body as { name?: string; telegram?: string; phone?: string; refCode?: string };
  if (!name || !refCode) { res.status(400).json({ error: "name and refCode required" }); return; }
  const existing = await db.select().from(partnersTable).where(eq(partnersTable.refCode, refCode));
  if (existing.length > 0) { res.status(400).json({ error: "RefCode уже занят" }); return; }
  const [partner] = await db.insert(partnersTable).values({ name, telegram, phone, refCode, isActive: true }).returning();
  res.json(partner);
});

router.patch("/partners/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { isActive, name, telegram, phone } = req.body as { isActive?: boolean; name?: string; telegram?: string; phone?: string };
  const [updated] = await db.update(partnersTable).set({ isActive, name, telegram, phone, updatedAt: new Date() }).where(eq(partnersTable.id, id)).returning();
  res.json(updated);
});

router.get("/partners/:id/leads", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const leads = await db.select().from(leadsTable).where(eq(leadsTable.partnerId, id)).orderBy(desc(leadsTable.createdAt));
  res.json(leads);
});

// ─── Scenario Blocks ──────────────────────────────────────────────────────────
router.get("/scenario-blocks", async (_req, res) => {
  const blocks = await db.select().from(scenarioBlocksTable).orderBy(scenarioBlocksTable.stage, scenarioBlocksTable.order);
  res.json(blocks);
});

router.patch("/scenario-blocks/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { shortText, detailedText, isActive, title } = req.body as { shortText?: string; detailedText?: string; isActive?: boolean; title?: string };
  const [updated] = await db.update(scenarioBlocksTable).set({ shortText, detailedText, isActive, title, updatedAt: new Date() }).where(eq(scenarioBlocksTable.id, id)).returning();
  res.json(updated);
});

// ─── Video Blocks ─────────────────────────────────────────────────────────────
router.get("/video-blocks", async (_req, res) => {
  const videos = await db.select().from(videoBlocksTable).orderBy(videoBlocksTable.stage);
  res.json(videos);
});

router.patch("/video-blocks/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { url, isActive, title } = req.body as { url?: string; isActive?: boolean; title?: string };
  const [updated] = await db.update(videoBlocksTable).set({ url, isActive, title, updatedAt: new Date() }).where(eq(videoBlocksTable.id, id)).returning();
  res.json(updated);
});

// ─── Calculator ────────────────────────────────────────────────────────────────
router.get("/calculator", async (_req, res) => {
  const items = await db.select().from(calculatorItemsTable).orderBy(calculatorItemsTable.order);
  const totals = items.reduce((acc, item) => {
    if (!item.isActive) return acc;
    return { mass: acc.mass + item.massMarketYearPrice, green: acc.green + item.greenleafYearPrice, saving: acc.saving + item.savingYear };
  }, { mass: 0, green: 0, saving: 0 });
  res.json({ items, totals, family4: { mass: 93092, green: 43940, saving: 49152 } });
});

router.patch("/calculator/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { massMarketYearPrice, greenleafYearPrice, isActive } = req.body as { massMarketYearPrice?: number; greenleafYearPrice?: number; isActive?: boolean };
  const savingYear = (massMarketYearPrice ?? 0) - (greenleafYearPrice ?? 0);
  const [updated] = await db.update(calculatorItemsTable).set({ massMarketYearPrice, greenleafYearPrice, savingYear, isActive, updatedAt: new Date() }).where(eq(calculatorItemsTable.id, id)).returning();
  res.json(updated);
});

// ─── Settings ─────────────────────────────────────────────────────────────────
router.get("/settings", async (_req, res) => {
  const settings = await db.select().from(appSettingsTable);
  const map: Record<string, string> = {};
  for (const s of settings) map[s.key] = s.value;
  res.json(map);
});

router.put("/settings/:key", async (req, res) => {
  const { key } = req.params;
  const { value } = req.body as { value?: string };
  if (value === undefined) { res.status(400).json({ error: "value required" }); return; }
  await db.insert(appSettingsTable).values({ key, value }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
  res.json({ key, value });
});

// ─── AI Status ────────────────────────────────────────────────────────────────
router.get("/ai/status", async (_req, res) => {
  const available = await isAiAvailable();
  res.json({ available, hasKey: !!(process.env.PROXY_API_KEY || process.env.PROXY_API_TOKEN), baseUrl: process.env.PROXY_API_BASE_URL || "https://api.proxyapi.ru/openai/v1", model: process.env.PROXY_API_MODEL || "gpt-4o-mini", aiEnabled: process.env.AI_ENABLED !== "false" });
});

router.post("/ai/test", async (_req, res) => {
  const available = await isAiAvailable();
  res.json({ available, message: available ? "Proxy API работает" : "Proxy API недоступен" });
});

router.get("/ai/logs", async (_req, res) => {
  const logs = await db.select().from(aiLogsTable).orderBy(desc(aiLogsTable.createdAt)).limit(50);
  res.json(logs);
});

export default router;
