#!/usr/bin/env python
"""VRAM cleaning — the command-line half of the local-eject plugin.

Same code as the plugin's `POST /api/plugins/local-eject/gc` route: unload every
resident model, stop the vision sidecar, and kill the llama-server processes a
previous gateway left behind.

  python vram_gc.py            # dry run: show what would be freed
  python vram_gc.py --kill     # do it, then print the VRAM delta
  python vram_gc.py --kill --no-sidecar    # keep the vision sidecar running

Run it with the repo interpreter:
  %LOCALAPPDATA%\\hermes\\hermes-agent\\venv\\Scripts\\python.exe vram_gc.py --kill
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "dashboard"))

# `hermes_cli` must be the repo copy the gateway runs, not whatever pip has.
_REPO = Path(__file__).resolve().parents[2] / "hermes-agent"
if _REPO.is_dir():
    sys.path.insert(0, str(_REPO))

import plugin_api as pa  # noqa: E402


def _row(item: dict) -> str:
    cmd = item.get("cmdline") or ""
    short = cmd[:110] + ("…" if len(cmd) > 110 else "")
    return (
        f"  pid {item['pid']:>6}  ppid {item.get('ppid', 0):>6}  "
        f"{item.get('age_s', 0):>7.0f}s  listen={int(bool(item.get('listening')))}  "
        f"{item.get('reason', ''):<18} {short}"
    )


def _names(ids: list[str]) -> str:
    return ", ".join(ids) if ids else "(ninguno)"


def main() -> int:
    parser = argparse.ArgumentParser(description="Free VRAM: models, vision sidecar, zombies.")
    parser.add_argument("--kill", action="store_true", help="actually act (default: dry run)")
    parser.add_argument("--no-sidecar", action="store_true", help="leave the vision sidecar running")
    parser.add_argument("--json", action="store_true", help="raw JSON output")
    args = parser.parse_args()

    result = pa.gc(dry_run=not args.kill, include_sidecar=not args.no_sidecar)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0

    print(f"router (server.json): pid {result.get('router_pid') or '—'}")
    print(f"VRAM antes: {result['vram_before_mb']} MiB\n")

    if result["dry_run"]:
        print(f"modelos a descargar: {_names(result.get('would_eject') or [])}")
        print(f"sidecar a detener:   {result.get('would_stop') or '(ninguno)'}")
        print("zombies a matar:")
        zombies = result.get("candidates") or []
        if not zombies:
            print("  (ninguno)")
        for item in zombies:
            print(_row(item))
        print("\ndry run: nada se tocó. Repite con --kill para liberar.")
        return 0

    print(f"modelos descargados: {_names(result.get('ejected') or [])}")
    print(f"sidecar detenido:    {result.get('stopped') or '(ninguno)'}")
    killed = result.get("killed") or []
    print(f"zombies matados:     {[k['pid'] for k in killed] or '(ninguno)'}")
    print(f"\nVRAM después: {result['vram_after_mb']} MiB")
    if result.get("stale_router"):
        print(
            "\nAVISO: el router de server.json no aparece vivo — el motor está caído.\n"
            "Arráncalo desde el chip (Mount) o Settings → Local models → Start.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
