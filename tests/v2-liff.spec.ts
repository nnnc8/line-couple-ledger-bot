import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const OWNER = "00000000-0000-4000-8000-000000000001";
const PARTNER = "00000000-0000-4000-8000-000000000002";
const LEDGER = "00000000-0000-4000-8000-000000000010";
const TRANSACTION = "00000000-0000-4000-8000-000000000011";
const SECOND_LEDGER = "00000000-0000-4000-8000-000000000012";

type PostMode = "success" | "failure" | "fail-once" | "delay";

test.beforeEach(async ({ page }) => {
  let bootstrapCalls = 0;
  let postMode: PostMode = "success";
  let postRequests = 0;
  let postedBodies: Array<Record<string, unknown>> = [];
  let releasePost: (() => void) | null = null;
  let rows: Array<Record<string, unknown>> = [];
  let balance = { [OWNER]: "0", [PARTNER]: "0" };
  let nextPayer: Record<string, string> | null = null;
  let failRefresh = false;
  let ledgerName = "共同生活";
  const requestPaths: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) requestPaths.push(`${request.method()} ${url.pathname}${url.search}`);
  });

  await page.addInitScript(() => {
    window.liff = {
      init: async () => undefined,
      isLoggedIn: () => true,
      login: () => undefined,
      getIDToken: () => "test-id-token",
      isInClient: () => true,
      closeWindow: () => undefined,
    };
  });
  await page.route("**/api/app/bootstrap", (route) => route.fulfill({ status: 401, json: { error: "V2 test uses context" } }));
  await page.route("**/api/app/session", (route) => route.fulfill({ json: { user: { id: OWNER, role: "owner" } } }));
  await page.route("**/api/app/v2/context", (route) => route.fulfill({ json: {
    today: "2026-08-28",
    user: { id: OWNER, role: "owner", label: "你" },
    users: [
      { id: OWNER, role: "owner", label: "你" },
      { id: PARTNER, role: "partner", label: "另一半" },
    ],
  } }));
  await page.route("**/api/app/v2/ledgers", (route) => route.fulfill({ json: {
    ledgers: [{ id: LEDGER, name: ledgerName, color: "#173B63", status: "active", version: 1, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" }],
  } }));
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/bootstrap`, (route) => {
    bootstrapCalls += 1;
    if (failRefresh && bootstrapCalls > 1) return route.fulfill({ status: 503, json: { error: "暫時無法同步" } });
    return route.fulfill({ json: {
      ledger: {
        id: LEDGER,
        name: ledgerName,
        color: "#173B63",
        status: "active",
        version: 1,
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T00:00:00Z",
        coupleId: 1,
        members: [{ userId: OWNER, role: "owner" }, { userId: PARTNER, role: "partner" }],
        defaultShares: { [OWNER]: "1", [PARTNER]: "1" },
      },
      transactions: rows,
      balance,
      nextPayer,
    } });
  });
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/categories`, (route) => route.fulfill({ json: { categories: [] } }));
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/recurring`, (route) => route.fulfill({ json: { recurring: [] } }));
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/statistics`, (route) => route.fulfill({ json: { byType: {}, byCategory: {}, paidBy: {}, borneBy: {} } }));
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/transactions*`, async (route) => {
    if (route.request().method() === "POST") {
      postRequests += 1;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      postedBodies = [...postedBodies, body];
      if (postMode === "delay") await new Promise<void>((resolve) => { releasePost = resolve; });
      if (postMode === "failure" || (postMode === "fail-once" && postRequests === 1)) {
        return route.fulfill({ status: 422, json: { error: "交易格式錯誤" } });
      }
      const created = {
        id: TRANSACTION,
        ledgerId: LEDGER,
        type: body.type ?? "expense",
        amountTwd: body.amountTwd ?? "100",
        payments: [{ userId: OWNER, amountTwd: body.amountTwd ?? "100" }],
        shares: [{ userId: OWNER, amountTwd: "50" }, { userId: PARTNER, amountTwd: "50" }],
        status: "posted",
        occurredOn: body.occurredOn ?? "2026-08-28",
        description: body.description ?? "午餐",
        category: null,
        categoryId: null,
        note: null,
        splitMethod: body.splitMethod ?? "weights",
        createdAt: "2026-08-28T02:30:00.000Z",
        version: 1,
      };
      rows = [created];
      balance = { [OWNER]: "-50", [PARTNER]: "50" };
      nextPayer = { payerUserId: OWNER, payeeUserId: PARTNER, amountTwd: "50" };
      return route.fulfill({ status: 201, json: {
        transaction: created,
        balance: { [OWNER]: "-50", [PARTNER]: "50" },
        nextPayer: { payerUserId: OWNER, payeeUserId: PARTNER, amountTwd: "50" },
        ledgerVersion: 2,
      } });
    }
    const url = new URL(route.request().url());
    const type = url.searchParams.get("type");
    const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase();
    const filtered = rows.filter((row) => {
      if (type && row.type !== type) return false;
      if (query && ![row.description, row.note, row.category].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(query))) return false;
      return true;
    });
    return route.fulfill({ json: { transactions: filtered, nextCursor: null } });
  });
  await page.route(`**/api/app/v2/transactions/${TRANSACTION}/mutate`, async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action === "void") {
      rows = rows.map((row) => row.id === TRANSACTION ? { ...row, status: "voided", version: 2 } : row);
      balance = { [OWNER]: "0", [PARTNER]: "0" };
      nextPayer = null;
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("https://static.line-scdn.net/**", (route) => route.fulfill({ contentType: "application/javascript", body: "" }));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "帳本", exact: true })).toBeVisible();

  (page as typeof page & { __v2Controls?: unknown }).__v2Controls = { setPostMode: (mode: PostMode) => { postMode = mode; }, releasePost: () => releasePost?.(), getPostRequests: () => postRequests, getPostedBodies: () => postedBodies, setFailRefresh: (value: boolean) => { failRefresh = value; }, setBalance: (owner: string, partner: string) => { balance = { [OWNER]: owner, [PARTNER]: partner }; nextPayer = Number(owner) === 0 ? null : { payerUserId: Number(owner) > 0 ? PARTNER : OWNER, payeeUserId: Number(owner) > 0 ? OWNER : PARTNER, amountTwd: String(Math.abs(Number(owner))) }; }, setLedgerName: (value: string) => { ledgerName = value; }, getRequestPaths: () => requestPaths };
});

const evidenceStage = process.env.P1A_CAPTURE_STAGE;
if (evidenceStage === "before" || evidenceStage === "after") {
  test(`P1-A captures mobile evidence (${evidenceStage})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const directory = `output/playwright/p1-a/${evidenceStage}`;
    mkdirSync(directory, { recursive: true });
    const capture = (name: string, fullPage = true) => page.screenshot({ path: `${directory}/${name}.png`, fullPage, animations: "disabled" });
    const measurements: Array<Record<string, unknown>> = [];
    const measure = async (label: string) => {
      measurements.push(await page.evaluate(({ state, requestedWidth }) => {
        const visible = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        return {
          state,
          viewport: { requestedWidth, innerWidth: window.innerWidth, height: window.innerHeight, screenWidth: window.screen.width },
          requestedWidth,
          documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
          viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
          textSizeAdjust: getComputedStyle(document.documentElement).webkitTextSizeAdjust,
          overflowingElements: Array.from(document.body.querySelectorAll<HTMLElement>("*"))
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return { tag: element.tagName.toLowerCase(), label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 36), right: Math.round(rect.right), width: Math.round(rect.width) };
            })
            .filter((element) => element.right > requestedWidth + 1)
            .sort((left, right) => right.right - left.right)
            .slice(0, 8),
          controls: Array.from(document.querySelectorAll("button, input:not([type=file]), select, [role=tab]"))
            .filter(visible)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                name: element.getAttribute("aria-label") || element.textContent?.trim() || (element as HTMLInputElement).placeholder || element.tagName,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                fontSize: style.fontSize,
                tag: element.tagName.toLowerCase(),
              };
            }),
        };
      }, { state: label, requestedWidth: page.viewportSize()?.width ?? 0 }));
    };
    const editor = page.locator("form").first();

    await expect(page.getByLabel(/金額/).first()).toBeVisible();
    await measure("390-normal");
    await capture("home-390");
    await editor.screenshot({ path: `${directory}/transaction-form-390.png`, animations: "disabled" });
    await page.getByText("更多設定", { exact: true }).click();
    await expect(page.getByLabel("交易類型")).toBeVisible();
    await editor.screenshot({ path: `${directory}/advanced-fields-390.png`, animations: "disabled" });
    await page.getByRole("tab", { name: "設定" }).click();
    await capture("settings-390");

    await page.setViewportSize({ width: 393, height: 852 });
    const controls = (page as typeof page & { __v2Controls?: { setLedgerName: (value: string) => void; setBalance: (owner: string, partner: string) => void } }).__v2Controls;
    controls?.setLedgerName("我們的共同生活帳本名稱超過一般長度的範例");
    controls?.setBalance("999999999", "-999999999");
    await page.getByLabel(/重新載入|重新整理/).click();
    await measure("393-long-content");
    await capture("long-content-393");

    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await measure("393-200-percent-root-text-size");
    await capture("enlarged-text-393");
    await page.getByRole("button", { name: "儲存交易" }).click();
    await expect(page.locator('p[role="alert"]')).toBeVisible();
    await capture("form-error-393");
    const controlsWithRequests = (page as typeof page & { __v2Controls?: { getRequestPaths: () => string[] } }).__v2Controls;
    measurements.push({ apiRequests: controlsWithRequests?.getRequestPaths() ?? [] });
    writeFileSync(`${directory}/measurements.json`, `${JSON.stringify(measurements, null, 2)}\n`);
  });
}

test("P1-A keeps the native transaction date fully readable at mobile widths and enlarged text", async ({ page, browserName }) => {
  await page.getByText("更多設定", { exact: true }).click();
  const dateInput = page.getByLabel("交易日期");
  await expect(dateInput).toBeVisible();
  await expect(dateInput).toHaveAttribute("type", "date");
  await expect(dateInput).toHaveValue("2026-08-28");
  const evidenceStage = process.env.P1A_DATE_STAGE;
  const directory = evidenceStage === "before" || evidenceStage === "after" ? `output/playwright/p1-a/date-${evidenceStage}` : null;
  if (directory) mkdirSync(directory, { recursive: true });
  const evidence: Array<Record<string, unknown>> = [];

  for (const viewport of [{ width: 390, height: 844 }, { width: 393, height: 852 }]) {
    await page.setViewportSize(viewport);
    for (const textScale of [100, 200]) {
      await page.evaluate((scale) => { document.documentElement.style.fontSize = `${scale}%`; }, textScale);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const metrics = await dateInput.evaluate((element, expectedWidth) => {
        const input = element as HTMLInputElement;
        const rect = input.getBoundingClientRect();
        const style = getComputedStyle(input);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (context) context.font = style.font;
        const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
        const border = Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
        const calendarReserve = 24;
        return {
          expectedWidth,
          viewportWidth: window.innerWidth,
          documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          value: input.value,
          type: input.type,
          right: rect.right,
          width: rect.width,
          height: rect.height,
          fontSize: Number.parseFloat(style.fontSize),
          padding,
          border,
          displayTextWidth: context?.measureText("08/28/2026").width ?? Number.POSITIVE_INFINITY,
          availableTextWidth: rect.width - padding - border - calendarReserve,
          calendarReserve,
        };
      }, viewport.width);
      evidence.push({ ...metrics, textScale });

      expect(metrics.value).toBe("2026-08-28");
      expect(metrics.type).toBe("date");
      expect(metrics.viewportWidth).toBe(viewport.width);
      expect(metrics.documentWidth).toBeLessThanOrEqual(viewport.width);
      expect(metrics.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(metrics.height).toBeGreaterThanOrEqual(44);
      expect(metrics.fontSize).toBeGreaterThanOrEqual(textScale === 200 ? 30 : 16);
      expect(metrics.availableTextWidth, JSON.stringify({ viewport, textScale, metrics })).toBeGreaterThanOrEqual(metrics.displayTextWidth);

      if (directory) await dateInput.screenshot({ path: `${directory}/date-${browserName}-${viewport.width}-${textScale}.png` });
    }
  }
  if (directory) writeFileSync(`${directory}/measurements-${browserName}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
});

function controls(page: Page) {
  return (page as typeof page & { __v2Controls: { setPostMode: (mode: PostMode) => void; releasePost: () => void; getPostRequests: () => number; getPostedBodies: () => Array<Record<string, unknown>>; setFailRefresh: (value: boolean) => void; setBalance: (owner: string, partner: string) => void; setLedgerName: (value: string) => void; getRequestPaths: () => string[] } }).__v2Controls;
}

async function horizontalOverflow(page: Page) {
  const expectedWidth = page.viewportSize()?.width;
  if (!expectedWidth) throw new Error("Playwright viewport is not set");
  return page.evaluate((width) => {
    const elements = Array.from(document.body.querySelectorAll<HTMLElement>("*"));
    const overflowingElements = elements.map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { tag: element.tagName.toLowerCase(), label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 36), right: Math.round(rect.right), width: Math.round(rect.width), display: style.display };
    }).filter((element) => element.display !== "none" && element.right > width + 1).sort((left, right) => right.right - left.right).slice(0, 8);
    return { expectedWidth: width, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), overflowingElements };
  }, expectedWidth);
}

test("uses the V2 startup request budget", async ({ page }) => {
  await expect.poll(() => controls(page).getRequestPaths().filter((path) => path.includes("/categories")).length).toBe(1);
  const requests = controls(page).getRequestPaths();
  expect(requests.filter((path) => path === "POST /api/app/session")).toHaveLength(1);
  expect(requests.filter((path) => path === "GET /api/app/v2/context")).toHaveLength(1);
  expect(requests.filter((path) => path === "GET /api/app/v2/ledgers")).toHaveLength(1);
  expect(requests.filter((path) => path === `GET /api/app/v2/ledgers/${LEDGER}/bootstrap`)).toHaveLength(1);
  expect(requests.some((path) => path.includes("/api/app/bootstrap"))).toBe(false);
  expect(requests.some((path) => path.includes("/statistics") || path.includes("/recurring") || path.includes("/transactions?"))).toBe(false);
});

test("P1-A restores zoom and keeps primary controls readable and tappable", async ({ page }) => {
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).toContain("width=device-width");
  expect(viewport).toContain("initial-scale=1");
  expect(viewport).toContain("viewport-fit=cover");
  expect(viewport).not.toMatch(/maximum-scale\s*=\s*1/i);
  expect(viewport).not.toMatch(/user-scalable\s*=\s*no/i);
  const textSizeAdjust = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      supported: CSS.supports("-webkit-text-size-adjust", "auto") || CSS.supports("text-size-adjust", "auto"),
      value: style.getPropertyValue("-webkit-text-size-adjust") || style.getPropertyValue("text-size-adjust"),
    };
  });
  if (textSizeAdjust.supported) expect(textSizeAdjust.value).toBe("auto");

  await expect(page.getByRole("heading", { name: "帳本", exact: true })).toBeVisible();
  await expect(page.getByLabel("切換帳本")).toBeVisible();
  await expect(page.getByLabel("建立帳本")).toBeVisible();
  await expect(page.getByLabel("重新整理帳本")).toBeVisible();
  await expect(page.getByLabel("金額（新台幣）")).toBeVisible();
  await expect(page.getByLabel("用途")).toBeVisible();
  await expect(page.getByRole("tab", { name: "紀錄" })).toBeVisible();

  for (const viewportSize of [{ width: 390, height: 844 }, { width: 393, height: 852 }]) {
    await page.setViewportSize(viewportSize);
    const overflow = await horizontalOverflow(page);
    expect(overflow.documentWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.expectedWidth);
    const controlsToMeasure = [
      page.getByLabel("切換帳本"),
      page.getByLabel("建立帳本"),
      page.getByLabel("重新整理帳本"),
      page.getByLabel("金額（新台幣）"),
      page.getByLabel("用途"),
      page.getByRole("button", { name: "儲存交易" }),
      ...await page.getByRole("tab").all(),
    ];
    const dimensions = await Promise.all(controlsToMeasure.map((control) => control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height, fontSize: Number.parseFloat(getComputedStyle(element).fontSize) };
    })));
    for (const { height } of dimensions) expect(height).toBeGreaterThanOrEqual(44);
    for (const { width } of dimensions.slice(0, 3)) expect(width).toBeGreaterThanOrEqual(44);
    for (const { fontSize } of dimensions.slice(3, 5)) expect(fontSize).toBeGreaterThanOrEqual(16);

    await page.getByText("更多設定", { exact: true }).click();
    const advancedSelects = await page.locator("select:visible").evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { height: rect.height, fontSize: Number.parseFloat(getComputedStyle(element).fontSize) };
    }));
    expect(advancedSelects.length).toBeGreaterThan(0);
    for (const { height, fontSize } of advancedSelects) {
      expect(height).toBeGreaterThanOrEqual(44);
      expect(fontSize).toBeGreaterThanOrEqual(16);
    }
    await page.getByText("更多設定", { exact: true }).click();
  }

  await page.getByLabel("建立帳本").click();
  await expect(page.getByRole("textbox", { name: "帳本名稱" })).toBeVisible();
    await page.setViewportSize({ width: 393, height: 852 });
    await page.getByRole("tab", { name: "設定" }).click();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const enlarged = await page.evaluate((expectedWidth) => ({
    expectedWidth,
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    amountFontSize: Number.parseFloat(getComputedStyle(document.querySelector<HTMLInputElement>('input[aria-label="金額（新台幣）"]')!).fontSize),
  }), page.viewportSize()?.width ?? 0);
  expect(enlarged.documentWidth, JSON.stringify(enlarged)).toBeLessThanOrEqual(enlarged.expectedWidth);
  expect(enlarged.amountFontSize).toBeGreaterThanOrEqual(30);
});

test("P1-A keeps keyboard focus visible and honors reduced motion", async ({ page }) => {
  await page.getByLabel("金額（新台幣）").focus();
  await page.keyboard.press("Tab");
  const focusStyle = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement;
    const style = getComputedStyle(element);
    return {
      name: element.getAttribute("aria-label"),
      visible: element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
      focusVisible: element.matches(":focus-visible"),
      outlineWidth: Number.parseFloat(style.outlineWidth),
      boxShadow: style.boxShadow,
    };
  });
  expect(focusStyle.name).toBe("用途");
  expect(focusStyle.visible).toBe(true);
  expect(focusStyle.focusVisible).toBe(true);
  expect(focusStyle.outlineWidth >= 2 || focusStyle.boxShadow !== "none").toBe(true);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const animationName = await page.evaluate(() => {
    const element = document.createElement("div");
    element.className = "animate-slide-up";
    document.body.append(element);
    const name = getComputedStyle(element).animationName;
    element.remove();
    return name;
  });
  expect(animationName).toBe("none");
});

test("P1-A keeps long Ledger names and large TWD balances reachable at 200% text size", async ({ page }) => {
  const ledgerName = "我們的共同生活帳本名稱超過一般長度的範例";
  controls(page).setLedgerName(ledgerName);
  controls(page).setBalance("999999999", "-999999999");
  await page.getByLabel("重新整理帳本").click();
  await expect(page.getByText(ledgerName, { exact: true })).toBeVisible();
  await expect(page.getByText("NT$999,999,999", { exact: true })).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const overflow = await horizontalOverflow(page);
  expect(overflow.documentWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.expectedWidth);
  const amountText = await page.getByText("NT$999,999,999", { exact: true }).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rects = Array.from(range.getClientRects());
    return {
      right: Math.max(...rects.map((rect) => rect.right)),
      cardRight: element.parentElement?.getBoundingClientRect().right ?? 0,
    };
  });
  expect(amountText.right, JSON.stringify(amountText)).toBeLessThanOrEqual(amountText.cardRight + 1);
});

test("loads statistics and recurring rules only when their secondary UI is opened", async ({ page }) => {
  await page.getByRole("tab", { name: "統計" }).click();
  await expect.poll(() => controls(page).getRequestPaths().filter((path) => path.includes("/statistics")).length).toBe(1);
  await page.getByRole("tab", { name: "設定" }).click();
  await expect.poll(() => controls(page).getRequestPaths().filter((path) => path.includes("/recurring")).length).toBe(1);
});

test("shows server-confirmed saving and success feedback without waiting for history reload", async ({ page }) => {
  controls(page).setPostMode("delay");
  await page.getByLabel("金額（新台幣）").fill("100");
  await page.getByLabel("用途").fill("午餐");
  const submit = page.getByRole("button", { name: "儲存交易" });
  await submit.click();
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('button[type="submit"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(page.getByRole("button", { name: /儲存中/ })).toBeDisabled();
  await expect.poll(() => controls(page).getPostRequests()).toBe(1);
  controls(page).releasePost();
  await expect(page.getByRole("status").filter({ hasText: "已入帳：午餐 NT$100" }).first()).toBeVisible();
  await expect(page.getByText("午餐", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("heading", { name: "另一半目前多付" })).toBeVisible();
  await expect(page.getByText("NT$50", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("下次建議由 你 付款", { exact: true })).toBeVisible();
  await expect(page.getByLabel("金額（新台幣）")).toHaveValue("");
  await expect(page.getByLabel("用途")).toHaveValue("");
  await expect(page.getByLabel("交易類型")).toHaveValue("expense");
  await expect(page.getByLabel("分攤方式")).toHaveValue("weights");
  expect(controls(page).getPostedBodies()[0]).toMatchObject({ type: "expense", amountTwd: "100", occurredOn: "2026-08-28", splitMethod: "weights", payments: [{ userId: OWNER, amountTwd: "100" }] });
});

test("keeps uncommon transaction choices behind more settings", async ({ page }) => {
  await expect(page.getByLabel("交易類型")).not.toBeVisible();
  await expect(page.getByLabel("分攤方式")).not.toBeVisible();
  await page.getByText("更多設定", { exact: true }).click();
  await expect(page.getByLabel("交易類型")).toHaveValue("expense");
  await page.getByLabel("付款人").first().selectOption("partner");
  await expect(page.getByLabel("付款人").first()).toHaveValue("partner");
  await page.getByLabel("付款人").first().selectOption("both");
  await expect(page.getByLabel("你 金額").first()).toBeVisible();
  await expect(page.getByLabel("另一半 金額").first()).toBeVisible();
  await page.getByLabel("分攤方式").first().selectOption("percentage");
  await expect(page.getByLabel("你 百分比").first()).toBeVisible();
  await page.getByLabel("分攤方式").first().selectOption("exact");
  await expect(page.getByLabel("你 分攤").first()).toBeVisible();
  await page.getByLabel("交易類型").first().selectOption("income");
  await expect(page.getByLabel("收款人").first()).toBeVisible();
  await page.getByLabel("交易類型").first().selectOption("transfer");
  await expect(page.getByLabel("發送人").first()).toBeVisible();
  await expect(page.getByLabel("分攤方式").first()).not.toBeVisible();
  await expect(page.getByText("轉帳會記錄發送人 → 接收人，不會出現支出分攤選項。")).toBeVisible();
});

test("uses continuous balance language for either payer and balanced state", async ({ page }) => {
  controls(page).setBalance("50", "-50");
  await page.getByLabel("重新整理帳本").click();
  await expect(page.getByRole("heading", { name: "你目前多付" })).toBeVisible();
  await expect(page.getByText("下次建議由 另一半 付款", { exact: true })).toBeVisible();
  controls(page).setBalance("0", "0");
  await page.getByLabel("重新整理帳本").click();
  await expect(page.getByRole("heading", { name: "目前很平衡" })).toBeVisible();
  await expect(page.getByText(/欠|全部結清|轉帳／結清/)).toHaveCount(0);
});

test("keeps the daily UI usable on a narrow mobile viewport", async ({ page }) => {
  await expect(page.getByRole("button", { name: "儲存交易" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "output/playwright/v2-visual/quick-entry.png", fullPage: true });
  await page.getByText("更多設定", { exact: true }).click();
  await page.screenshot({ path: "output/playwright/v2-visual/advanced-entry.png", fullPage: true });
  await page.getByLabel("交易類型").first().selectOption("transfer");
  await expect(page.getByText("轉帳會記錄發送人 → 接收人，不會出現支出分攤選項。")).toBeVisible();
  await page.screenshot({ path: "output/playwright/v2-visual/transfer.png", fullPage: true });
  await page.getByLabel("交易類型").first().selectOption("expense");
  await page.getByText("更多設定", { exact: true }).click();
  await page.getByRole("tab", { name: "統計" }).click();
  await page.screenshot({ path: "output/playwright/v2-visual/statistics.png", fullPage: true });
  await page.getByRole("tab", { name: "設定" }).click();
  await page.screenshot({ path: "output/playwright/v2-visual/settings.png", fullPage: true });
});

test("keeps voided transactions distinct in the mobile history", async ({ page }) => {
  await page.getByLabel("金額（新台幣）").fill("100");
  await page.getByLabel("用途").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByText("午餐", { exact: true }).last()).toBeVisible();
  await page.getByText("午餐", { exact: true }).last().click();
  await page.getByRole("button", { name: "作廢" }).click();
  await expect(page.getByText("午餐（已作廢）", { exact: true })).toBeVisible();
  await page.screenshot({ path: "output/playwright/v2-visual/voided-transaction.png", fullPage: true });
});

test("uses the canonical save response without reloading the Ledger", async ({ page }) => {
  controls(page).setFailRefresh(true);
  await page.getByLabel("金額（新台幣）").fill("100");
  await page.getByLabel("用途").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已入帳：午餐 NT$100" }).first()).toBeVisible();
  await expect.poll(() => controls(page).getRequestPaths().filter((path) => path === `GET /api/app/v2/ledgers/${LEDGER}/bootstrap`).length).toBe(1);
});

test("keeps the draft on a rejected POST and does not add a local row", async ({ page }) => {
  controls(page).setPostMode("failure");
  await page.getByLabel("金額（新台幣）").fill("100");
  await page.getByLabel("用途").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "交易格式錯誤" }).first()).toBeVisible();
  await expect(page.getByLabel("金額（新台幣）")).toHaveValue("100");
  await expect(page.getByLabel("用途")).toHaveValue("午餐");
  await expect(page.getByText("已入帳：午餐 NT$100", { exact: true })).toHaveCount(0);
  await expect(page.getByText("午餐", { exact: true })).toHaveCount(0);
});

test("reuses the idempotency key on an unchanged retry", async ({ page }) => {
  controls(page).setPostMode("fail-once");
  await page.getByLabel("金額（新台幣）").fill("100");
  await page.getByLabel("用途").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "交易格式錯誤" }).first()).toBeVisible();
  controls(page).setPostMode("success");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已入帳：午餐 NT$100" }).first()).toBeVisible();
  const bodies = controls(page).getPostedBodies();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]?.idempotencyKey).toBe(bodies[1]?.idempotencyKey);
});

test("does not insert a committed transaction that fails the active history filter", async ({ page }) => {
  await page.getByLabel("搜尋紀錄").fill("晚餐");
  await page.getByLabel("金額（新台幣）").fill("100");
  await page.getByLabel("用途").fill("午餐");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已入帳：午餐 NT$100" }).first()).toBeVisible();
  await expect(page.getByText("午餐", { exact: true })).toHaveCount(0);
});

// V3-0: every response is deliberately released by the test, independent of timing.
function scopeBootstrap(id: string, name: string) {
  return { ledger: { id, name, color: "#173B63", status: "active", version: 1,
    coupleId: 1, members: [{ userId: OWNER, role: "owner" }, { userId: PARTNER, role: "partner" }],
    defaultShares: { [OWNER]: "1", [PARTNER]: "1" } }, transactions: [], balance: { [OWNER]: "0", [PARTNER]: "0" }, nextPayer: null };
}

async function twoLedgers(page: Page) {
  await page.route("**/api/app/v2/ledgers", route => route.fulfill({ json: { ledgers: [scopeBootstrap(LEDGER, "Scope A").ledger, scopeBootstrap(SECOND_LEDGER, "Scope B").ledger] } }));
  await page.route("**/api/app/v2/ledgers/*/activate", route => route.fulfill({ json: { ok: true } }));
  for (const [id, name] of [[LEDGER, "Scope A"], [SECOND_LEDGER, "Scope B"]]) {
    await page.route(`**/api/app/v2/ledgers/${id}/bootstrap`, route => route.fulfill({ json: scopeBootstrap(id!, name!) }));
    await page.route(`**/api/app/v2/ledgers/${id}/categories`, route => route.fulfill({ json: { categories: [] } }));
    await page.route(`**/api/app/v2/ledgers/${id}/recurring`, route => route.fulfill({ json: { recurring: [] } }));
    await page.route(`**/api/app/v2/ledgers/${id}/statistics`, route => route.fulfill({ json: { byType: {}, byCategory: { [name!]: "73" }, paidBy: {}, borneBy: {} } }));
    await page.route(`**/api/app/v2/ledgers/${id}/transactions?*`, route => route.fulfill({ json: { transactions: [], nextCursor: null } }));
  }
  await page.reload();
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope A");
}

async function releaseScopeResponse(page: Page, route: Route, reply: Parameters<Route["fulfill"]>[0]) {
  const received = page.waitForResponse(response => response.url() === route.request().url());
  await route.fulfill(reply);
  await (await received).finished();
  // Wait for the completed response's React update, not an arbitrary delay.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("V3-0 ignores reversed bootstrap responses and resets the Ledger draft", async ({ page }) => {
  await twoLedgers(page);
  const held: Route[] = [];
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/bootstrap`, route => { held.push(route); });
  await page.getByLabel("金額（新台幣）").fill("731");
  await page.getByLabel("用途").fill("A draft");
  await page.getByLabel("重新整理帳本").click();
  await expect.poll(() => held.length).toBe(1);
  await page.getByLabel("切換帳本").selectOption(SECOND_LEDGER);
  const card = page.locator('[style*="linear-gradient"]').first();
  await expect(card).toContainText("Scope B");
  await releaseScopeResponse(page, held[0]!, { json: scopeBootstrap(LEDGER, "STALE A") });
  // An independent B request gives the browser an observable processing barrier.
  await page.getByRole("tab", { name: "統計" }).click();
  await expect(page.getByText("Scope B", { exact: true }).last()).toBeVisible();
  await expect(card).toContainText("Scope B");
  await expect(page.getByLabel("金額（新台幣）")).toHaveValue("");
  await expect(page.getByLabel("用途")).toHaveValue("");
  await page.screenshot({ path: "output/playwright/v3-0/ledger-scope.png", fullPage: true });
});

test("V3-0 rapid A B A switches ignore the first A generation and stale errors", async ({ page }) => {
  await twoLedgers(page);
  const held: Route[] = [];
  await page.route(`**/api/app/v2/ledgers/${LEDGER}/bootstrap`, route => { held.push(route); });
  await page.getByLabel("重新整理帳本").click();
  await expect.poll(() => held.length).toBe(1);
  await page.getByLabel("切換帳本").selectOption(SECOND_LEDGER);
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope B");
  await page.getByLabel("切換帳本").selectOption(LEDGER);
  await expect.poll(() => held.length).toBe(2);
  await held[1]!.fulfill({ json: scopeBootstrap(LEDGER, "NEW A") });
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("NEW A");
  await releaseScopeResponse(page, held[0]!, { status: 503, json: { error: "STALE ERROR" } });
  await page.getByLabel("金額（新台幣）").fill("12");
  await expect(page.getByText("STALE ERROR", { exact: true })).toHaveCount(0);
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("NEW A");
});

for (const endpoint of ["statistics", "categories", "recurring", "transactions"] as const) {
  test(`V3-0 ignores reversed ${endpoint} responses across Ledgers`, async ({ page }) => {
    await twoLedgers(page);
    const held: Route[] = [];
    await page.route(`**/api/app/v2/ledgers/${LEDGER}/${endpoint}${endpoint === "transactions" ? "?*" : ""}`, route => { held.push(route); });
    if (endpoint === "statistics") await page.getByRole("tab", { name: "統計" }).click();
    if (endpoint === "recurring") await page.getByRole("tab", { name: "設定" }).click();
    if (endpoint === "categories") await page.getByLabel("重新整理帳本").click();
    if (endpoint === "transactions") await page.getByLabel("搜尋紀錄").fill("STALE");
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.getByLabel("切換帳本").selectOption(SECOND_LEDGER);
    await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope B");
    await page.getByRole("tab", { name: endpoint === "statistics" ? "統計" : endpoint === "transactions" ? "紀錄" : "設定" }).click();
    const json = endpoint === "statistics" ? { byType: {}, byCategory: { STALE: "731" }, paidBy: {}, borneBy: {} }
      : endpoint === "categories" ? { categories: [{ id: "stale-cat", ledgerId: LEDGER, name: "STALE", status: "active" }] }
      : endpoint === "recurring" ? { recurring: [{ id: "stale-rule", ledgerId: LEDGER, name: "STALE", amountTwd: "731", frequency: "monthly", nextRunDate: "2026-09-14", active: true }] }
      : { transactions: [{ id: TRANSACTION, ledgerId: LEDGER, type: "expense", amountTwd: "731", description: "STALE", status: "posted", occurredOn: "2026-09-14", payments: [], shares: [] }], nextCursor: null };
    for (const route of held) {
      if (endpoint === "transactions") await route.fulfill({ json }).catch(() => undefined); // history was aborted by the switch
      else await releaseScopeResponse(page, route, { json });
    }
    await page.getByLabel("金額（新台幣）").fill("12");
    await expect(page.getByText(/STALE/)).toHaveCount(0);
    await expect(page.getByLabel("STALE 分類名稱", { exact: true })).toHaveCount(0);
    await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope B");
  });
}

test("V3-0 switching Ledger after a deep link stays on the manual selection", async ({ page }) => {
  await twoLedgers(page);
  await page.goto(`/?v2Ledger=${LEDGER}`);
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope A");
  const activations: string[] = [];
  await page.route("**/api/app/v2/ledgers/*/activate", route => {
    activations.push(route.request().url().split("/").at(-2)!);
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByLabel("切換帳本").selectOption(SECOND_LEDGER);
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope B");
  await expect.poll(() => activations.length).toBeGreaterThan(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(activations).toEqual([SECOND_LEDGER]);
  await expect(page.getByLabel("切換帳本")).toHaveValue(SECOND_LEDGER);
});


test("V3-0 a late A save cannot update B feedback or reuse A's draft/key", async ({ page }) => {
  await twoLedgers(page);
  let held: Route | undefined;
  const requests: Array<{ ledger: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/app/v2/ledgers/*/transactions", route => {
    if (route.request().method() !== "POST") return route.fallback();
    const ledger = route.request().url().includes(SECOND_LEDGER) ? SECOND_LEDGER : LEDGER;
    requests.push({ ledger, body: route.request().postDataJSON() as Record<string, unknown> });
    if (ledger === LEDGER) { held = route; return; }
    return route.fulfill({ status: 422, json: { error: "B rejection" } });
  });
  await page.getByLabel("金額（新台幣）").fill("100");
  await page.getByLabel("用途").fill("late-A");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.getByLabel("切換帳本").selectOption(SECOND_LEDGER);
  await expect(page.locator('[style*="linear-gradient"]').first()).toContainText("Scope B");
  await releaseScopeResponse(page, held!, { status: 422, json: { error: "STALE SAVE ERROR" } });
  await expect(page.getByText("STALE SAVE ERROR", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("金額（新台幣）")).toHaveValue("");
  await page.getByLabel("金額（新台幣）").fill("100");
  await page.getByLabel("用途").fill("late-A");
  await page.getByRole("button", { name: "儲存交易" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "B rejection" }).first()).toBeVisible();
  expect(requests.map(request => request.ledger)).toEqual([LEDGER, SECOND_LEDGER]);
  expect(requests[0]!.body.idempotencyKey).not.toBe(requests[1]!.body.idempotencyKey);
});
