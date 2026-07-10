import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  bigint,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─── Partners ────────────────────────────────────────────────────────────────
export const partnersTable = pgTable("partners", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  telegram: text("telegram"),
  phone: text("phone"),
  refCode: text("ref_code").notNull().unique(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }),
  sponsorPartnerId: integer("sponsor_partner_id"),
  sourceLeadId: integer("source_lead_id"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("partners_telegram_user_id_idx").on(table.telegramUserId),
  index("partners_sponsor_partner_id_idx").on(table.sponsorPartnerId),
]);

export const insertPartnerSchema = createInsertSchema(partnersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPartner = z.infer<typeof insertPartnerSchema>;
export type Partner = typeof partnersTable.$inferSelect;

// ─── UserSessions ─────────────────────────────────────────────────────────────
export const userSessionsTable = pgTable("user_sessions", {
  id: serial("id").primaryKey(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  refCode: text("ref_code"),
  partnerId: integer("partner_id"),
  currentStage: text("current_stage").notNull().default("intro"),
  depthMode: text("depth_mode"),
  familyAdults: integer("family_adults"),
  familyChildren: integer("family_children"),
  femaleHygieneRelevant: boolean("female_hygiene_relevant"),
  leadId: integer("lead_id"),
  isCompleted: boolean("is_completed").notNull().default(false),
  menuShown: boolean("menu_shown").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("user_sessions_telegram_user_id_idx").on(table.telegramUserId),
  index("user_sessions_partner_id_idx").on(table.partnerId),
  index("user_sessions_current_stage_idx").on(table.currentStage),
]);

export const insertUserSessionSchema = createInsertSchema(
  userSessionsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUserSession = z.infer<typeof insertUserSessionSchema>;
export type UserSession = typeof userSessionsTable.$inferSelect;

// ─── Messages ─────────────────────────────────────────────────────────────────
export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  role: text("role").notNull(), // 'user' | 'bot'
  content: text("content").notNull(),
  stage: text("stage"),
  intent: text("intent"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("messages_session_id_idx").on(table.sessionId),
  index("messages_created_at_idx").on(table.createdAt),
]);

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;

// ─── Leads ────────────────────────────────────────────────────────────────────
export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  partnerId: integer("partner_id"),
  name: text("name").notNull(),
  contact: text("contact").notNull(),
  comment: text("comment"),
  status: text("status").notNull().default("новая"), // новая/в работе/зарегистрирован/отказ/архив
  convertedPartnerId: integer("converted_partner_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("leads_session_id_idx").on(table.sessionId),
  index("leads_partner_id_idx").on(table.partnerId),
  index("leads_status_idx").on(table.status),
  index("leads_created_at_idx").on(table.createdAt),
]);

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;

// ─── ScenarioBlocks ───────────────────────────────────────────────────────────
export const scenarioBlocksTable = pgTable("scenario_blocks", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  stage: text("stage").notNull(),
  title: text("title").notNull(),
  shortText: text("short_text").notNull(),
  detailedText: text("detailed_text"),
  order: integer("order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertScenarioBlockSchema = createInsertSchema(
  scenarioBlocksTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertScenarioBlock = z.infer<typeof insertScenarioBlockSchema>;
export type ScenarioBlock = typeof scenarioBlocksTable.$inferSelect;

// ─── VideoBlocks ──────────────────────────────────────────────────────────────
export const videoBlocksTable = pgTable("video_blocks", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  stage: text("stage").notNull(),
  title: text("title").notNull(),
  url: text("url"),
  providerType: text("provider_type").default("youtube"),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertVideoBlockSchema = createInsertSchema(
  videoBlocksTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertVideoBlock = z.infer<typeof insertVideoBlockSchema>;
export type VideoBlock = typeof videoBlocksTable.$inferSelect;

// ─── CalculatorItems ──────────────────────────────────────────────────────────
export const calculatorItemsTable = pgTable("calculator_items", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  massMarketYearPrice: integer("mass_market_year_price").notNull(),
  greenleafYearPrice: integer("greenleaf_year_price").notNull(),
  savingYear: integer("saving_year").notNull(),
  familyMultiplier: text("family_multiplier").default("4"),
  description: text("description"),
  order: integer("order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCalculatorItemSchema = createInsertSchema(
  calculatorItemsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCalculatorItem = z.infer<typeof insertCalculatorItemSchema>;
export type CalculatorItem = typeof calculatorItemsTable.$inferSelect;

// ─── AppSettings ──────────────────────────────────────────────────────────────
export const appSettingsTable = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAppSettingSchema = createInsertSchema(
  appSettingsTable,
).omit({ id: true, updatedAt: true });
export type InsertAppSetting = z.infer<typeof insertAppSettingSchema>;
export type AppSetting = typeof appSettingsTable.$inferSelect;

// ─── AdminState ───────────────────────────────────────────────────────────────
export const adminStateTable = pgTable("admin_state", {
  id: serial("id").primaryKey(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" })
    .notNull()
    .unique(),
  mode: text("mode").notNull().default("idle"),
  pendingAction: text("pending_action"),
  payload: jsonb("payload"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAdminStateSchema = createInsertSchema(adminStateTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertAdminState = z.infer<typeof insertAdminStateSchema>;
export type AdminState = typeof adminStateTable.$inferSelect;

// ─── AiLogs ───────────────────────────────────────────────────────────────────
export const aiLogsTable = pgTable("ai_logs", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id"),
  promptType: text("prompt_type").notNull(),
  input: text("input").notNull(),
  output: text("output"),
  provider: text("provider").default("proxy_api"),
  success: boolean("success").notNull().default(false),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("ai_logs_session_id_idx").on(table.sessionId),
  index("ai_logs_created_at_idx").on(table.createdAt),
]);

export const insertAiLogSchema = createInsertSchema(aiLogsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertAiLog = z.infer<typeof insertAiLogSchema>;
export type AiLog = typeof aiLogsTable.$inferSelect;
