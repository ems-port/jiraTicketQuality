import json
from http.server import BaseHTTPRequestHandler
import traceback


class handler(BaseHTTPRequestHandler):
    def _respond(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(content_length) if content_length else b""
        prompt = None
        model = None
        if body:
            try:
                payload = json.loads(body.decode("utf-8"))
                prompt = payload.get("prompt")
                model = payload.get("model")
            except Exception:
                pass
        try:
            import gpt_probe_job

            stdout, stderr = gpt_probe_job.run(prompt=prompt, model=model)
            self._respond(200, {"ok": True, "stdout": stdout, "stderr": stderr})
        except Exception as exc:  # pragma: no cover - runtime
            traceback.print_exc()
            self._respond(500, {"ok": False, "error": str(exc)})

    def do_GET(self):
        self._respond(200, {"ok": True, "message": "POST to run GPT probe."})
