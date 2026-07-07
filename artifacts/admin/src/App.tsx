import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import Dashboard from "@/pages/Dashboard";
import LeadsPage from "@/pages/Leads";
import PartnersPage from "@/pages/Partners";
import SessionsPage from "@/pages/Sessions";
import VideosPage from "@/pages/Videos";
import CalculatorPage from "@/pages/Calculator";
import SettingsPage from "@/pages/Settings";
import AiPage from "@/pages/Ai";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });

const NAV = [
  { path: "/", label: "📊 Дашборд" },
  { path: "/leads", label: "📋 Заявки" },
  { path: "/partners", label: "👥 Партнёры" },
  { path: "/sessions", label: "💬 Диалоги" },
  { path: "/videos", label: "🎬 Видео" },
  { path: "/calculator", label: "💰 Калькулятор" },
  { path: "/settings", label: "⚙️ Настройки" },
  { path: "/ai", label: "🤖 AI" },
];

function Sidebar({ mobile, onClose }: { mobile?: boolean; onClose?: () => void }) {
  const [location] = useLocation();
  return (
    <aside className={`${mobile ? "w-full" : "w-64"} flex flex-col h-full bg-sidebar text-sidebar-foreground`}>
      <div className="px-6 py-5 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🌿</span>
          <div>
            <div className="font-bold text-sidebar-primary text-lg leading-tight">Greenleaf</div>
            <div className="text-xs text-sidebar-foreground/60">Admin Panel</div>
          </div>
        </div>
      </div>
      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
        {NAV.map((item) => {
          const active = location === item.path || (item.path !== "/" && location.startsWith(item.path));
          return (
            <Link key={item.path} href={item.path} onClick={onClose}>
              <div className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${active ? "bg-sidebar-primary text-sidebar-primary-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"}`}>
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>
      <div className="px-6 py-4 border-t border-sidebar-border text-xs text-sidebar-foreground/40">
        Greenleaf Bot v1.0
      </div>
    </aside>
  );
}

function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="flex h-screen overflow-hidden">
      <div className="hidden md:flex md:flex-shrink-0">
        <Sidebar />
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="fixed inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <div className="relative flex flex-col w-72 bg-sidebar z-50">
            <Sidebar mobile onClose={() => setMobileOpen(false)} />
          </div>
        </div>
      )}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="md:hidden flex items-center gap-3 px-4 py-3 bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
          <button onClick={() => setMobileOpen(true)} className="p-2 rounded-lg hover:bg-sidebar-accent">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <span className="font-bold text-sidebar-primary">🌿 Greenleaf Admin</span>
        </header>
        <main className="flex-1 overflow-y-auto bg-background p-6">
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/leads" component={LeadsPage} />
            <Route path="/partners" component={PartnersPage} />
            <Route path="/sessions" component={SessionsPage} />
            <Route path="/videos" component={VideosPage} />
            <Route path="/calculator" component={CalculatorPage} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/ai" component={AiPage} />
            <Route component={NotFound} />
          </Switch>
        </main>
      </div>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Layout />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
