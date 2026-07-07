import { useState } from "react";
import { useGetVideoBlocks, useUpdateVideoBlock, getGetVideoBlocksQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export default function VideosPage() {
  const qc = useQueryClient();
  const { data: videos = [], isLoading } = useGetVideoBlocks();
  const update = useUpdateVideoBlock({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetVideoBlocksQueryKey() }) } });
  const [editing, setEditing] = useState<number | null>(null);
  const [urlInput, setUrlInput] = useState("");

  return (
    <div className="space-y-4 md:space-y-6">
      <div>
        <h1 className="text-xl md:text-2xl font-bold">Видеоблоки</h1>
        <p className="text-sm text-muted-foreground mt-1">Управление видео в сценарии</p>
      </div>

      {isLoading && <div className="text-center text-muted-foreground py-8">Загрузка...</div>}

      <div className="space-y-3">
        {videos.map((v) => (
          <div key={v.id} className="bg-card border rounded-xl p-4">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-base">{v.title}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${v.isActive ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {v.isActive ? "активно" : "выключено"}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">key: <code className="bg-muted px-1 rounded">{v.key}</code></div>
                {v.url ? (
                  <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary mt-1 truncate block hover:underline">{v.url}</a>
                ) : (
                  <div className="text-sm text-muted-foreground italic mt-1">URL не задан</div>
                )}
              </div>
              <div className="flex flex-row sm:flex-col gap-2 shrink-0">
                <button
                  onClick={() => { setEditing(v.id); setUrlInput(v.url || ""); }}
                  className="text-sm border px-3 py-1.5 rounded-lg hover:bg-muted transition flex-1 sm:flex-none"
                >
                  ✏️ Изменить
                </button>
                <button
                  onClick={() => update.mutate({ id: v.id, data: { isActive: !v.isActive } })}
                  className={`text-sm border px-3 py-1.5 rounded-lg transition flex-1 sm:flex-none ${v.isActive ? "hover:bg-destructive/10 hover:border-destructive text-destructive" : "hover:bg-primary/10 hover:border-primary text-primary"}`}
                >
                  {v.isActive ? "Выключить" : "Включить"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {editing !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl border p-6 w-[500px] shadow-xl space-y-4">
            <h2 className="font-bold text-lg">Изменить URL видео</h2>
            <input
              type="url"
              placeholder="https://youtu.be/... или ссылка на видео"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">Оставьте пустым — видео будет скрыто (кнопка вместо видео).</p>
            <div className="flex gap-3">
              <button onClick={() => setEditing(null)} className="flex-1 border rounded-lg px-4 py-2 text-sm hover:bg-muted transition">Отмена</button>
              <button
                onClick={() => { update.mutate({ id: editing, data: { url: urlInput || undefined } }); setEditing(null); }}
                disabled={update.isPending}
                className="flex-1 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm hover:opacity-90 transition disabled:opacity-50"
              >
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
