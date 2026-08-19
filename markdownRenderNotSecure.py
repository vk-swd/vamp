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
</head>

<body>
    <div id="content"></div>

    <script type="module">
        import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
        import {{ marked }} from "https://cdn.jsdelivr.net/npm/marked@16.2.1/lib/marked.esm.js";

        mermaid.initialize({{
            startOnLoad: false
        }});
        const markdown = {markdown};

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
            self.send_error(404, "File not found")
            return

        if file_path.suffix.lower() != ".md":
            self.send_error(404, "Not a Markdown file")
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
            markdown=markdown_js
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