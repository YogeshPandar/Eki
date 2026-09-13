const API_TIMEOUT_MS = 10_000;

type ApiRequestOptions = RequestInit & {
  fallbackError?: string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function configuredBackendUrl(): string {
  const configured = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (!configured) throw new Error("Backend URL is invalid or not configured.");
  try {
    const url = new URL(configured);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("invalid backend URL");
    }
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new Error("Backend URL is invalid or not configured.");
  }
}

export async function apiRequest<T>(
  path: string,
  { fallbackError = "Request failed.", signal, ...init }: ApiRequestOptions = {},
): Promise<T> {
  const backendUrl = configuredBackendUrl();

  const requestController = new AbortController();
  let abortSource: "caller" | "timeout" | null = null;
  const abortFromCaller = () => {
    if (requestController.signal.aborted) return;
    abortSource = "caller";
    requestController.abort(signal?.reason);
  };
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    if (requestController.signal.aborted) return;
    abortSource = "timeout";
    requestController.abort(new DOMException("Request timed out.", "TimeoutError"));
  }, API_TIMEOUT_MS);

  try {
    const response = await fetch(`${backendUrl}${path}`, {
      ...init,
      signal: requestController.signal,
    });
    if (response.status === 204) return undefined as T;
    let result: T & { error?: unknown; code?: unknown };
    try {
      result = await response.json() as T & { error?: unknown; code?: unknown };
    } catch (error) {
      if (response.ok) throw error;
      result = {} as T & { error?: unknown; code?: unknown };
    }
    if (!response.ok) {
      const message = typeof result.error === "string" && result.error.trim()
        ? result.error
        : `${fallbackError} (HTTP ${response.status})`;
      const code = typeof result.code === "string" && result.code.trim()
        ? result.code
        : undefined;
      throw new ApiError(message, response.status, code);
    }
    return result;
  } catch (error) {
    if (abortSource === "timeout") {
      throw new Error("The request timed out. Please try again.");
    }
    if (abortSource === "caller" || error instanceof ApiError) throw error;
    if (error instanceof TypeError) throw new Error(fallbackError);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
