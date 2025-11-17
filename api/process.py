import json
import os
from http.server import BaseHTTPRequestHandler
import traceback


class handler(BaseHTTPRequestHandler):
    def _respond_json(self, status_code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._respond_json(
            200,
            {"ok": True, "message": "Process endpoint ready. POST with optional JSON body {\"limit\": n}."},
        )

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", "0") or 0)
        body_bytes = self.rfile.read(content_length) if content_length else b""
        limit = 50
        model: str | None = None
        if body_bytes:
            try:
                data = json.loads(body_bytes.decode("utf-8"))
                maybe_limit = data.get("limit")
                if isinstance(maybe_limit, int) and maybe_limit > 0:
                    limit = maybe_limit
                maybe_model = data.get("model")
                if isinstance(maybe_model, str) and maybe_model.strip():
                    model = maybe_model.strip()
            except Exception:
                pass

        try:
            import process_job

            stdout, stderr = process_job.run(limit=limit, model=model)
            summary = process_job.describe_success(stdout)
            self._respond_json(
                200,
                {
                    "ok": True,
                    "summary": summary,
                    "limit": limit,
                    "model": model or os.getenv("PORT_CONVO_MODEL") or os.getenv("PORT_CONVO_DEFAULT_MODEL"),
                    "stdout": stdout,
                    "stderr": stderr,
                },
            )
        except Exception:
            traceback.print_exc()
            self._respond_json(500, {"ok": False, "error": "error in process_job.run(); see logs"})
