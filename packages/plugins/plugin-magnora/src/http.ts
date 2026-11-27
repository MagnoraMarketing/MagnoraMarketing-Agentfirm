export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type IntegrationErrorKind = "not_configured" | "auth_expired" | "auth_failed" | "rate_limited" | "upstream" | "invalid_request" | "permission_denied";

export class IntegrationError extends Error {
  constructor(
    public readonly kind: IntegrationErrorKind,
    message: string,
    public readonly status: number | null = null,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip anything that looks like a credential before an upstream message is stored or logged. */
export function redact(text: string): string {
  return text
    .replace(/(access_token|refresh_token|client_secret|token|apikey|api_key)=([^&\s"]+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/"(access_token|refresh_token|id_token|client_secret)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .slice(0, 500);
}

export interface RequestJsonOptions extends RequestInit {
  retries?: number;
  retryBaseMs?: number;
}

/**
 * Fetch with bounded retries on transient failures (429/5xx/network),
 * mapping provider failures into IntegrationError kinds the UI understands.
 * Resolves only with a 2xx response.
 */
export async function requestOk(fetchFn: FetchFn, url: string, options: RequestJsonOptions = {}): Promise<Response> {
  const { retries = 2, retryBaseMs = 500, ...init } = options;
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetchFn(url, init);
    } catch (error) {
      if (attempt < retries) {
        await sleep(retryBaseMs * 2 ** attempt);
        attempt += 1;
        continue;
      }
      throw new IntegrationError("upstream", `Network error: ${redact(String((error as Error)?.message ?? error))}`, null, true);
    }
    if (response.ok) return response;
    if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : retryBaseMs * 2 ** attempt);
      attempt += 1;
      continue;
    }
    const body = redact(await response.text().catch(() => ""));
    if (response.status === 401) throw new IntegrationError("auth_expired", `Unauthorized (401): ${body}`, 401);
    if (response.status === 403) throw new IntegrationError("auth_failed", `Forbidden (403): ${body}`, 403);
    if (response.status === 429) throw new IntegrationError("rate_limited", `Rate limited (429): ${body}`, 429, true);
    if (response.status >= 500) throw new IntegrationError("upstream", `Provider error (${response.status}): ${body}`, response.status, true);
    throw new IntegrationError("invalid_request", `Request failed (${response.status}): ${body}`, response.status);
  }
}

export async function requestJson<T = unknown>(fetchFn: FetchFn, url: string, options: RequestJsonOptions = {}): Promise<T> {
  const response = await requestOk(fetchFn, url, options);
  if (response.status === 204) return {} as T;
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new IntegrationError("upstream", "Provider returned a non-JSON response");
  }
}

/** Read a dot path ("a.b.0.c") from a JSON value. */
export function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  if (value && typeof value === "object" && "amount" in value) return toNumber((value as { amount: unknown }).amount);
  return 0;
}
