import { useState } from "react";
import { useGetCalculator, useUpdateCalculatorItem, getGetCalculatorQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export default function CalculatorPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useGetCalculator();
  const update = useUpdateCalculatorItem({ mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getGetCalculatorQueryKey() }) } });
  const [editing, setEditing] = useState<{ id: number; mass: string; green: string } | null>(null);

  const fmt = (n: number) => n.toLocaleString("ru");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Калькулятор</h1>
        <p className="text-sm text-muted-foreground mt-1">13 категорий расходов на бытовую химию</p>
      </div>

      {isLoading && <div className="text-center text-muted-foreground py-8">Загрузка...</div>}

      {data && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-gray-50 border rounded-xl p-4 text-center">
              <div className="text-xs text-muted-foreground mb-1">Масс-маркет (1 чел/год)</div>
              <div className="text-2xl font-bold">{fmt(data.totals.mass)} ₽</div>
            </div>
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
              <div className="text-xs text-muted-foreground mb-1">Greenleaf (1 чел/год)</div>
              <div className="text-2xl font-bold text-green-700">{fmt(data.totals.green)} ₽</div>
            </div>
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 text-center">
              <div className="text-xs text-muted-foreground mb-1">Экономия (1 чел/год)</div>
              <div className="text-2xl font-bold text-primary">{fmt(data.totals.saving)} ₽</div>
            </div>
          </div>

          <div className="bg-card rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">#</th>
                  <th className="text-left px-4 py-3 font-medium">Категория</th>
                  <th className="text-right px-4 py-3 font-medium">Масс-маркет</th>
                  <th className="text-right px-4 py-3 font-medium">Greenleaf</th>
                  <th className="text-right px-4 py-3 font-medium">Экономия</th>
                  <th className="text-center px-4 py-3 font-medium">Статус</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map((item) => (
                  <tr key={item.id} className={`hover:bg-muted/40 transition ${!item.isActive ? "opacity-50" : ""}`}>
                    <td className="px-4 py-3 text-muted-foreground">{item.order}</td>
                    <td className="px-4 py-3 font-medium">{item.category}</td>
                    <td className="px-4 py-3 text-right">{fmt(item.massMarketYearPrice)} ₽</td>
                    <td className="px-4 py-3 text-right text-green-700">{fmt(item.greenleafYearPrice)} ₽</td>
                    <td className="px-4 py-3 text-right text-primary font-medium">{fmt(item.savingYear)} ₽</td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => update.mutate({ id: item.id, data: { isActive: !item.isActive } })}
                        className={`text-xs px-2 py-1 rounded-full border transition ${item.isActive ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-500 border-gray-200"}`}
                      >
                        {item.isActive ? "вкл" : "выкл"}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setEditing({ id: item.id, mass: String(item.massMarketYearPrice), green: String(item.greenleafYearPrice) })}
                        className="text-xs text-primary hover:underline"
                      >
                        Изменить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl border p-6 w-96 shadow-xl space-y-4">
            <h2 className="font-bold text-lg">Изменить цены</h2>
            <div>
              <label className="text-sm text-muted-foreground">Масс-маркет (₽/год)</label>
              <input type="number" value={editing.mass} onChange={(e) => setEditing({ ...editing, mass: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
            </div>
            <div>
              <label className="text-sm text-muted-foreground">Greenleaf (₽/год)</label>
              <input type="number" value={editing.green} onChange={(e) => setEditing({ ...editing, green: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setEditing(null)} className="flex-1 border rounded-lg px-4 py-2 text-sm hover:bg-muted transition">Отмена</button>
              <button
                onClick={() => { update.mutate({ id: editing.id, data: { massMarketYearPrice: parseInt(editing.mass), greenleafYearPrice: parseInt(editing.green) } }); setEditing(null); }}
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
