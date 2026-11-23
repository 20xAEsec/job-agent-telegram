"""DOCX -> PDF (Word via docx2pdf, else LibreOffice) and PDF -> grayscale pages."""
import shutil
import subprocess
import tempfile
from pathlib import Path

import pymupdf

from .plan import DocError


def docx_to_pdf(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        from docx2pdf import convert  # drives Word on Windows/macOS

        convert(str(src), str(dst))
        if dst.exists():
            return
    except Exception:  # noqa: BLE001 - try the next converter
        pass
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if soffice:
        with tempfile.TemporaryDirectory() as t:
            subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", t, str(src)], check=True, capture_output=True, timeout=180)
            shutil.move(str(Path(t) / (src.stem + ".pdf")), dst)
            return
    raise DocError("no_converter", "could not turn the DOCX into a PDF: install Microsoft Word or LibreOffice, or upload your resume as a PDF")


def has_converter() -> bool:
    try:
        import docx2pdf  # noqa: F401

        if Path("C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE").exists():
            return True
    except ImportError:
        pass
    return bool(shutil.which("soffice") or shutil.which("libreoffice"))


def page_png(pdf: Path, page: int = 0, dpi: int = 100) -> bytes:
    with pymupdf.open(pdf) as d:
        return d[page].get_pixmap(dpi=dpi).tobytes("png")
