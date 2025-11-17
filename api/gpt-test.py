import json
from http.server import BaseHTTPRequestHandler
import traceback
import sys
import os


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
        print("[gpt-test] Raw body:", body, file=sys.stderr, flush=True)
        if body:
            try:
                payload = json.loads(body.decode("utf-8"))
                prompt = payload.get("prompt")
                model = payload.get("model")
                print(
                    f"[gpt-test] Parsed payload prompt={prompt!r}, model={model!r}",
                    file=sys.stderr,
                    flush=True,
                )
            except Exception:
                pass
        try:
            import gpt_probe_job
            print(
                f"[gpt-test] About to call gpt_probe_job.run with model={model!r}, prompt={prompt!r}",
                file=sys.stderr,
                flush=True,
            )
            print("[gpt-test] ENV OPENAI_API_KEY set:", "OPENAI_API_KEY" in os.environ, file=sys.stderr, flush=True)
            stdout, stderr = gpt_probe_job.run(prompt=prompt, model=model)
            self._respond(200, {"ok": True, "stdout": stdout, "stderr": stderr})
        except Exception as exc:  # pragma: no cover - runtime
            tb = traceback.format_exc()
            print("[gpt-test] Exception during gpt_probe_job.run:\n" + tb, file=sys.stderr, flush=True)
            self._respond(500, {"ok": False, "error": str(exc), "traceback": tb})

    def do_GET(self):
        self._respond(200, {"ok": True, "message": "POST to run GPT probe."})
