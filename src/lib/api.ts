type ApiResult = Record<string, unknown>;

const idempotencyKey = () => crypto.randomUUID();

export async function api(path: string, body?: unknown): Promise<ApiResult> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
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
    const error = (body as { error?: string }).error ?? "操作失敗";
    const failure = new Error(error) as Error & { status?: number };
    failure.status = response.status;
    throw failure;
  }
  return body as ApiResult;
}
