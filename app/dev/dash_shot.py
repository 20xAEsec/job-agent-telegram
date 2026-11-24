"""Screenshot the dashboard (from dev/dash.ts) at 1600x900, 1366x640 and 390x844 @2x, plus the open job drawer.
Usage: uv run --project agent python app/dev/dash_shot.py <link>"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

out = Path(__file__).parent / "out"
out.mkdir(exist_ok=True)
link = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h, s in [(1600, 900, 1), (1366, 640, 1), (390, 844, 2)]:
        ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=s, reduced_motion="reduce")
        page = ctx.new_page()
        page.goto(link)
        page.wait_for_selector(".job")
        page.screenshot(path=str(out / f"dash-{w}.png"))
        page.click("[data-job=greenhouse-acme-1]")
        page.wait_for_selector("#drawer.on #dTitle")
        page.screenshot(path=str(out / f"dash-{w}-job.png"))
        page.keyboard.press("Escape")
        page.click("[data-view=insights]")
        page.screenshot(path=str(out / f"dash-{w}-insights.png"))
        ctx.close()
    b.close()
print(out)
