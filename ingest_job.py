import os
import subprocess
from datetime import datetime
from typing import Tuple, Dict

PYTHON_BIN = os.getenv("PYTHON_BIN", "python3")
INGEST_SCRIPT = os.path.join(os.getcwd(), "jiraPull", "injestionJiraTickes.py")


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


def run() -> Tuple[str, str]:
    env = {
        **os.environ,
        **_required_env(),
        "PYTHONUNBUFFERED": "1"
    }
    completed = subprocess.run(
        [PYTHON_BIN, INGEST_SCRIPT],
        check=True,
        capture_output=True,
        text=True,
        env=env
    )
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    return stdout, stderr


def describe_success(stdout: str) -> str:
    timestamp = datetime.utcnow().isoformat()
    summary = stdout.strip().splitlines()
    top_line = summary[0] if summary else "Ingestion script finished."
    return f"[{timestamp}] {top_line}"
