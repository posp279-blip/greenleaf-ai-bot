from pathlib import Path

engine = Path("artifacts/api-server/src/bot/engine-v2.ts")
text = engine.read_text(encoding="utf-8")

old_options = "  options: TelegramBot.SendMessageOptions = {},\n): Promise<void> {"
new_options = "  options?: TelegramBot.SendMessageOptions,\n): Promise<void> {"
if text.count(old_options) != 2:
    raise SystemExit(f"Expected 2 options declarations, found {text.count(old_options)}")
text = text.replace(old_options, new_options)

old_values = '    const values = key === "laundry_question_named" ? { name: session.firstName || "" } : {};'
new_values = '    const values: Record<string, string | number> = key === "laundry_question_named" ? { name: session.firstName || "" } : {};'
if old_values not in text:
    raise SystemExit("Expected values declaration was not found")
text = text.replace(old_values, new_values, 1)

engine.write_text(text, encoding="utf-8")

Path("scripts/fix_railway_types.py").unlink()
Path(".github/workflows/fix-railway-types.yml").unlink()
