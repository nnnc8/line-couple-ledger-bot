export interface BuildVersion {
  commitSha: string;
  environment: string;
  buildTimestamp: string | null;
}

/** Return only non-sensitive deployment identity metadata. */
export function getBuildVersion(env: Record<string, string | undefined> = process.env): BuildVersion {
  return {
    commitSha: env.VERCEL_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA ?? "unknown",
    environment: env.VERCEL_ENV ?? env.NODE_ENV ?? "unknown",
    buildTimestamp: env.BUILD_TIMESTAMP ?? env.VERCEL_BUILD_TIMESTAMP ?? null,
  };
}
