import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

const WIDTH = 2500;
const HEIGHT = 1686;
const CONTENT_HEIGHT = 1436;
const TAB_HEIGHT = 250;
const ASSET_DIR = path.resolve("assets/line-rich-menu");
const ROLLBACK_FILE = path.resolve("output/rich-menu-rollback.json");
const API = "https://api.line.me";
const DATA_API = "https://api-data.line.me";
const RECORD_ALIAS = "ledger-record-v1";
const MANAGE_ALIAS = "ledger-manage-v1";

type RichMenuAction =
  | { type: "postback"; data: string; displayText: string }
  | { type: "uri"; uri: string }
  | { type: "richmenuswitch"; richMenuAliasId: string; data: string };

type Area = {
  bounds: { x: number; y: number; width: number; height: number };
  action: RichMenuAction;
};

type RichMenuDefinition = {
  size: { width: number; height: number };
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: Area[];
};

function recordMenu(name: string): RichMenuDefinition {
  return {
    size: { width: WIDTH, height: HEIGHT },
    selected: true,
    name,
    chatBarText: "帳務選單",
    areas: [
      area(0, 0, WIDTH, 700, {
        type: "postback",
        data: "m=1&a=expense",
        displayText: "快速新增花費",
      }),
      area(0, 700, WIDTH / 2, CONTENT_HEIGHT - 700, {
        type: "postback",
        data: "m=1&a=transfer",
        displayText: "記錄轉帳",
      }),
      area(WIDTH / 2, 700, WIDTH / 2, CONTENT_HEIGHT - 700, {
        type: "postback",
        data: "m=1&a=settle",
        displayText: "全部結清",
      }),
      area(0, CONTENT_HEIGHT, WIDTH / 2, TAB_HEIGHT, {
        type: "richmenuswitch",
        richMenuAliasId: RECORD_ALIAS,
        data: "tab=record",
      }),
      area(WIDTH / 2, CONTENT_HEIGHT, WIDTH / 2, TAB_HEIGHT, {
        type: "richmenuswitch",
        richMenuAliasId: MANAGE_ALIAS,
        data: "tab=manage",
      }),
    ],
  };
}

function manageMenu(name: string, appUrl: string): RichMenuDefinition {
  const url = (tab: string) => {
    const target = new URL(appUrl);
    target.searchParams.set("tab", tab);
    return target.toString();
  };
  return {
    size: { width: WIDTH, height: HEIGHT },
    selected: true,
    name,
    chatBarText: "帳務選單",
    areas: [
      area(0, 0, WIDTH / 2, CONTENT_HEIGHT / 2, {
        type: "uri",
        uri: url("dashboard"),
      }),
      area(WIDTH / 2, 0, WIDTH / 2, CONTENT_HEIGHT / 2, {
        type: "uri",
        uri: url("history"),
      }),
      area(0, CONTENT_HEIGHT / 2, WIDTH / 2, CONTENT_HEIGHT / 2, {
        type: "uri",
        uri: url("private"),
      }),
      area(WIDTH / 2, CONTENT_HEIGHT / 2, WIDTH / 2, CONTENT_HEIGHT / 2, {
        type: "uri",
        uri: url("settings"),
      }),
      area(0, CONTENT_HEIGHT, WIDTH / 2, TAB_HEIGHT, {
        type: "richmenuswitch",
        richMenuAliasId: RECORD_ALIAS,
        data: "tab=record",
      }),
      area(WIDTH / 2, CONTENT_HEIGHT, WIDTH / 2, TAB_HEIGHT, {
        type: "richmenuswitch",
        richMenuAliasId: MANAGE_ALIAS,
        data: "tab=manage",
      }),
    ],
  };
}

function area(
  x: number,
  y: number,
  width: number,
  height: number,
  action: RichMenuAction,
): Area {
  return { bounds: { x, y, width, height }, action };
}

async function render() {
  await mkdir(ASSET_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
    await page.setContent(menuHtml("record"), { waitUntil: "load" });
    await page.screenshot({
      path: path.join(ASSET_DIR, "record.png"),
      type: "png",
    });
    await page.setContent(menuHtml("manage"), { waitUntil: "load" });
    await page.screenshot({
      path: path.join(ASSET_DIR, "manage.png"),
      type: "png",
    });
  } finally {
    await browser.close();
  }
  console.log(`Rendered ${ASSET_DIR}`);
}

function menuHtml(page: "record" | "manage") {
  const tiles =
    page === "record"
      ? `
        <section class="record">
          <article class="hero">
            <div class="icon">＋</div>
            <div><p>最常用</p><h1>快速新增花費</h1><span>共同帳或私人帳，直接點選完成</span></div>
          </article>
          <article class="half transfer"><div class="icon">↔</div><h2>記錄轉帳</h2><span>還款、預付款、雙方向</span></article>
          <article class="half settle"><div class="icon">✓</div><h2>全部結清</h2><span>依最新餘額安全結清</span></article>
        </section>`
      : `
        <section class="manage">
          <article><div class="icon">⌂</div><h2>本月總覽</h2><span>餘額與支出分析</span></article>
          <article><div class="icon">≡</div><h2>帳務流水</h2><span>花費、轉帳與搜尋</span></article>
          <article><div class="icon">●</div><h2>私人帳</h2><span>只有自己看得到</span></article>
          <article><div class="icon">⚙</div><h2>設定</h2><span>群組、週期與通知</span></article>
        </section>`;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
    body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC",sans-serif;background:#f7f3eb;color:#10213d}
    article{display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:80px 110px;border:10px solid #f7f3eb}
    h1,h2,p,span{margin:0}h1{font-size:116px;line-height:1.08;letter-spacing:-5px}h2{font-size:86px;line-height:1.1;letter-spacing:-3px}
    p{font-size:34px;font-weight:800;color:#2563eb;margin-bottom:18px}span{font-size:38px;font-weight:650;color:#53627a;margin-top:24px}
    .icon{width:116px;height:116px;border-radius:34px;background:#fff;display:grid;place-items:center;font-size:76px;font-weight:800;box-shadow:0 18px 50px #0f172a1c;margin-bottom:38px}
    .record{height:${CONTENT_HEIGHT}px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:700px ${CONTENT_HEIGHT - 700}px}
    .hero{grid-column:1/3;flex-direction:row;align-items:center;gap:70px;background:linear-gradient(125deg,#dbeafe,#eef6ff)}
    .hero .icon{width:180px;height:180px;font-size:126px;background:#2563eb;color:#fff}.hero span{font-size:42px}
    .transfer{background:#e8f5f1}.settle{background:#fff1cf}
    .manage{height:${CONTENT_HEIGHT}px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
    .manage article:nth-child(1){background:#e8f0ff}.manage article:nth-child(2){background:#e8f5f1}
    .manage article:nth-child(3){background:#f2ecff}.manage article:nth-child(4){background:#fff1cf}
    nav{height:${TAB_HEIGHT}px;display:grid;grid-template-columns:1fr 1fr;background:#10213d;color:#fff}
    nav div{display:flex;align-items:center;justify-content:center;gap:24px;font-size:52px;font-weight:800;border-top:8px solid transparent}
    nav .active{background:#fff;color:#10213d;border-color:#2563eb}
    nav b{font-size:58px}
  </style></head><body>${tiles}<nav>
    <div class="${page === "record" ? "active" : ""}"><b>＋</b>記帳</div>
    <div class="${page === "manage" ? "active" : ""}"><b>▦</b>管理</div>
  </nav></body></html>`;
}

async function validate() {
  const appUrl = process.env.APP_URL || "https://example.com";
  const definitions = [
    recordMenu("ledger-v1-record-validation"),
    manageMenu("ledger-v1-manage-validation", appUrl),
  ];
  for (const [index, definition] of definitions.entries()) {
    validateDefinition(definition);
    const filename = index === 0 ? "record.png" : "manage.png";
    const image = await readFile(path.join(ASSET_DIR, filename));
    if (image.length > 1024 * 1024) {
      throw new Error(`${filename} exceeds LINE's 1 MB limit`);
    }
    if (
      image.readUInt32BE(16) !== WIDTH ||
      image.readUInt32BE(20) !== HEIGHT
    ) {
      throw new Error(`${filename} must be ${WIDTH}x${HEIGHT}`);
    }
  }
  console.log("Rich Menu assets and areas are valid.");
}

function validateDefinition(definition: RichMenuDefinition) {
  let covered = 0;
  for (const [index, current] of definition.areas.entries()) {
    const { x, y, width, height } = current.bounds;
    if (
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > WIDTH ||
      y + height > HEIGHT
    ) {
      throw new Error(`Area ${index} is outside the image`);
    }
    if (
      current.action.type === "postback" &&
      current.action.data.length > 300
    ) {
      throw new Error(`Area ${index} postback exceeds 300 characters`);
    }
    for (const previous of definition.areas.slice(0, index)) {
      if (overlaps(current.bounds, previous.bounds)) {
        throw new Error(`Area ${index} overlaps another area`);
      }
    }
    covered += width * height;
  }
  if (covered !== WIDTH * HEIGHT) {
    throw new Error(`${definition.name} does not cover the full image`);
  }
}

function overlaps(left: Area["bounds"], right: Area["bounds"]) {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

async function plan() {
  await validate();
  const sha = gitSha();
  const localPlan = {
    release: sha,
    aliases: [RECORD_ALIAS, MANAGE_ALIAS],
    menus: [`ledger-v1-record-${sha}`, `ledger-v1-manage-${sha}`],
    default: RECORD_ALIAS,
  };
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.log(JSON.stringify({ ...localPlan, current: "LINE token unavailable" }, null, 2));
    return;
  }
  const [menus, aliases, currentDefault] = await Promise.all([
    lineJson<{ richmenus?: Array<{ richMenuId: string; name: string }> }>(
      token,
      "/v2/bot/richmenu/list",
    ),
    lineJson<{ aliases?: Array<{ richMenuAliasId: string; richMenuId: string }> }>(
      token,
      "/v2/bot/richmenu/alias/list",
    ),
    lineJson<{ richMenuId?: string }>(token, "/v2/bot/user/all/richmenu", {
      allow404: true,
    }),
  ]);
  console.log(
    JSON.stringify({
      ...localPlan,
      current: {
        defaultRichMenuId: currentDefault.richMenuId ?? null,
        aliases: aliases.aliases ?? [],
        matchingMenus: (menus.richmenus ?? []).filter((menu) =>
          menu.name.endsWith(sha),
        ),
      },
    }, null, 2),
  );
}

async function apply() {
  await validate();
  if (
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  ) {
    throw new Error("Commit and verify the release before applying Rich Menu.");
  }
  const token = requireEnv("LINE_CHANNEL_ACCESS_TOKEN");
  const appUrl = requireEnv("APP_URL");
  const sha = gitSha();
  const existing = await lineJson<{
    richmenus?: Array<{ richMenuId: string; name: string }>;
  }>(token, "/v2/bot/richmenu/list");
  const aliases = await lineJson<{
    aliases?: Array<{ richMenuAliasId: string; richMenuId: string }>;
  }>(token, "/v2/bot/richmenu/alias/list");
  const currentDefault = await lineJson<{ richMenuId?: string }>(
    token,
    "/v2/bot/user/all/richmenu",
    { allow404: true },
  );
  await mkdir(path.dirname(ROLLBACK_FILE), { recursive: true });
  await writeFile(
    ROLLBACK_FILE,
    JSON.stringify({
      defaultRichMenuId: currentDefault.richMenuId ?? null,
      aliases: (aliases.aliases ?? []).filter((item) =>
        [RECORD_ALIAS, MANAGE_ALIAS].includes(item.richMenuAliasId),
      ),
    }, null, 2),
    { mode: 0o600 },
  );

  const recordId = await ensureMenu(
    token,
    existing.richmenus ?? [],
    recordMenu(`ledger-v1-record-${sha}`),
    path.join(ASSET_DIR, "record.png"),
  );
  const manageId = await ensureMenu(
    token,
    existing.richmenus ?? [],
    manageMenu(`ledger-v1-manage-${sha}`, appUrl),
    path.join(ASSET_DIR, "manage.png"),
  );
  await upsertAlias(token, aliases.aliases ?? [], RECORD_ALIAS, recordId);
  await upsertAlias(token, aliases.aliases ?? [], MANAGE_ALIAS, manageId);
  await lineJson(token, `/v2/bot/user/all/richmenu/${recordId}`, {
    method: "POST",
  });
  console.log(JSON.stringify({ recordId, manageId, defaultRichMenuId: recordId }, null, 2));
}

async function rollback() {
  const token = requireEnv("LINE_CHANNEL_ACCESS_TOKEN");
  const state = JSON.parse(await readFile(ROLLBACK_FILE, "utf8")) as {
    defaultRichMenuId: string | null;
    aliases: Array<{ richMenuAliasId: string; richMenuId: string }>;
  };
  const currentAliases = await lineJson<{
    aliases?: Array<{ richMenuAliasId: string; richMenuId: string }>;
  }>(token, "/v2/bot/richmenu/alias/list");
  for (const alias of state.aliases) {
    await upsertAlias(
      token,
      currentAliases.aliases ?? [],
      alias.richMenuAliasId,
      alias.richMenuId,
    );
  }
  if (state.defaultRichMenuId) {
    await lineJson(
      token,
      `/v2/bot/user/all/richmenu/${state.defaultRichMenuId}`,
      { method: "POST" },
    );
  } else {
    await lineJson(token, "/v2/bot/user/all/richmenu", { method: "DELETE" });
  }
  console.log("Rich Menu rollback completed.");
}

async function ensureMenu(
  token: string,
  existing: Array<{ richMenuId: string; name: string }>,
  definition: RichMenuDefinition,
  imagePath: string,
) {
  const prior = existing.find((menu) => menu.name === definition.name);
  if (prior) return prior.richMenuId;
  const created = await lineJson<{ richMenuId: string }>(
    token,
    "/v2/bot/richmenu",
    { method: "POST", body: definition },
  );
  const image = await readFile(imagePath);
  await lineRequest(
    token,
    `${DATA_API}/v2/bot/richmenu/${created.richMenuId}/content`,
    {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: image,
    },
  );
  return created.richMenuId;
}

async function upsertAlias(
  token: string,
  existing: Array<{ richMenuAliasId: string; richMenuId: string }>,
  aliasId: string,
  richMenuId: string,
) {
  const prior = existing.find((item) => item.richMenuAliasId === aliasId);
  if (prior?.richMenuId === richMenuId) return;
  await lineJson(
    token,
    prior
      ? `/v2/bot/richmenu/alias/${aliasId}`
      : "/v2/bot/richmenu/alias",
    {
      method: prior ? "POST" : "POST",
      body: prior
        ? { richMenuId }
        : { richMenuAliasId: aliasId, richMenuId },
    },
  );
}

async function lineJson<T = Record<string, never>>(
  token: string,
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    allow404?: boolean;
  } = {},
): Promise<T> {
  const response = await lineRequest(token, `${API}${endpoint}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }, options.allow404);
  if (response.status === 404 && options.allow404) return {} as T;
  const text = await response.text();
  return text ? JSON.parse(text) as T : {} as T;
}

async function lineRequest(
  token: string,
  url: string,
  init: RequestInit,
  allow404 = false,
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok && !(allow404 && response.status === 404)) {
    throw new Error(`LINE API request failed (${response.status})`);
  }
  return response;
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function gitSha() {
  return execFileSync(
    "git",
    [
      "log",
      "-1",
      "--format=%H",
      "--",
      "assets/line-rich-menu",
      "src/app/page.tsx",
      "src/components/expense/expense-form.tsx",
      "src/components/transfer/transfer-sheet.tsx",
      "src/lib/flex-message-builder.ts",
      "src/lib/line-menu-service.ts",
      "src/lib/line-webhook-service.ts",
    ],
    { encoding: "utf8" },
  ).trim().slice(0, 8);
}

async function main() {
  const command = process.argv[2];
  if (command === "render") await render();
  else if (command === "validate") await validate();
  else if (command === "plan") await plan();
  else if (command === "apply") await apply();
  else if (command === "rollback") await rollback();
  else {
    throw new Error(
      "Usage: tsx scripts/line-rich-menu.ts <render|validate|plan|apply|rollback>",
    );
  }
}

void main();
