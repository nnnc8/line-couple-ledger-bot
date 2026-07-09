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
import { safeSecretEqual } from "@/lib/security";
import {
  changeGroup,
  importBankCsv,
  saveRecurring,
  pendingActionService,
  ledgerQueryService,
  accountantService,
} from "@/lib/services";
import { exportCsv } from "@/lib/export-service";
import { getOpenTasks, completeTask, dismissTask, snoozeTask } from "@/lib/secretary-tasks";
import { RuleService } from "@/lib/rule-service";
import { getRecentEvents } from "@/lib/agent-event-service";

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
      const url = new URL(request.url);
      const period = url.searchParams.get("period") ?? undefined;
      const ledger = (url.searchParams.get("ledger") as "shared" | "private" | "all" | null) ?? "all";
      const groupId = url.searchParams.get("groupId") ?? undefined;
      const csv = await exportCsv(
        { db: context.db, coupleId: context.user.couple_id, userId: context.user.id },
        { period, ledger, groupId },
      );
      const filename = period
        ? `ledger-${period}.csv`
        : `ledger-all.csv`;
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "no-store",
        },
      });
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
    if (path[0] === "agent" && path[1] === "tasks") {
      const tasks = await getOpenTasks(context.db, {
        coupleId: context.user.couple_id,
        limit: 20,
      });
      return json({ tasks });
    }
    if (path[0] === "agent" && path[1] === "memories") {
      const memories = await new RuleService(context.db).listMemories({
        coupleId: context.user.couple_id,
        limit: 20,
      });
      return json({ memories });
    }
    if (path[0] === "agent" && path[1] === "events") {
      const events = await getRecentEvents(context.db, context.user.couple_id, { limit: 20 });
      return json({ events });
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
    if (path[0] === "agent" && path[1] === "tasks") {
      const parsed = z.object({
        taskId: z.string().uuid(),
        action: z.enum(["complete", "dismiss", "snooze"]),
        until: z.string().min(1).optional(),
      }).parse(body);
      if (parsed.action === "complete") {
        await completeTask(context.db, parsed.taskId);
        return json({ ok: true });
      }
      if (parsed.action === "dismiss") {
        await dismissTask(context.db, parsed.taskId);
        return json({ ok: true });
      }
      if (parsed.action === "snooze") {
        if (!parsed.until) throw new HttpError(400, "snooze 需要 until 參數");
        await snoozeTask(context.db, parsed.taskId, parsed.until);
        return json({ ok: true });
      }
    }
    if (path[0] === "onboarding") {
      const input = z.object({
        pairCode: z.string().min(1).max(200),
        groupName: z.string().min(1).max(50),
        firstExpense: z.string().max(200).optional(),
        firstAmount: z.number().int().positive().optional(),
      }).parse(body);

      if (!safeSecretEqual(input.pairCode.trim(), env.COUPLE_SETUP_CODE)) {
        throw new HttpError(403, "配對碼不正確");
      }

      const { data: existingGroups } = await context.db
        .from("groups")
        .select("id")
        .eq("couple_id", context.user.couple_id)
        .is("archived_at", null);

      if (existingGroups && existingGroups.length > 0) {
        return json({ ok: true, message: "已有群組" });
      }

      const { data: newGroup, error: groupError } = await context.db
        .from("groups")
        .insert({
          couple_id: context.user.couple_id,
          name: input.groupName,
          created_by_user_id: context.user.id,
        })
        .select("id, name")
        .single();

      if (groupError || !newGroup) {
        throw new HttpError(500, "建立群組失敗");
      }

      if (input.firstExpense && input.firstAmount) {
        await context.db
          .from("expenses")
          .insert({
            couple_id: context.user.couple_id,
            group_id: newGroup.id,
            ledger: "shared",
            description: input.firstExpense,
            amount_twd: input.firstAmount,
            paid_by_user_id: context.user.id,
            created_by_user_id: context.user.id,
            expense_date: new Date().toISOString().slice(0, 10),
            split_method: "equal",
            tag: "其他",
          });
      }

      await context.db
        .from("user_preferences")
        .upsert({
          user_id: context.user.id,
          active_group_id: newGroup.id,
        });

      return json({ ok: true, groupId: newGroup.id });
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
