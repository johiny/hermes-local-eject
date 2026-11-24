"""local-eject — agent half: eject models from the managed runtime and keep the engine alive.

Three jobs, all about the same 24 GB of VRAM:

- **Free it**: `dashboard/plugin_api.py` backs the status-bar chip (`/api/plugins/local-eject/`) and
  `vram_gc.py` is the CLI for the same reaping rules.
- **Keep the engine alive**: `runtime_boot.py` boots the llama.cpp router with the host and respawns
  it when the process that owned it dies. Without it the chip offered "Mount" over a `server.json`
  pointing at a dead PID.
- **Hand the GPU over**: `lifecycle_hooks.py` runs user-defined HTTP calls before a load and after a
  load/unload, so an image model (ComfyUI) can release VRAM before a video model takes it.
"""

from __future__ import annotations

import logging

from . import lifecycle_hooks, runtime_boot

PLUGIN_NAME = "local-eject"

logger = logging.getLogger("local_eject")

# Import-time: the host imports plugin modules when it boots, and the runtime should exist before
# the first turn needs it. `start_once` is idempotent, so register() does not duplicate the work.
runtime_boot.start_once()
lifecycle_hooks.start_watcher()


def register(ctx) -> None:  # noqa: ARG001 - the agent side registers no tools
    """No tools: the chip is a dashboard route and the background loops start at import."""
    runtime_boot.start_once()
    lifecycle_hooks.start_watcher()
    return None
