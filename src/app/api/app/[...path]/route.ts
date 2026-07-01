import { NextResponse } from "next/server";
import { z } from "zod";

import { HttpError } from "@/lib/http-error";
import {
  assertSameOrigin,
  createSession,
  requireContext,
  serverEnvironment,
  sessionCookie,
} from "@/lib/server-runtime";
import {
  changeGroup,
  createReceiptUpload,
  importBankCsv,
  processReceipt,
  receiptDetails,
  receiptUrl,
  saveRecurring,
  pendingActionService,
  ledgerQueryService,
  accountantService,
} from "@/lib/services";
import { expensesCsv } from "@/lib/ledger-query";
import { getOpenTasks } from "@/lib/secretary-tasks";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: Request, route: RouteContext) {
  try {
    const path = (await route.params).path;
    const context = await requireContext(request);
    if (path[0] === "bootstrap") return json(await ledgerQueryService.loadBootstrap(context));
    if (path[0] === "export") {
      const data = await ledgerQueryService.loadBootstrap(context);
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
    if (path[0] === "analytics" && path[1] === "categories") {
      return json(await accountantService.categoryAnalytics(context, new URL(request.url).searchParams));
    }
    if (path[0] === "analytics" && path[1] === "expenses") {
      return json(await ledgerQueryService.categoryExpenses(context, new URL(request.url).searchParams));
    }
    if (path[0] === "expenses" && path[1] === "search") {
      return json(await ledgerQueryService.searchExpenses(context, new URL(request.url).searchParams));
    }
    if (path[0] === "expenses" && path[1] && path[2] === "check-settlement") {
      return json(await ledgerQueryService.checkExpenseInSettlements(context, path[1]));
    }
    if (path[0] === "secretary" && path[1] === "tasks") {
      const tasks = await getOpenTasks(context.db, {
        coupleId: context.user.couple_id,
        limit: 10,
      });
      return json({ tasks });
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
      return json(await pendingActionService.proposeAction(context, body, { source: "liff", idempotencyKey: key }));
    }
    if (path[0] === "groups") return json(await changeGroup(context, body));
    if (path[0] === "recurring")
      return json(await saveRecurring(context, body));
    if (path[0] === "receipts" && path[1] === "upload")
      return json(await createReceiptUpload(context, body));
    if (path[0] === "receipts" && path[1] && path[2] === "process")
      return json({ extraction: await processReceipt(context, path[1]) });
    if (path[0] === "categories" && path[1] === "cleanup") {
      const key = request.headers.get("idempotency-key")?.slice(0, 100);
      return json(await accountantService.createCategoryCleanup(
        context,
        body,
        key,
        (action) => pendingActionService.execute(context, action)
      ));
    }
    if (path[0] === "categories" && path[1] === "suggest") {
      return json(await accountantService.suggestCategoryUpdates(context, body));
    }
    if (path[0] === "bank" && path[1] === "import") {
      return json(await importBankCsv(context, body));
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
