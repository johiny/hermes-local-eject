"""local-eject — backend half.

Ejects the model the managed llama.cpp runtime is holding and, when needed, turns the whole engine
off. It runs inside the gateway process, so it reuses the supervisor Settings → Local models uses
(no invented ports or api-keys).

Routes (mounted at /api/plugins/local-eject/):
  GET  /state      -> {server, models, resident, vram}
  POST /mount      -> {ok, mounted}; fires the `before_load` lifecycle hooks first
  POST /eject      -> {ok, ejected, vram_before_mb, vram_after_mb}
  POST /stop       -> {ok}
  GET  /hooks      -> configured lifecycle hooks and their most recent results
  POST /hooks/run  -> {ok, results}; fire one event on demand (body: {event, model?})
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter

logger = logging.getLogger(__name__)

router = APIRouter()


def _hooks():
    """Import `lifecycle_hooks.py` from the plugin root by path, cached.

    The dashboard mounts this module under a name of its own choosing and `local-eject` is not a
    valid Python identifier, so a relative import is not guaranteed here.
    """
    cached = sys.modules.get("local_eject_lifecycle_hooks")
    if cached is not None:
        return cached
    import importlib.util

    root = Path(__file__).resolve().parent.parent
    spec = importlib.util.spec_from_file_location("local_eject_lifecycle_hooks", root / "lifecycle_hooks.py")
    if spec is None or spec.loader is None:
        raise ImportError("lifecycle_hooks.py not found next to the plugin")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

_RESIDENT = ("loaded", "ready")
_VRAM_TTL_S = 3.0
_vram_lock = threading.Lock()
_vram_cache: tuple[float, dict[str, int] | None] = (0.0, None)

# Files that live next to chat models but are not chat models.
_NOT_A_MODEL = ("mmproj", "encoder", "clip", "vision", "embed")
_SCAN_TTL_S = 15.0
_scan_lock = threading.Lock()
_scan_cache: tuple[float, dict[str, Any] | None] = (0.0, None)


# ── runtime plumbing ─────────────────────────────────────────


def _supervisor():
    """The managed runtime owned by THIS process, or None (another process owns it)."""
    try:
        from hermes_cli.local_runtime import bootstrap

        return bootstrap.get_supervisor()
    except Exception:  # pragma: no cover - the gateway always has it
        logger.debug("local-eject: no bootstrap module", exc_info=True)
        return None


def _state() -> dict[str, Any] | None:
    """server.json written by whichever process owns the router."""
    try:
        from hermes_cli.local_runtime.supervisor import state_path

        path = state_path()
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _router_base() -> str:
    """The router root, without the OpenAI-compatible `/v1` suffix.

    `server.json` publishes `base_url` for chat clients (`http://host:port/v1`);
    the router's own management routes (`/models/load`, `/models/unload`) live at
    the root, so appending them to `base_url` as-is 404s.
    """
    base = _alive_base()
    if base:
        return base
    state = _state() or {}
    raw = str(state.get("base_url") or "").rstrip("/")
    if not raw:
        raise RuntimeError("local llama.cpp server is not running")
    return raw[: -len("/v1")] if raw.endswith("/v1") else raw


def _candidate_bases() -> list[str]:
    """Every root URL the router could be on, best guess first.

    `server.json` is written by whichever process owns the router, and a spawn that dies
    leaves an ephemeral port and `"port": null` behind — the file then points at nothing
    while a perfectly healthy router answers on `local_runtime.port`. The chip showed
    "Mount" over an already-loaded model because of exactly that, so probe the configured
    port too instead of trusting the file alone.
    """
    out: list[str] = []

    def add(value: object) -> None:
        text = str(value or "").strip().rstrip("/")
        if text.endswith("/v1"):
            text = text[: -len("/v1")]
        if text and text not in out:
            out.append(text)

    add((_state() or {}).get("base_url"))
    try:
        from hermes_cli.config import load_config

        section = (load_config() or {}).get("local_runtime") or {}
        port = section.get("port") or 0
        if isinstance(port, int) and port > 0:
            add(f"http://127.0.0.1:{port}")
        for extra in section.get("detect_ports") or []:
            add(f"http://127.0.0.1:{extra}")
    except Exception:
        logger.debug("local-eject: no local_runtime config", exc_info=True)
    add("http://127.0.0.1:8080")
    add("http://127.0.0.1:18434")
    return out


_ALIVE_TTL_S = 4.0
_alive_lock = threading.Lock()
_alive_cache: tuple[float, str | None] = (0.0, None)


def _alive_base() -> str | None:
    """First candidate whose `/health` answers, cached for a few seconds."""
    global _alive_cache

    with _alive_lock:
        stamp, value = _alive_cache
        if value and time.time() - stamp < _ALIVE_TTL_S:
            return value
        for base in _candidate_bases():
            try:
                with urllib.request.urlopen(base + "/health", timeout=3) as response:
                    if response.status == 200:
                        _alive_cache = (time.time(), base)
                        return base
            except Exception:
                continue
        _alive_cache = (time.time(), None)
        return None


def _router_call(path: str, payload: dict | None = None, timeout: float = 60) -> Any:
    state = _state() or {}
    url = _router_base() + path
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST" if body is not None else "GET")
    request.add_header("Authorization", f"Bearer {state.get('api_key', '')}")
    if body is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw.strip() else {}


def _router_models() -> dict[str, str]:
    raw = _router_call("/models", timeout=15)
    models: dict[str, str] = {}
    for entry in raw.get("data") or []:
        status = entry.get("status")
        value = status.get("value") if isinstance(status, dict) else status
        if entry.get("id"):
            models[str(entry["id"])] = str(value or "unknown")
    return models


def _models() -> dict[str, str] | None:
    """Every model the router knows about, or None when it does not answer at all.

    None is the honest "engine is not serving" signal: the chip hides instead of
    claiming the rig is free because a stale state file exists.
    """
    supervisor = _supervisor()
    if supervisor is not None:
        try:
            models = dict(supervisor.models(timeout_s=5))
            # A supervisor adopted from a stale `server.json` answers `{}` while a live router
            # serves the models on the configured port — never let that empty view win.
            if models:
                return models
        except Exception:
            logger.debug("local-eject: supervisor.models() failed", exc_info=True)
    try:
        return _router_models()
    except Exception:
        return None


def _presets_path() -> Path:
    """`presets.ini` next to `server.json` — the router's own model list."""
    try:
        from hermes_cli.local_runtime.supervisor import state_path

        return state_path().parent / "presets.ini"
    except Exception:
        return Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "runtimes" / "llamacpp" / "presets.ini"


def _presets() -> dict[str, dict[str, str]]:
    """`{model_id: {path, ctx}}` from the router presets, empty when unreadable."""
    import configparser

    path = _presets_path()
    if not path.is_file():
        return {}
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(path, encoding="utf-8")
    except Exception:
        logger.debug("local-eject: presets.ini unreadable", exc_info=True)
        return {}
    presets: dict[str, dict[str, str]] = {}
    for section in parser.sections():
        presets[section] = {
            "path": (parser.get(section, "model", fallback="") or "").strip(),
            "ctx": (parser.get(section, "ctx-size", fallback="") or "").strip(),
        }
    return presets


def _model_dirs() -> list[Path]:
    """Folders worth scanning: wherever the presets point, plus `hermes/models`."""
    candidates = [Path(meta["path"]).parent for meta in _presets().values() if meta["path"]]
    candidates.append(Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "models")
    seen: set[str] = set()
    out: list[Path] = []
    for folder in candidates:
        key = str(folder).lower()
        if key in seen or not folder.is_dir():
            continue
        seen.add(key)
        out.append(folder)
    return out


def _disk_models() -> list[dict[str, Any]]:
    """Chat GGUFs on disk (mmproj/encoders/embeddings filtered out)."""
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for folder in _model_dirs():
        try:
            files = sorted(folder.glob("*.gguf"))
        except OSError:
            continue
        for file in files:
            name = file.name.lower()
            if any(skip in name for skip in _NOT_A_MODEL):
                continue
            key = str(file).lower()
            if key in seen:
                continue
            seen.add(key)
            try:
                size = file.stat().st_size
            except OSError:
                continue
            rows.append({"id": file.stem, "path": str(file), "size_mb": round(size / 1048576)})
    return sorted(rows, key=lambda row: row["id"].lower())


def discover(force: bool = False) -> dict[str, Any]:
    """Re-read presets + disk so deleted or newly copied models show up.

    The UI polls this through /state with a short TTL; the Refresh button calls it with
    force=True. A preset whose file no longer exists stays listed (the router still
    advertises it) but is reported as `exists: false` so the menu can grey it out.
    """
    global _scan_cache

    with _scan_lock:
        cached_ts, cached = _scan_cache
        if not force and cached is not None and time.time() - cached_ts < _SCAN_TTL_S:
            return cached

        presets = _presets()
        on_disk = {row["id"].lower(): row for row in _disk_models()}
        entries: list[dict[str, Any]] = []

        for model_id, meta in presets.items():
            path = Path(meta["path"]) if meta["path"] else None
            exists = bool(path and path.is_file())
            size_mb = 0
            if exists:
                try:
                    size_mb = round(path.stat().st_size / 1048576)
                except OSError:
                    exists = False
            entries.append(
                {
                    "ctx": meta.get("ctx") or "",
                    "exists": exists,
                    "id": model_id,
                    "path": meta["path"],
                    "size_mb": size_mb,
                    "staged": True,
                }
            )
            on_disk.pop(model_id.lower(), None)

        for row in on_disk.values():
            entries.append({**row, "ctx": "", "exists": True, "staged": False})

        payload = {
            "count": len(entries),
            "dirs": [str(folder) for folder in _model_dirs()],
            "entries": entries,
            "missing": [row["id"] for row in entries if not row["exists"]],
            "scanned_at": time.strftime("%H:%M:%S"),
            "unstaged": [row["id"] for row in entries if not row["staged"]],
        }
        _scan_cache = (time.time(), payload)
        return payload


def _vram() -> dict[str, int] | None:
    """GPU memory used/total via nvidia-smi (cached: the chip polls this)."""
    global _vram_cache
    now = time.monotonic()
    with _vram_lock:
        stamp, cached = _vram_cache
        if cached is not None and now - stamp < _VRAM_TTL_S:
            return cached
    exe = shutil.which("nvidia-smi")
    result: dict[str, int] | None = None
    if exe:
        try:
            out = subprocess.run(  # noqa: S603 - fixed argv, no shell
                [exe, "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if out.returncode == 0 and out.stdout.strip():
                used, total = out.stdout.strip().splitlines()[0].split(",")[:2]
                result = {"used_mb": int(float(used)), "total_mb": int(float(total))}
        except Exception:
            logger.debug("local-eject: nvidia-smi probe failed", exc_info=True)
    with _vram_lock:
        _vram_cache = (now, result)
    return result


# ── zombie GC ────────────────────────────────────────────────
#
# Rules (deliberately conservative — this kills processes):
#   * the router named by server.json and its children are NEVER touched;
#   * a process younger than _GC_GRACE_S seconds is left alone: it may still be booting;
#   * an orphaned llama-server (dead parent) is killed only when it is
#     - a vision sidecar (`--mmproj`) from a previous gateway, or
#     - a stalled router with no LISTENING port.
# An orphan that still listens and is not a sidecar (e.g. the :8020 turn-taking
# server) is reported but left alive: nobody can prove you are not using it.

_GC_GRACE_S = float(os.environ.get("LOCAL_EJECT_GC_GRACE_S", "120"))


def _port_of(cmdline: str) -> int | None:
    """The `--port N` a llama-server was started with, if any."""
    tokens = cmdline.split()
    for index, token in enumerate(tokens):
        if token == "--port" and index + 1 < len(tokens) and tokens[index + 1].isdigit():
            return int(tokens[index + 1])
        if token.startswith("--port=") and token.split("=", 1)[1].isdigit():
            return int(token.split("=", 1)[1])
    return None


def _bound(port: int | None) -> bool:
    """True when something is LISTENING on that port.

    Neither `netstat -ano` (reports pid 0 without elevation) nor
    `psutil.net_connections()` (empty for other processes on Windows) can map a
    port to a pid here, so probe the port the process itself declares.
    """
    if not port:
        return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            return True
    except OSError:
        return False


def _proc_rows() -> list[dict[str, Any]]:
    import psutil

    rows: list[dict[str, Any]] = []
    for proc in psutil.process_iter(["pid", "name", "ppid", "create_time", "cmdline"]):
        info = proc.info or {}
        if str(info.get("name") or "").lower() != "llama-server.exe":
            continue
        cmdline = " ".join(info.get("cmdline") or [])
        port = _port_of(cmdline)
        rows.append(
            {
                "pid": int(info["pid"]),
                "ppid": int(info.get("ppid") or 0),
                "age_s": round(time.time() - float(info.get("create_time") or time.time()), 1),
                "cmdline": cmdline,
                "port": port,
                "listening": _bound(port),
            }
        )
    return rows


def _gc_plan() -> dict[str, Any]:
    """Classify every llama-server as keep-or-zombie without touching anything."""
    import psutil

    state = _state() or {}
    router_pid = int(state.get("pid") or 0)
    protected: set[int] = set()
    if router_pid:
        protected.add(router_pid)
        try:
            protected.update(child.pid for child in psutil.Process(router_pid).children(recursive=True))
        except Exception:
            pass

    keep: list[dict[str, Any]] = []
    zombies: list[dict[str, Any]] = []
    for row in _proc_rows():
        pid = row["pid"]
        if pid in protected:
            keep.append({**row, "reason": "router" if pid == router_pid else "model"})
            continue
        if row["age_s"] < _GC_GRACE_S:
            keep.append({**row, "reason": "starting"})
            continue
        parent_alive = True
        try:
            psutil.Process(row["ppid"]) if row["ppid"] else None
        except Exception:
            parent_alive = False
        if parent_alive:
            keep.append({**row, "reason": "owned"})
            continue
        is_sidecar = "--mmproj" in row["cmdline"]
        if is_sidecar:
            zombies.append({**row, "reason": "orphan-sidecar"})
        elif not row["listening"]:
            zombies.append({**row, "reason": "orphan-no-endpoint"})
        else:
            keep.append({**row, "reason": "orphan-listening"})

    stale_router = bool(router_pid) and all(k["pid"] != router_pid for k in keep)
    return {
        "keep": keep,
        "zombies": zombies,
        "stale_router": stale_router,
        "router_pid": router_pid,
    }


def gc(dry_run: bool = True, include_sidecar: bool = True) -> dict[str, Any]:
    """Free VRAM: unload every resident model, stop the vision sidecar, kill zombie processes.

    The order matters: the sidecar and the models hold the VRAM, the orphans only hold it when
    nothing else does, and the reported delta is measured after all of it.
    """
    import psutil

    global _vram_cache

    before = _vram()
    plan = _gc_plan()
    models = _models() or {}
    resident = [mid for mid, status in models.items() if status in _RESIDENT]
    sidecar_pids = [
        row["pid"] for row in _proc_rows() if include_sidecar and "--mmproj" in row["cmdline"]
    ]

    result: dict[str, Any] = {
        "ok": True,
        "dry_run": dry_run,
        "router_pid": plan["router_pid"],
        "would_eject": resident,
        "would_stop": sidecar_pids,
        "candidates": plan["zombies"],
        "kept": plan["keep"],
        "stale_router": plan["stale_router"],
        "ejected": [],
        "stopped": [],
        "killed": [],
        "vram_before_mb": (before or {}).get("used_mb"),
        "vram_after_mb": (before or {}).get("used_mb"),
    }
    if dry_run:
        return result

    supervisor = _supervisor()

    # 1. the vision sidecar (a 4B + mmproj child of the gateway: ~3 GB that a render needs)
    for pid in sidecar_pids:
        try:
            proc = psutil.Process(pid)
            for child in proc.children(recursive=True):
                child.kill()
            proc.kill()
            proc.wait(timeout=8)
            result["stopped"].append(pid)
            logger.info("local-eject: gc stopped the vision sidecar (pid %s)", pid)
        except Exception as exc:
            logger.warning("local-eject: gc could not stop the sidecar %s: %s", pid, exc)

    # 2. every resident model
    for model_id in resident:
        try:
            if supervisor is not None:
                supervisor.unload_model(model_id)
            else:
                _router_call("/models/unload", {"model": model_id}, timeout=180)
            result["ejected"].append(model_id)
            logger.info("local-eject: gc unloaded %s", model_id)
        except Exception as exc:
            logger.warning("local-eject: gc could not unload %s: %s", model_id, exc)

    # 3. orphans left by a previous gateway
    for zombie in plan["zombies"]:
        try:
            proc = psutil.Process(zombie["pid"])
            for child in proc.children(recursive=True):
                child.kill()
            proc.kill()
            proc.wait(timeout=5)
            result["killed"].append({"pid": zombie["pid"], "reason": zombie["reason"]})
            logger.info("local-eject: gc killed pid %s (%s)", zombie["pid"], zombie["reason"])
        except Exception as exc:
            logger.warning("local-eject: gc could not kill %s: %s", zombie["pid"], exc)

    if result["stopped"] or result["ejected"] or result["killed"]:
        time.sleep(2)
        with _vram_lock:
            _vram_cache = (0.0, None)
        after = _vram()
        result["vram_after_mb"] = (after or {}).get("used_mb")
    return result


# ── routes ───────────────────────────────────────────────────


@router.post("/gc")
def gc_route(body: dict | None = None) -> dict[str, Any]:
    payload = body or {}
    return gc(
        dry_run=bool(payload.get("dry_run", False)),
        include_sidecar=bool(payload.get("include_sidecar", True)),
    )


@router.post("/discover")
def discover_route(body: dict | None = None) -> dict[str, Any]:
    """Force a rescan of presets.ini + the model folders (the Refresh button)."""
    return discover(force=bool((body or {}).get("force", True)))


@router.get("/state")
def state() -> dict[str, Any]:
    models = _models()
    enabled = _supervisor() is not None or _state() is not None
    scan = discover()
    summary = {
        "count": scan["count"],
        "dirs": scan["dirs"],
        "entries": scan["entries"],
        "missing": scan["missing"],
        "scanned_at": scan["scanned_at"],
        "unstaged": scan["unstaged"],
    }
    if models is None:
        return {
            "enabled": enabled,
            "server": False,
            "models": {},
            "resident": [],
            "scan": summary,
            "vram": _vram(),
        }
    resident = [model_id for model_id, status in models.items() if status in _RESIDENT]
    return {
        "enabled": True,
        "server": True,
        "models": models,
        "resident": resident,
        "scan": summary,
        "vram": _vram(),
    }


def _runtime_enabled() -> bool:
    """Whether `local_runtime.enabled` is on (config is the only authority)."""
    try:
        from hermes_cli.config import load_config

        section = (load_config() or {}).get("local_runtime") or {}
        return bool(section.get("enabled", True))
    except Exception:
        return True


@router.post("/mount")
def mount(body: dict | None = None) -> dict[str, Any]:
    """Load a model into the router, starting the engine first when it is down.

    Returns at once; the chip polls /state until the model is resident.
    """
    supervisor = _supervisor()
    alive = _alive_base()
    # A supervisor ADOPTED from a stale `server.json` keeps pointing at the dead ephemeral
    # port of a spawn that never survived. `sup.load_model()` against it blocks for the whole
    # 900 s timeout while nothing happens — that is the chip stuck on "Cargando…" forever.
    # Only trust the in-process supervisor when its base is the one answering /health.
    if supervisor is not None:
        sup_base = str(getattr(supervisor, "base_url", "") or "").rstrip("/")
        if sup_base.endswith("/v1"):
            sup_base = sup_base[: -len("/v1")]
        if alive and sup_base and sup_base != alive:
            logger.info("local-eject: supervisor at %s is stale (live router %s); using HTTP", sup_base, alive)
            supervisor = None
    models = _models()
    wanted = (body or {}).get("model_id")

    # A dead engine is recoverable (`_load` boots it), so only a disabled runtime
    # is a hard error — the old guard returned `engine_not_running` for exactly
    # the case the cold start exists to fix.
    if models is None and supervisor is None and not _runtime_enabled():
        return {"ok": False, "error": "engine_not_running", "mounted": None}

    if models is not None:
        wanted = wanted or next(
            (model_id for model_id, status in models.items() if status not in _RESIDENT), None
        )
        # Everything resident already? Then "mount" is a no-op for that model.
        wanted = wanted or next(iter(models), None)
        if not wanted:
            return {"ok": False, "error": "no_model", "mounted": None}
        if models.get(wanted) in _RESIDENT:
            return {"already": True, "mounted": wanted, "ok": True}

    def _load() -> None:
        target = wanted
        sup = supervisor
        try:
            if models is None:
                # No engine answering. `supervisor` is None when the gateway boot
                # ADOPTED a router that later died (it only reads server.json), so
                # booting the runtime here is the only way back without a restart.
                if sup is None:
                    logger.info("local-eject: booting the local runtime")
                    from hermes_cli.config import load_config
                    from hermes_cli.local_runtime.bootstrap import ensure_local_runtime

                    sup = ensure_local_runtime(load_config(), force=True)
                if sup is None:
                    logger.warning("local-eject: local runtime is disabled or unavailable")
                    return
                if _models() is None:  # nothing listening yet → spawn it ourselves
                    sup.start(timeout_s=240)
                available = dict(sup.models(timeout_s=15))
                # An explicit pick from the menu wins: falling back to "first available" here
                # mounted a model the user never chose whenever the click had to cold-start
                # the engine (the picker is what made that visible).
                if not (target and target in available):
                    target = next(
                        (model_id for model_id, status in available.items() if status not in _RESIDENT), None
                    ) or next(iter(available), None)
                if not target:
                    logger.warning("local-eject: engine is up but there is no model to mount")
                    return
            # Load through whichever client we actually have: the supervisor we just
            # booted, the one the gateway owns, or plain HTTP when there is none.
            # `before_load` runs first: on a 24 GB card the model needs the VRAM another
            # process (ComfyUI) may still be sitting on.
            try:
                _hooks().run("before_load", target)
            except Exception as hook_exc:  # noqa: BLE001 - hooks are best-effort
                logger.debug("local-eject: before_load hooks skipped (%s)", hook_exc)
            if sup is not None:
                sup.load_model(target, timeout_s=900)
            else:
                _router_call("/models/load", {"model": target}, timeout=900)
            logger.info("local-eject: mounted %s", target)
        except Exception as exc:
            logger.warning("local-eject: mount failed: %s", exc)

    threading.Thread(target=_load, daemon=True, name="local-eject-mount").start()
    return {"already": False, "mounted": wanted, "ok": True}


@router.post("/eject")
def eject(body: dict | None = None) -> dict[str, Any]:
    """Unload the named model, or every resident one. Frees VRAM + its commit."""
    wanted = (body or {}).get("model_id")
    before = _vram()
    models = _models() or {}
    targets = [wanted] if wanted else [m for m, s in models.items() if s in _RESIDENT]

    ejected: list[str] = []
    supervisor = _supervisor()
    for model_id in targets:
        try:
            if supervisor is not None:
                supervisor.unload_model(model_id)
            else:
                _router_call("/models/unload", {"model": model_id}, timeout=120)
            ejected.append(model_id)
        except Exception as exc:
            logger.warning("local-eject: unload of %s failed: %s", model_id, exc)

    after = _vram()
    return {
        "ok": bool(ejected) or not targets,
        "ejected": ejected,
        "vram_before_mb": (before or {}).get("used_mb"),
        "vram_after_mb": (after or {}).get("used_mb"),
    }


@router.post("/stop")
def stop() -> dict[str, Any]:
    """Stop the llama.cpp engine entirely (what 'kill the server' does by hand)."""
    supervisor = _supervisor()
    if supervisor is not None:
        try:
            from hermes_cli.local_runtime import bootstrap

            bootstrap.shutdown_local_runtime()
            return {"ok": True, "via": "supervisor"}
        except Exception as exc:
            logger.warning("local-eject: shutdown_local_runtime failed: %s", exc)
    state = _state() or {}
    pid = state.get("pid")
    if not pid:
        return {"ok": False, "error": "no local server pid found"}
    try:
        import psutil

        proc = psutil.Process(int(pid))
        for child in proc.children(recursive=True):
            child.terminate()
        proc.terminate()
        return {"ok": True, "via": "pid", "pid": int(pid)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ── lifecycle hooks ──────────────────────────────────────────
@router.get("/hooks")
def hooks_status() -> dict[str, Any]:
    """Configured hooks, the file they came from, and what fired recently."""
    try:
        return {"ok": True, **_hooks().status()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


@router.get("/hooks/config")
def hooks_config() -> dict[str, Any]:
    """The editable tree the settings page renders (hooks exactly as stored)."""
    try:
        return {"ok": True, **_hooks().raw_config()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


@router.post("/hooks/save")
def hooks_save(body: dict | None = None) -> dict[str, Any]:
    """Persist the hooks the settings page edited. Body: {events: {...}, poll_seconds?}"""
    payload = body or {}
    events = payload.get("events")
    if not isinstance(events, dict):
        return {"ok": False, "error": "events is required (object keyed by event name)"}
    try:
        saved = _hooks().save_config(events, payload.get("poll_seconds"))
        return {"ok": True, **saved}
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


@router.post("/hooks/run")
def hooks_run(body: dict | None = None) -> dict[str, Any]:
    """Fire one event now — the manual test for "does ComfyUI really free the VRAM?".

    Body: {"event": "before_load" | "after_load" | "after_unload", "model": "<optional id>"}
    """
    payload = body or {}
    event = str(payload.get("event") or "before_load")
    model = payload.get("model")
    try:
        module = _hooks()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"hooks module unavailable: {exc}"}
    if event not in module.EVENTS:
        return {"ok": False, "error": f"event must be one of {list(module.EVENTS)}"}
    results = module.run(event, model)
    return {"ok": True, "event": event, "results": results, "count": len(results)}
