"""lifecycle_hooks — run user-defined HTTP calls around model load/unload.

24 GB of VRAM cannot hold an image model and a video model at once, so whoever wants the GPU has to
tell the other side to let go. This module is that switchboard: before the router loads a model it
can call something else's "free your VRAM" endpoint (ComfyUI's `POST /free` is the built-in default),
and after a model becomes resident or stops being resident it can call more endpoints.

Nothing here is hard-coded to ComfyUI: every call comes from a user file.

Config resolution order:

1. `$HERMES_LOCAL_EJECT_HOOKS` (absolute path to a JSON or YAML file)
2. `%LOCALAPPDATA%/hermes/local-eject/hooks.json` (created with the default example on first use)
3. the built-in defaults below

JSON is the primary format because the host interpreter is not guaranteed to have PyYAML (the
desktop ships one that does not). A YAML file is accepted when `yaml` happens to be importable.

Schema:

```json
{
  "version": 1,
  "poll_seconds": 5,
  "events": {
    "before_load":  [ {hook}, ... ],
    "after_load":   [ {hook}, ... ],
    "after_unload": [ {hook}, ... ]
  }
}
```

One hook:

```json
{
  "name": "free-comfyui",
  "enabled": true,
  "method": "POST",
  "url": "http://127.0.0.1:8188/free",
  "json": {"unload_models": true, "free_memory": true},
  "headers": {"Content-Type": "application/json"},
  "timeout": 10,
  "expect": [200, 204]
}
```

`enabled` defaults to true, `method` to POST, `timeout` to 10 s, `expect` to any 2xx. A hook that
fails is logged; it never raises into the load path and never blocks a load longer than its timeout
(the caller treats hooks as best-effort announcements).
"""

from __future__ import annotations

import json
import logging
import os
import pathlib
import threading
import time
import urllib.error
import urllib.request

logger = logging.getLogger("local_eject.hooks")

EVENTS = ("before_load", "after_load", "after_unload")

DEFAULT_CONFIG: dict = {
    "version": 1,
    "poll_seconds": 5,
    "events": {
        "before_load": [
            {
                "name": "free-comfyui-vram",
                "enabled": True,
                "method": "POST",
                "url": "http://127.0.0.1:8188/free",
                "json": {"unload_models": True, "free_memory": True},
                "timeout": 10,
                "expect": [200, 204],
            }
        ],
        "after_load": [],
        "after_unload": [],
    },
}

_state_dir = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "local-eject"
_config_lock = threading.Lock()
_config_cache: tuple[float, pathlib.Path | None, dict] = (0.0, None, DEFAULT_CONFIG)
_results: list[dict] = []          # newest last, capped
_results_lock = threading.Lock()
_watch_started = False
_watch_lock = threading.Lock()


# ── config ───────────────────────────────────────────────────
def config_path() -> pathlib.Path:
    override = os.environ.get("HERMES_LOCAL_EJECT_HOOKS")
    if override:
        return pathlib.Path(override)
    return _state_dir / "hooks.json"


def _parse(text: str, path: pathlib.Path) -> dict:
    """JSON first (stdlib everywhere); YAML only when the host happens to have it."""
    if path.suffix.lower() in (".yaml", ".yml"):
        try:
            import yaml  # type: ignore

            return yaml.safe_load(text) or {}
        except Exception as exc:  # noqa: BLE001
            logger.warning("hooks: %s needs PyYAML (%s); using defaults", path.name, exc)
            return {}
    try:
        return json.loads(text or "{}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("hooks: %s is not valid JSON (%s); using defaults", path.name, exc)
        return {}


def _normalise(raw: dict) -> dict:
    """Accept both `{"events": {...}}` and a bare `{"before_load": [...]}`."""
    events = raw.get("events") if isinstance(raw.get("events"), dict) else raw
    cleaned: dict[str, list[dict]] = {}
    for event in EVENTS:
        hooks = []
        for hook in events.get(event) or []:
            if not isinstance(hook, dict):
                continue
            url = str(hook.get("url") or "").strip()
            if not url:
                continue
            hooks.append(
                {
                    "name": str(hook.get("name") or url),
                    "enabled": bool(hook.get("enabled", True)),
                    "method": str(hook.get("method") or "POST").upper(),
                    "url": url,
                    "json": hook.get("json"),
                    "headers": hook.get("headers") if isinstance(hook.get("headers"), dict) else {},
                    "timeout": float(hook.get("timeout") or 10),
                    "expect": list(hook.get("expect") or []),
                }
            )
        cleaned[event] = hooks
    return {
        "version": raw.get("version", 1),
        "poll_seconds": float(raw.get("poll_seconds") or 5),
        "events": cleaned,
    }


def load(force: bool = False) -> dict:
    """Read the config, re-reading it when the file changes (edit + save, no restart)."""
    global _config_cache
    path = config_path()
    with _config_lock:
        try:
            mtime = path.stat().st_mtime if path.exists() else 0.0
        except OSError:
            mtime = 0.0
        if not force and _config_cache[1] == path and _config_cache[0] == mtime:
            return _config_cache[2]
        if not path.exists():
            if path == _state_dir / "hooks.json":
                try:
                    _state_dir.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps(DEFAULT_CONFIG, indent=2) + "\n", encoding="utf-8")
                    mtime = path.stat().st_mtime
                    logger.info("hooks: wrote the default config at %s", path)
                except OSError as exc:  # noqa: BLE001
                    logger.debug("hooks: could not write %s (%s); keeping defaults in memory", path, exc)
            config = _normalise(DEFAULT_CONFIG)
        else:
            config = _normalise(_parse(path.read_text(encoding="utf-8-sig"), path))
            if not any(config["events"].values()):
                logger.debug("hooks: %s defines no hooks", path)
        _config_cache = (mtime, path, config)
        return config


# ── execution ────────────────────────────────────────────────
def _fire(hook: dict, model: str | None) -> dict:
    payload = hook.get("json")
    if isinstance(payload, dict) and model:
        # `{model}` in any string value is replaced with the model id being loaded/unloaded.
        payload = {k: (v.replace("{model}", model) if isinstance(v, str) else v) for k, v in payload.items()}
    data = json.dumps(payload).encode() if payload else None
    headers = {"Content-Type": "application/json", **(hook.get("headers") or {})}
    request = urllib.request.Request(hook["url"], data=data, method=hook["method"], headers=headers)
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=hook["timeout"]) as response:
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    except Exception as exc:  # noqa: BLE001 - a closed ComfyUI is the normal case, not an error
        return {
            "hook": hook["name"],
            "event": None,
            "ok": False,
            "status": None,
            "ms": int((time.time() - started) * 1000),
            "error": f"{type(exc).__name__}: {exc}"[:200],
        }
    expected = hook["expect"] or []
    ok = (status in expected) if expected else 200 <= status < 300
    return {
        "hook": hook["name"],
        "event": None,
        "ok": ok,
        "status": status,
        "ms": int((time.time() - started) * 1000),
        "error": None if ok else f"unexpected status {status}",
    }


def run(event: str, model: str | None = None) -> list[dict]:
    """Fire every enabled hook of an event. Never raises."""
    if event not in EVENTS:
        return []
    try:
        hooks = load()["events"].get(event) or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("hooks: could not load the config (%s)", exc)
        return []
    results = []
    for hook in hooks:
        if not hook["enabled"]:
            continue
        result = _fire(hook, model)
        result["event"] = event
        if result["ok"]:
            logger.info(
                "hooks: %s/%s ok (status %s, %s ms)",
                event, result["hook"], result["status"], result["ms"],
            )
        else:
            logger.info(
                "hooks: %s/%s no-op (%s)", event, result["hook"], result["error"],
            )
        results.append(result)
    if results:
        with _results_lock:
            _results.extend(results)
            del _results[:-50]
    return results


def last_results(limit: int = 20) -> list[dict]:
    with _results_lock:
        return _results[-limit:]


def status() -> dict:
    config = load()
    path = config_path()
    return {
        "path": str(path),
        "exists": path.exists(),
        "poll_seconds": config["poll_seconds"],
        "events": {event: [h["name"] for h in hooks] for event, hooks in config["events"].items()},
        "recent": last_results(10),
    }


# ── editing (the settings page writes through here) ──────────
_FIELDS = ("name", "enabled", "method", "url", "json", "headers", "timeout", "expect")
_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")


def raw_config() -> dict:
    """The editable tree: hooks exactly as stored, for a settings page to render."""
    config = load(force=True)
    return {
        "path": str(config_path()),
        "version": config["version"],
        "poll_seconds": config["poll_seconds"],
        "events": {
            event: [{key: hook[key] for key in _FIELDS if key in hook} for hook in config["events"][event]]
            for event in EVENTS
        },
    }


def save_config(events: dict, poll_seconds: float | None = None) -> dict:
    """Validate and persist. Raises ValueError with a readable message on bad input.

    Written to a temp file and `replace`d, so a crash mid-write cannot leave the plugin without a
    config; the previous file is kept as `hooks.json.bak`.
    """
    if not isinstance(events, dict):
        raise ValueError("events must be an object")
    unknown = set(events) - set(EVENTS)
    if unknown:
        raise ValueError(f"unknown event(s): {', '.join(sorted(unknown))}")
    cleaned: dict[str, list[dict]] = {}
    for event in EVENTS:
        hooks_in = events.get(event) or []
        if not isinstance(hooks_in, list):
            raise ValueError(f"{event} must be a list")
        hooks_out = []
        for index, hook in enumerate(hooks_in):
            if not isinstance(hook, dict):
                raise ValueError(f"{event}[{index}] must be an object")
            url = str(hook.get("url") or "").strip()
            if not url.lower().startswith(("http://", "https://")):
                raise ValueError(f"{event}[{index}].url must start with http:// or https://")
            method = str(hook.get("method") or "POST").upper()
            if method not in _METHODS:
                raise ValueError(f"{event}[{index}].method must be one of {', '.join(_METHODS)}")
            body = hook.get("json")
            if body is not None and not isinstance(body, (dict, list)):
                raise ValueError(f"{event}[{index}].json must be an object or null")
            try:
                timeout = float(hook.get("timeout") or 10)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"{event}[{index}].timeout must be a number") from exc
            if not 0.5 <= timeout <= 300:
                raise ValueError(f"{event}[{index}].timeout must be between 0.5 and 300 seconds")
            expect = hook.get("expect") or []
            if not isinstance(expect, list) or any(not isinstance(code, int) for code in expect):
                raise ValueError(f"{event}[{index}].expect must be a list of status codes")
            headers = hook.get("headers") or {}
            if not isinstance(headers, dict):
                raise ValueError(f"{event}[{index}].headers must be an object")
            hooks_out.append(
                {
                    "name": str(hook.get("name") or url),
                    "enabled": bool(hook.get("enabled", True)),
                    "method": method,
                    "url": url,
                    "json": body,
                    "headers": headers,
                    "timeout": timeout,
                    "expect": expect,
                }
            )
        cleaned[event] = hooks_out

    document = {
        "version": 1,
        "poll_seconds": float(poll_seconds or load()["poll_seconds"] or 5),
        "events": cleaned,
    }
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if path.exists():
        try:
            path.replace(path.with_suffix(path.suffix + ".bak"))
        except OSError:
            pass
    tmp.replace(path)
    load(force=True)
    logger.info("hooks: saved %s (%s)", path, {event: len(hooks) for event, hooks in cleaned.items()})
    return raw_config()


# ── residency watcher (fires after_load / after_unload) ──────
def _router_endpoint() -> tuple[str, str] | None:
    state = pathlib.Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "runtimes" / "llamacpp" / "server.json"
    try:
        data = json.loads(state.read_text(encoding="utf-8-sig"))
    except Exception:
        return None
    base = str(data.get("base_url") or "").rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return (base, str(data.get("api_key") or "")) if base else None


def _resident_models() -> set[str] | None:
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
    return {
        m["id"]
        for m in catalog.get("data", [])
        if str((m.get("status") or {}).get("value") or "") in ("loaded", "ready")
    }


def _watch() -> None:
    known: set[str] = set()
    first = True
    while True:
        try:
            config = load()
            poll = max(2.0, float(config["poll_seconds"]))
            current = _resident_models()
            if current is not None:
                if first:
                    known = set(current)  # adopt whatever was already loaded; do not announce it
                    first = False
                for model in sorted(current - known):
                    run("after_load", model)
                for model in sorted(known - current):
                    run("after_unload", model)
                known = current
        except Exception as exc:  # noqa: BLE001 - the loop must never die
            logger.debug("hooks: watcher error (%s)", exc)
            poll = 5.0
        time.sleep(poll)


def start_watcher() -> None:
    """Start the residency watcher once per process. Never raises."""
    global _watch_started
    with _watch_lock:
        if _watch_started:
            return
        _watch_started = True
    try:
        threading.Thread(target=_watch, name="local-eject-hooks", daemon=True).start()
        logger.debug("hooks: watcher started (config %s)", config_path())
    except Exception as exc:  # noqa: BLE001
        logger.warning("hooks: could not start the watcher (%s)", exc)
