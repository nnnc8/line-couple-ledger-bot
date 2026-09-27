type ApiResult = Record<string, unknown>;

export class ApiError extends Error {
  constructor(message: string, public status: number, public recognized: boolean) { super(message); }
}

const idempotencyKey = (body: unknown) => {
  if (
    body &&
    typeof body === "object" &&
    "idempotencyKey" in body &&
    typeof body.idempotencyKey === "string" &&
    body.idempotencyKey.length >= 1 &&
    body.idempotencyKey.length <= 100
  ) {
    return body.idempotencyKey;
  }
  return crypto.randomUUID();
};

export async function api(path: string, body?: unknown, options: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<ApiResult> {
  const response = await fetch(path, {
    method: options.method ?? "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.method === "DELETE" ? {} : { "idempotency-key": idempotencyKey(body) }),
      ...options.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    signal: options.signal,
  });
  return parseResponse(response);
}

export async function get<T = ApiResult>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  return parseResponse(response) as Promise<T>;
}

export async function parseResponse(response: Response): Promise<ApiResult> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body && typeof body === "object" && typeof body.error === "string" ? body.error : null;
    throw new ApiError(error ?? "操作失敗", response.status, error !== null);
  }
  return body as ApiResult;
}
