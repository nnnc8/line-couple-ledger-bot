# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: p2-c-timeline.spec.ts >> Detail pending read and read500 never guess a transaction or reveal foreign scope
- Location: tests/p2-c-timeline.spec.ts:306:5

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('alert').filter({ hasText: /fixture read failure/ })
Expected: visible
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('alert').filter({ hasText: /fixture read failure/ })

```

```yaml
- main:
  - button "返回帳本": ‹ 共同生活
  - heading "共同生活 · 紀錄詳情" [level=1]
  - button "共同生活，目前查看，切換帳本": 共同生活
  - status "正在載入紀錄詳情"
- region "Notifications alt+T"
- alert
```

# Test source

```ts
  211 |   await expect(detail(page)).toContainText("已作廢，不計入目前近況"); await expect(detail(page)).toContainText("已作廢");
  212 |   expect(fixture.actions.mutations).toHaveLength(1); expect(fixture.actions.mutations[0]!.body).toMatchObject({ action: "void", expectedVersion: 1 });
  213 |   if (readFailure) { await expect(detail(page)).toContainText(/暫時無法|待.*更新|重新整理/); await expect(detail(page)).not.toContainText("作廢失敗"); }
  214 |   await capture(page, info, readFailure ? "void-commit-read500" : "void-committed", { mutations: fixture.actions.mutations });
  215 |   await back(page).click(); await expect(row(page, IDS.expense)).toHaveCount(0); await expect(rows(page)).toHaveCount(20);
  216 | });
  217 | 
  218 | test("31 historical void Detail retains service restore ability", async ({ page }, info) => {
  219 |   const fixture = await timelineBrowser(page); await fixture.goto(detailUrl(IDS.voided)); await expect(detail(page)).toBeVisible(); await openActions(page);
  220 |   await detail(page).getByRole("button", { name: "恢復", exact: true }).click(); expect(fixture.actions.mutations).toHaveLength(0);
  221 |   await detail(page).getByRole("button", { name: "確認恢復", exact: true }).click(); await expect(detail(page)).toContainText("已恢復");
  222 |   await expect(detail(page)).not.toContainText("不計入目前近況"); expect(fixture.actions.mutations[0]!.body).toMatchObject({ action: "restore", expectedVersion: 2 });
  223 |   await capture(page, info, "restore-committed", { mutations: fixture.actions.mutations }); await back(page).click(); await loadAll(page); await expect(row(page, IDS.voided)).toBeVisible();
  224 | });
  225 | 
  226 | test("32–34 receipt existing open upload and delete stay within Detail attachment capability", async ({ page }, info) => {
  227 |   const fixture = await start(page); await openDetail(page, IDS.expense); await openActions(page);
  228 |   const receipt = detail(page).getByRole("link", { name: /PDF 收據/ }); await expect(receipt).toHaveAttribute("href", "https://receipt.example.invalid/existing.pdf"); await expect(receipt).toHaveAttribute("target", "_blank");
  229 |   await capture(page, info, "receipt-section");
  230 |   await detail(page).locator('input[type="file"]').setInputFiles({ name: "browser-receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nfixture receipt\n") });
  231 |   await expect(detail(page)).toContainText("收據已上傳"); await expect(detail(page).getByRole("link", { name: /PDF 收據/ })).toHaveCount(2);
  232 |   expect(fixture.actions.attachmentRequests.map(item => item.method)).toEqual(["POST", "PUT", "POST"]);
  233 |   await detail(page).getByRole("button", { name: "刪除收據", exact: true }).first().click(); await expect(detail(page).getByRole("link", { name: /PDF 收據/ })).toHaveCount(1);
  234 |   expect(fixture.actions.mutations).toHaveLength(0); expect(fixture.state.posts).toHaveLength(0);
  235 |   await capture(page, info, "receipt-upload-delete", { attachmentRequests: fixture.actions.attachmentRequests });
  236 | });
  237 | 
  238 | test("35 attachment failure preserves posted financial state and sends no financial mutation", async ({ page }, info) => {
  239 |   const fixture = await start(page); await openDetail(page, IDS.expense); await openActions(page); fixture.actions.attachmentFailure = true;
  240 |   await detail(page).locator('input[type="file"]').setInputFiles({ name: "failed-receipt.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
  241 |   await expect(detail(page)).toContainText("收據上傳失敗"); await expect(detail(page)).not.toContainText(/交易.*失敗|尚未確認|已作廢，不計入目前近況/);
  242 |   expect(fixture.state.rows.find(item => item.id === IDS.expense)!.status).toBe("posted"); expect(fixture.actions.mutations).toHaveLength(0); expect(fixture.state.posts).toHaveLength(0);
  243 |   await expect(page.locator('[data-write-outcome="unknown"], [data-write-outcome="submitting"]')).toHaveCount(0);
  244 |   await capture(page, info, "attachment-failure-financial-state", { attachmentRequests: fixture.actions.attachmentRequests });
  245 | });
  246 | 
  247 | test("36–37 timeline has one interactive row and no legacy details or duplicate financial/receipt actions", async ({ page }, info) => {
  248 |   await start(page); await expect(timeline(page).locator("details, summary, input[type=file]")).toHaveCount(0);
  249 |   await expect(timeline(page).getByRole("button", { name: /^(修改|編輯|作廢|恢復|加收據|刪除收據)$/ })).toHaveCount(0);
  250 |   expect(await rows(page).evaluateAll(nodes => nodes.every(node => node.querySelectorAll("button, a, input, summary").length === 0))).toBe(true);
  251 |   await openDetail(page, IDS.expense); await expect(timeline(page)).toHaveCount(0); await openActions(page);
  252 |   await expect(detail(page).getByRole("button", { name: "修改", exact: true })).toHaveCount(1); await expect(detail(page).getByRole("button", { name: "作廢", exact: true })).toHaveCount(1);
  253 |   await expect(detail(page).locator("details, summary")).toHaveCount(0); await capture(page, info, "single-detail-actions");
  254 | });
  255 | 
  256 | test("38–39 Search preserves secondary filters and include-void reveals historical row, with origin Back", async ({ page }, info) => {
  257 |   const fixture = await start(page); await expect(page.getByLabel("搜尋紀錄")).toHaveCount(0); await page.getByRole("button", { name: "搜尋", exact: true }).click();
  258 |   await expect(page.getByLabel("搜尋紀錄")).toBeVisible(); await expect(page.getByLabel("紀錄開始日期")).toBeVisible(); await expect(page.getByLabel("紀錄結束日期")).toBeVisible();
  259 |   await expect(page.getByLabel("付款人", { exact: true })).toBeVisible(); await expect(page.getByLabel("紀錄分類")).toBeVisible(); await expect(page.getByLabel("紀錄類型")).toBeVisible();
  260 |   await page.getByLabel("搜尋紀錄").fill("已作廢早餐"); await expect(row(page, IDS.voided)).toHaveCount(0);
  261 |   await page.getByLabel("包含已作廢", { exact: true }).check(); await expect(row(page, IDS.voided)).toBeVisible(); expect(new URL(page.url()).searchParams.get("includeVoided")).toBe("1");
  262 |   await row(page, IDS.voided).click(); await expect(detail(page)).toContainText("已作廢，不計入目前近況"); await back(page).click();
  263 |   await expect(page).toHaveURL(/view=search/); await expect(page.getByLabel("搜尋紀錄")).toHaveValue("已作廢早餐"); await expect(page.getByLabel("包含已作廢")).toBeChecked(); await expect(row(page, IDS.voided)).toBeFocused();
  264 |   await capture(page, info, "search-void-back", { requests: fixture.state.requests });
  265 | });
  266 | 
  267 | test("40 P2-B Ledger switch keeps truthful identity and scopes timeline data", async ({ page }, info) => {
  268 |   const fixture = await start(page); await switchLedger(page, B); await fixture.ready(); await expect(page.getByTestId("ledger-name-trigger")).toContainText("旅行");
  269 |   await expect(rows(page)).toHaveCount(1); await expect(rows(page)).toContainText("旅行帳本車票"); await expect(row(page, IDS.expense)).toHaveCount(0);
  270 |   await openDetail(page, transactionId(80)); await expect(back(page)).toContainText("旅行"); await capture(page, info, "ledger-switch-detail");
  271 | });
  272 | 
  273 | test("41 P2-A create editor remains usable and canonical upsert keeps future row first", async ({ page }, info) => {
  274 |   const fixture = await start(page); await fillEntry(page, "新增的正常日期紀錄", "681"); await page.getByTestId("payer-summary").click();
  275 |   await page.getByRole("dialog").getByRole("combobox").selectOption("partner"); await page.getByRole("dialog").getByRole("button", { name: "套用", exact: true }).click();
  276 |   await page.getByRole("button", { name: "加入", exact: true }).click(); await expect(page.locator("[data-write-outcome]")).toContainText("已加入新增的正常日期紀錄");
  277 |   await expect(rows(page)).toHaveCount(20); expect(await rows(page).first().getAttribute("data-transaction-id")).toBe(IDS.future);
  278 |   expect(fixture.state.posts).toHaveLength(1); const created = fixture.state.rows.find(item => item.description === "新增的正常日期紀錄")!;
  279 |   await loadAll(page); await expect(row(page, created.id)).toHaveCount(1); await capture(page, info, "new-create-canonical-upsert", { posts: fixture.state.posts });
  280 | });
  281 | 
  282 | test("42 dirty correction leave guard keeps draft/focus or explicitly discards with one dialog host", async ({ page }, info) => {
  283 |   const fixture = await start(page); await openDetail(page, IDS.expense); await openActions(page); await detail(page).getByRole("button", { name: "修改", exact: true }).click();
  284 |   const purpose = page.getByLabel("用途", { exact: true }); await purpose.fill("尚未儲存的更正"); await back(page).click();
  285 |   await expect(page.getByRole("dialog")).toHaveCount(1); await expect(page.getByRole("dialog")).toContainText(/放棄/); expect(fixture.actions.mutations).toHaveLength(0);
  286 |   await page.getByRole("dialog").getByRole("button", { name: "繼續編輯", exact: true }).click(); await expect(purpose).toHaveValue("尚未儲存的更正"); await expect(purpose).toBeFocused();
  287 |   await capture(page, info, "dirty-correction-preserved"); await back(page).click();
  288 |   await page.getByRole("dialog").getByRole("button", { name: /放棄/ }).click(); await expect(timeline(page)).toBeVisible(); expect(fixture.actions.mutations).toHaveLength(0);
  289 | });
  290 | 
  291 | test("first read has three static timeline skeletons and refresh failure preserves known effective rows", async ({ page }, info) => {
  292 |   const fixture = await timelineBrowser(page), hold = deferred(); fixture.state.holdReads.set(A, hold);
  293 |   await fixture.goto(); await expect(timeline(page).locator("[data-timeline-skeleton]")).toHaveCount(3);
  294 |   await expect(page.getByText("從一起花的第一筆開始", { exact: true })).toHaveCount(0); await capture(page, info, "timeline-loading");
  295 |   hold.release(); await fixture.ready(); await expect(rows(page)).toHaveCount(20); fixture.state.failReads.set(A, 500);
  296 |   await page.getByRole("button", { name: "重新整理帳本", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: /fixture read failure/ })).toBeVisible();
  297 |   await expect(rows(page)).toHaveCount(20); await capture(page, info, "read-failure-keeps-timeline");
  298 | });
  299 | 
  300 | test("empty effective history avoids fake zeros and historical records remain deep-linkable", async ({ page }, info) => {
  301 |   const fixture = await start(page, { rows: timelineRows().filter(item => item.id === IDS.old || item.id === IDS.voided) });
  302 |   await expect(rows(page)).toHaveCount(0); await expect(timeline(page)).toContainText("從一起花的第一筆開始"); await capture(page, info, "empty-effective-history");
  303 |   await fixture.goto(detailUrl(IDS.voided)); await expect(detail(page)).toContainText("已作廢早餐");
  304 | });
  305 | 
  306 | test("Detail pending read and read500 never guess a transaction or reveal foreign scope", async ({ page }, info) => {
  307 |   const fixture = await timelineBrowser(page), hold = deferred(); fixture.state.holdReads.set(A, hold);
  308 |   await fixture.goto(detailUrl(IDS.expense)); await expect(page.getByTestId("transaction-detail-skeleton")).toBeVisible();
  309 |   await expect(page.getByText("單人付款晚餐", { exact: true })).toHaveCount(0); await capture(page, info, "detail-loading"); hold.release(); await expect(detail(page)).toBeVisible();
  310 |   fixture.state.holdReads.delete(A); fixture.state.failReads.set(A, 500); await page.reload();
> 311 |   await expect(page.getByRole("alert").filter({ hasText: /fixture read failure/ })).toBeVisible(); await expect(page.getByRole("button", { name: /重新整理|重新讀取/ }).first()).toBeVisible();
      |                                                                                     ^ Error: expect(locator).toBeVisible() failed
  312 |   await capture(page, info, "detail-read-error");
  313 | });
  314 | 
  315 | test("200% long notes and reduced motion keep Back and More actions reachable without overflow", async ({ page }, info) => {
  316 |   await page.emulateMedia({ reducedMotion: "reduce" }); const fixture = await timelineBrowser(page); await fixture.goto(detailUrl(IDS.long)); await expect(detail(page)).toBeVisible();
  317 |   await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  318 |   await expect(back(page)).toBeVisible(); await more(page).scrollIntoViewIfNeeded(); await expect(more(page)).toBeInViewport();
  319 |   await openActions(page); await capture(page, info, "200-percent-long-note-reduced-motion"); await back(page).click(); await expect(timeline(page)).toBeVisible();
  320 | });
  321 | 
  322 | test("filtered Search preserves insertion-independent origin scroll and loaded second history page without a new request", async ({ page }, info) => {
  323 |   const fixture = await start(page, { searchPageSize: 50 }); await page.getByRole("button", { name: "搜尋", exact: true }).click();
  324 |   await page.getByLabel("紀錄類型").selectOption("expense"); await page.getByLabel("搜尋紀錄").fill("日常紀錄");
  325 |   await expect(page.getByRole("button", { name: "載入更早交易", exact: true })).toBeVisible();
  326 |   await page.getByRole("button", { name: "載入更早交易", exact: true }).click();
  327 |   const origin = row(page, transactionId(59)); await expect(origin).toBeVisible(); await origin.scrollIntoViewIfNeeded(); await origin.focus();
  328 |   const before = await origin.evaluate(node => ({ top: node.getBoundingClientRect().top, scrollY })); expect(before.scrollY).toBeGreaterThan(500);
  329 |   const requests = fixture.state.requests.length; await origin.click(); await expect(detail(page)).toBeVisible(); await back(page).click();
  330 |   await expect(page.locator("[data-search-ready]")).toHaveAttribute("data-search-ready", "true"); await expect(origin).toBeFocused();
  331 |   await expect(page.getByLabel("紀錄類型")).toHaveValue("expense"); await expect(page.getByLabel("搜尋紀錄")).toHaveValue("日常紀錄");
  332 |   await expect.poll(async () => Math.abs((await origin.evaluate(node => node.getBoundingClientRect().top)) - before.top)).toBeLessThan(5);
  333 |   expect(fixture.state.requests.slice(requests)).toEqual([]); await expect(page.getByRole("button", { name: "載入更早交易", exact: true })).toHaveCount(0);
  334 |   await capture(page, info, "search-page-2-origin-restored", { origin: before, requests: fixture.state.requests });
  335 | });
  336 | 
  337 | for (const failedRead of [false, true]) test(`Search mutation refresh restores loaded history window and ${failedRead ? "preserves known rows on read500" : "reads the same two pages"}`, async ({ page }, info) => {
  338 |   const fixture = await start(page, { searchPageSize: 50 }); await page.getByRole("button", { name: "搜尋", exact: true }).click();
  339 |   await page.getByLabel("搜尋紀錄").fill("日常紀錄"); await expect(page.getByRole("button", { name: "載入更早交易", exact: true })).toBeVisible(); await page.getByRole("button", { name: "載入更早交易", exact: true }).click();
  340 |   const origin = row(page, transactionId(59)); await expect(origin).toBeVisible(); await origin.scrollIntoViewIfNeeded(); await origin.click(); await expect(detail(page)).toBeVisible(); await openActions(page);
  341 |   await detail(page).getByRole("button", { name: "作廢", exact: true }).click(); await detail(page).getByRole("button", { name: "確認作廢", exact: true }).click();
  342 |   await expect(detail(page)).toContainText("已作廢，不計入目前近況");
  343 |   await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).length).toBe(2);
  344 |   fixture.actions.historyFailure = failedRead; const requests = fixture.state.requests.length; await back(page).click();
  345 |   await expect(page.locator("[data-search-ready]")).toHaveAttribute("data-search-ready", "true");
  346 |   await expect(row(page, transactionId(58))).toBeVisible(); await expect(origin).toHaveCount(0);
  347 |   const returnedRows = page.locator("button[data-transaction-id]"); await expect(returnedRows).toHaveCount(52);
  348 |   await expect(row(page, transactionId(58))).toBeFocused();
  349 |   if (failedRead) await expect(page.getByRole("alert").filter({ hasText: "fixture Search read failure" })).toBeVisible();
  350 |   else {
  351 |     const historyReads = fixture.state.requests.slice(requests).filter(item => /\/transactions\?/.test(item.path));
  352 |     expect(historyReads.map(item => new URL(`http://fixture${item.path}`).searchParams.get("cursor"))).toEqual([null, "50"]);
  353 |   }
  354 |   await capture(page, info, failedRead ? "search-mutation-known-history-read500" : "search-mutation-window-refreshed", { requests: fixture.state.requests, mutations: fixture.actions.mutations });
  355 | });
  356 | 
  357 | test("direct Detail retry focuses purpose heading after initial bootstrap read500", async ({ page }, info) => {
  358 |   const fixture = await timelineBrowser(page); fixture.state.failReads.set(A, 500); await fixture.goto(detailUrl(IDS.expense));
  359 |   await expect(page.getByRole("alert").filter({ hasText: /fixture read failure/ })).toBeVisible(); fixture.state.failReads.delete(A);
  360 |   await page.getByRole("alert").getByRole("button", { name: /重新整理|重新讀取/ }).click();
  361 |   await expect(detail(page)).toBeVisible(); await expect(detail(page).locator("[data-detail-heading]")).toBeFocused(); await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  362 |   await capture(page, info, "detail-initial-read500-retry-focus", { requests: fixture.state.requests });
  363 | });
  364 | 
  365 | test("ambiguous void response retains original mutation key and expectedVersion across a successful background read", async ({ page }, info) => {
  366 |   const fixture = await start(page), hold = deferred();
  367 |   await page.route(`**/api/app/v2/ledgers/${A}/bootstrap`, async route => { await hold.promise; await route.fulfill({ json: fixture.snapshot(A) }); });
  368 |   await page.getByRole("button", { name: "重新整理帳本", exact: true }).click();
  369 |   await expect.poll(() => fixture.state.requests.filter(item => item.path.endsWith("/bootstrap")).length).toBe(2);
  370 |   await openDetail(page, IDS.expense); await openActions(page); fixture.actions.dropNextMutationResponse = true;
  371 |   await detail(page).getByRole("button", { name: "作廢", exact: true }).click(); await detail(page).getByRole("button", { name: "確認作廢", exact: true }).click();
  372 |   await expect(detail(page).getByTestId("mutation-status")).toContainText("尚未確認是否已作廢");
  373 |   hold.release(); await expect(detail(page)).toContainText("已作廢，不計入目前近況");
  374 |   await detail(page).getByRole("button", { name: "確認作廢", exact: true }).click(); await expect(detail(page).getByTestId("mutation-status")).toHaveText("已作廢");
  375 |   expect(fixture.actions.mutations).toHaveLength(2); expect(fixture.actions.mutations[1]!.body).toEqual(fixture.actions.mutations[0]!.body);
  376 |   expect(fixture.actions.mutations[1]!.body).toMatchObject({ action: "void", expectedVersion: 1, idempotencyKey: `v2:transaction:${IDS.expense}:void:1` });
  377 |   expect(fixture.state.rows.find(item => item.id === IDS.expense)!.version).toBe(2); expect(fixture.state.version).toBe(2);
  378 |   await capture(page, info, "void-ambiguous-same-key-after-read", { mutations: fixture.actions.mutations, requests: fixture.state.requests });
  379 | });
  380 | 
  381 | test("voiding an origin row beyond twenty returns focus to its nearest surviving timeline row", async ({ page }, info) => {
  382 |   await start(page); await page.getByRole("button", { name: "更早紀錄", exact: true }).click();
  383 |   const origin = row(page, transactionId(35)); await origin.scrollIntoViewIfNeeded(); const before = await origin.evaluate(node => node.getBoundingClientRect().top);
  384 |   await openDetail(page, transactionId(35)); await openActions(page); await detail(page).getByRole("button", { name: "作廢", exact: true }).click(); await detail(page).getByRole("button", { name: "確認作廢", exact: true }).click();
  385 |   await expect(detail(page)).toContainText("已作廢，不計入目前近況"); await back(page).click(); await expect(rows(page)).toHaveCount(40); await expect(origin).toHaveCount(0);
  386 |   const nearest = row(page, transactionId(36)); await expect(nearest).toBeFocused();
  387 |   await expect.poll(async () => Math.abs((await nearest.evaluate(node => node.getBoundingClientRect().top)) - before)).toBeLessThan(5);
  388 |   await capture(page, info, "void-origin-nearest-row-focus");
  389 | });
  390 | 
  391 | test("browser records native view-transition support for bounded Detail-close motion", async ({ page }, info) => {
  392 |   await start(page); const support = await page.evaluate(() => typeof document.startViewTransition === "function");
  393 |   await page.evaluate(() => {
  394 |     const observations: string[] = []; Object.assign(window, { detailCloseMotion: observations });
  395 |     if (typeof document.startViewTransition !== "function") return;
  396 |     const original = document.startViewTransition;
  397 |     document.startViewTransition = (...args: Parameters<Document["startViewTransition"]>) => {
  398 |       const transition = original.apply(document, args);
  399 |       void transition.ready.then(() => observations.push(getComputedStyle(document.documentElement, "::view-transition-old(transaction-detail)").animationDuration)).catch(() => undefined);
  400 |       return transition;
  401 |     };
  402 |   });
  403 |   await openDetail(page, IDS.expense); await back(page).click(); await expect(timeline(page)).toBeVisible();
  404 |   if (support) await expect.poll(() => page.evaluate(() => (window as unknown as { detailCloseMotion: string[] }).detailCloseMotion)).toEqual(["0.14s"]);
  405 |   await page.emulateMedia({ reducedMotion: "reduce" }); await openDetail(page, IDS.expense); await back(page).click(); await expect(timeline(page)).toBeVisible();
  406 |   const motion = await page.evaluate(() => (window as unknown as { detailCloseMotion: string[] }).detailCloseMotion);
  407 |   expect(motion).toHaveLength(support ? 1 : 0);
  408 |   await capture(page, info, "native-view-transition-support", { supported: support, motion });
  409 | });
  410 | 
  411 | test("aborted filtered Search append returns an enabled retry and preserves the loaded first page", async ({ page }, info) => {
```