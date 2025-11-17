import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler


SAFE_ENV_VARS = [
    "PORT_CONVO_MODEL",
    "VERCEL",
    "VERCEL_ENV",
    "VERCEL_REGION",
    "PYTHON_VERSION",
    "PYTHONPATH",
]


def collect_openai_info() -> dict:
    info: dict = {"loaded": False}
    try:
        import openai  # type: ignore

        info["loaded"] = True
        info["module"] = getattr(openai, "__name__", "openai")
        info["version"] = getattr(openai, "__version__", "unknown")
        info["has_OpenAI_class"] = hasattr(openai, "OpenAI")
        info["has_client_attr"] = hasattr(openai, "Client")
        info["has_chat_completion"] = hasattr(getattr(openai, "ChatCompletion", None), "create")
        info["has_responses_attr"] = hasattr(openai, "Responses")
        info["has_beta_responses"] = hasattr(getattr(openai, "beta", None), "responses")
        try:
            from openai import OpenAI  # type: ignore

            client = OpenAI()
            info["client_object"] = {
                "has_responses": hasattr(client, "responses"),
                "has_chat": hasattr(client, "chat"),
                "has_chat_completions": hasattr(getattr(client, "chat", None), "completions"),
            }
        except Exception as exc:  # pragma: no cover - diagnostics only
            info["client_import_error"] = str(exc)
    except Exception as exc:  # pragma: no cover - diagnostics only
        info["import_error"] = str(exc)
    return info


def collect_python_info() -> dict:
    info = {
        "version": sys.version,
        "executable": sys.executable,
        "platform": sys.platform,
    }
    return info


def collect_pip_freeze() -> list[str]:
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "freeze"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return lines[:50]
    except Exception:
        return []


class handler(BaseHTTPRequestHandler):  # pragma: no cover - Vercel runtime adapter
    def _respond(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        env_snapshot = {name: os.getenv(name) for name in SAFE_ENV_VARS if os.getenv(name) is not None}
        payload = {
            "python": collect_python_info(),
            "openai": collect_openai_info(),
            "env": env_snapshot,
            "pip_freeze_head": collect_pip_freeze(),
        }
        self._respond(200, payload)

    def do_POST(self):
        self.do_GET()
