import json
import traceback
import sys
import os
from http.server import BaseHTTPRequestHandler

try:  # Python 3.8 compatibility on Vercel
    from importlib import metadata as importlib_metadata
except ImportError:  # pragma: no cover - fallback for older runtimes
    import importlib_metadata  # type: ignore


def log_runtime_state() -> None:
    """Emit diagnostics about the Python/OpenAI runtime for Vercel logs."""
    prefix = "[gpt-test]"
    print(f"{prefix} Python executable: {sys.executable}", file=sys.stderr, flush=True)
    print(f"{prefix} Python version: {sys.version}", file=sys.stderr, flush=True)
    try:
        import openai  # type: ignore

        module_version = getattr(openai, "__version__", "unknown")
        module_path = getattr(openai, "__file__", "unknown")
        try:
            installed_version = importlib_metadata.version("openai")
        except Exception:
            installed_version = "unknown"
        print(
            f"{prefix} openai import OK -> __version__={module_version}, dist-info version={installed_version}, path={module_path}",
            file=sys.stderr,
            flush=True,
        )
    except Exception as exc:
        print(f"{prefix} openai import FAILED: {exc}", file=sys.stderr, flush=True)


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
        log_runtime_state()
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
