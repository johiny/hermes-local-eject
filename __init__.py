"""local-eject — agent half: eject models from the managed runtime and keep the engine alive.

Two halves of the same job:

- **Unload / free**: `dashboard/plugin_api.py` (the status-bar chip calls
  `/api/plugins/local-eject/`), plus `vram_gc.py` as a CLI.
- **Boot / repair**: `runtime_boot.py` makes sure the llama.cpp router exists when the host starts
  and comes back when the process that spawned it dies. Without it the chip offered "Mount" over a
  `server.json` pointing at a dead PID.
"""

from __future__ import annotations

import logging

from . import runtime_boot

PLUGIN_NAME = "local-eject"

logger = logging.getLogger("local_eject")

# Import-time: the host imports plugin modules when it boots, and the runtime should exist before
# the first turn needs it. `start_once` is idempotent, so register() does not duplicate the work.
runtime_boot.start_once()


def register(ctx) -> None:  # noqa: ARG001 - the agent side registers no tools
    """No tools: the chip is a dashboard route and the boot runs in background threads."""
    runtime_boot.start_once()
    return None
