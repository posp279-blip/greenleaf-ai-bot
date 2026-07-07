import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import adminRouter from "./admin.js";
import authRouter from "./auth.js";
import { requireAuth } from "../middleware/auth.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/admin/auth", authRouter);
router.use("/admin", requireAuth, adminRouter);

export default router;
