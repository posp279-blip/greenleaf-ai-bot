import { useState } from "react";
import { useGetSettings, useUpdateSetting, getGetSettingsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const SETTING_LABELS: Record<string, string> = {
  bot_username: "Username бота",
  default_contact: "Контакт по умолчанию",
  admin_telegram_ids: "Telegram ID администраторов (через запятую)",
  telegram_notifications_enabled: "Уведомления о заявках (true/false)",
};

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useGetSettings();
  const update = useUpdateSetting({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetSettingsQueryKey() }) } });

  const [editing, setEditing] = useState<string | null>(null);
  const [valueInput, setValueInput] = useState("");

  const allKeys = settings ? Object.keys(settings) : [];

  return (
    <div className="space-y-4 md:space-y-6">
      <div>
        <h1 className="text-xl md:text-2xl font-bold">Настройки</h1>
        <p className="text-sm text-muted-foreground mt-1">Конфигурация бота</p>
      </div>

      {isLoading && <div className="text-center text-muted-foreground py-8">Загрузка...</div>}

      <div className="space-y-3">
        {allKeys.map((key) => (
          <div key={key} className="bg-card border rounded-xl p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{SETTING_LABELS[key] || key}</div>
                <code className="text-xs text-muted-foreground">{key}</code>
                <div className="mt-1 text-sm truncate">{settings![key] || <span className="text-muted-foreground italic">не задано</span>}</div>
              </div>
              <button
                onClick={() => { setEditing(key); setValueInput(settings![key] || ""); }}
                className="text-sm border px-3 py-1.5 rounded-lg hover:bg-muted transition shrink-0"
              >
                ✏️ Изменить
              </button>
            </div>
          </div>
        ))}

        {!isLoading && allKeys.length === 0 && (
          <div className="text-center text-muted-foreground py-12">
            <p>Нет настроек</p>
            <p className="text-xs mt-1">Запусти бота — настройки появятся автоматически</p>
          </div>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <div className="bg-card rounded-xl border p-5 md:p-6 w-full max-w-[500px] shadow-xl space-y-4">
            <h2 className="font-bold text-lg">Изменить настройку</h2>
            <div>
              <label className="text-sm text-muted-foreground block mb-1">{SETTING_LABELS[editing] || editing}</label>
              <code className="text-xs text-muted-foreground">{editing}</code>
              <textarea
                value={valueInput}
                onChange={(e) => setValueInput(e.target.value)}
                rows={3}
                className="w-full border rounded-lg px-3 py-2 text-sm mt-2 resize-none"
              />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setEditing(null)} className="flex-1 border rounded-lg px-4 py-2 text-sm hover:bg-muted transition">Отмена</button>
              <button
                onClick={() => { update.mutate({ key: editing, data: { value: valueInput } }); setEditing(null); }}
                disabled={update.isPending}
                className="flex-1 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm hover:opacity-90 transition disabled:opacity-50"
              >
                {update.isPending ? "..." : "Сохранить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
