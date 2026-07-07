import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

export function useAuth() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      const res = await fetch("/api/admin/auth/me", { credentials: "include" });
      if (!res.ok) return { authenticated: false };
      return res.json() as Promise<{ authenticated: boolean }>;
    },
    retry: false,
    staleTime: Infinity,
  });

  const login = useMutation({
    mutationFn: async (password: string) => {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Неверный пароль");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });

  const logout = useCallback(async () => {
    await fetch("/api/admin/auth/logout", { method: "POST", credentials: "include" });
    queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    window.location.reload();
  }, [queryClient]);

  return {
    isAuthenticated: data?.authenticated === true,
    isLoading,
    login,
    logout,
  };
}
