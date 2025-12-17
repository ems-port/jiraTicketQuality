#!/usr/bin/env python3
"""
Helper entrypoint to generate and persist LLM improvement groupings.

This is a thin wrapper around analysis/improvement_tip_summary_v2.py so
it can be invoked from cron, CLI, or other scripts without duplicating
logic. Supabase/LLM credentials must be available in the environment:
  - SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)
  - OPENAI_API_KEY
"""

from __future__ import annotations

import sys
from typing import Sequence

from analysis import improvement_tip_summary_v2


def run(args: Sequence[str] | None = None) -> int:
    """
    Execute the grouper. Arguments are forwarded to the v2 script.

    Example:
      run(["--max-tokens", "4000"])
    """
    return improvement_tip_summary_v2.main(args)


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
