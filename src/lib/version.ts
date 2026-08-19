export interface BuildVersion {
  commitSha: string;
  environment: string;
  buildTimestamp: string | null;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Return only non-sensitive deployment identity metadata. */
export function getBuildVersion(env: Record<string, string | undefined> = process.env): BuildVersion {
  return {
    commitSha: firstNonEmpty(env.RELEASE_SHA, env.VERCEL_GIT_COMMIT_SHA, env.GIT_COMMIT_SHA) ?? "unknown",
    environment: firstNonEmpty(env.VERCEL_ENV, env.NODE_ENV) ?? "unknown",
    buildTimestamp: firstNonEmpty(env.BUILD_TIMESTAMP, env.VERCEL_BUILD_TIMESTAMP) ?? null,
  };
}
