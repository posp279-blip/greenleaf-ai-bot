import { useGetStats } from "@workspace/api-client-react";

function StatCard({ title, value, sub, color }: { title: string; value: number | string; sub?: string; color?: string }) {
  return (
    <div className="bg-card rounded-xl border p-5 flex flex-col gap-1">
      <div className="text-sm text-muted-foreground font-medium">{title}</div>
      <div className={`text-3xl font-bold ${color || "text-foreground"}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const { data, isLoading } = useGetStats();

  if (isLoading) return <div className="text-muted-foreground p-8 text-center">Загрузка...</div>;
  if (!data) return <div className="text-destructive p-8 text-center">Нет данных</div>;

  const stages = Object.entries(data.stageCounts || {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Дашборд</h1>
        <p className="text-muted-foreground text-sm mt-1">Статистика Greenleaf Bot</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <StatCard title="Пользователей" value={data.totalUsers} />
        <StatCard title="Завершили" value={data.completedScenario} sub={`${data.totalUsers ? Math.round((data.completedScenario / data.totalUsers) * 100) : 0}%`} />
        <StatCard title="Заявок" value={data.totalLeads} color="text-primary" />
        <StatCard title="Зарег-но" value={data.registeredLeads} color="text-primary" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        <StatCard title="Партнёров" value={data.totalPartners} />
        <StatCard title="Конверсия" value={`${data.conversionToLead}%`} color="text-primary" />
        <StatCard title="В партнёры" value={`${data.conversionToPartner}%`} color="text-primary" />
      </div>

      <div className="bg-card rounded-xl border p-5">
        <h2 className="font-semibold mb-4">Распределение по этапам</h2>
        <div className="space-y-2">
          {stages.slice(0, 10).map(([stage, count]) => (
            <div key={stage} className="flex items-center gap-3">
              <div className="w-40 text-sm text-muted-foreground truncate">{stage}</div>
              <div className="flex-1 bg-muted rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${data.totalUsers ? (count / data.totalUsers) * 100 : 0}%` }}
                />
              </div>
              <div className="text-sm font-medium w-8 text-right">{count}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
