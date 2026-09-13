export interface PlaceResult {
  name: string;
  address?: string;
  lat: number;
  lng: number;
}

export type PlaceSearchFailureReason =
  | "timeout"
  | "rate_limit"
  | "upstream"
  | "network"
  | "invalid_response";

export type PlaceSearchResult =
  | { ok: true; results: PlaceResult[] }
  | {
      ok: false;
      reason: PlaceSearchFailureReason;
      upstreamStatus?: number;
    };

interface PlaceSearchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function normalizePlaces(value: unknown): PlaceResult[] {
  if (!value || typeof value !== "object") return [];
  const places = (value as { places?: unknown }).places;
  if (!Array.isArray(places)) return [];

  return places.flatMap((entry): PlaceResult[] => {
    if (!entry || typeof entry !== "object") return [];
    const place = entry as Record<string, unknown>;
    const displayName = place.displayName as { text?: unknown } | undefined;
    const location = place.location as {
      latitude?: unknown;
      longitude?: unknown;
    } | undefined;
    const title = typeof displayName?.text === "string" ? displayName.text : "";
    const address = typeof place.formattedAddress === "string"
      ? place.formattedAddress
      : "";
    const name = title.trim().slice(0, 100);
    const lat = Number(location?.latitude);
    const lng = Number(location?.longitude);
    if (
      !name ||
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lng) ||
      lng < -180 ||
      lng > 180
    ) {
      return [];
    }
    return [{ name, ...(address ? { address } : {}), lat, lng }];
  });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

export async function searchGooglePlaces(
  query: string,
  apiKey: string,
  options: PlaceSearchOptions = {},
): Promise<PlaceSearchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "places.displayName,places.formattedAddress,places.location",
        },
        body: JSON.stringify({ textQuery: query, maxResultCount: 5 }),
        signal: controller.signal,
      },
    );

    const responseText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        reason: response.status === 429 ? "rate_limit" : "upstream",
        upstreamStatus: response.status,
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      return { ok: false, reason: "invalid_response" };
    }
    return { ok: true, results: normalizePlaces(payload) };
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timeoutId);
  }
}
