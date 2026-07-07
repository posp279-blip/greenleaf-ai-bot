---
name: Proxy API AI integration
description: Greenleaf bot AI layer via Proxy API — key constraints and integration details
---

The bot uses Proxy API (https://api.proxyapi.ru/openai/v1) as an OpenAI-compatible endpoint.

**Key constraint — AI never changes stage:**
The AI layer only classifies user intent and generates personalized reactions/answers. It NEVER changes `currentStage` in the DB. All stage transitions are explicit in `engine.ts`. This is intentional to keep the state machine predictable.

**How to apply:**
- `classifyUserInput()` — returns `{ intent, confidence }`, used to personalize reactions
- `generateReaction()` — generates brand-specific reaction text (e.g. "Ты пользуешься Ariel...")
- `answerQuestion()` — answers free-form user questions about Greenleaf
- All three functions fall back gracefully if AI is unavailable

**Config (env vars):**
- `PROXY_API_KEY` — the API key (also checked as `PROXY_API_TOKEN`)
- `PROXY_API_BASE_URL` — defaults to `https://api.proxyapi.ru/openai/v1`
- `PROXY_API_MODEL` — defaults to `gpt-4o-mini`
- `AI_ENABLED` — set to `"false"` to disable AI entirely

**AI logs** are stored in `ai_logs` table and visible in the web admin panel `/admin/ai`.
