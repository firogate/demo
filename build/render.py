import hashlib
import json
import shutil
import sys
from pathlib import Path

from jinja2 import ChainableUndefined, Environment, FileSystemLoader
from markupsafe import Markup, escape

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
PAGES = PUBLIC / "_pages"
DEMO_ASSETS = ROOT / "demo-assets"


def main(ce_path: str) -> None:
    ce = Path(ce_path).resolve()
    if not (ce / "templates" / "dashboard" / "index.html").is_file():
        sys.exit(f"Not a FiroGate CE folder: {ce}")

    static_out = PUBLIC / "static"
    if static_out.exists():
        shutil.rmtree(static_out)
    shutil.copytree(ce / "static", static_out, ignore=shutil.ignore_patterns("*.map", ".DS_Store"))
    PAGES.mkdir(parents=True, exist_ok=True)
    for f in DEMO_ASSETS.iterdir():
        dest = {".js": static_out / "js", ".css": static_out / "css", ".html": PAGES}[f.suffix]
        shutil.copy2(f, dest / f.name)

    version = _app_version(ce)

    def bust(path):
        if not isinstance(path, str) or not path.startswith("/static/"):
            return path
        clean = path.split("?", 1)[0]
        f = PUBLIC / clean.lstrip("/")
        if f.is_file():
            return f"{clean}?v={hashlib.sha1(f.read_bytes()).hexdigest()[:10]}"
        return path

    icon_dir = ce / "static" / "icons"

    def icon(name, cls="ico", size=None, stroke=2):
        p = icon_dir / f"{name}.svg"
        if not p.is_file():
            return Markup("")
        dims = f' width="{int(size)}" height="{int(size)}"' if size else ""
        return Markup(
            f'<svg class="{escape(cls)}"{dims} viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            f'stroke-width="{float(stroke):g}" stroke-linecap="round" stroke-linejoin="round" '
            f'aria-hidden="true" focusable="false">{p.read_text(encoding="utf-8").strip()}</svg>'
        )

    env = Environment(loader=FileSystemLoader(str(ce / "templates")), autoescape=True, undefined=ChainableUndefined)
    env.filters["bust"] = bust
    env.globals["icon"] = icon
    env.globals["app_version"] = version

    class Settings:
        is_testnet = False
        PANEL_REQUIRE_2FA = False
        BASE_URL = ""

        def __getattr__(self, name):
            return ""

    base_ctx = {
        "request": {}, "settings": Settings(), "base_url": "", "is_onion": False, "is_testnet": False,
        "lang": "en", "dir": "ltr", "is_rtl": False, "supported_langs": [], "lang_meta": {},
        "dashboard_url": "/dashboard", "checkout_url": "", "api_url": "", "login_url": "/",
        "panel_require_2fa": False, "firebase_config": {}, "firebase_enabled": False, "google_client_id": "",
        "auth_pages_hidden": False,
    }

    def render(template, out, **ctx):
        html = env.get_template(template).render(**base_ctx, **ctx)
        html = _inject_demo(html, bust)
        (PAGES / out).write_text(html, encoding="utf-8")
        print(f"  {out}  {len(html) // 1024} KB")

    print("Rendering pages")
    render("dashboard/index.html", "dashboard.html", is_operator=False, show_market_price=True, active_tab="@@ACTIVE_TAB@@", active_sub="@@ACTIVE_SUB@@")
    render("checkout/index.html", "checkout.html", payment_id="@@PAYMENT_ID@@", preview_layout="")
    render("api-docs.html", "docs.html", api_version="1.0.0")
    render("about.html", "about.html")
    render("theme_preview.html", "theme-preview.html")
    render("changelog.html", "changelog.html", releases=_releases(ce), api_version="1.0.0")
    for fixed in (True, False):
        for email in (True, False):
            for price in (True, False):
                name = f"paylink-{int(fixed)}{int(email)}{int(price)}.html"
                render(
                    "paylink.html", name,
                    link_slug="@@SLUG@@", link_title="@@TITLE@@", link_description="@@DESC@@",
                    link_amount=7777.123 if fixed else None, link_fixed=fixed,
                    link_collect_email=email, show_market_price=price,
                )

    thumbs = {}
    tdir = PUBLIC / "static" / "images" / "themes"
    if tdir.is_dir():
        for f in sorted(tdir.iterdir()):
            if f.suffix in (".webp", ".jpg", ".png") and f.stem not in thumbs:
                thumbs[f.stem] = f"/static/images/themes/{f.name}"
    (ROOT / "src" / "generated.js").write_text(
        "export const THUMBNAILS = " + json.dumps(thumbs, indent=2) + ";\n"
        + f"export const APP_VERSION = {json.dumps(version)};\n",
        encoding="utf-8",
    )
    print("Done")


def _inject_demo(html: str, bust) -> str:
    tag = (
        f'<link rel="stylesheet" href="{bust("/static/css/demo.css")}">'
        f'<script src="{bust("/static/js/demo.js")}" defer></script>'
    )
    return html.replace("</head>", tag + "</head>", 1)


def _app_version(ce: Path) -> str:
    import re
    m = re.search(r'APP_VERSION\s*=\s*["\']([^"\']+)', (ce / "app" / "core" / "version.py").read_text())
    return m.group(1) if m else "0.0.0"


def _releases(ce: Path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("fg_changelog", ce / "app" / "core" / "changelog.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.CHANGELOG_PATH = ce / "CHANGELOG.md"
    return mod.parse_changelog.__wrapped__() if hasattr(mod.parse_changelog, "__wrapped__") else mod.parse_changelog()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 build/render.py /path/to/firogate-ce")
    main(sys.argv[1])
