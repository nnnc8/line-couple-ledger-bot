import type { SupabaseClient } from "@supabase/supabase-js";

import { dispatchV2NotificationOutbox } from "./v2-outbox-dispatch";

type AfterResponse = (callback: () => Promise<void>) => void;

/** Schedule delivery only after the canonical write response is ready. */
export function scheduleV2NotificationOutboxDrain(
  afterResponse: AfterResponse,
  input: { db: SupabaseClient; lineChannelAccessToken: string },
  limit = 20,
  dispatch = dispatchV2NotificationOutbox,
) {
  afterResponse(async () => {
    try {
      await dispatch(input, limit);
    } catch (error) {
      console.error("V2 notification outbox drain failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  });
}
