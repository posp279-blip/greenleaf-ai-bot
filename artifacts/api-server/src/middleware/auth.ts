import { type Request, type Response, type NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.signedCookies.admin_auth === "1") {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}
