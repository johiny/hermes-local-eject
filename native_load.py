"""native_load — fire `before_load` when the NATIVE selector loads a local model.

The chip's `/mount` route fires the hooks itself. Every other way a managed model reaches the GPU
(the desktop model picker, `/model`, the CLI, cron, subagents) never touches this plugin's HTTP
surface: the router boots with `--models-autoload` (hermes_cli/local_runtime/supervisor.py), so a
model is pulled into VRAM by the first `/v1/chat/completions` that names it. Hermes has no call site
that "loads" it — the load is a side effect of the request — so there is nothing to wrap on the
load side.

What every turn does pass through first is the `pre_api_request` plugin hook
(agent/turn_api_request.py), fired immediately before the request leaves the agent. This module
hangs there: when the request targets the managed router and the model is not resident yet, it
fires the same user-defined `before_load` hooks, synchronously, so whatever else is holding VRAM
(ComfyUI) lets go before llama-server starts allocating.

Contract:

- **Fail-open, always.** Never raises into the turn; every failure is logged at DEBUG.
- **Bounded.** Fires with a 25 s budget, under the 30 s plugin hook-callback timeout, so a slow
  endpoint costs a longer first token, never an abandoned callback.
- **One shot per cold transition.** `pre_api_request` fires per physical attempt (retries, every
  tool-loop iteration, post-compression re-sends). A firing is remembered per model for
  `THROTTLE_S` and cleared as soon as the router reports the model resident.
- **Managed router only.** `provider` in `LOCAL_PROVIDERS`, or a loopback `base_url` on the managed
  router's port (server.json, else `local_runtime.port`). A different local engine (LM Studio and
  friends) is deliberately out of scope.
- **`after_load` / `after_unload` are untouched**: the residency watcher in `lifecycle_hooks.py`
  polls `/models`, so it observes native loads exactly like the chip's.

Disable with `HERMES_LOCAL_EJECT_NATIVE=0`.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import pathlib
import sys
import threading
import time
import urllib.parse
import urllib.request

logger = logging.getLogger("local_eject.native_load")

LOCAL_PROVIDERS = frozenset({"llamacpp", "llama.cpp", "llama-cpp", "local"})
RESIDENT = ("loaded", "ready")
DEFAULT_PORT = 18434

BUDGET_S = 25.0        # under the 30 s hook-callback timeout (plugins.hook_callback_timeout)
THROTTLE_S = 120.0     # a cold model that never becomes resident must not re-fire on every attempt
STATUS_TTL_S = 2.0     # /models cache: this runs on the request path

_lock = threading.Lock()
_fired: dict[str, float] = {}
_status_cache: tuple[float, dict[str, str] | None] = (0.0, None)
_stats: dict = {"fired": 0, "skipped": 0, "errors": 0, "last": None}
_state_dir = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "hermes"


# ── helpers ──────────────────────────────────────────────────
def _hooks():
    """`lifecycle_hooks` whether this file was imported as part of the package or by path."""
    try:
        from . import lifecycle_hooks  # type: ignore

        return lifecycle_hooks
    except ImportError:
        pass
    cached = sys.modules.get("local_eject_lifecycle_hooks")
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(
        "local_eject_lifecycle_hooks", pathlib.Path(__file__).with_name("lifecycle_hooks.py")
    )
    if spec is None or spec.loader is None:
        raise ImportError("lifecycle_hooks.py not found next to native_load.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def enabled() -> bool:
    return str(os.environ.get("HERMES_LOCAL_EJECT_NATIVE", "1")).strip().lower() not in ("0", "false", "no", "off")


def _state() -> dict | None:
    try:
        return json.loads((_state_dir / "runtimes" / "llamacpp" / "server.json").read_text(encoding="utf-8-sig"))
    except Exception:
        return None


def _router_endpoint() -> tuple[str, str] | None:
    """(base without /v1, api_key) of the managed router, from the state file it writes."""
    data = _state() or {}
    base = str(data.get("base_url") or "").rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return (base, str(data.get("api_key") or "")) if base else None


def _router_port() -> int:
    endpoint = _router_endpoint()
    if endpoint is not None:
        try:
            port = urllib.parse.urlsplit(endpoint[0]).port
            if port:
                return int(port)
        except ValueError:
            pass
    try:
        from hermes_cli.config import load_config  # type: ignore

        port = ((load_config() or {}).get("local_runtime") or {}).get("port")
        if port:
            return int(port)
    except Exception:
        pass
    return DEFAULT_PORT


def looks_local(provider: str, base_url: str) -> bool:
    """True when this request will be served by the managed llama.cpp router."""
    if (provider or "").strip().lower() in LOCAL_PROVIDERS:
        return True
    base = (base_url or "").strip()
    if not base:
        return False
    try:
        parsed = urllib.parse.urlsplit(base)
    except ValueError:
        return False
    if (parsed.hostname or "").lower() not in ("127.0.0.1", "localhost", "::1"):
        return False
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return False
    return port == _router_port()


def _statuses(force: bool = False) -> dict[str, str] | None:
    """{model_id: status} from the router, cached briefly. ``None`` when it cannot be read."""
    global _status_cache
    now = time.monotonic()
    with _lock:
        if not force and _status_cache[1] is not None and now - _status_cache[0] < STATUS_TTL_S:
            return _status_cache[1]
    endpoint = _router_endpoint()
    if endpoint is None:
        return None
    base, key = endpoint
    request = urllib.request.Request(f"{base}/models", headers={"Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=4) as response:
            catalog = json.loads(response.read().decode())
    except Exception:
        return None
    statuses = {
        str(m.get("id") or ""): str((m.get("status") or {}).get("value") or "unknown")
        for m in catalog.get("data", [])
        if m.get("id")
    }
    with _lock:
        _status_cache = (now, statuses)
    return statuses


def _bump(key: str) -> None:
    with _lock:
        _stats[key] = int(_stats.get(key) or 0) + 1


# ── the hook ─────────────────────────────────────────────────
def on_pre_api_request(**kwargs) -> None:
    """`pre_api_request` subscriber: free VRAM before the router autoloads a cold model."""
    try:
        if not enabled():
            return
        model = str(kwargs.get("model") or "").strip()
        if not model or not looks_local(str(kwargs.get("provider") or ""), str(kwargs.get("base_url") or "")):
            return
        statuses = _statuses()
        if statuses is None:
            return  # unreadable catalog: this request will not load anything either
        state = statuses.get(model)
        if state in RESIDENT:
            with _lock:
                _fired.pop(model, None)  # the transition completed: re-arm for the next cold load
            return
        if state == "loading":
            _bump("skipped")
            return  # already allocating: freeing VRAM now cannot help and can abort the load
        now = time.monotonic()
        with _lock:
            if now - _fired.get(model, 0.0) < THROTTLE_S:
                _stats["skipped"] = int(_stats.get("skipped") or 0) + 1
                return
            _fired[model] = now
        with _lock:
            _stats["fired"] = int(_stats.get("fired") or 0) + 1
        started = time.time()
        results = _hooks().run("before_load", model, budget=BUDGET_S)
        record = {
            "model": model,
            "provider": str(kwargs.get("provider") or ""),
            "at": time.time(),
            "ms": int((time.time() - started) * 1000),
            "results": results,
        }
        with _lock:
            _stats["last"] = record
            if any(r.get("error") and not r.get("ok") for r in results):
                _stats["errors"] = int(_stats.get("errors") or 0) + 1
        logger.info(
            "native_load: before_load for %s fired from the native selector (%s, %s ms)",
            model, [f"{r['hook']}={'ok' if r['ok'] else r.get('error')}" for r in results], record["ms"],
        )
    except Exception as exc:  # noqa: BLE001 - a hook must never break the turn
        _bump("errors")
        logger.debug("native_load: skipped (%s)", exc)


# ── observability (the settings page reads this) ─────────────
def status() -> dict:
    with _lock:
        fired = dict(_fired)
        snapshot = dict(_stats)
    return {
        "enabled": enabled(),
        "provider_gate": sorted(LOCAL_PROVIDERS),
        "router_port": _router_port(),
        "budget_seconds": BUDGET_S,
        "throttle_seconds": THROTTLE_S,
        "pending": {model: round(time.monotonic() - seen, 1) for model, seen in fired.items()},
        **snapshot,
    }
