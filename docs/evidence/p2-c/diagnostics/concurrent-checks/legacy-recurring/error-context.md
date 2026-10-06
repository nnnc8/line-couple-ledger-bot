# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: v2-liff.spec.ts >> V3-0 ignores reversed recurring responses across Ledgers
- Location: tests/v2-liff.spec.ts:691:7

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: '固定記帳', exact: true })
    - locator resolved to <button type="button" class="inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 border border-[var(--border)] bg-[var(--card)] text-foreground hover:bg-muted h-11 min-w-11 px-3 text-sm">固定記帳</button>

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e2]:
    - generic [ref=e3]:
      - button "返回帳本" [ref=e4] [cursor=pointer]: ‹ Scope A
      - heading "Scope A · 帳本設定" [active] [level=1] [ref=e5]
      - button "Scope A，目前查看，切換帳本" [ref=e6] [cursor=pointer]:
        - generic [ref=e7]: Scope A
        - img [ref=e8]
    - generic [ref=e10]:
      - generic [ref=e11]:
        - heading "帳本設定" [level=2] [ref=e12]
        - button "固定記帳" [ref=e13] [cursor=pointer]
        - heading "預設分攤" [level=3] [ref=e14]
        - paragraph [ref=e15]: 新帳本預設 50 / 50；這裡只設定目前帳本，不會影響其他帳本。
        - generic [ref=e16]:
          - generic [ref=e17]:
            - textbox "你 預設權重" [ref=e18]:
              - /placeholder: 你 權重
              - text: "1"
            - textbox "另一半 預設權重" [ref=e19]:
              - /placeholder: 另一半 權重
              - text: "1"
          - button "儲存預設分攤" [ref=e20] [cursor=pointer]
        - generic [ref=e21]:
          - heading "帳本分類" [level=3] [ref=e22]
          - paragraph [ref=e23]: 分類只屬於這本帳本；封存不會改寫既有交易的文字快照。
          - generic [ref=e24]:
            - textbox "新增自訂分類" [ref=e25]
            - button "新增" [ref=e26] [cursor=pointer]
        - generic [ref=e27]:
          - heading "匯出" [level=3] [ref=e28]
          - button "匯出 CSV" [ref=e29] [cursor=pointer]:
            - img
            - text: 匯出 CSV
      - generic [ref=e30]:
        - generic [ref=e31]:
          - generic [ref=e32]:
            - img [ref=e33]
            - heading "週期交易" [level=2] [ref=e37]
          - button "新增" [ref=e38] [cursor=pointer]
        - paragraph [ref=e39]: 尚未設定週期交易
  - region "Notifications alt+T"
  - button "Open Next.js Dev Tools" [ref=e45] [cursor=pointer]:
    - img [ref=e46]
  - alert [ref=e49]
```

# Test source

```ts
  202 |     await page.getByText("更多", { exact: true }).click();
  203 |     await expect(page.getByLabel("交易類型")).toBeVisible();
  204 |     await editor.screenshot({ path: `${directory}/advanced-fields-390.png`, animations: "disabled" });
  205 |     await openSecondary(page, "settings");
  206 |     await capture("settings-390");
  207 |     await returnHome(page);
  208 | 
  209 |     await page.setViewportSize({ width: 393, height: 852 });
  210 |     const controls = (page as typeof page & { __v2Controls?: { setLedgerName: (value: string) => void; setBalance: (owner: string, partner: string) => void } }).__v2Controls;
  211 |     controls?.setLedgerName("我們的共同生活帳本名稱超過一般長度的範例");
  212 |     controls?.setBalance("999999999", "-999999999");
  213 |     await page.getByLabel(/重新載入|重新整理/).click();
  214 |     await measure("393-long-content");
  215 |     await capture("long-content-393");
  216 | 
  217 |     await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  218 |     await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  219 |     await measure("393-200-percent-root-text-size");
  220 |     await capture("enlarged-text-393");
  221 |     await expect(page.getByRole("button", { name: "加入" })).toBeDisabled();
  222 |     await expect(page.locator("#entry-disabled-reason")).toContainText("請輸入");
  223 |     await capture("form-error-393");
  224 |     const controlsWithRequests = (page as typeof page & { __v2Controls?: { getRequestPaths: () => string[] } }).__v2Controls;
  225 |     measurements.push({ apiRequests: controlsWithRequests?.getRequestPaths() ?? [] });
  226 |     writeFileSync(`${directory}/measurements.json`, `${JSON.stringify(measurements, null, 2)}\n`);
  227 |   });
  228 | }
  229 | 
  230 | test("P1-A keeps the native transaction date fully readable at mobile widths and enlarged text", async ({ page, browserName }) => {
  231 |   await page.getByText("更多", { exact: true }).click();
  232 |   const dateInput = page.getByLabel("交易日期");
  233 |   await expect(dateInput).toBeVisible();
  234 |   await expect(dateInput).toHaveAttribute("type", "date");
  235 |   await expect(dateInput).toHaveValue("2026-08-28");
  236 |   const evidenceStage = process.env.P1A_DATE_STAGE;
  237 |   const directory = evidenceStage === "before" || evidenceStage === "after" ? `output/playwright/p1-a/date-${evidenceStage}` : null;
  238 |   if (directory) mkdirSync(directory, { recursive: true });
  239 |   const evidence: Array<Record<string, unknown>> = [];
  240 | 
  241 |   for (const viewport of [{ width: 390, height: 844 }, { width: 393, height: 852 }]) {
  242 |     await page.setViewportSize(viewport);
  243 |     for (const textScale of [100, 200]) {
  244 |       await page.evaluate((scale) => { document.documentElement.style.fontSize = `${scale}%`; }, textScale);
  245 |       await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  246 |       const metrics = await dateInput.evaluate((element, expectedWidth) => {
  247 |         const input = element as HTMLInputElement;
  248 |         const rect = input.getBoundingClientRect();
  249 |         const style = getComputedStyle(input);
  250 |         const canvas = document.createElement("canvas");
  251 |         const context = canvas.getContext("2d");
  252 |         if (context) context.font = style.font;
  253 |         const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  254 |         const border = Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
  255 |         const calendarReserve = 24;
  256 |         return {
  257 |           expectedWidth,
  258 |           viewportWidth: window.innerWidth,
  259 |           documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  260 |           value: input.value,
  261 |           type: input.type,
  262 |           right: rect.right,
  263 |           width: rect.width,
  264 |           height: rect.height,
  265 |           fontSize: Number.parseFloat(style.fontSize),
  266 |           padding,
  267 |           border,
  268 |           displayTextWidth: context?.measureText("08/28/2026").width ?? Number.POSITIVE_INFINITY,
  269 |           availableTextWidth: rect.width - padding - border - calendarReserve,
  270 |           calendarReserve,
  271 |         };
  272 |       }, viewport.width);
  273 |       evidence.push({ ...metrics, textScale });
  274 | 
  275 |       expect(metrics.value).toBe("2026-08-28");
  276 |       expect(metrics.type).toBe("date");
  277 |       expect(metrics.viewportWidth).toBe(viewport.width);
  278 |       expect(metrics.documentWidth).toBeLessThanOrEqual(viewport.width);
  279 |       expect(metrics.right).toBeLessThanOrEqual(viewport.width + 1);
  280 |       expect(metrics.height).toBeGreaterThanOrEqual(44);
  281 |       expect(metrics.fontSize).toBeGreaterThanOrEqual(textScale === 200 ? 30 : 16);
  282 |       // Keep at least 4 CSS px of layout clearance beyond the native calendar reserve.
  283 |       expect(metrics.availableTextWidth - metrics.displayTextWidth, JSON.stringify({ viewport, textScale, metrics })).toBeGreaterThanOrEqual(4);
  284 | 
  285 |       if (directory) await dateInput.screenshot({ path: `${directory}/date-${browserName}-${viewport.width}-${textScale}.png` });
  286 |     }
  287 |   }
  288 |   if (directory) writeFileSync(`${directory}/measurements-${browserName}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  289 | });
  290 | 
  291 | async function chooseLedger(page: Page, ledgerId: string) {
  292 |   await page.getByTestId("ledger-name-trigger").click();
  293 |   await page.getByRole("dialog").locator(`[data-ledger-option="${ledgerId}"]`).click();
  294 | }
  295 | async function returnHome(page: Page) {
  296 |   await page.getByRole("button", { name: "返回帳本", exact: true }).click();
  297 |   await expect(page.getByLabel("金額，新臺幣")).toBeVisible();
  298 | }
  299 | async function openSecondary(page: Page, surface: "stats" | "settings" | "recurring" | "search") {
  300 |   if (await page.getByRole("button", { name: "返回帳本", exact: true }).isVisible()) await returnHome(page);
  301 |   await page.getByRole("button", { name: surface === "stats" ? "收支概況" : surface === "search" ? "搜尋" : "帳本設定", exact: true }).click();
> 302 |   if (surface === "recurring") await page.getByRole("button", { name: "固定記帳", exact: true }).click();
      |                                                                                              ^ Error: locator.click: Test timeout of 30000ms exceeded.
  303 | }
  304 | 
  305 | function controls(page: Page) {
  306 |   return (page as typeof page & { __v2Controls: { setPostMode: (mode: PostMode) => void; releasePost: () => void; getPostRequests: () => number; getPostedBodies: () => Array<Record<string, unknown>>; setFailRefresh: (value: boolean) => void; setBalance: (owner: string, partner: string) => void; setLedgerName: (value: string) => void; getRequestPaths: () => string[] } }).__v2Controls;
  307 | }
  308 | 
  309 | async function horizontalOverflow(page: Page) {
  310 |   const expectedWidth = page.viewportSize()?.width;
  311 |   if (!expectedWidth) throw new Error("Playwright viewport is not set");
  312 |   return page.evaluate((width) => {
  313 |     const elements = Array.from(document.body.querySelectorAll<HTMLElement>("*"));
  314 |     const overflowingElements = elements.map((element) => {
  315 |       const rect = element.getBoundingClientRect();
  316 |       const style = getComputedStyle(element);
  317 |       return { tag: element.tagName.toLowerCase(), label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 36), right: Math.round(rect.right), width: Math.round(rect.width), display: style.display };
  318 |     }).filter((element) => element.display !== "none" && element.right > width + 1).sort((left, right) => right.right - left.right).slice(0, 8);
  319 |     return { expectedWidth: width, documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), overflowingElements };
  320 |   }, expectedWidth);
  321 | }
  322 | 
  323 | test("uses the V2 startup request budget", async ({ page }) => {
  324 |   await expect.poll(() => controls(page).getRequestPaths().filter((path) => path.includes("/categories")).length).toBe(1);
  325 |   const requests = controls(page).getRequestPaths();
  326 |   expect(requests.filter((path) => path === "POST /api/app/session")).toHaveLength(1);
  327 |   expect(requests.filter((path) => path === "GET /api/app/v2/context")).toHaveLength(1);
  328 |   expect(requests.filter((path) => path === "GET /api/app/v2/ledgers")).toHaveLength(1);
  329 |   expect(requests.filter((path) => path === `GET /api/app/v2/ledgers/${LEDGER}/bootstrap`)).toHaveLength(1);
  330 |   expect(requests.some((path) => path.includes("/api/app/bootstrap"))).toBe(false);
  331 |   expect(requests.some((path) => path.includes("/statistics") || path.includes("/recurring") || path.includes("/transactions?"))).toBe(false);
  332 | });
  333 | 
  334 | test("P1-A restores zoom and keeps primary controls readable and tappable", async ({ page }) => {
  335 |   const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  336 |   expect(viewport).toContain("width=device-width");
  337 |   expect(viewport).toContain("initial-scale=1");
  338 |   expect(viewport).toContain("viewport-fit=cover");
  339 |   expect(viewport).not.toMatch(/maximum-scale\s*=\s*1/i);
  340 |   expect(viewport).not.toMatch(/user-scalable\s*=\s*no/i);
  341 |   const textSizeAdjust = await page.evaluate(() => {
  342 |     const style = getComputedStyle(document.documentElement);
  343 |     return {
  344 |       supported: CSS.supports("-webkit-text-size-adjust", "auto") || CSS.supports("text-size-adjust", "auto"),
  345 |       value: style.getPropertyValue("-webkit-text-size-adjust") || style.getPropertyValue("text-size-adjust"),
  346 |     };
  347 |   });
  348 |   if (textSizeAdjust.supported) expect(textSizeAdjust.value).toBe("auto");
  349 | 
  350 |   await expect(page.getByTestId("surface-heading")).toContainText("共同生活");
  351 |   await expect(page.getByTestId("ledger-name-trigger")).toBeVisible();
  352 |   await page.getByTestId("ledger-name-trigger").click();
  353 |   const createLedger = page.getByRole("dialog").getByRole("button", { name: "建立帳本", exact: true });
  354 |   await expect(createLedger).toBeVisible();
  355 |   const createDimensions = await createLedger.boundingBox();
  356 |   expect(createDimensions!.height).toBeGreaterThanOrEqual(44);
  357 |   expect(createDimensions!.width).toBeGreaterThanOrEqual(44);
  358 |   await page.getByRole("dialog").getByRole("button", { name: "關閉視窗" }).click();
  359 |   await expect(page.getByLabel("重新整理帳本")).toBeVisible();
  360 |   await expect(page.getByLabel("金額，新臺幣")).toBeVisible();
  361 |   await expect(page.getByLabel("用途")).toBeVisible();
  362 |   await expect(page.getByRole("heading", { name: "生活紀錄", exact: true })).toBeVisible();
  363 | 
  364 |   for (const viewportSize of [{ width: 390, height: 844 }, { width: 393, height: 852 }]) {
  365 |     await page.setViewportSize(viewportSize);
  366 |     const overflow = await horizontalOverflow(page);
  367 |     expect(overflow.documentWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.expectedWidth);
  368 |     const controlsToMeasure = [
  369 |       page.getByTestId("ledger-name-trigger"),
  370 |       page.getByRole("button", { name: "搜尋", exact: true }),
  371 |       page.getByLabel("重新整理帳本"),
  372 |       page.getByLabel("金額，新臺幣"),
  373 |       page.getByLabel("用途"),
  374 |       page.getByRole("button", { name: "加入" }),
  375 |       page.getByRole("button", { name: "收支概況", exact: true }),
  376 |       page.getByRole("button", { name: "帳本設定", exact: true }),
  377 |     ];
  378 |     const dimensions = await Promise.all(controlsToMeasure.map((control) => control.evaluate((element) => {
  379 |       const rect = element.getBoundingClientRect();
  380 |       return { width: rect.width, height: rect.height, fontSize: Number.parseFloat(getComputedStyle(element).fontSize) };
  381 |     })));
  382 |     for (const { height } of dimensions) expect(height).toBeGreaterThanOrEqual(44);
  383 |     for (const { width } of dimensions.slice(0, 3)) expect(width).toBeGreaterThanOrEqual(44);
  384 |     for (const { fontSize } of dimensions.slice(3, 5)) expect(fontSize).toBeGreaterThanOrEqual(16);
  385 | 
  386 |     await page.getByText("更多", { exact: true }).click();
  387 |     const advancedSelects = await page.locator("select:visible").evaluateAll((elements) => elements.map((element) => {
  388 |       const rect = element.getBoundingClientRect();
  389 |       return { height: rect.height, fontSize: Number.parseFloat(getComputedStyle(element).fontSize) };
  390 |     }));
  391 |     expect(advancedSelects.length).toBeGreaterThan(0);
  392 |     for (const { height, fontSize } of advancedSelects) {
  393 |       expect(height).toBeGreaterThanOrEqual(44);
  394 |       expect(fontSize).toBeGreaterThanOrEqual(16);
  395 |     }
  396 |     await page.getByText("更多", { exact: true }).click();
  397 |   }
  398 | 
  399 |   await page.getByTestId("ledger-name-trigger").click();
  400 |   await page.getByRole("dialog").getByRole("button", { name: "建立帳本", exact: true }).click();
  401 |   await expect(page.getByRole("textbox", { name: "新帳本名稱" })).toBeVisible();
  402 |   await page.getByRole("dialog").getByRole("button", { name: "關閉視窗" }).click();
```