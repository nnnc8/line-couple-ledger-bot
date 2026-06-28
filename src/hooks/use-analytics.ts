"use client";

import { useEffect, useState } from "react";
import type { CategoryAnalytics } from "@/lib/types";
import { get } from "@/lib/api";

export function useCategoryAnalytics(
  range: CategoryAnalytics["range"],
  scope: CategoryAnalytics["scope"],
  enabled = true,
) {
  const [analytics, setAnalytics] = useState<CategoryAnalytics | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void get<CategoryAnalytics>(
      `/api/app/analytics/categories?range=${range}&scope=${scope}`,
    )
      .then((result) => {
        if (!cancelled) setAnalytics(result);
      })
      .catch(() => {
        if (!cancelled) setAnalytics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [range, scope, enabled]);

  return analytics;
}
