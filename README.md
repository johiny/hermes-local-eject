# local-eject

A Hermes Agent plugin in two halves that do the same job from opposite ends:

1. **Eject** — a status-bar chip that unloads the model the managed llama.cpp runtime is holding, so
   the VRAM goes back to ComfyUI (or anything else) without restarting Hermes.
2. **Boot and self-healing** — the llama.cpp router is started when a long-lived host boots, and
   respawned when the process that owned it dies.

Both live here because they manage the same lifecycle: one frees the memory, the other keeps the
engine that serves it reachable.

## Why the second half exists

The runtime's native boot lives in `web_server_app.app_lifespan`, and the gateway mounts that
dashboard "on first use". It works — with one hole: the router is a **child of whichever process
spawned it**. When that process is short-lived (a desktop backend that restarts), the router dies
with it while `server.json` keeps pointing at a dead PID. The gateway, which had only *adopted* the
server, never revives it. The chip then reads "Mount" over a port nobody serves.

This plugin closes that hole without patching the Hermes checkout:

| rule | why |
|---|---|
| Boot is idempotent and adopting (`ensure_local_runtime`) | a second host must not spawn a duplicate router |
| Only long-lived hosts may spawn (`gateway run`, `dashboard`, `serve`, `web` in argv) | a one-shot CLI parent takes its child router down on exit — the "dead pid in `server.json`" trap |
| A heal loop polls `/health` every 30 s and spawns on 2 consecutive misses | the router that was adopted can die with its owner; the host that lives rebuilds it and becomes the owner |
| Config reading falls back `load_config()` → plain YAML → regex | `load_config` can raise `No module named 'ruamel'` on a bare interpreter and a single boolean must still be readable |

Measured on a 24 GB RTX 3090: killing the owning host (`taskkill /T /F`) while another long-lived
host was up → `router is not answering; spawning it from this host` at +41 s, `router spawned` and
`recovered` at +43 s, and `server.json.owner_pid` moved to the surviving host.

## What it deliberately does NOT do

**It never loads a model.** Residency is v2 upstream: nothing loads until demand — a message in a
profile whose model is local, or an explicit Mount. An empty router costs a couple of gigabytes of
CUDA context, not 20 GB of weights. (An `on_session_start` preload was prototyped and removed: the
user decides when VRAM is spent.)

## Install

```bash
git clone https://github.com/johiny/hermes-local-eject.git \
  ~/.hermes/plugins/local-eject      # %LOCALAPPDATA%\hermes\plugins\local-eject on Windows
```

Then allow it in `~/.hermes/config.yaml`:

```yaml
plugins:
  enabled:
    - local-eject
```

Restart the gateway. Nothing else to configure: `local_runtime.enabled` must be `true` (the default)
for the boot half to do anything.

## Environment switches

| variable | effect |
|---|---|
| `HERMES_NO_LOCAL_RUNTIME_BOOT=1` | disables both boot and healing for this process |
| `HERMES_NO_LOCAL_RUNTIME_PRELOAD=1` | reserved (no preload code ships today) |

## Routes

The dashboard half is mounted by the host at `/api/plugins/local-eject/`:

| route | purpose |
|---|---|
| `GET  /state` | is a model resident, which one, engine health |
| `POST /mount` | load the selected model |
| `POST /eject` | unload it and free the VRAM |
| `POST /gc` | reap orphaned engines (conservative: never the router `server.json` names, never anything younger than the grace window, and a listening non-sidecar orphan is reported, not killed) |

Management routes of the router itself live at the **root** of its base URL, not under `/v1` — a
detail that cost a 404 loop while writing this.

## Caveats

- It imports Hermes internals (`hermes_cli.local_runtime.bootstrap`, `hermes_cli.config.load_config`),
  so a Hermes upgrade can break it. Everything is wrapped so a failure degrades to "no plugin
  behaviour" rather than a host that will not start.
- `--models-autoload` (upstream, not set here) is what makes a message load a staged model; with
  `models_max: 1` there is exactly one warm model at a time.

## License

MIT — see [LICENSE](LICENSE).
