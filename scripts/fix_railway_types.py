from pathlib import Path

engine = Path("artifacts/api-server/src/bot/engine-v2.ts")
text = engine.read_text(encoding="utf-8")
changed = False

old_options = "  options: TelegramBot.SendMessageOptions = {},\n): Promise<void> {"
new_options = "  options?: TelegramBot.SendMessageOptions,\n): Promise<void> {"
count = text.count(old_options)
if count:
    if count != 2:
        raise SystemExit(f"Expected 2 options declarations, found {count}")
    text = text.replace(old_options, new_options)
    changed = True
elif text.count(new_options) != 2:
    raise SystemExit("Expected patched options declarations were not found")

old_values = '    const values = key === "laundry_question_named" ? { name: session.firstName || "" } : {};'
new_values = '    const values: Record<string, string | number> = key === "laundry_question_named" ? { name: session.firstName || "" } : {};'
if old_values in text:
    text = text.replace(old_values, new_values, 1)
    changed = True
elif new_values not in text:
    raise SystemExit("Expected values declaration was not found")

if changed:
    engine.write_text(text, encoding="utf-8")
    print("Applied Railway TypeScript compatibility patch")
else:
    print("Railway TypeScript compatibility patch already applied")
