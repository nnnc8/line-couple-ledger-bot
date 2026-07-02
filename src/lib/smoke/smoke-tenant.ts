import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppUser } from "../server-runtime";

export interface SmokeTenant {
  owner: AppUser;
  partner: AppUser;
  group: {
    id: string;
    name: string;
  };
  cleanup: () => Promise<void>;
}

export function getSmokeEnv() {
  const SMOKE_LINE_USER_ID = process.env.SMOKE_LINE_USER_ID;
  const SMOKE_PARTNER_LINE_USER_ID = process.env.SMOKE_PARTNER_LINE_USER_ID;
  const SMOKE_GROUP_NAME = process.env.SMOKE_GROUP_NAME;

  if (!SMOKE_LINE_USER_ID || !SMOKE_PARTNER_LINE_USER_ID || !SMOKE_GROUP_NAME) {
    throw new Error(
      "Missing required smoke environment variables: SMOKE_LINE_USER_ID, SMOKE_PARTNER_LINE_USER_ID, SMOKE_GROUP_NAME"
    );
  }

  return { SMOKE_LINE_USER_ID, SMOKE_PARTNER_LINE_USER_ID, SMOKE_GROUP_NAME };
}

export async function getOrCreateSmokeTenant(db: SupabaseClient): Promise<SmokeTenant> {
  const { SMOKE_LINE_USER_ID, SMOKE_PARTNER_LINE_USER_ID, SMOKE_GROUP_NAME } = getSmokeEnv();

  // 1. Resolve owner user
  let owner: AppUser;
  const ownerRes = await db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("line_user_id", SMOKE_LINE_USER_ID)
    .maybeSingle();

  if (ownerRes.error) throw new Error(`Smoke owner lookup failed: ${ownerRes.error.message}`);
  
  if (ownerRes.data) {
    owner = ownerRes.data as AppUser;
  } else {
    // Check if owner role is already taken for couple_id = 1
    const ownerCheck = await db.from("users").select("id").eq("couple_id", 1).eq("role", "owner").maybeSingle();
    if (ownerCheck.data) {
      throw new Error("Smoke setup error: owner role already taken for couple 1 but LINE user ID does not match");
    }
    const createOwner = await db
      .from("users")
      .insert({ line_user_id: SMOKE_LINE_USER_ID, role: "owner", couple_id: 1 })
      .select("id, couple_id, line_user_id, role")
      .single();
    if (createOwner.error) throw new Error(`Smoke owner seeding failed: ${createOwner.error.message}`);
    owner = createOwner.data as AppUser;
  }

  // 2. Resolve partner user
  let partner: AppUser;
  const partnerRes = await db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("line_user_id", SMOKE_PARTNER_LINE_USER_ID)
    .maybeSingle();

  if (partnerRes.error) throw new Error(`Smoke partner lookup failed: ${partnerRes.error.message}`);
  
  if (partnerRes.data) {
    partner = partnerRes.data as AppUser;
  } else {
    // Check if partner role is already taken for couple_id = 1
    const partnerCheck = await db.from("users").select("id").eq("couple_id", 1).eq("role", "partner").maybeSingle();
    if (partnerCheck.data) {
      throw new Error("Smoke setup error: partner role already taken for couple 1 but LINE user ID does not match");
    }
    const createPartner = await db
      .from("users")
      .insert({ line_user_id: SMOKE_PARTNER_LINE_USER_ID, role: "partner", couple_id: 1 })
      .select("id, couple_id, line_user_id, role")
      .single();
    if (createPartner.error) throw new Error(`Smoke partner seeding failed: ${createPartner.error.message}`);
    partner = createPartner.data as AppUser;
  }

  const preferenceSnapshot = await db
    .from("user_preferences")
    .select("user_id, active_group_id")
    .in("user_id", [owner.id, partner.id]);
  if (preferenceSnapshot.error) {
    throw new Error(`Smoke preferences snapshot failed: ${preferenceSnapshot.error.message}`);
  }

  const originalPreferences = new Map(
    (preferenceSnapshot.data ?? []).map((row) => [row.user_id as string, row.active_group_id as string]),
  );

  // 3. Resolve Group
  let groupId: string;
  let createdGroup = false;
  const groupRes = await db
    .from("groups")
    .select("id")
    .eq("name", SMOKE_GROUP_NAME)
    .eq("couple_id", 1)
    .is("archived_at", null)
    .maybeSingle();

  if (groupRes.error) throw new Error(`Smoke group lookup failed: ${groupRes.error.message}`);

  if (groupRes.data) {
    groupId = groupRes.data.id;
  } else {
    const createGroup = await db
      .from("groups")
      .insert({ couple_id: 1, name: SMOKE_GROUP_NAME, created_by_user_id: owner.id })
      .select("id")
      .single();
    if (createGroup.error) throw new Error(`Smoke group seeding failed: ${createGroup.error.message}`);
    groupId = createGroup.data.id;
    createdGroup = true;
  }

  // 4. Ensure preferences are set to this group as active
  const prefUpsert = await db.from("user_preferences").upsert([
    { user_id: owner.id, active_group_id: groupId },
    { user_id: partner.id, active_group_id: groupId }
  ]);
  if (prefUpsert.error) throw new Error(`Smoke preferences update failed: ${prefUpsert.error.message}`);

  return {
    owner,
    partner,
    group: {
      id: groupId,
      name: SMOKE_GROUP_NAME
    },
    cleanup: async () => {
      const errors: string[] = [];
      const userIds = [owner.id, partner.id];
      const restoreRows = userIds
        .map((userId) => {
          const activeGroupId = originalPreferences.get(userId);
          if (!activeGroupId) return null;
          return { user_id: userId, active_group_id: activeGroupId };
        })
        .filter((row): row is { user_id: string; active_group_id: string } => row !== null);

      if (restoreRows.length > 0) {
        const restoreRes = await db.from("user_preferences").upsert(restoreRows);
        if (restoreRes.error) {
          errors.push(`Smoke preferences restore failed: ${restoreRes.error.message}`);
        }
      }

      const createdPreferenceUserIds = userIds.filter((userId) => !originalPreferences.has(userId));
      if (createdPreferenceUserIds.length > 0) {
        const deletePrefRes = await db
          .from("user_preferences")
          .delete()
          .in("user_id", createdPreferenceUserIds)
          .eq("active_group_id", groupId);
        if (deletePrefRes.error) {
          errors.push(`Smoke created preferences cleanup failed: ${deletePrefRes.error.message}`);
        }
      }

      if (createdGroup) {
        const deleteGroupRes = await db.from("groups").delete().eq("id", groupId);
        if (deleteGroupRes.error) {
          errors.push(`Smoke group cleanup failed: ${deleteGroupRes.error.message}`);
        }
      }

      if (errors.length > 0) {
        throw new Error(`Smoke tenant cleanup failed:\n${errors.join("\n")}`);
      }
    },
  };
}
