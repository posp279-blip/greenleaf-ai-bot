import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="text-6xl mb-4">🌿</div>
      <h1 className="text-2xl font-bold mb-2">Страница не найдена</h1>
      <p className="text-muted-foreground mb-6">Такой страницы нет в панели администратора</p>
      <Link href="/" className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition">← На главную</Link>
    </div>
  );
}
