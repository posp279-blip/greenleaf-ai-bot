import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type ScenarioBlock = {
  id: number;
  key: string;
  stage: string;
  title: string;
  shortText: string;
  detailedText: string | null;
  order: number;
  isActive: boolean;
  updatedAt: string;
};

type EditorState = {
  id: number;
  title: string;
  shortText: string;
};

const QUERY_KEY = ["admin", "scenario-blocks"] as const;

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Ошибка запроса: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function getScenarioBlocks(): Promise<ScenarioBlock[]> {
  const response = await fetch("/api/admin/scenario-blocks", { credentials: "include" });
  return readJson<ScenarioBlock[]>(response);
}

async function updateScenarioBlock(
  id: number,
  data: Partial<Pick<ScenarioBlock, "title" | "shortText" | "isActive">>,
): Promise<ScenarioBlock> {
  const response = await fetch(`/api/admin/scenario-blocks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  return readJson<ScenarioBlock>(response);
}

async function resetScenarioBlock(id: number): Promise<ScenarioBlock> {
  const response = await fetch(`/api/admin/scenario-blocks/${id}/reset`, {
    method: "POST",
    credentials: "include",
  });
  return readJson<ScenarioBlock>(response);
}

function previewText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export default function ScenarioPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const { data: blocks = [], isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getScenarioBlocks,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  };

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Pick<ScenarioBlock, "title" | "shortText" | "isActive">> }) =>
      updateScenarioBlock(id, data),
    onSuccess: async () => {
      await refresh();
      setFeedback("Изменения сохранены. Бот уже использует новый текст.");
    },
  });

  const resetMutation = useMutation({
    mutationFn: resetScenarioBlock,
    onSuccess: async () => {
      await refresh();
      setEditor(null);
      setFeedback("Исходный текст восстановлен.");
    },
  });

  const stages = useMemo(
    () => Array.from(new Set(blocks.map((block) => block.stage))).sort((a, b) => a.localeCompare(b, "ru")),
    [blocks],
  );

  const filteredBlocks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return blocks.filter((block) => {
      if (stageFilter && block.stage !== stageFilter) return false;
      if (!query) return true;
      return [block.title, block.key, block.stage, block.shortText]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [blocks, search, stageFilter]);

  const saveEditor = async () => {
    if (!editor) return;
    const title = editor.title.trim();
    const shortText = editor.shortText.trim();
    if (!title || !shortText) {
      setFeedback("Заголовок и текст не могут быть пустыми.");
      return;
    }

    await updateMutation.mutateAsync({
      id: editor.id,
      data: { title, shortText },
    });
    setEditor(null);
  };

  const resetCurrent = async () => {
    if (!editor) return;
    const confirmed = window.confirm("Вернуть исходный текст этого блока? Текущая версия будет заменена.");
    if (!confirmed) return;
    await resetMutation.mutateAsync(editor.id);
  };

  return (
    <div className="space-y-4 md:space-y-6">
      <div>
        <h1 className="text-xl md:text-2xl font-bold">📝 Сценарий</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Редактирование сообщений бота без изменения его логики
        </p>
      </div>

      <div className="bg-card border rounded-xl p-4">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_240px] gap-3">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск по названию, ключу или тексту"
            className="w-full border rounded-lg px-3 py-2.5 text-sm bg-background"
          />
          <select
            value={stageFilter}
            onChange={(event) => setStageFilter(event.target.value)}
            className="w-full border rounded-lg px-3 py-2.5 text-sm bg-background"
          >
            <option value="">Все этапы</option>
            {stages.map((stage) => (
              <option key={stage} value={stage}>{stage}</option>
            ))}
          </select>
        </div>
        <div className="text-xs text-muted-foreground mt-3">
          Найдено блоков: {filteredBlocks.length} из {blocks.length}
        </div>
      </div>

      {feedback && (
        <div className="border rounded-xl px-4 py-3 bg-card text-sm flex items-start justify-between gap-3">
          <span>{feedback}</span>
          <button onClick={() => setFeedback(null)} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
      )}

      {isLoading && <div className="text-center text-muted-foreground py-10">Загрузка сценария...</div>}
      {error && <div className="text-center text-destructive py-10">{error instanceof Error ? error.message : "Не удалось загрузить сценарий"}</div>}

      <div className="space-y-3">
        {filteredBlocks.map((block) => (
          <div key={block.id} className="bg-card border rounded-xl p-4">
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-base">{block.title}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${block.isActive ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {block.isActive ? "активно" : "выключено"}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  <span>этап: <code className="bg-muted px-1 rounded">{block.stage}</code></span>
                  <span>ключ: <code className="bg-muted px-1 rounded">{block.key}</code></span>
                </div>
                <p className="text-sm mt-3 text-foreground/80 leading-relaxed line-clamp-3">
                  {previewText(block.shortText)}
                </p>
              </div>

              <div className="flex flex-row lg:flex-col gap-2 shrink-0">
                <button
                  onClick={() => {
                    setFeedback(null);
                    setEditor({ id: block.id, title: block.title, shortText: block.shortText });
                  }}
                  className="text-sm border px-3 py-2 rounded-lg hover:bg-muted transition flex-1 lg:flex-none"
                >
                  ✏️ Изменить
                </button>
                <button
                  onClick={() => updateMutation.mutate({ id: block.id, data: { isActive: !block.isActive } })}
                  disabled={updateMutation.isPending}
                  className={`text-sm border px-3 py-2 rounded-lg transition flex-1 lg:flex-none disabled:opacity-50 ${block.isActive ? "hover:bg-destructive/10 hover:border-destructive text-destructive" : "hover:bg-primary/10 hover:border-primary text-primary"}`}
                >
                  {block.isActive ? "Выключить" : "Включить"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {!isLoading && !error && filteredBlocks.length === 0 && (
        <div className="text-center text-muted-foreground py-12">Подходящие блоки не найдены</div>
      )}

      {editor && (
        <div className="fixed inset-0 bg-black/60 flex items-end md:items-center justify-center z-50 p-0 md:p-4">
          <div className="bg-card border w-full md:max-w-3xl h-[92vh] md:h-auto md:max-h-[90vh] rounded-t-2xl md:rounded-2xl shadow-xl flex flex-col">
            <div className="px-4 md:px-6 py-4 border-b flex items-center justify-between gap-3">
              <div>
                <h2 className="font-bold text-lg">Редактирование блока</h2>
                <p className="text-xs text-muted-foreground mt-1">Сохраняй фигурные переменные: {"{name}"}, {"{family}"}, {"{mass}"}, {"{green}"}, {"{saving}"}</p>
              </div>
              <button onClick={() => setEditor(null)} className="text-xl text-muted-foreground hover:text-foreground p-2">✕</button>
            </div>

            <div className="p-4 md:p-6 space-y-4 overflow-y-auto flex-1">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Название блока</span>
                <input
                  value={editor.title}
                  onChange={(event) => setEditor({ ...editor, title: event.target.value })}
                  className="w-full border rounded-lg px-3 py-2.5 bg-background"
                />
              </label>

              <label className="block space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">Текст сообщения</span>
                  <span className="text-xs text-muted-foreground">{editor.shortText.length} символов</span>
                </div>
                <textarea
                  value={editor.shortText}
                  onChange={(event) => setEditor({ ...editor, shortText: event.target.value })}
                  rows={18}
                  className="w-full border rounded-lg px-3 py-3 bg-background text-sm leading-relaxed resize-y min-h-[320px]"
                />
              </label>

              {(updateMutation.error || resetMutation.error) && (
                <div className="text-sm text-destructive">
                  {(updateMutation.error || resetMutation.error) instanceof Error
                    ? (updateMutation.error || resetMutation.error)?.message
                    : "Не удалось сохранить изменения"}
                </div>
              )}
            </div>

            <div className="p-4 md:p-6 border-t flex flex-col-reverse sm:flex-row gap-3">
              <button
                onClick={resetCurrent}
                disabled={resetMutation.isPending || updateMutation.isPending}
                className="sm:mr-auto border border-destructive/40 text-destructive rounded-lg px-4 py-2.5 text-sm hover:bg-destructive/10 disabled:opacity-50"
              >
                ↩ Вернуть исходный текст
              </button>
              <button
                onClick={() => setEditor(null)}
                className="border rounded-lg px-4 py-2.5 text-sm hover:bg-muted"
              >
                Отмена
              </button>
              <button
                onClick={saveEditor}
                disabled={updateMutation.isPending || resetMutation.isPending}
                className="bg-primary text-primary-foreground rounded-lg px-5 py-2.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {updateMutation.isPending ? "Сохранение..." : "Сохранить и применить"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
