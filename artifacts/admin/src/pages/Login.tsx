import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";

export default function Login() {
  const [password, setPassword] = useState("");
  const { login } = useAuth();
  const isPending = login.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim()) return;
    try {
      await login.mutateAsync(password);
    } catch {
      // error handled by mutation state
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm p-6 md:p-8 bg-card rounded-xl shadow-lg border">
        <div className="text-center mb-6">
          <span className="text-4xl md:text-5xl">🌿</span>
          <h1 className="text-xl font-bold mt-3">Greenleaf Admin</h1>
          <p className="text-sm text-muted-foreground mt-1">Введите пароль для входа</p>
        </div>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Пароль"
            className="w-full px-4 py-2.5 rounded-lg border bg-background mb-4 text-base"
            autoFocus
          />
          {login.isError && (
            <p className="text-destructive text-sm mb-3">{login.error?.message || "Ошибка входа"}</p>
          )}
          <button
            type="submit"
            disabled={isPending || !password.trim()}
            className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-base disabled:opacity-50"
          >
            {isPending ? "Вход..." : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
