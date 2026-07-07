import { useGetAiStatus, useGetAiLogs, useTestAi } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export default function AiPage() {
  const qc = useQueryClient();
  const { data: status, isLoading } = useGetAiStatus();
  const { data: logs = [] } = useGetAiLogs();
  const testAi = useTestAi({ mutation: { onSuccess: () => qc.invalidateQueries() } });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">AI / Proxy API</h1>
        <p className="text-sm text-muted-foreground mt-1">Статус и логи ИИ-модуля</p>
      </div>

      {isLoading && <div className="text-center text-muted-foreground py-8">Загрузка...</div>}

      {status && (
        <div className="bg-card border rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${status.available ? "bg-green-500" : "bg-red-500"} animate-pulse`} />
            <span className="font-semibold">{status.available ? "✅ Proxy API доступен" : "❌ Proxy API недоступен"}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-muted/50 rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">API Key</div>
              <div className={status.hasKey ? "text-green-600" : "text-red-600"}>{status.hasKey ? "✅ задан" : "❌ не задан"}</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">Модель</div>
              <div className="font-mono">{status.model}</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 col-span-2">
              <div className="text-xs text-muted-foreground mb-1">Base URL</div>
              <div className="font-mono text-xs truncate">{status.baseUrl}</div>
            </div>
          </div>
          <button
            onClick={() => testAi.mutate({})}
            disabled={testAi.isPending}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {testAi.isPending ? "Тестирую..." : "🔄 Тест подключения"}
          </button>
          {testAi.data && (
            <div className={`text-sm px-3 py-2 rounded-lg ${testAi.data.available ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
              {testAi.data.message}
            </div>
          )}
        </div>
      )}

      <div className="bg-card border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/50">
          <h2 className="font-semibold text-sm">Последние AI-запросы ({logs.length})</h2>
        </div>
        <div className="divide-y max-h-96 overflow-y-auto">
          {logs.length === 0 && <div className="text-center text-muted-foreground py-8 text-sm">Логов нет</div>}
          {logs.map((log) => (
            <div key={log.id} className="px-4 py-3 text-xs">
              <div className="flex items-center gap-2 mb-1">
                <span className={`px-1.5 py-0.5 rounded text-xs font-mono ${log.success ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>{log.success ? "OK" : "ERR"}</span>
                <span className="font-medium">{log.promptType}</span>
                <span className="text-muted-foreground ml-auto">{new Date(log.createdAt).toLocaleTimeString("ru")}</span>
              </div>
              <div className="text-muted-foreground truncate">{log.input?.substring(0, 120)}</div>
              {log.output && <div className="text-foreground truncate mt-0.5">{log.output?.substring(0, 120)}</div>}
              {log.error && <div className="text-destructive mt-0.5">{log.error}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
