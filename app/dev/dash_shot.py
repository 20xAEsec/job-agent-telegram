"""Screenshot every dashboard screen (from dev/dash.ts) at 1600x900 and 390x844 @2x, plus the open job drawer.
Usage: uv run --project agent python app/dev/dash_shot.py <link>"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

out = Path(__file__).parent / "out"
out.mkdir(exist_ok=True)
link = sys.argv[1]
VIEWS = ["overview", "review", "jobs", "questions", "profile", "settings", "insights", "health"]
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    for w, h, s in [(1600, 900, 1), (390, 844, 2)]:
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=s, reduced_motion="reduce")
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.goto(link)
        page.wait_for_selector(".hero")
        page.wait_for_function("document.documentElement.dataset.scene")
        print(w, "scene:", page.evaluate("document.documentElement.dataset.scene"))
        for v in VIEWS:
            page.evaluate(f"location.hash = '#/{v}'")
            page.wait_for_timeout(700)
            page.screenshot(path=str(out / f"dash-{w}-{v}.png"))
            if v == "settings" and w == 1600:
                page.screenshot(path=str(out / f"dash-{w}-settings-full.png"), full_page=True)
        page.evaluate("location.hash = '#/jobs'")
        page.wait_for_selector("[data-job=web-0000000001]")
        page.click("[data-job=web-0000000001]")
        page.wait_for_selector("#drawer.on #dTitle")
        page.wait_for_timeout(700)
        page.screenshot(path=str(out / f"dash-{w}-drawer.png"))
        if w == 1600:  # click through the main actions; the dev server answers "Done (dev: <op>)"
            toasts = []
            def toast():
                page.wait_for_selector("#toast.on")
                toasts.append(page.inner_text("#toast"))
                page.evaluate("document.querySelector('#toast').classList.remove('on')")
            page.keyboard.press("Escape")
            page.evaluate("location.hash = '#/overview'"); page.wait_for_selector(".hero")
            page.click(".hero [data-tap='H:pause']"); toast()
            page.fill("#linkIn", "https://job-boards.greenhouse.io/acme/jobs/9"); page.click("#linkForm button"); toast()
            page.evaluate("location.hash = '#/questions'"); page.wait_for_selector("[data-form]")
            page.click("[data-pick='0'][data-o='1']"); page.fill("[data-q='1']", "2 weeks"); page.click("[data-multi-q='2'][data-o='1']")
            page.click("[data-form] button.btn--solid"); toast()
            page.evaluate("location.hash = '#/settings'"); page.wait_for_selector("[data-bool]")
            page.click("[data-bool]"); toast()
            page.fill("[data-add][data-set='ti']", "Data Analyst"); page.keyboard.press("Enter"); toast()
            page.evaluate("location.hash = '#/review'"); page.wait_for_selector("[data-approve]")
            page.click("[data-tap^='r:hv:']"); page.wait_for_selector("#modal.on"); page.click("#modal [data-m=ok]"); toast()
            page.click("[data-approve]"); toast()
            print("toasts:", toasts)
        ctx.close()
    b.close()
print(out)
print("errors:", errors or "none")
