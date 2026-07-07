import { useState } from "react";
import { useGetSessions, useGetSessionMessages } from "@workspace/api-client-react";

export default function SessionsPage() {
  const { data: sessions = [], isLoading } = useGetSessions({ limit: 50 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: messages = [] } = useGetSessionMessages(selectedId!, { query: { enabled: !!selectedId, queryKey: ["sessionMessages", selectedId] } });

  return (
    <div className="space-y-4 md:space-y-6">
      <div>
        <h1 className="text-xl md:text-2xl font-bold">Диалоги</h1>
        <p className="text-sm text-muted-foreground mt-1">{sessions.length} сессий</p>
      </div>

      {isLoading && <div className="text-muted-foreground text-center py-8">Загрузка...</div>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-2">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(selectedId === s.id ? null : s.id)}
              className={`w-full text-left bg-card border rounded-xl p-4 transition hover:border-primary ${selectedId === s.id ? "border-primary ring-1 ring-primary" : ""}`}
            >
              <div className="flex items-center justify-between">
                <div className="font-medium">@{s.username || `user_${s.telegramUserId}`}</div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${s.isCompleted ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                  {s.isCompleted ? "завершил" : "активен"}
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-1 font-mono">{s.currentStage}</div>
              <div className="text-xs text-muted-foreground mt-1">{new Date(s.updatedAt).toLocaleString("ru")}</div>
            </button>
          ))}
        </div>

        {selectedId && (
          <div className="bg-card border rounded-xl p-4 h-[600px] flex flex-col">
            <div className="font-semibold mb-3">Переписка</div>
            <div className="flex-1 overflow-y-auto space-y-2">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}>
                    {m.content}
                    {m.intent && <div className="text-xs opacity-60 mt-1">[{m.intent}]</div>}
                  </div>
                </div>
              ))}
              {messages.length === 0 && <div className="text-muted-foreground text-center pt-8">Нет сообщений</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
