import { createHash } from "node:crypto";

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
import { taipeiToday } from "@/lib/ledger-shared";
import { publicUser, userSchema } from "@/lib/ledger-query-core";
import { actionResultErrorMessage } from "@/lib/pending-action-utils";
import {
  createV2Ledger,
  createV2Transaction,
  getV2LedgerBootstrap,
  listV2UserLedgers,
  settleAllV2Ledger,
  activateV2Ledger,
  confirmV2Proposal,
  cancelV2Proposal,
  getV2Proposal,
  createV2Proposal,
  listV2LedgerTransactions,
  exportV2LedgerCsv,
  listV2LedgerStatistics,
  updateV2LedgerDefaultShares,
  mutateV2Transaction,
  listV2RecurringRules,
  createV2RecurringRule,
  toggleV2RecurringRule,
  listV2LedgerCategories,
  createV2LedgerCategory,
  updateV2LedgerCategory,
} from "@/lib/v2-ledger-service";
import { completeV2AttachmentUpload, createV2AttachmentUpload, deleteV2Attachment, listV2TransactionAttachments } from "@/lib/v2-attachment-service";
import {
  isV2IncidentBootstrapOnly,
  isV2IncidentBootstrapDelete,
  isV2IncidentBootstrapRead,
  isV2IncidentBootstrapWrite,
  V2IncidentFreezeError,
} from "@/lib/v2-incident-freeze";

export const runtime = "nodejs";
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

function deterministicOnboardingGroupId(coupleId: number) {
  const hash = createHash("sha256")
    .update(`couple-ledger:onboarding-group:${coupleId}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function requireV2Ledger(
  env: ReturnType<typeof serverEnvironment>,
  path: readonly string[],
  method: "GET" | "POST" | "DELETE",
): void {
  const bootstrapCompatible = method === "GET"
    ? isV2IncidentBootstrapRead(path)
    : method === "POST"
      ? isV2IncidentBootstrapWrite(path)
      : isV2IncidentBootstrapDelete(path);
  if (isV2IncidentBootstrapOnly(env) && !bootstrapCompatible) {
    throw new V2IncidentFreezeError();
  }
  if (env.V2_LEDGER_ENABLED !== "1") throw new HttpError(404, "Not found");
}

export async function GET(request: Request, route: RouteContext) {
  try {
    const path = (await route.params).path;
    const context = await requireContext(request);
    if (path[0] === "v2") requireV2Ledger(context.env, path, "GET");
    if (path[0] === "v2" && path[1] === "context" && path.length === 2) {
      const usersResult = await context.db
        .from("users")
        .select("id, couple_id, line_user_id, role")
        .eq("couple_id", context.user.couple_id)
        .order("role");
      if (usersResult.error) throw new Error("V2 context lookup failed");
      const users = z.array(userSchema).parse(usersResult.data ?? []);
      if (users.length !== 2) {
        throw new HttpError(409, "Couple 必須正好有兩位成員才能使用 V2 Ledger");
      }
      return json({
        today: taipeiToday(),
        user: publicUser(context.user, context.user.id),
        users: users.map((user) => publicUser(user, context.user.id)),
      });
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path.length === 2) {
      return json({ ledgers: await listV2UserLedgers(context.user.couple_id, context.user.id) });
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "bootstrap") {
      return json(await getV2LedgerBootstrap(context.user.couple_id, path[2]));
    }
    if (path[0] === "v2" && path[1] === "transactions" && path[2] && path[3] === "attachments") {
      return json(await listV2TransactionAttachments(context.db, context.user, path[2]));
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "recurring" && path.length === 4) {
      return json(await listV2RecurringRules(context.user.couple_id, context.user.id, path[2]));
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "categories" && path.length === 4) {
      return json(await listV2LedgerCategories(context.user.couple_id, context.user.id, path[2]));
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "transactions" && path.length === 4) {
      const url = new URL(request.url);
      return json(await listV2LedgerTransactions(context.user.couple_id, context.user.id, path[2], {
        type: url.searchParams.get("type"),
        category: url.searchParams.get("category"),
        categoryId: url.searchParams.get("categoryId"),
        payerUserId: url.searchParams.get("payerUserId"),
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        q: url.searchParams.get("q"),
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit") && /^\d+$/.test(url.searchParams.get("limit")!)
          ? Number(url.searchParams.get("limit"))
          : undefined,
      }));
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "export" && path.length === 4) {
      const url = new URL(request.url);
      const csv = await exportV2LedgerCsv(context.user.couple_id, context.user.id, path[2], {
        type: url.searchParams.get("type"),
        category: url.searchParams.get("category"),
        categoryId: url.searchParams.get("categoryId"),
        payerUserId: url.searchParams.get("payerUserId"),
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        q: url.searchParams.get("q"),
      });
      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="ledger-${path[2]}.csv"`,
          "cache-control": "no-store",
        },
      });
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "statistics" && path.length === 4) {
      const url = new URL(request.url);
      return json(await listV2LedgerStatistics(context.user.couple_id, context.user.id, path[2], {
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
      }));
    }
    if (path[0] === "v2" && path[1] === "proposals" && path[2] && path.length === 3) {
      return json(await getV2Proposal(context.user.couple_id, context.user.id, path[2]));
    }
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
    if (path[0] === "v2") requireV2Ledger(context.env, path, "POST");
    if (context.env.V2_LEDGER_ENABLED === "1" && path[0] !== "v2") {
      throw new HttpError(409, "V2 Ledger writer 已啟用；請使用 V2 Ledger API");
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path.length === 2) {
      const key = request.headers.get("idempotency-key");
      return json(await createV2Ledger(context.user.couple_id, context.user.id, { ...(body as Record<string, unknown>), ...(key ? { idempotencyKey: key } : {}) }), {}, 201);
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "transactions") {
      return json(
        await createV2Transaction(
          context.user.couple_id,
          context.user.id,
          path[2],
          body,
          request.headers.get("idempotency-key"),
        ),
        {},
        201,
      );
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "settle-all") {
      return json(
        await settleAllV2Ledger(context.user.couple_id, context.user.id, path[2], body, request.headers.get("idempotency-key")),
      );
    }
    if (path[0] === "v2" && path[1] === "transactions" && path[2] && path[3] === "mutate" && path.length === 4) {
      const key = request.headers.get("idempotency-key");
      const input = body && typeof body === "object"
        ? { ...(body as Record<string, unknown>), ...(key ? { idempotencyKey: key } : {}) }
        : body;
      return json(await mutateV2Transaction(context.user.couple_id, context.user.id, path[2], input));
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "activate") {
      return json(await activateV2Ledger(context.user.couple_id, context.user.id, path[2]));
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "default-shares" && path.length === 4) {
      const key = request.headers.get("idempotency-key");
      const input = body && typeof body === "object"
        ? { ...(body as Record<string, unknown>), ...(key ? { idempotencyKey: key } : {}) }
        : body;
      return json(await updateV2LedgerDefaultShares(context.user.couple_id, context.user.id, path[2], input));
    }
    if (path[0] === "v2" && path[1] === "attachments" && path.length === 2) {
      return json(await createV2AttachmentUpload(context.db, context.user, body), {}, 201);
    }
    if (path[0] === "v2" && path[1] === "attachments" && path[2] && path[3] === "complete" && path.length === 4) {
      return json(await completeV2AttachmentUpload(context.user, path[2]));
    }
    if (path[0] === "v2" && path[1] === "proposals" && path.length === 2) {
      return json(await createV2Proposal(context.user.couple_id, context.user.id, body, request.headers.get("idempotency-key")), {}, 201);
    }
    if (path[0] === "v2" && path[1] === "proposals" && path[2] && path[3] === "confirm" && path.length === 4) {
      return json(await confirmV2Proposal(context.user.couple_id, context.user.id, path[2]));
    }
    if (path[0] === "v2" && path[1] === "proposals" && path[2] && path[3] === "cancel" && path.length === 4) {
      return json(await cancelV2Proposal(context.user.couple_id, context.user.id, path[2]));
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "recurring" && path.length === 4) {
      const key = request.headers.get("idempotency-key");
      const input = body && typeof body === "object" ? { ...(body as Record<string, unknown>), ...(key ? { idempotencyKey: key } : {}) } : body;
      return json(await createV2RecurringRule(context.user.couple_id, context.user.id, path[2], input), {}, 201);
    }
    if (path[0] === "v2" && path[1] === "ledgers" && path[2] && path[3] === "categories" && path.length === 4) {
      const key = request.headers.get("idempotency-key");
      const input = body && typeof body === "object" ? { ...(body as Record<string, unknown>), ...(key ? { idempotencyKey: key } : {}) } : body;
      return json(await createV2LedgerCategory(context.user.couple_id, context.user.id, path[2], input), {}, 201);
    }
    if (path[0] === "v2" && path[1] === "categories" && path[2] && path.length === 3) {
      const key = request.headers.get("idempotency-key");
      const input = body && typeof body === "object" ? { ...(body as Record<string, unknown>), ...(key ? { idempotencyKey: key } : {}) } : body;
      return json(await updateV2LedgerCategory(context.user.couple_id, context.user.id, path[2], input));
    }
    if (path[0] === "v2" && path[1] === "recurring" && path[2] && path[3] === "toggle" && path.length === 4) {
      return json(await toggleV2RecurringRule(context.user.couple_id, context.user.id, path[2], body));
    }
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
      const input = z
        .object({
          pairCode: z.string().min(1).max(200),
          groupName: z.string().trim().min(1).max(40),
          firstExpense: z.preprocess(
            (value) =>
              typeof value === "string" && value.trim() === ""
                ? undefined
                : value,
            z.string().trim().min(1).max(100).optional(),
          ),
          firstAmount: z.number().int().min(1).max(100_000_000).optional(),
        })
        .refine(
          (value) => Boolean(value.firstExpense) === Boolean(value.firstAmount),
          { message: "第一筆花費的說明與金額必須一起填寫" },
        )
        .parse(body);

      if (!safeSecretEqual(input.pairCode.trim(), env.COUPLE_SETUP_CODE)) {
        throw new HttpError(403, "配對碼不正確");
      }

      const { data: existingGroups, error: existingGroupsError } = await context.db
        .from("groups")
        .select("id")
        .eq("couple_id", context.user.couple_id)
        .is("archived_at", null);

      if (existingGroupsError) {
        throw new HttpError(500, "讀取群組失敗");
      }

      if (input.firstExpense && input.firstAmount) {
        const members = await context.db
          .from("users")
          .select("id")
          .eq("couple_id", context.user.couple_id);
        if (members.error || (members.data ?? []).length !== 2) {
          throw new HttpError(
            409,
            "請先讓另一半加入，再記第一筆共同花費；也可以留空完成設定",
          );
        }
      }

      let groupId = existingGroups?.[0]?.id ?? null;
      if (!groupId) {
        const candidateGroupId = deterministicOnboardingGroupId(
          context.user.couple_id,
        );
        const { data: newGroup, error: groupError } = await context.db
          .from("groups")
          .insert({
            id: candidateGroupId,
            couple_id: context.user.couple_id,
            name: input.groupName,
            created_by_user_id: context.user.id,
          })
          .select("id")
          .single();

        if (!groupError && newGroup) {
          groupId = newGroup.id;
        } else if (groupError?.code === "23505") {
          const concurrentGroup = await context.db
            .from("groups")
            .select("id")
            .eq("id", candidateGroupId)
            .eq("couple_id", context.user.couple_id)
            .is("archived_at", null)
            .maybeSingle();
          if (concurrentGroup.error || !concurrentGroup.data) {
            throw new HttpError(500, "建立群組失敗");
          }
          groupId = concurrentGroup.data.id;
        } else {
          throw new HttpError(500, "建立群組失敗");
        }
      }

      if (input.firstExpense && input.firstAmount) {
        const idempotencyKey = `onboarding:${groupId}:first-expense`;
        const existingAction = await context.db
          .from("pending_actions")
          .select("payload")
          .eq("requested_by_user_id", context.user.id)
          .eq("action_type", "create_expense")
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        if (existingAction.error) {
          throw new HttpError(500, "讀取第一筆花費狀態失敗");
        }
        const storedExpenseDate = z
          .object({
            payload: z.object({ expense_date: z.iso.date() }).passthrough(),
          })
          .safeParse(existingAction.data).data?.payload.expense_date;
        const proposeFirstExpense = () =>
          pendingActionService.proposeAction(
            context,
            {
              type: "create_expense",
              expense: {
                ledger: "shared",
                groupId,
                description: input.firstExpense,
                merchant: null,
                notes: null,
                tag: "其他",
                amountTwd: input.firstAmount,
                paidBy: "self",
                expenseDate: storedExpenseDate ?? taipeiToday(),
                splitMethod: "equal",
                selfValue: null,
                partnerValue: null,
              },
            },
            {
              source: "onboarding",
              idempotencyKey,
            },
          );
        try {
          await proposeFirstExpense();
        } catch (error) {
          if (
            !(error instanceof HttpError) ||
            error.status !== 409 ||
            error.message !== actionResultErrorMessage({ result: "expired" })
          ) {
            throw error;
          }
          const expiredAction = await context.db
            .from("pending_actions")
            .select("id")
            .eq("requested_by_user_id", context.user.id)
            .eq("action_type", "create_expense")
            .eq("idempotency_key", idempotencyKey)
            .maybeSingle();
          if (expiredAction.error || !expiredAction.data) {
            throw new HttpError(500, "讀取第一筆花費狀態失敗");
          }
          const revivedAction = await context.db
            .from("pending_actions")
            .update({
              status: "pending",
              expires_at: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
              processed_at: null,
            })
            .eq("id", expiredAction.data.id)
            .eq("requested_by_user_id", context.user.id)
            .eq("action_type", "create_expense")
            .eq("idempotency_key", idempotencyKey)
            .eq("status", "expired");
          if (revivedAction.error) {
            throw new HttpError(500, "恢復第一筆花費失敗");
          }
          await proposeFirstExpense();
        }
      }

      const preference = await context.db
        .from("user_preferences")
        .upsert({
          user_id: context.user.id,
          active_group_id: groupId,
        });
      if (preference.error) {
        throw new HttpError(500, "儲存使用者偏好失敗");
      }

      return json({ ok: true, groupId });
    }
    throw new HttpError(404, "Not found");
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, route: RouteContext) {
  try {
    const path = (await route.params).path;
    const env = serverEnvironment();
    assertSameOrigin(request, env.APP_URL);
    const context = await requireContext(request);
    if (path[0] === "v2") requireV2Ledger(context.env, path, "DELETE");
    if (path[0] === "v2" && path[1] === "attachments" && path[2] && path.length === 3) {
      return json(await deleteV2Attachment(context.db, context.user, path[2]));
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
