import os
import subprocess
from datetime import datetime
from typing import Dict, Optional, Tuple

PYTHON_BIN = os.getenv("PYTHON_BIN", "python3")
PROCESS_SCRIPT = os.path.join(os.getcwd(), "jiraPull", "process_conversations.py")


class MissingCredentialsError(RuntimeError):
    pass


def _required_env() -> Dict[str, str]:
    supabase_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    jira_base = os.getenv("JIRA_BASE_URL") or os.getenv("JIRA_BASEURL") or os.getenv("JIRA_URL")
    jira_user = os.getenv("JIRA_USERNAME") or os.getenv("JIRA_EMAIL")
    jira_token = os.getenv("JIRA_API_TOKEN") or os.getenv("JIRA_API_KEY") or os.getenv("JIRA_TOKEN")

    missing = []
    if not supabase_url:
        missing.append("SUPABASE_URL")
    if not supabase_key:
        missing.append("SUPABASE_SERVICE_ROLE_KEY")
    if not jira_base:
        missing.append("JIRA_BASE_URL")
    if not jira_user:
        missing.append("JIRA_USERNAME")
    if not jira_token:
        missing.append("JIRA_API_TOKEN/JIRA_API_KEY")

    if missing:
        raise MissingCredentialsError(f"Missing credentials: {', '.join(missing)}")

    return {
        "SUPABASE_URL": supabase_url,
        "SUPABASE_SERVICE_ROLE_KEY": supabase_key,
        "JIRA_BASE_URL": jira_base,
        "JIRA_USERNAME": jira_user,
        "JIRA_EMAIL": jira_user,
        "JIRA_API_TOKEN": jira_token,
        "JIRA_API_KEY": jira_token
    }


def run(limit: int = 50, model: Optional[str] = None) -> Tuple[str, str]:
    env = {**os.environ, **_required_env(), "PYTHONUNBUFFERED": "1"}
    args = [PYTHON_BIN, PROCESS_SCRIPT, "--limit", str(limit)]
    resolved_model = (model or os.getenv("PORT_CONVO_MODEL") or os.getenv("PORT_CONVO_DEFAULT_MODEL"))
    if resolved_model:
        args.extend(["--model", resolved_model])
    try:
        completed = subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        return stdout, stderr
    except subprocess.CalledProcessError as exc:  # pragma: no cover - runtime safety
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        raise RuntimeError(
            f"process_conversations exited with {exc.returncode}. stdout:\\n{stdout}\\n\\nstderr:\\n{stderr}"
        ) from exc


def describe_success(stdout: str) -> str:
    timestamp = datetime.utcnow().isoformat()
    summary = stdout.strip().splitlines()
    top_line = summary[0] if summary else "Process script finished."
    return f"[{timestamp}] {top_line}"
