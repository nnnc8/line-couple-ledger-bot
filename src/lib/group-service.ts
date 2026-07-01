import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { HttpError } from "./http-error";

const groupInputSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  z.object({
    operation: z.literal("rename"),
    groupId: z.string().uuid(),
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  z.object({ operation: z.literal("archive"), groupId: z.string().uuid() }),
  z.object({ operation: z.literal("activate"), groupId: z.string().uuid() }),
]);

const groupSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

const nextGroupSchema = z.object({
  id: z.string().uuid(),
});

export class GroupService {
  async change(
    context: {
      db: SupabaseClient;
      user: {
        id: string;
        couple_id: number;
      };
      requireGroup: (groupId: string) => Promise<unknown>;
      appendActivity: (
        entityId: string,
        action: "create" | "update" | "archive",
        groupId: string | null,
        beforeState: unknown,
        afterState: unknown,
      ) => Promise<void>;
    },
    input: unknown,
  ): Promise<{ ok: true } | { groupId: string }> {
    const parsed = groupInputSchema.parse(input);
    if (parsed.operation === "create") {
      return this.createGroup(context, parsed);
    }

    const group = groupSummarySchema.parse(
      await context.requireGroup(parsed.groupId),
    );

    if (parsed.operation === "activate") {
      return this.activateGroup(context, group.id);
    }
    if (parsed.operation === "rename") {
      return this.renameGroup(context, group, parsed.name, parsed.color);
    }
    return this.archiveGroup(context, group);
  }

  private async createGroup(
    context: {
      db: SupabaseClient;
      user: { id: string; couple_id: number };
      appendActivity: (
        entityId: string,
        action: "create",
        groupId: string | null,
        beforeState: unknown,
        afterState: unknown,
      ) => Promise<void>;
    },
    input: z.infer<typeof groupInputSchema> & { operation: "create" },
  ): Promise<{ groupId: string }> {
    const result = await context.db
      .from("groups")
      .insert({
        couple_id: context.user.couple_id,
        name: input.name,
        color: input.color,
        created_by_user_id: context.user.id,
      })
      .select("id")
      .single();
    if (result.error) throw new Error("group create failed");

    await this.updateActiveGroup(context.db, "user_id", context.user.id, result.data.id);
    await context.appendActivity(
      result.data.id,
      "create",
      result.data.id,
      null,
      { name: input.name, color: input.color },
    );
    return { groupId: result.data.id };
  }

  private async activateGroup(
    context: {
      db: SupabaseClient;
      user: { id: string };
    },
    groupId: string,
  ): Promise<{ ok: true }> {
    await this.updateActiveGroup(context.db, "user_id", context.user.id, groupId);
    return { ok: true };
  }

  private async renameGroup(
    context: {
      db: SupabaseClient;
      appendActivity: (
        entityId: string,
        action: "update",
        groupId: string | null,
        beforeState: unknown,
        afterState: unknown,
      ) => Promise<void>;
    },
    group: z.infer<typeof groupSummarySchema>,
    name: string,
    color: string,
  ): Promise<{ ok: true }> {
    const result = await context.db
      .from("groups")
      .update({
        name,
        color,
        updated_at: new Date().toISOString(),
      })
      .eq("id", group.id);
    if (result.error) throw new Error("group update failed");

    await context.appendActivity(
      group.id,
      "update",
      group.id,
      group,
      { ...group, name, color },
    );
    return { ok: true };
  }

  private async archiveGroup(
    context: {
      db: SupabaseClient;
      user: { couple_id: number };
      appendActivity: (
        entityId: string,
        action: "archive",
        groupId: string | null,
        beforeState: unknown,
        afterState: unknown,
      ) => Promise<void>;
    },
    group: z.infer<typeof groupSummarySchema>,
  ): Promise<{ ok: true }> {
    const available = await context.db
      .from("groups")
      .select("id")
      .eq("couple_id", context.user.couple_id)
      .is("archived_at", null)
      .neq("id", group.id)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (available.error || !available.data) {
      throw new HttpError(409, "至少保留一個使用中的群組");
    }
    const nextGroup = nextGroupSchema.parse(available.data);

    const archive = await context.db
      .from("groups")
      .update({
        archived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", group.id);
    if (archive.error) throw new Error("group archive failed");

    await this.updateActiveGroup(
      context.db,
      "active_group_id",
      group.id,
      nextGroup.id,
    );
    await context.appendActivity(
      group.id,
      "archive",
      group.id,
      group,
      { ...group, archived: true },
    );
    return { ok: true };
  }

  private async updateActiveGroup(
    db: SupabaseClient,
    key: "user_id" | "active_group_id",
    value: string,
    activeGroupId: string,
  ): Promise<void> {
    const result = await db
      .from("user_preferences")
      .update({
        active_group_id: activeGroupId,
        updated_at: new Date().toISOString(),
      })
      .eq(key, value);
    if (result.error) {
      throw new Error("active group update failed");
    }
  }
}
