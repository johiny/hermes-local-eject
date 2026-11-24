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

## Lifecycle hooks — hand the GPU over

24 GB cannot hold an image model and a video model at once, so the side that wants the card has to
tell the other side to let go. Hooks are the switchboard: **user-defined HTTP calls** fired around a
model load. Nothing is hard-coded to ComfyUI — every call comes from a file you edit.

Config lives at `%LOCALAPPDATA%\hermes\local-eject\hooks.json` (Linux/macOS:
`~/.hermes/local-eject/hooks.json`). It is created with the default example the first time the plugin
runs. Override the path with `HERMES_LOCAL_EJECT_HOOKS=/abs/path/hooks.json`.

```json
{
  "version": 1,
  "poll_seconds": 5,
  "events": {
    "before_load": [
      {
        "name": "free-comfyui-vram",
        "enabled": true,
        "method": "POST",
        "url": "http://127.0.0.1:8188/free",
        "json": {"unload_models": true, "free_memory": true},
        "timeout": 10,
        "expect": [200, 204]
      }
    ],
    "after_load": [],
    "after_unload": []
  }
}
```

| event | when it fires |
|---|---|
| `before_load` | right before the plugin loads a model (`POST /mount`). This is the one that matters when ComfyUI is sitting on the VRAM llama.cpp is about to need |
| `after_load` | when a model becomes resident — including loads this plugin did not start (a message hit `--models-autoload`) |
| `after_unload` | when a model stops being resident |

Per hook: `name`, `enabled` (default true), `method` (default POST), `url`, `json` (body),
`headers`, `timeout` (default 10 s), `expect` (status codes; default any 2xx). A `{model}` placeholder
inside any string value of `json` is replaced with the model id.

Design rules, on purpose:

- A failing hook is **logged, never raised**: a closed ComfyUI must not break a load. Measured: a dead
  endpoint returns `ok:false` / `URLError: timed out` in its own timeout while the load proceeds.
- Status is polled for `after_*` events instead of hooking the router, so autoload is covered too.
- The config is re-read when its mtime changes — edit, save, no restart.

Test it without touching a real workflow:

```bash
curl -s http://127.0.0.1:8642/api/plugins/local-eject/hooks | jq        # what is configured + recent results
curl -s -X POST http://127.0.0.1:8642/api/plugins/local-eject/hooks/run \
     -H 'Content-Type: application/json' -d '{"event":"before_load"}' | jq
```

### Editing the hooks in the app

**Settings ▸ Plugins ▸ Local Eject → Lifecycle hooks** (the desktop half, `desktop/plugin.js`): one
group per event, each hook with name, on/off, method (POST/GET), URL, timeout and JSON body. `+ Add
hook` appends, `✕` removes, `Test` fires that event immediately and prints each hook's status (or its
error) in the note line, and `Save hooks` writes the file through
`POST /hooks/save` (validated: URL must be http(s), method from a fixed list, timeout 0.5–300 s,
body must parse as JSON — the error names the offending hook).

Two honest details:

- Edits live in a **draft** inside the settings page; nothing is written until Save, so a half-typed
  URL cannot break a load.
- The section is served by a **new backend route**: until the gateway is restarted once after
  installing this version, it renders "the hooks backend is not loaded yet" instead of an empty
  list — an empty list would read as "my hooks are gone".

Install the UI half by copying `ui/plugin.js` to
`%LOCALAPPDATA%\hermes\desktop-plugins\local-eject\plugin.js` (the app hot-reloads it within ~5 s;
the repo copy is the source of truth, so keep them in sync).

> **Do not put it back under `desktop/`.** The desktop app treats `<package>/desktop/plugin.js` as
> the UI half of a *unified package* and stamps `.hermes-package.json` next to the copy, which puts
> the Python half in "installed-but-inert until allowlisted" posture — the chip and the settings page
> vanish with no error in the logs. `ui/` is just a folder the app never looks for, so the plugin
> stays standalone: agent half in `plugins/`, UI half in `desktop-plugins/`.

> Heads-up: `POST /free` with `unload_models` frees ComfyUI's models. If you render **while** chatting
> with a local model, that is exactly the hand-off you want; if ComfyUI is mid-job, it is not. Disable
> the hook (`"enabled": false`) or move it to `after_load` if you would rather the chat model wait.

YAML is accepted too (same schema, `events:` at the top) **only when the host interpreter has PyYAML** —
the desktop ships one that does not, which is why JSON is the primary format.

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
