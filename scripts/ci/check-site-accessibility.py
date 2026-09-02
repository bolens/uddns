#!/usr/bin/env python3
"""Check the hand-authored Pages documents for basic accessibility contracts."""

from html.parser import HTMLParser
from pathlib import Path
import os
import sys


class Document(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.failures: list[str] = []
        self.lang = ""
        self.title = False
        self.viewport = False
        self.mains = 0
        self.headings: list[int] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name: value or "" for name, value in attrs}
        if tag == "html":
            self.lang = values.get("lang", "")
        elif tag == "meta" and values.get("name") == "viewport":
            self.viewport = True
        elif tag == "main":
            self.mains += 1
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.headings.append(int(tag[1]))
        elif tag == "img" and "alt" not in values and values.get("role") != "presentation":
            self.failures.append("image has no alt text")
        elif tag == "iframe" and not values.get("title"):
            self.failures.append("iframe has no title")
        elif tag == "nav" and not (values.get("aria-label") or values.get("aria-labelledby")):
            self.failures.append("navigation landmark has no accessible name")
        elif tag in {"a", "button"} and not (values.get("aria-label") or values.get("href") or values.get("title")):
            self.failures.append(f"{tag} has no accessible name")

    def handle_data(self, data: str) -> None:
        if self.get_starttag_text() and data.strip():
            pass

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.title = True

    def finish(self) -> list[str]:
        if not self.lang:
            self.failures.append("html has no language")
        if not self.title:
            self.failures.append("document has no title")
        if not self.viewport:
            self.failures.append("document has no viewport metadata")
        if self.mains != 1:
            self.failures.append(f"document has {self.mains} main landmarks")
        if self.headings.count(1) != 1:
            self.failures.append(f"document has {self.headings.count(1)} h1 elements")
        for previous, current in zip(self.headings, self.headings[1:]):
            if current > previous + 1:
                self.failures.append(f"heading level jumps from h{previous} to h{current}")
        return self.failures


def main() -> int:
    site = Path(os.environ.get("SITE_DIR", "site"))
    failures: list[str] = []
    for asset in ("theme.js", "theme-modes.css", "favicon.ico", "favicon.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "og.png", "site.webmanifest"):
        if not (site / asset).is_file():
            failures.append(f"{site / asset}: missing discovery asset")
    for name in ("index.html", "404.html"):
        path = site / name
        document = Document()
        document.feed(path.read_text(encoding="utf-8"))
        failures.extend(f"{path}: {failure}" for failure in document.finish())
    home = (site / "index.html").read_text(encoding="utf-8")
    css = (site / "styles.css").read_text(encoding="utf-8")
    for contract in ('og:site_name', 'twitter:image:alt', 'rel="apple-touch-icon"', 'rel="manifest"'):
        if contract not in home:
            failures.append(f"{site / 'index.html'}: missing discovery contract {contract}")
    if ":focus-visible" not in css:
        failures.append(f"{site / 'styles.css'}: no visible keyboard focus rule")
    if "@media (prefers-reduced-motion: reduce)" not in css:
        failures.append(f"{site / 'styles.css'}: no reduced-motion fallback")
    theme_source = (site / "theme.js").read_text(encoding="utf-8")
    for behavior in ("prefers-color-scheme: light", "prefers-color-scheme: dark", "new Date().getHours()", "return \"dark\"", "localStorage.setItem"):
        if behavior not in theme_source:
            failures.append(f"theme.js: missing {behavior} adaptive-theme behavior")

    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("ok: accessibility and discovery contracts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
