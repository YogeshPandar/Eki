import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../middleware/requireAdmin";
import {
  searchGooglePlaces,
  type PlaceResult,
  type PlaceSearchFailureReason,
} from "../lib/placeSearch";

const router = Router();
const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, { expiresAt: number; results: PlaceResult[] }>();

const placeSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res, _next, options) => {
    const retryAfterMs = options.windowMs;
    res.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    res.status(options.statusCode).json({
      error: "Place search rate limit exceeded. Try again shortly.",
      code: "PLACE_SEARCH_RATE_LIMITED",
      retryAfterMs,
    });
  },
});

function sendResults(res: Response, results: PlaceResult[]): void {
  res.json({
    results,
    ...(results.length === 0
      ? {
          code: "PLACE_SEARCH_NO_RESULTS",
          message: "No matching places were found.",
        }
      : {}),
  });
}

function failureResponse(reason: PlaceSearchFailureReason): {
  status: number;
  code: string;
  error: string;
} {
  switch (reason) {
    case "timeout":
      return {
        status: 504,
        code: "PLACE_SEARCH_UPSTREAM_TIMEOUT",
        error: "Place search timed out. Try again.",
      };
    case "rate_limit":
      return {
        status: 503,
        code: "PLACE_SEARCH_UPSTREAM_RATE_LIMITED",
        error: "Place search quota is temporarily unavailable. Try again shortly.",
      };
    case "invalid_response":
      return {
        status: 502,
        code: "PLACE_SEARCH_INVALID_UPSTREAM_RESPONSE",
        error: "Place search returned an invalid response. Try again.",
      };
    case "network":
      return {
        status: 502,
        code: "PLACE_SEARCH_UPSTREAM_UNREACHABLE",
        error: "Place search could not reach Google Places. Try again.",
      };
    case "upstream":
    default:
      return {
        status: 502,
        code: "PLACE_SEARCH_UPSTREAM_FAILURE",
        error: "Place search service is temporarily unavailable.",
      };
  }
}

export async function handlePlaceSearch(req: Request, res: Response): Promise<void> {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (query.length < 3 || query.length > 200) {
    res.status(400).json({
      error: "Search text must be between 3 and 200 characters.",
      code: "PLACE_SEARCH_INVALID_QUERY",
    });
    return;
  }

  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    sendResults(res, cached.results);
    return;
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: "Place search is not configured on the server.",
      code: "PLACE_SEARCH_NOT_CONFIGURED",
    });
    return;
  }

  const result = await searchGooglePlaces(query, apiKey);
  if (!result.ok) {
    const failure = failureResponse(result.reason);
    console.warn("[Places] Search failed.", {
      reason: result.reason,
      upstreamStatus: result.upstreamStatus ?? null,
    });
    res.status(failure.status).json({
      error: failure.error,
      code: failure.code,
    });
    return;
  }

  searchCache.set(cacheKey, {
    results: result.results,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  if (searchCache.size > 100) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  sendResults(res, result.results);
}

router.get("/search", placeSearchLimiter, requireAdmin, handlePlaceSearch);

export default router;
