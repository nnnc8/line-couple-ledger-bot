import { NextResponse } from "next/server";
import { z } from "zod";

import {
  HttpError,
  agentChat,
  assertSameOrigin,
  askAccountant,
  changeGroup,
  checkExpenseInSettlements,
  confirmAction,
  categoryAnalytics,
  createCategoryCleanup,
  createReceiptUpload,
  createSession,
  expensesCsv,
  listCanonicalLabels,
  loadBootstrap,
  listAccountantReports,
  markNotificationsRead,
  mergeCanonicalLabels,
  processReceipt,
  proposeAction,
  receiptDetails,
  receiptUrl,
  requireContext,
  runAgent,
  saveBudget,
  saveRecurring,
  serverEnvironment,
  sessionCookie,
  suggestCategoryUpdates,
} from "@/lib/app-server";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: Request, route: RouteContext) {
  try {
    const path = (await route.params).path;
    const context = await requireContext(request);
    if (path[0] === "bootstrap") return json(await loadBootstrap(context));
    if (path[0] === "export") {
      const data = await loadBootstrap(context);
      return new Response(expensesCsv(data.expenses, data.users), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="ledger-${data.month}.csv"`,
          "cache-control": "no-store",
        },
      });
    }
    if (path[0] === "receipts" && path[1] && path[2] === "url") {
      return json({ url: await receiptUrl(context, path[1]) });
    }
    if (path[0] === "receipts" && path[1] && path.length === 2) {
      return json(await receiptDetails(context, path[1]));
    }
    if (path[0] === "accountant" && path[1] === "reports") {
      return json(await listAccountantReports(context));
    }
    if (path[0] === "analytics" && path[1] === "categories") {
      return json(await categoryAnalytics(context, new URL(request.url).searchParams));
    }
    if (path[0] === "canonical-labels") {
      return json(await listCanonicalLabels(context));
    }
    if (path[0] === "expenses" && path[1] && path[2] === "check-settlement") {
      return json(await checkExpenseInSettlements(context, path[1]));
    }
    throw new HttpError(404, "Not found");
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, route: RouteContext) {
  try {
    const path = (await route.params).path;
    const env = serverEnvironment();
    assertSameOrigin(request, env.APP_URL);
    const body = await readJson(request);
    if (path[0] === "session") {
      const input = z
        .object({
          idToken: z.string().min(20).max(5_000),
          invite: z.string().min(1).max(200).optional(),
        })
        .parse(body);
      const session = await createSession(input.idToken, input.invite);
      return json(
        { user: { id: session.user.id, role: session.user.role } },
        {
          "set-cookie": sessionCookie(session.token),
        },
      );
    }

    const context = await requireContext(request);
    if (path[0] === "actions" && path.length === 1) {
      const key = request.headers.get("idempotency-key")?.slice(0, 100);
      return json(await proposeAction(context, body, key));
    }
    if (path[0] === "actions" && path[1] === "confirm") {
      const input = z
        .object({ actionId: z.string().uuid(), confirm: z.boolean() })
        .parse(body);
      return json(await confirmAction(context, input.actionId, input.confirm));
    }
    if (path[0] === "groups") return json(await changeGroup(context, body));
    if (path[0] === "budgets") return json(await saveBudget(context, body));
    if (path[0] === "recurring")
      return json(await saveRecurring(context, body));
    if (path[0] === "receipts" && path[1] === "upload")
      return json(await createReceiptUpload(context, body));
    if (path[0] === "receipts" && path[1] && path[2] === "process")
      return json({ extraction: await processReceipt(context, path[1]) });
    if (path[0] === "notifications" && path[1] === "read")
      return json(await markNotificationsRead(context));
    if (path[0] === "accountant" && path[1] === "ask")
      return json(await askAccountant(context, body));
    if (path[0] === "agent" && path[1] === "runs")
      return json(await runAgent(context, body));
    if (path[0] === "categories" && path[1] === "cleanup") {
      const key = request.headers.get("idempotency-key")?.slice(0, 100);
      return json(await createCategoryCleanup(context, body, key));
    }
    if (path[0] === "categories" && path[1] === "suggest") {
      return json(await suggestCategoryUpdates(context, body));
    }
    if (path[0] === "canonical-labels" && path[1] === "merge") {
      return json(await mergeCanonicalLabels(context, body));
    }
    if (path[0] === "accountant" && path[1] === "chat") {
      return json(await agentChat(context, body));
    }
    throw new HttpError(404, "Not found");
  } catch (error) {
    return errorResponse(error);
  }
}

async function readJson(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (raw.length > 64_000) throw new HttpError(413, "Payload too large");
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function json(
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof HttpError)
    return json({ error: error.message }, {}, error.status);
  if (error instanceof z.ZodError)
    return json(
      {
        error: "輸入資料不正確",
        issues: error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
      {},
      400,
    );
  console.error("App API failed", {
    error: error instanceof Error ? error.name : "unknown",
  });
  return json({ error: "暫時無法處理" }, {}, 500);
}
