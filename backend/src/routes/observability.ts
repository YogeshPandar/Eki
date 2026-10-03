import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/requireAuth";
import {
  parseFrontendObservabilityBatch,
  recordFrontendObservabilityBatch,
} from "../services/frontendObservability";

const router = Router();

router.post("/frontend", requireAuth, (req: Request, res: Response) => {
  const events = parseFrontendObservabilityBatch(req.body);
  if (!events) {
    res.status(400).json({ error: "Invalid frontend observability payload." });
    return;
  }
  recordFrontendObservabilityBatch(events);
  res.status(202).json({ accepted: events.length });
});

export default router;
