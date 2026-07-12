import { useState } from "react";
import { useGetLeads, useUpdateLead, useConvertLeadToPartner, getGetLeadsQueryKey, getGetPartnersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const STATUS_OPTIONS = ["новая", "в работе", "зарегистрирован", "отказ", "архив"];
const STATUS_COLORS: Record<string, string> = {
  "новая": "bg-blue-100 text-blue-700",
  "в работе": "bg-yellow-100 text-yellow-700",
  "зарегистрирован": "bg-green-100 text-green-700",
  "отказ": "bg-red-100 text-red-700",
  "архив": "bg-gray-100 text-gray-600",
};

function getLeadSource(lead: unknown): "vk" | "telegram" {
  const source = (lead as { source?: string }).source;
  return source === "vk" ? "vk" : "telegram";
}

export default function LeadsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [convertId, setConvertId] = useState<number | null>(null);

  const { data: leads = [], isLoading } = useGetLeads({ status: statusFilter || undefined });
  const visibleLeads = leads.filter((lead) => !sourceFilter || getLeadSource(lead) === sourceFilter);
  const updateLead = useUpdateLead({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetLeadsQueryKey() }) } });
  const convertLead = useConvertLeadToPartner({ mutation: { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetLeadsQueryKey() }); qc.invalidateQueries({ queryKey: getGetPartnersQueryKey() }); setConvertId(null); } } });

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Заявки</h1>
          <p className="text-sm text-muted-foreground mt-1">{visibleLeads.length} заявок</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-card w-full sm:w-auto">
            <option value="">Все каналы</option>
            <option value="telegram">Telegram</option>
            <option value="vk">VK</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-card w-full sm:w-auto">
            <option value="">Все статусы</option>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {isLoading && <div className="text-muted-foreground text-center py-8">Загрузка...</div>}

      <div className="space-y-3">
        {visibleLeads.map((lead) => {
          const source = getLeadSource(lead);
          return (
            <div key={lead.id} className="bg-card border rounded-xl p-4">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-base">{lead.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[lead.status] || "bg-gray-100 text-gray-600"}`}>{lead.status}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${source === "vk" ? "bg-blue-100 text-blue-700" : "bg-sky-100 text-sky-700"}`}>
                      {source === "vk" ? "VK" : "Telegram"}
                    </span>
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">{lead.contact}</div>
                  {lead.comment && <div className="text-sm text-muted-foreground mt-1 italic">{lead.comment}</div>}
                  <div className="text-xs text-muted-foreground mt-2">{new Date(lead.createdAt).toLocaleString("ru")}</div>
                </div>
                <div className="flex flex-row sm:flex-col gap-2 shrink-0">
                  <select
                    value={lead.status}
                    onChange={(e) => updateLead.mutate({ id: lead.id, data: { status: e.target.value } })}
                    className="border rounded-lg px-2 py-1.5 text-sm bg-card flex-1 sm:flex-none"
                  >
                    {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  {lead.status === "зарегистрирован" && !lead.convertedPartnerId && (
                    <button
                      onClick={() => setConvertId(lead.id)}
                      className="bg-primary text-primary-foreground text-xs px-3 py-1.5 rounded-lg hover:opacity-90 transition whitespace-nowrap"
                    >
                      👥 В партнёры
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {!isLoading && visibleLeads.length === 0 && <div className="text-center text-muted-foreground py-12">Заявок нет</div>}
      </div>

      {convertId !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl border p-6 w-96 shadow-xl">
            <h2 className="font-bold text-lg mb-4">Создать партнёра из заявки</h2>
            <p className="text-sm text-muted-foreground mb-4">refCode будет сгенерирован автоматически по имени заявки.</p>
            <div className="flex gap-3">
              <button onClick={() => { setConvertId(null); }} className="flex-1 border rounded-lg px-4 py-2 text-sm hover:bg-muted transition">Отмена</button>
              <button
                onClick={() => convertLead.mutate({ id: convertId, data: {} })}
                disabled={convertLead.isPending}
                className="flex-1 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm hover:opacity-90 transition disabled:opacity-50"
              >
                {convertLead.isPending ? "..." : "Создать"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
