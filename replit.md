# Greenleaf AI Telegram Bot System

A full-stack MLM/referral system with a Telegram bot that guides users through a product scenario (laundry, dish soap, feminine hygiene, toilet paper), captures leads, and manages a partner/referral network.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API + Telegram bot (port 8080)
- `pnpm --filter @workspace/admin run dev` — run the React web admin panel
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `PROXY_API_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (port 8080, path `/api`)
- Telegram: node-telegram-bot-api (polling mode)
- AI: OpenAI SDK pointed at https://api.proxyapi.ru/openai/v1, model gpt-4o-mini
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Web admin: React + Vite + Tailwind (path `/admin`)

## Where things live

- `lib/db/src/schema/index.ts` — DB schema (9 tables)
- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `artifacts/api-server/src/bot/engine.ts` — state machine + all bot handlers
- `artifacts/api-server/src/bot/texts.ts` — all bot message texts
- `artifacts/api-server/src/bot/ai.ts` — Proxy API / OpenAI integration
- `artifacts/api-server/src/bot/seed.ts` — DB seeding (scenario blocks, videos, calculator, settings)
- `artifacts/api-server/src/routes/admin.ts` — REST API for admin panel
- `artifacts/admin/src/` — React web admin panel

## Architecture decisions

- AI (Proxy API) only classifies intent and generates reactions — it NEVER changes bot stage. Stage transitions are always explicit in engine.ts.
- Lead capture only happens at the end of the scenario (final_question stage), after user clicks "Хочу открыть условия Greenleaf".
- Menu (Главное меню) is only shown after depth_choice — not on first message.
- Admin IDs stored in app_settings key "admin_telegram_ids" (comma-separated).
- Partner referral links: `https://t.me/{BOT_USERNAME}?start={refCode}`.
- adminStateTable used for both admin multi-step flows and user lead capture state.
- Express 5 route handlers: use `{ res.status(...); return; }` pattern (NOT `return res.status(...)`) to avoid TS7030 "not all code paths return a value" errors.

## Product

- Telegram bot conducts a scenario-based conversation across 4 product categories
- AI personalizes reactions based on user brand preferences
- Calculator shows annual savings across 13 household product categories
- Partners get referral links, see their leads and stats in the bot
- Admins manage everything via Telegram commands AND the React web panel
- Lead capture collects name + contact + optional comment at scenario end
- Admin panel: dashboard, leads, partners, dialogs, videos, calculator, settings, AI status

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Telegram 404 polling errors in dev = invalid/test TELEGRAM_BOT_TOKEN — this is normal until a real token is set
- After any lib/db schema change: run `pnpm run typecheck:libs` before checking artifact packages
- After any openapi.yaml change: run `pnpm --filter @workspace/api-spec run codegen`
- Bot seed runs on every startup (idempotent — uses onConflictDoNothing/onConflictDoUpdate)
- Engine.ts imports TelegramBot as default + named types from node-telegram-bot-api (separate imports required)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
