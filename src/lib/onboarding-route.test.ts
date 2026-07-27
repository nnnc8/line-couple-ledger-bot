import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "@/lib/http-error";
import { actionResultErrorMessage } from "@/lib/pending-action-utils";
import { signSession } from "@/lib/security";
import { pendingActionService } from "@/lib/services";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const PARTNER_ID = "00000000-0000-4000-8000-000000000002";
const ACTION_ID = "00000000-0000-4000-8000-000000000004";
const LINE_USER_ID = "line-owner";

function setupEnv() {
  process.env.DATABASE_URL = "postgresql://localhost:5432/db";
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";
  process.env.LINE_LOGIN_CHANNEL_ID = "login";
  process.env.GEMINI_API_KEY = "gemini";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "secret";
  process.env.COUPLE_SETUP_CODE = "x".repeat(24);
  process.env.LIFF_SESSION_SECRET = "x".repeat(32);
  process.env.APP_URL = "https://app.example.com";
  process.env.CRON_SECRET = "x".repeat(16);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("onboarding resumes the same first expense and existing groups never short-circuit", async () => {
  setupEnv();
  const { POST } = await import("../app/api/app/[...path]/route");
  const originalFetch = globalThis.fetch;
  const originalProposeAction = pendingActionService.proposeAction;
  const OriginalDate = Date;
  let now = Date.parse("2026-07-27T01:00:00.000Z");
  class FrozenDate extends OriginalDate {
    constructor(value?: string | number) {
      super(value ?? now);
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;

  let groupExists = false;
  let groupId: string | null = null;
  let groupInserts = 0;
  let groupDeletes = 0;
  let preferenceUpserts = 0;
  let preferenceFailuresRemaining = 0;
  let actionRevives = 0;
  let pendingAction: {
    id: string;
    payload: { expense_date: string };
    status: "pending" | "expired" | "confirmed";
    expiresAt: number;
  } | null = null;
  let expenseWrites = 0;
  const proposals: Array<{
    groupId: string;
    expenseDate: string;
    idempotencyKey: string | null | undefined;
  }> = [];

  globalThis.fetch = async (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(href);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const table = url.pathname.match(/\/rest\/v1\/([^/]+)/)?.[1];

    if (table === "users") {
      if (url.searchParams.has("id")) {
        return jsonResponse({
          id: USER_ID,
          couple_id: 1,
          line_user_id: LINE_USER_ID,
          role: "owner",
        });
      }
      return jsonResponse([
        { id: USER_ID },
        { id: PARTNER_ID },
      ]);
    }

    if (table === "groups") {
      if (method === "GET") {
        return jsonResponse(groupExists && groupId ? [{ id: groupId }] : []);
      }
      if (method === "POST") {
        const inserted = JSON.parse(String(init?.body)) as { id: string };
        groupExists = true;
        groupId = inserted.id;
        groupInserts += 1;
        return jsonResponse({ id: groupId }, 201);
      }
      if (method === "DELETE") {
        groupDeletes += 1;
        return jsonResponse({ message: "foreign key violation" }, 409);
      }
    }

    if (table === "pending_actions" && method === "GET") {
      return jsonResponse(
        pendingAction
          ? [
              {
                id: pendingAction.id,
                payload: pendingAction.payload,
                status: pendingAction.status,
              },
            ]
          : [],
      );
    }

    if (table === "pending_actions" && method === "PATCH") {
      const update = JSON.parse(String(init?.body)) as {
        status: "pending";
        expires_at: string;
        processed_at: null;
      };
      assert.equal(pendingAction?.status, "expired");
      assert.equal(update.status, "pending");
      assert.equal(update.processed_at, null);
      assert.ok(Date.parse(update.expires_at) > now);
      pendingAction = {
        ...pendingAction,
        status: "pending",
        expiresAt: Date.parse(update.expires_at),
      };
      actionRevives += 1;
      return new Response(null, { status: 204 });
    }

    if (table === "user_preferences" && method === "POST") {
      preferenceUpserts += 1;
      if (preferenceFailuresRemaining > 0) {
        preferenceFailuresRemaining -= 1;
        return jsonResponse({ message: "preference write failed" }, 500);
      }
      return new Response(null, { status: 201 });
    }

    throw new Error(`Unexpected Supabase request: ${method} ${url}`);
  };

  pendingActionService.proposeAction = (async (
    _context,
    action,
    metadata,
  ) => {
    const expense = (action as {
      expense: { groupId: string; expenseDate: string };
    }).expense;
    proposals.push({
      groupId: expense.groupId,
      expenseDate: expense.expenseDate,
      idempotencyKey: metadata?.idempotencyKey,
    });
    pendingAction ??= {
      id: ACTION_ID,
      payload: { expense_date: expense.expenseDate },
      status: "pending",
      expiresAt: now + 5 * 60 * 1_000,
    };
    if (proposals.length === 1) {
      throw new Error("confirm failed after pending insert");
    }
    if (
      pendingAction.status === "expired" ||
      (pendingAction.status === "pending" && pendingAction.expiresAt <= now)
    ) {
      pendingAction.status = "expired";
      throw new HttpError(
        409,
        actionResultErrorMessage({ result: "expired" }),
      );
    }
    if (pendingAction.status === "confirmed") {
      return { result: "already_done", action_type: "create_expense" };
    }
    if (expenseWrites === 0) {
      expenseWrites += 1;
      pendingAction.status = "confirmed";
      return { result: "confirmed", action_type: "create_expense" };
    }
    return { result: "already_done", action_type: "create_expense" };
  }) as typeof pendingActionService.proposeAction;

  const token = signSession(
    {
      userId: USER_ID,
      lineUserId: LINE_USER_ID,
      expiresAt: Math.floor(now / 1_000) + 3 * 86_400,
    },
    process.env.LIFF_SESSION_SECRET!,
  );
  const firstExpense = {
    pairCode: process.env.COUPLE_SETUP_CODE,
    groupName: "共同生活",
    firstExpense: "晚餐",
    firstAmount: 800,
  };
  const postOnboarding = (body: Record<string, unknown>) =>
    POST(
      new Request("https://app.example.com/api/app/onboarding", {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          cookie: `couple_ledger_session=${token}`,
          origin: "https://app.example.com",
        },
      }),
      { params: Promise.resolve({ path: ["onboarding"] }) },
    );

  try {
    const first = await postOnboarding(firstExpense);
    assert.equal(first.status, 500);
    assert.equal(groupExists, true);
    assert.equal(groupInserts, 1);
    assert.equal(groupDeletes, 0);
    assert.equal(preferenceUpserts, 0);
    const createdGroupId = groupId;
    assert.ok(createdGroupId);

    now += 86_400_000;
    const retry = await postOnboarding(firstExpense);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), {
      ok: true,
      groupId: createdGroupId,
    });
    assert.equal(expenseWrites, 1);
    assert.equal(groupInserts, 1);
    assert.equal(actionRevives, 1);
    assert.equal(proposals.length, 3);
    assert.deepEqual(
      proposals.map((proposal) => proposal.groupId),
      [createdGroupId, createdGroupId, createdGroupId],
    );
    assert.deepEqual(
      proposals.map((proposal) => proposal.idempotencyKey),
      [
        `onboarding:${createdGroupId}:first-expense`,
        `onboarding:${createdGroupId}:first-expense`,
        `onboarding:${createdGroupId}:first-expense`,
      ],
    );
    assert.equal(
      proposals[1]?.expenseDate,
      proposals[0]?.expenseDate,
      "cross-day retries must reuse the stored request fingerprint",
    );
    assert.equal(proposals[2]?.expenseDate, proposals[0]?.expenseDate);

    const completedRetry = await postOnboarding(firstExpense);
    assert.equal(completedRetry.status, 200);
    assert.equal(expenseWrites, 1);
    assert.equal(new Set(proposals.map((proposal) => proposal.idempotencyKey)).size, 1);

    const proposalCount = proposals.length;
    preferenceFailuresRemaining = 1;
    const failedNoExpenseRetry = await postOnboarding({
      pairCode: process.env.COUPLE_SETUP_CODE,
      groupName: "共同生活",
    });
    assert.equal(failedNoExpenseRetry.status, 500);
    assert.equal(proposals.length, proposalCount);

    const noExpenseRetry = await postOnboarding({
      pairCode: process.env.COUPLE_SETUP_CODE,
      groupName: "共同生活",
    });
    assert.equal(noExpenseRetry.status, 200);
    assert.deepEqual(await noExpenseRetry.json(), {
      ok: true,
      groupId: createdGroupId,
    });
    assert.equal(proposals.length, proposalCount);
    assert.equal(preferenceUpserts, 4);
  } finally {
    globalThis.fetch = originalFetch;
    pendingActionService.proposeAction = originalProposeAction;
    globalThis.Date = OriginalDate;
  }
});

test("concurrent onboarding submissions converge on one group and one expense", async () => {
  setupEnv();
  const { POST } = await import("../app/api/app/[...path]/route");
  const originalFetch = globalThis.fetch;
  const originalProposeAction = pendingActionService.proposeAction;
  let releaseInitialReads: (() => void) | undefined;
  const initialReadsComplete = new Promise<void>((resolve) => {
    releaseInitialReads = resolve;
  });
  let initialGroupReads = 0;
  let groupInsertAttempts = 0;
  let successfulGroupInserts = 0;
  let groupDeletes = 0;
  let storedGroupId: string | null = null;
  let expenseWrites = 0;
  const proposalKeys: Array<string | null | undefined> = [];
  const completedKeys = new Set<string>();

  globalThis.fetch = async (input, init) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(href);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const table = url.pathname.match(/\/rest\/v1\/([^/]+)/)?.[1];

    if (table === "users") {
      if (url.searchParams.has("id")) {
        return jsonResponse({
          id: USER_ID,
          couple_id: 1,
          line_user_id: LINE_USER_ID,
          role: "owner",
        });
      }
      return jsonResponse([{ id: USER_ID }, { id: PARTNER_ID }]);
    }

    if (table === "groups" && method === "GET") {
      if (url.searchParams.has("id")) {
        return jsonResponse(
          storedGroupId ? [{ id: storedGroupId }] : [],
        );
      }
      initialGroupReads += 1;
      if (initialGroupReads === 2) releaseInitialReads?.();
      await initialReadsComplete;
      return jsonResponse([]);
    }

    if (table === "groups" && method === "POST") {
      const inserted = JSON.parse(String(init?.body)) as { id: string };
      groupInsertAttempts += 1;
      if (!storedGroupId) {
        storedGroupId = inserted.id;
        successfulGroupInserts += 1;
        return jsonResponse({ id: storedGroupId }, 201);
      }
      assert.equal(inserted.id, storedGroupId);
      return jsonResponse(
        {
          code: "23505",
          message: "duplicate key value violates unique constraint",
        },
        409,
      );
    }

    if (table === "groups" && method === "DELETE") {
      groupDeletes += 1;
      return jsonResponse({ message: "must not delete" }, 500);
    }

    if (table === "pending_actions" && method === "GET") {
      return jsonResponse([]);
    }

    if (table === "user_preferences" && method === "POST") {
      return new Response(null, { status: 201 });
    }

    throw new Error(`Unexpected Supabase request: ${method} ${url}`);
  };

  pendingActionService.proposeAction = (async (
    _context,
    _action,
    metadata,
  ) => {
    const key = metadata?.idempotencyKey;
    proposalKeys.push(key);
    assert.ok(key);
    if (completedKeys.has(key)) {
      return { result: "already_done", action_type: "create_expense" };
    }
    completedKeys.add(key);
    expenseWrites += 1;
    return { result: "confirmed", action_type: "create_expense" };
  }) as typeof pendingActionService.proposeAction;

  const token = signSession(
    {
      userId: USER_ID,
      lineUserId: LINE_USER_ID,
      expiresAt: Math.floor(Date.now() / 1_000) + 86_400,
    },
    process.env.LIFF_SESSION_SECRET!,
  );
  const request = () =>
    POST(
      new Request("https://app.example.com/api/app/onboarding", {
        method: "POST",
        body: JSON.stringify({
          pairCode: process.env.COUPLE_SETUP_CODE,
          groupName: "共同生活",
          firstExpense: "晚餐",
          firstAmount: 800,
        }),
        headers: {
          cookie: `couple_ledger_session=${token}`,
          origin: "https://app.example.com",
        },
      }),
      { params: Promise.resolve({ path: ["onboarding"] }) },
    );

  try {
    const [first, second] = await Promise.all([request(), request()]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const firstBody = (await first.json()) as { groupId: string };
    const secondBody = (await second.json()) as { groupId: string };
    assert.equal(firstBody.groupId, secondBody.groupId);
    assert.equal(firstBody.groupId, storedGroupId);
    assert.equal(groupInsertAttempts, 2);
    assert.equal(successfulGroupInserts, 1);
    assert.equal(groupDeletes, 0);
    assert.equal(new Set(proposalKeys).size, 1);
    assert.equal(expenseWrites, 1);
  } finally {
    globalThis.fetch = originalFetch;
    pendingActionService.proposeAction = originalProposeAction;
  }
});
