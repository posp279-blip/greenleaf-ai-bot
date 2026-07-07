import { db } from "@workspace/db";
import {
  scenarioBlocksTable,
  videoBlocksTable,
  calculatorItemsTable,
  appSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";

export async function seedDatabase() {
  try {
    // Seed scenario blocks
    const existingBlocks = await db
      .select()
      .from(scenarioBlocksTable)
      .limit(1);
    if (existingBlocks.length === 0) {
      await db.insert(scenarioBlocksTable).values([
        {
          key: "intro",
          stage: "intro",
          title: "Приветствие",
          shortText:
            "Привет! Я помогу разобраться в обычных товарах для дома и посчитать, сколько можно сэкономить.",
          order: 1,
        },
        {
          key: "depth_choice",
          stage: "depth_choice",
          title: "Выбор глубины",
          shortText:
            "Как тебе удобнее пройти? Быстро по сути, подробно или сначала хочешь увидеть экономию?",
          order: 1,
        },
        {
          key: "laundry_short",
          stage: "laundry_short_or_details",
          title: "Стирка: коротко",
          shortText:
            "ПАВ, отдушки, оптические отбеливатели — компоненты, на которые стоит обращать внимание.",
          order: 1,
        },
        {
          key: "dish_short",
          stage: "dish_short_or_details",
          title: "Посуда: коротко",
          shortText:
            "ПАВ, SLS/SLES, отдушки, красители — компоненты, которые стоит знать.",
          order: 1,
        },
        {
          key: "pads_short",
          stage: "pads_short_or_details",
          title: "Прокладки: коротко",
          shortText:
            "Синтетический слой, пластик, ароматизаторы — на что стоит обращать внимание.",
          order: 1,
        },
        {
          key: "toilet_short",
          stage: "toilet_short_or_details",
          title: "Туалетная бумага: коротко",
          shortText:
            "Ароматизаторы, красители, пыльность, микроворсинки — важные параметры выбора.",
          order: 1,
        },
      ]);
      logger.info("Scenario blocks seeded");
    }

    // Seed video blocks
    const existingVideos = await db.select().from(videoBlocksTable).limit(1);
    if (existingVideos.length === 0) {
      await db.insert(videoBlocksTable).values([
        {
          key: "intro_video",
          stage: "intro_video",
          title: "Приветственное видео",
          url: null,
          isActive: true,
        },
        {
          key: "laundry_video",
          stage: "laundry_video",
          title: "Видео по стирке",
          url: null,
          isActive: true,
        },
        {
          key: "dish_video",
          stage: "dish_video",
          title: "Видео по средству для посуды",
          url: null,
          isActive: true,
        },
        {
          key: "pads_video",
          stage: "pads_video",
          title: "Видео по женской гигиене",
          url: null,
          isActive: true,
        },
        {
          key: "toilet_video",
          stage: "toilet_video",
          title: "Видео по туалетной бумаге",
          url: null,
          isActive: true,
        },
        {
          key: "company_video",
          stage: "company_video",
          title: "Видео о компании Greenleaf",
          url: null,
          isActive: true,
        },
        {
          key: "bonus_video",
          stage: "bonus_video",
          title: "Видео: в каком случае компания платит",
          url: null,
          isActive: true,
        },
        {
          key: "model_3x3_video",
          stage: "model_3x3",
          title: "Запасное видео по модели 3 по 3",
          url: null,
          isActive: true,
        },
      ]);
      logger.info("Video blocks seeded");
    }

    // Seed calculator items
    const existingCalc = await db
      .select()
      .from(calculatorItemsTable)
      .limit(1);
    if (existingCalc.length === 0) {
      await db.insert(calculatorItemsTable).values([
        {
          category: "Стирка белья",
          massMarketYearPrice: 1500,
          greenleafYearPrice: 570,
          savingYear: 930,
          order: 1,
        },
        {
          category: "Кондиционер для белья",
          massMarketYearPrice: 450,
          greenleafYearPrice: 264,
          savingYear: 186,
          order: 2,
        },
        {
          category: "Парфюм для белья",
          massMarketYearPrice: 2925,
          greenleafYearPrice: 600,
          savingYear: 2325,
          order: 3,
        },
        {
          category: "Мытьё посуды",
          massMarketYearPrice: 420,
          greenleafYearPrice: 67,
          savingYear: 353,
          order: 4,
        },
        {
          category: "Шампунь",
          massMarketYearPrice: 720,
          greenleafYearPrice: 432,
          savingYear: 288,
          order: 5,
        },
        {
          category: "Бальзам для волос",
          massMarketYearPrice: 1050,
          greenleafYearPrice: 420,
          savingYear: 630,
          order: 6,
        },
        {
          category: "Гель для душа",
          massMarketYearPrice: 1560,
          greenleafYearPrice: 903,
          savingYear: 657,
          order: 7,
        },
        {
          category: "Зубная паста",
          massMarketYearPrice: 1920,
          greenleafYearPrice: 1575,
          savingYear: 345,
          order: 8,
        },
        {
          category: "Мыло для рук",
          massMarketYearPrice: 4050,
          greenleafYearPrice: 1800,
          savingYear: 2250,
          order: 9,
        },
        {
          category: "Крем для рук",
          massMarketYearPrice: 540,
          greenleafYearPrice: 336,
          savingYear: 204,
          order: 10,
        },
        {
          category: "Уборка кухни",
          massMarketYearPrice: 180,
          greenleafYearPrice: 144,
          savingYear: 36,
          order: 11,
        },
        {
          category: "Женская гигиена",
          massMarketYearPrice: 8866,
          greenleafYearPrice: 3400,
          savingYear: 5466,
          order: 12,
        },
        {
          category: "Туалетная бумага",
          massMarketYearPrice: 2093,
          greenleafYearPrice: 1424,
          savingYear: 669,
          order: 13,
        },
      ]);
      logger.info("Calculator items seeded");
    }

    // Seed app settings
    const existingSettings = await db
      .select()
      .from(appSettingsTable)
      .limit(1);
    if (existingSettings.length === 0) {
      await db.insert(appSettingsTable).values([
        { key: "bot_username", value: "" },
        { key: "default_contact", value: "@greenleaf_admin" },
        { key: "admin_telegram_ids", value: "" },
        {
          key: "final_cta",
          value: "Хочу открыть условия Greenleaf",
        },
        {
          key: "disclaimer_health",
          value:
            "Информация носит ознакомительный характер и не является медицинской консультацией.",
        },
        {
          key: "disclaimer_income",
          value:
            "Бонусы и доход не гарантированы. Результат зависит от действий, товарооборота и условий компании.",
        },
        { key: "telegram_notifications_enabled", value: "true" },
        { key: "ai_enabled", value: "true" },
      ]);
      logger.info("App settings seeded");
    }
  } catch (err) {
    logger.error({ err }, "Error seeding database");
  }
}
