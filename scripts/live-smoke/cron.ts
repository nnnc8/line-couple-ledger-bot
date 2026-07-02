import { existsSync } from "node:fs";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main() {
  console.log("Starting Cron HTTP Live Smoke Test...");

  const appUrl = requireEnv("APP_URL");
  const cronSecret = requireEnv("CRON_SECRET");
  const url = `${appUrl}/api/cron/daily`;

  console.log(`Triggering daily cron via GET ${url}...`);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
    },
  });

  console.log(`Response Status: ${res.status}`);

  if (res.status === 401) {
    throw new Error("Unauthorized (401). Please verify your CRON_SECRET.");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed with status ${res.status}: ${text}`);
  }

  const data = await res.json();
  console.log("Response JSON:", JSON.stringify(data, null, 2));

  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid response: expected JSON object");
  }

  const expectedKeys = ["drafts", "purgedReceipts", "accountantReports", "insightNotifications"];
  for (const key of expectedKeys) {
    if (!(key in data)) {
      throw new Error(`Invalid response structure: missing key "${key}"`);
    }
    if (typeof data[key] !== "number") {
      throw new Error(`Invalid response structure: key "${key}" is not a number`);
    }
  }

  console.log("Cron HTTP Live Smoke Test finished successfully!");
}

main().catch((err) => {
  console.error("Cron smoke test failed with error:");
  console.error(err);
  process.exit(1);
});
