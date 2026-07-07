---
name: Telegram bot import pattern
description: Correct way to import TelegramBot and its types in TypeScript with node-telegram-bot-api
---

`node-telegram-bot-api` exports `TelegramBot` as a class (default export) and named types (`Message`, `CallbackQuery`, `InlineKeyboardButton`, etc.) as a namespace.

**Rule:** Always split the import — default import for the class, named `type` imports for the types.

```ts
// CORRECT
import TelegramBot from "node-telegram-bot-api";
import type { Message, CallbackQuery, InlineKeyboardButton } from "node-telegram-bot-api";

// WRONG — causes TS2702 "TelegramBot only refers to a type, not a namespace"
import TelegramBot, { type Message } from "node-telegram-bot-api";
// Then using TelegramBot.Message in type positions
```

**Why:** The `TelegramBot` namespace sub-types (`TelegramBot.Message`, etc.) do not exist at the type level in the @types/node-telegram-bot-api package. Use the named exports directly.
