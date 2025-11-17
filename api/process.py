from http.server import BaseHTTPRequestHandler
import json
import traceback


class handler(BaseHTTPRequestHandler):
    def _write(self, text: str):
        self.wfile.write(text.encode("utf-8"))

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self._write("Process endpoint ready. Use POST with optional JSON body {\"limit\": n}.")

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", "0") or 0)
        body_bytes = self.rfile.read(content_length) if content_length else b""
        limit = 50
        if body_bytes:
            try:
                data = json.loads(body_bytes.decode("utf-8"))
                maybe_limit = data.get("limit")
                if isinstance(maybe_limit, int) and maybe_limit > 0:
                    limit = maybe_limit
            except Exception:
                pass

        self.send_response(200)
        self.end_headers()
        try:
            import process_job

            stdout, stderr = process_job.run(limit=limit)
            summary = process_job.describe_success(stdout)
            response_lines = [f"process_job.run(limit={limit}) executed.", summary]
            if stderr.strip():
                response_lines.append("stderr:\n" + stderr.strip())
            self._write("\n".join(response_lines))
        except Exception:
            traceback.print_exc()
            self._write("error in process_job.run(); see logs")
