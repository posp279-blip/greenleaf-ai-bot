import { Router } from "express";

const router = Router();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.SESSION_SECRET || "";

router.post("/login", (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password || password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Неверный пароль" });
    return;
  }
  res.cookie("admin_auth", "1", {
    signed: true,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: "lax",
  });
  res.json({ success: true });
});

router.post("/logout", (_req, res) => {
  res.clearCookie("admin_auth");
  res.json({ success: true });
});

router.get("/me", (req, res) => {
  if (req.signedCookies.admin_auth === "1") {
    res.json({ authenticated: true });
  } else {
    res.status(401).json({ authenticated: false });
  }
});

export default router;
