"""runtime_boot — boot and self-healing for the managed llama.cpp runtime.

Lives inside `local-eject` because it is the other half of the same job: that chip unloads models
and frees VRAM, this keeps the engine that serves them alive.

Background (measured on this machine, 2026-11-23): the native boot lives in
`web_server_app.app_lifespan`, and the gateway mounts that dashboard "on first use"
(`gateway/run_api.py`). It works, but the router is a **child of whichever process spawned it**: if
that process is short-lived (a desktop backend that restarts), the router dies with it and
`server.json` keeps pointing at a dead PID. The gateway, which had only *adopted* the server, never
revives it. Symptom: the chip reads "Mount" while `/mount` waits on a port nobody serves.

Strategy, entirely on the official plugin surface (plugin modules are imported when the host boots):

1. **Boot** (`ensure_local_runtime`): idempotent and adopting — it no-ops when a router is already up.
2. **Short-host guard**: a one-shot process must not spawn the router (it would drag it down on
   exit); it only adopts.
3. **Self-healing**: on long-lived hosts (gateway/dashboard/serve) a loop polls `/health` every
   30 s; when the router is gone it calls `ensure_local_runtime` again, which creates the supervisor
   in **that** host — so the owner becomes the process that actually lives.

Disable with `HERMES_NO_LOCAL_RUNTIME_BOOT=1`.
"""

from __future__ import annotations

import logging
import os
import pathlib
import sys
import threading
import time
import urllib.request

logger = logging.getLogger("local_eject.runtime_boot")

HEALTH_URL = "http://127.0.0.1:18434/health"
RECHECK_S = 30

booted = threading.Event()
_started = False
_start_lock = threading.Lock()


def _health_ok(timeout: float = 3.0) -> bool:
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def _long_lived_host() -> bool:
    """Only these hosts deserve the healing loop: in a one-shot CLI it dies with the process."""
    argv = " ".join(sys.argv[1:]).lower()
    return any(marker in argv for marker in ("gateway run", "dashboard", "serve", "web"))


def _config_enabled() -> dict | None:
    try:
        from hermes_cli.config import load_config

        config = load_config() or {}
        return config if (config.get("local_runtime") or {}).get("enabled") else None
    except Exception as exc:  # noqa: BLE001
        # The canonical loader may pull dependencies this host lacks (ruamel, for one). The runtime
        # must not depend on that: a plain YAML read is enough for a single boolean.
        logger.debug("runtime_boot: load_config failed (%s); reading plain YAML", exc)
    try:
        import yaml

        import os
        import pathlib

        home = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "config.yaml"
        config = yaml.safe_load(home.read_text(encoding="utf-8-sig")) or {}
        return config if (config.get("local_runtime") or {}).get("enabled") else None
    except Exception as exc:  # noqa: BLE001
        logger.debug("runtime_boot: yaml unavailable (%s); parsing the block by hand", exc)
    try:
        # Last resort with no dependencies: the `local_runtime:` block and its `enabled:` line.
        import os
        import pathlib
        import re

        home = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "config.yaml"
        text = home.read_text(encoding="utf-8-sig")
        block = re.search(r"^local_runtime:\s*$((?:\n[ \t]+[^\n]*)*)", text, re.M)
        if block is None:
            return None
        if re.search(r"^\s+enabled:\s*(true|yes|on)\s*$", block.group(1), re.M | re.I):
            return {"local_runtime": {"enabled": True}}
        return None
    except Exception as exc:  # noqa: BLE001
        logger.warning("runtime_boot: could not read the config: %s", exc)
        return None


def _boot() -> None:
    """Best-effort: it must never break the host's startup."""
    try:
        config = _config_enabled()
        if config is None:
            logger.debug("runtime_boot: local_runtime.enabled is false; nothing to boot")
            return
        if not _long_lived_host():
            # Spawning from a short-lived process leaves a doomed router and a lying server.json.
            if _health_ok():
                logger.info("runtime_boot: router already up; this host is short-lived, leaving it")
            else:
                logger.debug("runtime_boot: short-lived host with no router; waiting for the host that lives")
            return
        from hermes_cli.local_runtime.bootstrap import ensure_local_runtime

        supervisor = ensure_local_runtime(config)
        if supervisor is None:
            logger.info("runtime_boot: router already served by another process (adopted)")
        else:
            logger.info("runtime_boot: local runtime up at %s", getattr(supervisor, "base_url", "?"))
    except Exception as exc:  # noqa: BLE001 - the host keeps working without the local runtime
        logger.warning("runtime_boot: could not start the local runtime: %s", exc)
    finally:
        booted.set()


def _heal_loop() -> None:
    """When the router we adopted died with its owner, spawn it here and become the owner."""
    misses = 0
    while True:
        time.sleep(RECHECK_S)
        if _health_ok():
            misses = 0
            continue
        misses += 1
        if misses < 2:  # a single miss can be the supervisor's own internal restart
            continue
        misses = 0
        try:
            config = _config_enabled()
            if config is None:
                return  # the runtime was disabled: nothing to look after
            from hermes_cli.local_runtime.bootstrap import ensure_local_runtime

            logger.warning("runtime_boot: router is not answering; spawning it from this host")
            supervisor = ensure_local_runtime(config, force=True)
            logger.info("runtime_boot: recovered (%s)", getattr(supervisor, "base_url", "no supervisor"))
        except Exception as exc:  # noqa: BLE001
            logger.warning("runtime_boot: recovery failed: %s", exc)


def start_once() -> None:
    """Start the boot/heal threads once per process. Never raises."""
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    if os.environ.get("HERMES_NO_LOCAL_RUNTIME_BOOT") == "1":
        logger.info("runtime_boot: disabled by HERMES_NO_LOCAL_RUNTIME_BOOT")
        return
    try:
        threading.Thread(target=_boot, name="local-runtime-boot", daemon=True).start()
        if _long_lived_host():
            threading.Thread(target=_heal_loop, name="local-runtime-heal", daemon=True).start()
    except Exception as exc:  # noqa: BLE001
        logger.warning("runtime_boot: could not start the threads: %s", exc)
