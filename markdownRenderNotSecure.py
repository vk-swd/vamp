#!/usr/bin/env python3
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote
import json

HOST = "127.0.0.1"
PORT = 8000

DOCS_DIR = Path(".").resolve()

HTML_TEMPLATE = """<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Documentation</title>
    <style>
        :root {{
            color-scheme: light;
            font-family: system-ui, sans-serif;
        }}

        body {{
            margin: 0;
            padding: 3.5rem 2rem 2rem;
            color: #202124;
            background: #fff;
        }}

        #content {{
            max-width: 1100px;
            margin: 0 auto;
        }}

        #contents-button {{
            position: fixed;
            top: 1rem;
            left: 1rem;
            z-index: 3;
            border: 0;
            border-radius: 0.35rem;
            padding: 0.55rem 0.8rem;
            color: #fff;
            background: #202124;
            cursor: pointer;
        }}

        #contents-panel {{
            position: fixed;
            top: 0;
            bottom: 0;
            left: 0;
            z-index: 2;
            width: min(22rem, 85vw);
            overflow-y: auto;
            padding: 4rem 1rem 1rem;
            box-sizing: border-box;
            background: #f1f3f4;
            box-shadow: 0.2rem 0 1rem rgb(0 0 0 / 20%);
            transform: translateX(-105%);
            transition: transform 160ms ease;
        }}

        #contents-panel.open {{
            transform: translateX(0);
        }}

        #contents-panel h2 {{
            margin-top: 0;
            font-size: 1.1rem;
        }}

        #contents-list {{
            display: grid;
            gap: 0.35rem;
        }}

        #contents-list a {{
            color: #174ea6;
            overflow-wrap: anywhere;
        }}
    </style>
</head>

<body>
    <button id="contents-button" type="button" aria-expanded="false" aria-controls="contents-panel">
        Contents
    </button>
    <aside id="contents-panel" aria-hidden="true">
        <h2>Contents</h2>
        <nav id="contents-list" aria-label="Memo files"></nav>
    </aside>
    <div id="content"></div>

    <script type="module">
        import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
        import {{ marked }} from "https://cdn.jsdelivr.net/npm/marked@16.2.1/lib/marked.esm.js";

        mermaid.initialize({{
            startOnLoad: false
        }});
        const markdown = {markdown};
        const memoPaths = {memo_paths};

        const contentsButton = document.getElementById("contents-button");
        const contentsPanel = document.getElementById("contents-panel");
        const contentsList = document.getElementById("contents-list");

        for (const memoPath of memoPaths) {{
            const link = document.createElement("a");
            link.href = `/${{memoPath.split("/").map(encodeURIComponent).join("/")}}`;
            link.textContent = memoPath;
            contentsList.appendChild(link);
        }}

        contentsButton.addEventListener("click", () => {{
            const isOpen = contentsPanel.classList.toggle("open");
            contentsButton.setAttribute("aria-expanded", String(isOpen));
            contentsPanel.setAttribute("aria-hidden", String(!isOpen));
        }});

        document.getElementById("content").innerHTML =
            marked.parse(markdown);

        // Convert marked's Mermaid code blocks into Mermaid blocks.
        document
            .querySelectorAll("pre code.language-mermaid")
            .forEach((block) => {{
                const pre = block.parentElement;

                pre.className = "mermaid";
                pre.textContent = block.textContent;
            }});

        await mermaid.run();
    </script>
</body>
</html>
"""


class MarkdownHandler(BaseHTTPRequestHandler):
    def memo_paths(self):
        pathsDocs = (DOCS_DIR / "docs").rglob("*.md")
        pathsSrc = (DOCS_DIR / "src").rglob("memo.md")
        pathsTauri = (DOCS_DIR / "src-tauri").rglob("memo.md")
        return sorted(
            path.relative_to(DOCS_DIR).as_posix()
            for path in list(pathsDocs) + list(pathsSrc) + list(pathsTauri)
            if path.is_file()
        )

    def send_html(self, markdown, status=200):
        html = HTML_TEMPLATE.format(
            markdown=json.dumps(markdown),
            memo_paths=json.dumps(self.memo_paths()),
        )
        data = html.encode("utf-8")

        self.send_response(status)
        self.send_header(
            "Content-Type",
            "text/html; charset=utf-8"
        )
        self.send_header(
            "Content-Length",
            str(len(data))
        )
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = unquote(self.path.split("?", 1)[0])

        # Remove leading slash.
        relative_path = path.lstrip("/")

        file_path = (DOCS_DIR / relative_path).resolve()

        print(f"Request for {path}, base directory: {DOCS_DIR} file path is {file_path}")
        # Prevent ../ from escaping DOCS_DIR.
        if not file_path.is_relative_to(DOCS_DIR):
            self.send_error(403, "Forbidden")
            return

        if not file_path.is_file():
            self.send_html(f"# File not found\n\n`{relative_path}`", status=404)
            return

        if file_path.suffix.lower() != ".md":
            self.send_html(f"# Not a Markdown file\n\n`{relative_path}`", status=404)
            return

        try:
            markdown = file_path.read_text(encoding="utf-8")
        except OSError as e:
            self.send_error(500, str(e))
            return

        # JSON encoding safely embeds arbitrary Markdown
        # into a JavaScript string.
        markdown_js = json.dumps(markdown)

        html = HTML_TEMPLATE.format(
            markdown=markdown_js,
            memo_paths=json.dumps(self.memo_paths()),
        )

        data = html.encode("utf-8")

        self.send_response(200)
        self.send_header(
            "Content-Type",
            "text/html; charset=utf-8"
        )
        self.send_header(
            "Content-Length",
            str(len(data))
        )
        self.end_headers()

        self.wfile.write(data)


if __name__ == "__main__":
    print(f"Serving documentation at http://{HOST}:{PORT}")
    HTTPServer((HOST, PORT), MarkdownHandler).serve_forever()