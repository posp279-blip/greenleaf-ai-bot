import { useState } from "react";
import { useGetPartners, useCreatePartner, useUpdatePartner, useDeletePartner, getGetPartnersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export default function PartnersPage() {
  const qc = useQueryClient();
  const { data: partners = [], isLoading } = useGetPartners();
  const createPartner = useCreatePartner({ mutation: { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetPartnersQueryKey() }); setShowCreate(false); setForm({ name: "", refCode: "", telegram: "", phone: "" }); } } });
  const updatePartner = useUpdatePartner({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetPartnersQueryKey() }) } });
  const deletePartner = useDeletePartner({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetPartnersQueryKey() }) } });

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", refCode: "", telegram: "", phone: "" });
  const [editingPartner, setEditingPartner] = useState<typeof partners[0] | null>(null);
  const [editForm, setEditForm] = useState({ name: "", refCode: "", telegram: "", phone: "", telegramUserId: "" });

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Партнёры</h1>
          <p className="text-sm text-muted-foreground mt-1">{partners.length} партнёров</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition w-full sm:w-auto">
          ➕ Создать
        </button>
      </div>

      {isLoading && <div className="text-center text-muted-foreground py-8">Загрузка...</div>}

      <div className="space-y-3">
        {partners.map((p) => (
          <div key={p.id} className="bg-card border rounded-xl p-4">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-base">{p.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${p.isActive ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                    {p.isActive ? "активен" : "неактивен"}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground mt-1">refCode: <code className="bg-muted px-1 rounded">{p.refCode}</code></div>
                {p.partnerLink && (
                  <div className="text-xs text-primary mt-1 truncate">
                    <a href={p.partnerLink} target="_blank" rel="noopener noreferrer">{p.partnerLink}</a>
                  </div>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm text-muted-foreground">
                  {p.telegram && <span>TG: {p.telegram}</span>}
                  {p.phone && <span>📞 {p.phone}</span>}
                  <span>Заявок: <strong className="text-foreground">{p.leadsCount}</strong></span>
                  <span>TG ID: <code className="bg-muted px-1 rounded">{p.telegramUserId ?? "—"}</code></span>
                </div>
              </div>
              <div className="flex flex-row sm:flex-col gap-2 sm:items-end shrink-0">
                <button
                  onClick={() => updatePartner.mutate({ id: p.id, data: { isActive: !p.isActive } })}
                  className={`text-sm px-3 py-1.5 rounded-lg border transition flex-1 sm:flex-none ${p.isActive ? "hover:bg-destructive hover:text-destructive-foreground hover:border-destructive" : "hover:bg-primary hover:text-primary-foreground hover:border-primary"}`}
                >
                  {p.isActive ? "Деактивировать" : "Активировать"}
                </button>
                <button
                  onClick={() => { setEditingPartner(p); setEditForm({ name: p.name, refCode: p.refCode, telegram: p.telegram || "", phone: p.phone || "", telegramUserId: p.telegramUserId != null ? String(p.telegramUserId) : "" }); }}
                  className="text-xs px-3 py-1.5 rounded-lg border hover:bg-muted transition flex-1 sm:flex-none"
                >
                  ✏️ Редактировать
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Удалить партнёра "${p.name}"? Это необратимо.`)) {
                      deletePartner.mutate({ id: p.id });
                    }
                  }}
                  disabled={deletePartner.isPending}
                  className="text-xs px-3 py-1.5 rounded-lg border border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground transition flex-1 sm:flex-none disabled:opacity-50"
                >
                  🗑️ Удалить
                </button>
              </div>
            </div>
          </div>
        ))}
        {!isLoading && partners.length === 0 && <div className="text-center text-muted-foreground py-12">Партнёров нет</div>}
      </div>

      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl border p-6 w-96 shadow-xl space-y-4">
            <h2 className="font-bold text-lg">Новый партнёр</h2>
            <input type="text" placeholder="Имя *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
            <div className="text-xs text-muted-foreground -mt-1">refCode будет сгенерирован автоматически по имени. Можно ввести вручную:</div>
            <input type="text" placeholder="refCode (опционально, латиница/цифры)" value={form.refCode} onChange={(e) => setForm({ ...form, refCode: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input type="text" placeholder="Telegram (@username)" value={form.telegram} onChange={(e) => setForm({ ...form, telegram: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input type="text" placeholder="Телефон" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
            <div className="flex gap-3">
              <button onClick={() => { setShowCreate(false); setForm({ name: "", refCode: "", telegram: "", phone: "" }); }} className="flex-1 border rounded-lg px-4 py-2 text-sm hover:bg-muted transition">Отмена</button>
              <button
                onClick={() => createPartner.mutate({ data: { name: form.name, refCode: form.refCode, telegram: form.telegram || undefined, phone: form.phone || undefined } })}
                disabled={!form.name || createPartner.isPending}
                className="flex-1 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm hover:opacity-90 transition disabled:opacity-50"
              >
                {createPartner.isPending ? "..." : "Создать"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingPartner && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl border p-6 w-96 shadow-xl space-y-4">
            <h2 className="font-bold text-lg">Редактировать партнёра</h2>
            <input type="text" placeholder="Имя" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input type="text" placeholder="refCode" value={editForm.refCode} onChange={(e) => setEditForm({ ...editForm, refCode: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input type="text" placeholder="Telegram (@username)" value={editForm.telegram} onChange={(e) => setEditForm({ ...editForm, telegram: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input type="text" placeholder="Телефон" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input type="text" placeholder="Telegram ID (число) — для привязки бота" value={editForm.telegramUserId} onChange={(e) => setEditForm({ ...editForm, telegramUserId: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" />
            <div className="text-xs text-muted-foreground">
              Telegram ID позволяет пользователю видеть партнёрское меню в боте. Если не заполнен — напишите его или попросите партнёра написать <code className="bg-muted px-1 rounded">/id</code> боту.
            </div>
            <div className="flex gap-3">
              <button onClick={() => setEditingPartner(null)} className="flex-1 border rounded-lg px-4 py-2 text-sm hover:bg-muted transition">Отмена</button>
              <button
                onClick={() => {
                  const tid = editForm.telegramUserId.trim() ? parseInt(editForm.telegramUserId.trim(), 10) : null;
                  updatePartner.mutate({ id: editingPartner.id, data: {
                    name: editForm.name,
                    telegram: editForm.telegram || undefined,
                    phone: editForm.phone || undefined,
                    telegramUserId: tid && !isNaN(tid) ? tid : null,
                  } });
                  setEditingPartner(null);
                }}
                className="flex-1 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm hover:opacity-90 transition"
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
