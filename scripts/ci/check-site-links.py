#!/usr/bin/env python3
"""Validate local links, fragments, discovery files, and public URLs."""

from html.parser import HTMLParser
from pathlib import Path
import os
import sys
import urllib.parse
import xml.etree.ElementTree as ET

ROOT = "https://bolens.github.io/uddns/"


class Document(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: set[str] = set()
        self.duplicates: set[str] = set()
        self.references: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name: value or "" for name, value in attrs}
        element_id = values.get("id")
        if element_id:
            if element_id in self.ids:
                self.duplicates.add(element_id)
            self.ids.add(element_id)
        for attribute in ("href", "src"):
            if values.get(attribute):
                self.references.append(values[attribute])


def parse(path: Path) -> Document:
    document = Document()
    document.feed(path.read_text(encoding="utf-8"))
    return document


def main() -> int:
    site = Path(os.environ.get("SITE_DIR", "site")).resolve()
    failures: list[str] = []
    documents = {path.resolve(): parse(path) for path in site.glob("*.html")}
    for path, document in documents.items():
        for duplicate in document.duplicates:
            failures.append(f"{path}: duplicate id #{duplicate}")
        for value in document.references:
            parsed = urllib.parse.urlsplit(value)
            if parsed.scheme or parsed.netloc or value.startswith(("data:", "mailto:", "tel:")):
                continue
            target = path.parent / urllib.parse.unquote(parsed.path)
            if not parsed.path or parsed.path.endswith("/"):
                target /= "index.html"
            target = target.resolve()
            if site not in (target, *target.parents):
                failures.append(f"{path}: link escapes site: {value}")
            elif not target.is_file():
                failures.append(f"{path}: missing local target: {value}")
            elif parsed.fragment and target.suffix == ".html":
                target_document = documents.get(target) or parse(target)
                if parsed.fragment not in target_document.ids:
                    failures.append(f"{path}: missing fragment: {value}")
    try:
        namespace = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        locations = {node.text for node in ET.parse(site / "sitemap.xml").findall("s:url/s:loc", namespace)}
        if locations != {ROOT, f"{ROOT}architecture.html"}:
            failures.append(f"{site / 'sitemap.xml'}: public URLs do not match")
    except (OSError, ET.ParseError) as error:
        failures.append(f"{site / 'sitemap.xml'}: {error}")
    robots = (site / "robots.txt").read_text(encoding="utf-8")
    if f"Sitemap: {ROOT}sitemap.xml" not in robots:
        failures.append(f"{site / 'robots.txt'}: sitemap URL is missing")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"ok: {len(documents)} HTML documents")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
