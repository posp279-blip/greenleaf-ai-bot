import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  try {
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  } catch (err) {
    logger.error({ err }, "Healthcheck parse error");
    res.status(500).json({ error: "healthcheck failed" });
  }
});

export default router;
