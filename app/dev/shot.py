"""Screenshot app/dev/out/preview.html at phone width (run `bun run dev/preview.ts` first).
Usage: uv run --project agent python app/dev/shot.py"""
from pathlib import Path

from playwright.sync_api import sync_playwright

out = Path(__file__).parent / "out"
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page.goto((out / "preview.html").resolve().as_uri())
    page.screenshot(path=str(out / "preview.png"), full_page=True)
    b.close()
print(out / "preview.png")
