"""Local production-build evidence with identical API fixtures; no real account writes.
Run through webapp-testing/scripts/with_server.py with a built app and Python Playwright.
Timings use the browser clock and two animation frames, not physical LINE measurements.
"""
import argparse
import gzip
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument("stage", choices=["before", "after"])
parser.add_argument("base_url")
parser.add_argument("output")
args = parser.parse_args()
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
OWNER, PARTNER = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
A, B = "00000000-0000-4000-8000-000000000010", "00000000-0000-4000-8000-000000000020"
NAMES = {A: "共同生活", B: "旅行"}

INSTRUMENT = """() => {
  window.liff = { init: async () => {}, isLoggedIn: () => true, login: () => {}, getIDToken: () => 'fixture-id-token', isInClient: () => true, closeWindow: () => {} };
  window.p2Metrics = { actions: [], identities: [], responses: [], dialogs: [] };
  const m = window.p2Metrics;
  let identity = '', open = false;
  document.addEventListener('click', e => {
    const target = e.target.closest('[data-testid="ledger-name-trigger"], [data-ledger-option], button[aria-label="切換帳本"]');
    if (target) m.actions.push({ at: performance.now(), kind: target.hasAttribute('data-ledger-option') ? 'choose' : 'open' });
  }, true);
  document.addEventListener('change', e => { if(e.target.matches('select[aria-label="切換帳本"]')) m.actions.push({ at: performance.now(), kind: 'choose' }); }, true);
  const nativeFetch = window.fetch;
  window.fetch = async (...args) => { const response = await nativeFetch(...args); const path = String(args[0]); if(path.includes('/api/')) m.responses.push({ path, at: performance.now() }); return response; };
  new MutationObserver(() => {
    const name = document.querySelector('[data-testid="ledger-name-trigger"] span')?.textContent || document.querySelector('[data-testid="surface-heading"]')?.textContent;
    if (name && name !== identity) { identity = name; const at = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => m.identities.push({ name, at, paintAt: performance.now() }))); }
    const current = Boolean(document.querySelector('dialog[open]'));
    if(current && !open) requestAnimationFrame(() => requestAnimationFrame(() => m.dialogs.push({ paintAt: performance.now() })));
    open = current;
  }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['open'] });
}"""

def ledger(id, default_id):
    return {"id": id, "name": NAMES[id], "color": "#173B63", "status": "active", "activeForUser": id == default_id,
            "version": 1, "createdAt": "2026-09-25T00:00:00Z", "updatedAt": "2026-09-25T00:00:00Z", "coupleId": 1,
            "members": [{"userId": OWNER, "role": "owner"}, {"userId": PARTNER, "role": "partner"}], "defaultShares": {OWNER: "1", PARTNER: "1"}}

def setup(page):
    state = {"default": A, "requests": []}
    page.add_init_script("(" + INSTRUMENT + ")()")
    page.route("https://static.line-scdn.net/**", lambda route: route.fulfill(content_type="application/javascript", body=""))
    def handle(route):
        request = route.request
        path = request.url.split(args.base_url)[-1]
        state["requests"].append({"method": request.method, "path": path})
        if path == "/api/app/session": data = {"ok": True}
        elif path == "/api/app/v2/context":
            data = {"today": "2026-09-25", "user": {"id": OWNER, "label": "你", "role": "owner"}, "users": [{"id": OWNER, "label": "你", "role": "owner"}, {"id": PARTNER, "label": "另一半", "role": "partner"}]}
        elif path == "/api/app/v2/ledgers": data = {"ledgers": [ledger(id, state["default"]) for id in NAMES]}
        elif path.endswith("/bootstrap"):
            id = path.split("/")[5]
            data = {"ledger": ledger(id, state["default"]), "transactions": [], "balance": {OWNER: "0", PARTNER: "0"}, "nextPayer": None}
        elif path.endswith("/categories"): data = {"categories": []}
        elif path.endswith("/activate"):
            state["default"] = path.split("/")[5]; data = {"ok": True}
        else: raise AssertionError("Unexpected API request: " + request.method + " " + path)
        route.fulfill(json=data)
    page.route("**/api/**", handle)
    return state

def ready(page):
    expect(page.get_by_label("金額，新臺幣")).to_be_visible()
    page.wait_for_load_state("networkidle")

def open_switcher(page):
    target = page.get_by_test_id("ledger-name-trigger") if args.stage == "after" else page.get_by_role("button", name="切換帳本", exact=True)
    target.click()
    expect(page.get_by_role("dialog")).to_be_visible()

def choose(page, id):
    if args.stage == "after": page.locator(f'[data-ledger-option="{id}"]').click()
    else: page.get_by_role("dialog").get_by_role("combobox", name="切換帳本", exact=True).select_option(id)
    ready(page)

samples = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for run in range(3):
        context = browser.new_context(**p.devices["iPhone 13"], base_url=args.base_url)
        page = context.new_page(); state = setup(page); scripts = {}
        def script_response(response):
            if response.url.startswith(args.base_url) and response.url.split("?")[0].endswith(".js"):
                scripts[response.url.split(args.base_url)[-1]] = len(gzip.compress(response.body(), compresslevel=6, mtime=0))
        page.on("response", script_response)
        page.goto("/"); ready(page)
        initial_js = sum(scripts.values()); initial_scripts = dict(scripts); initial_requests = list(state["requests"])
        if run == 0: page.screenshot(path=str(output / "home-390.png"), full_page=True)
        offset = len(state["requests"]); open_switcher(page); page.wait_for_timeout(150)
        opening_requests = state["requests"][offset:]
        if run == 0: page.screenshot(path=str(output / "switcher-390.png"), full_page=True)
        offset = len(state["requests"]); choose(page, B); page.wait_for_timeout(150)
        switch_requests = state["requests"][offset:]
        m = page.evaluate("window.p2Metrics")
        opening = next(x for x in m["actions"] if x["kind"] == "open")
        selection = next(x for x in m["actions"] if x["kind"] == "choose")
        identity = next(x for x in m["identities"] if x["name"] == "旅行")
        response = next(x for x in m["responses"] if x["path"].endswith(B + "/bootstrap"))
        samples.append({"run": run, "initialGzipJsBytes": initial_js, "initialScripts": initial_scripts,
            "startupRequests": initial_requests, "openRequests": opening_requests, "switchRequests": switch_requests,
            "openTapToPaintMs": m["dialogs"][0]["paintAt"] - opening["at"],
            "switchTapToIdentityPaintMs": identity["paintAt"] - selection["at"],
            "bootstrapResponseToIdentityPaintMs": max(0, identity["paintAt"] - response["at"]),
            "identityAcceptedBeforeBootstrapResponse": identity["at"] < response["at"], "browserClock": m})
        context.close()
    browser.close()
    # Before/after visual comparison for both mobile engines and widths.
    for engine in ["chromium", "webkit"]:
        browser = getattr(p, engine).launch()
        for width, height in [(390, 844), (393, 852)]:
            context = browser.new_context(**{**p.devices["iPhone 13"], "viewport": {"width": width, "height": height}}, base_url=args.base_url)
            page = context.new_page(); setup(page); page.goto("/"); ready(page)
            page.screenshot(path=str(output / f"{engine}-{width}-home.png"), full_page=True)
            open_switcher(page); page.screenshot(path=str(output / f"{engine}-{width}-switcher.png"), full_page=True)
            context.close()
        browser.close()

(output / "metrics.json").write_text(json.dumps({"stage": args.stage, "baseURL": args.base_url,
    "method": "Node 22 / Next production build, identical two-empty-ledger fixtures, no network throttling, 3 fresh Chromium 390x844 contexts; gzip level 6 loaded initial JS; browser-clock tap/mutation/fetch-response/two-rAF paint proxies. Cross-engine screenshots use the same build. No physical LINE claim.", "samples": samples}, indent=2) + "\n")
print(output / "metrics.json")
