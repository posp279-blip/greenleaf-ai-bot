import { readFileSync, writeFileSync } from "node:fs";

const enginePath = "artifacts/api-server/src/bot/engine-v2.ts";
let text = readFileSync(enginePath, "utf8");
let changed = false;

const oldOptions = "  options: TelegramBot.SendMessageOptions = {},\n): Promise<void> {";
const newOptions = "  options?: TelegramBot.SendMessageOptions,\n): Promise<void> {";
const optionsCount = text.split(oldOptions).length - 1;

if (optionsCount > 0) {
  if (optionsCount !== 2) {
    throw new Error(`Expected 2 options declarations, found ${optionsCount}`);
  }
  text = text.split(oldOptions).join(newOptions);
  changed = true;
} else {
  const patchedCount = text.split(newOptions).length - 1;
  if (patchedCount !== 2) {
    throw new Error("Expected patched options declarations were not found");
  }
}

const oldValues = '    const values = key === "laundry_question_named" ? { name: session.firstName || "" } : {};';
const newValues = '    const values: Record<string, string | number> = key === "laundry_question_named" ? { name: session.firstName || "" } : {};';

if (text.includes(oldValues)) {
  text = text.replace(oldValues, newValues);
  changed = true;
} else if (!text.includes(newValues)) {
  throw new Error("Expected values declaration was not found");
}

if (changed) {
  writeFileSync(enginePath, text, "utf8");
  console.log("Applied Railway TypeScript compatibility patch");
} else {
  console.log("Railway TypeScript compatibility patch already applied");
}
