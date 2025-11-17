import os
import subprocess
from typing import Tuple

PYTHON_BIN = os.getenv("PYTHON_BIN", "python3")
PROBE_SCRIPT = os.path.join(os.getcwd(), "jiraPull", "gpt_probe.py")


def run(prompt: str | None = None, model: str | None = None) -> Tuple[str, str]:
    env = dict(os.environ)
    args = [PYTHON_BIN, PROBE_SCRIPT]
    if model:
        args.extend(["--model", model])
    if prompt:
        args.extend(["--prompt", prompt])
    completed = subprocess.run(args, check=True, capture_output=True, text=True, env=env)
    return completed.stdout or "", completed.stderr or ""
