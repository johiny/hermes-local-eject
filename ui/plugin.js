/**
 * local-eject — status-bar chip to eject the local llama.cpp model.
 *
 * - Chip in the right status-bar cluster: shows the loaded model and, on
 *   click, POSTs /eject (the same path as Settings → Local models).
 * - ⌘K commands: "Eject local model" and "Stop llama.cpp server".
 * - Default keybind: mod+alt+e (rebindable in Settings → Keybinds).
 * - Settings ▸ Plugins ▸ Local Eject: language picker (Auto / English /
 *   Español / 日本語 / 中文). Strings ship in all four; English is the
 *   fallback whenever a key is missing.
 *
 * Backend: ~/.hermes/plugins/local-eject/dashboard/plugin_api.py
 */

import {
  atom,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  host,
  icons,
  Input,
  KEYBINDS_AREA,
  PALETTE_AREA,
  SegmentedControl,
  STATUSBAR_AREAS,
  Tip,
  cn,
  queryClient,
  usePluginI18n,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'local-eject'
const STATE_KEY = [PLUGIN_ID, 'state']
const LANG_KEY = 'lang'
const LANGS = ['auto', 'en', 'es', 'ja', 'zh']

// ── strings ──────────────────────────────────────────────────

const MESSAGES = {
  en: {
    'chip.mount': 'Mount',
    'chip.eject': 'Eject',
    'chip.loading': 'Loading',
    'chip.unloading': 'Ejecting',
    'chip.cleaning': 'Cleaning',
    'tip.loading': 'loading the model into VRAM…',
    'tip.unloading': 'freeing the model from VRAM…',
    'tip.cleaning': 'freeing models, the vision sidecar and leftover processes…',
    'tip.loaded': (model, vram) => `${model} loaded${vram ? ` · VRAM ${vram}` : ''} — click to eject and free VRAM`,
    'tip.idle': 'no model loaded — click to mount one into VRAM',
    'tip.down': 'engine is off — click to start it and mount the model',
    'toast.title': 'Local model',
    'toast.mountFailed': 'Could not mount a local model',
    'toast.engineDown': 'The local engine is not running — start it (Settings → Local models → Start) and retry',
    'status.loaded': 'loaded',
    'status.loading': 'loading…',
    'status.unloaded': 'unloaded',
    'status.unknown': 'unknown',
    'refresh.label': 'Refresh models',
    'refresh.hint': 'Re-reads presets.ini and the model folders: models you deleted disappear, new .gguf files show up.',
    'refresh.done': count => `${count} local model${count === 1 ? '' : 's'} found`,
    'refresh.meta': (count, time) => `${count} found · scanned ${time}`,
    'refresh.stale': 'The gateway still runs the previous plugin backend — restart it (hermes gateway restart) to rescan models',
    'refresh.title': 'Local models',
    'refresh.staged': 'preset',
    'refresh.unstaged': 'no preset',
    'refresh.empty': 'No local models found',
    'model.unstaged': 'on disk · no preset',
    'menu.empty': 'No model staged to mount',
    'gc.label': 'Clean VRAM',
    'gc.hint': 'Unloads every local model, stops the vision sidecar and kills processes a previous gateway left behind. Frees VRAM and nothing else.',
    'gc.run': 'Clean now',
    'palette.gc': 'Clean VRAM',
    'palette.gcDetail': 'Unload local models, stop the sidecar, kill leftover processes',
    'toast.gcTitle': 'VRAM cleaning',
    'toast.gcDone': (detail, freed) => `${detail}${freed ? ` · ${freed} freed` : ''}`,
    'toast.gcModels': count => `${count} model${count === 1 ? '' : 's'} unloaded`,
    'toast.gcNone': 'Nothing to clean',
    'toast.gcStale': 'The gateway is still running the previous plugin backend — restart it (hermes gateway restart) so Clean VRAM also unloads models and the sidecar',
    'toast.gcProcs': count => `${count} leftover process${count === 1 ? '' : 'es'} killed`,
    'toast.gcSidecar': 'vision sidecar stopped',
    'toast.stopTitle': 'Local runtime',
    'toast.stopped': 'llama.cpp engine stopped',
    'toast.stopFailed': 'Could not stop the engine',
    'palette.eject': 'Eject local model (free VRAM)',
    'palette.stop': 'Stop llama.cpp server',
    'palette.ejectDetail.idle': 'no model loaded',
    'palette.ejectDetail.loaded': (model, vram) => (vram ? `${model} · VRAM ${vram}` : model),
    'palette.stopDetail.up': 'engine running',
    'palette.stopDetail.down': 'engine stopped',
    'keybind.category': 'Local runtime',
    'keybind.eject': 'Eject local model',
    'settings.title': 'Local Eject',
    'settings.language': 'Language',
    'settings.languageHint':
      'Ships English, Spanish, Japanese and Chinese. "Auto" follows the app language.',
    'settings.auto': 'Auto',
    'settings.idleLabel': 'Mount text',
    'settings.ejectLabel': 'Eject text',
    'settings.idleIcon': 'Mount icon',
    'settings.loadedIcon': 'Eject icon',
    'settings.overrideHint':
      'Empty = the localized default. Custom text and icons apply in every language.',
    'settings.reset': 'Reset to defaults',
    'hooks.title': "Lifecycle hooks",
    'hooks.hint': "HTTP calls sent around a model load — before it loads, once it is loaded, and after it is unloaded. \"Before\" fires for every way a local model starts loading: the chip's Mount, the native model picker, the CLI and cron. Add the endpoints your other apps need to hear about.",
    'hooks.needsRestart': "The hooks backend is not loaded yet — restart the gateway once to pick it up.",
    'hooks.save': "Save hooks",
    'hooks.saving': "Saving…",
    'hooks.saved': "Hooks saved",
    'hooks.saveError': "Could not save the hooks",
    'hooks.test': "Test",
    'hooks.add': "Add hook",
    'hooks.remove': "Remove hook",
    'hooks.name': "Name",
    'hooks.url': "http://127.0.0.1:8188/free",
    'hooks.body': "{\"unload_models\": true, \"free_memory\": true}",
    'hooks.timeout': "seconds",
    'hooks.empty': "no hooks",
    'hooks.badJson': "Body is not valid JSON",
    'hooks.on': "On",
    'hooks.off': "Off",
    'hooks.event.before_load': "Before a model loads",
    'hooks.event.after_load': "After a model loads",
    'hooks.event.after_unload': "After a model unloads"
  },
  es: {
    'chip.mount': 'Cargar',
    'chip.eject': 'Expulsar',
    'chip.loading': 'Cargando',
    'chip.unloading': 'Expulsando',
    'chip.cleaning': 'Limpiando',
    'tip.loading': 'cargando el modelo a la VRAM…',
    'tip.unloading': 'liberando el modelo de la VRAM…',
    'tip.cleaning': 'liberando modelos, sidecar de visión y procesos huérfanos…',
    'tip.loaded': (model, vram) => `${model} cargado${vram ? ` · VRAM ${vram}` : ''} — click para expulsar y liberar VRAM`,
    'tip.idle': 'sin modelo cargado — click para cargarlo en la VRAM',
    'tip.down': 'motor apagado — click para arrancarlo y cargar el modelo',
    'toast.title': 'Modelo local',
    'toast.mountFailed': 'No se pudo cargar un modelo local',
    'toast.engineDown': 'El motor local no está encendido — arráncalo (Settings → Local models → Start) y reintenta',
    'status.loaded': 'cargado',
    'status.loading': 'cargando…',
    'status.unloaded': 'descargado',
    'status.unknown': 'desconocido',
    'refresh.label': 'Refrescar modelos',
    'refresh.hint': 'Vuelve a leer presets.ini y las carpetas de modelos: los que borraste desaparecen y los .gguf nuevos aparecen.',
    'refresh.done': count => `${count} modelo${count === 1 ? '' : 's'} local${count === 1 ? '' : 'es'} encontrado${count === 1 ? '' : 's'}`,
    'refresh.meta': (count, time) => `${count} encontrados · escaneado ${time}`,
    'refresh.stale': 'El gateway sigue con el backend anterior del plugin — reinícialo (hermes gateway restart) para reescanear los modelos',
    'refresh.title': 'Modelos locales',
    'refresh.staged': 'preset',
    'refresh.unstaged': 'sin preset',
    'refresh.empty': 'No hay modelos locales',
    'model.unstaged': 'en disco · sin preset',
    'menu.empty': 'No hay modelo para montar',
    'gc.label': 'Limpiar VRAM',
    'gc.hint': 'Descarga todos los modelos locales, detiene el sidecar de visión y mata los procesos que dejó un gateway anterior. Libera VRAM y nada más.',
    'gc.run': 'Limpiar ahora',
    'palette.gc': 'Limpiar VRAM',
    'palette.gcDetail': 'Descargar modelos, detener el sidecar y matar procesos huérfanos',
    'toast.gcTitle': 'Limpieza de VRAM',
    'toast.gcDone': (detail, freed) => `${detail}${freed ? ` · ${freed} liberados` : ''}`,
    'toast.gcModels': count => `${count} modelo${count === 1 ? '' : 's'} descargado${count === 1 ? '' : 's'}`,
    'toast.gcNone': 'No había nada que limpiar',
    'toast.gcStale': 'El gateway sigue con el backend anterior del plugin — reinícialo (hermes gateway restart) para que Limpiar VRAM descargue también modelos y sidecar',
    'toast.gcProcs': count => `${count} proceso${count === 1 ? '' : 's'} huérfano${count === 1 ? '' : 's'} eliminado${count === 1 ? '' : 's'}`,
    'toast.gcSidecar': 'sidecar de visión detenido',
    'toast.stopTitle': 'Runtime local',
    'toast.stopped': 'Motor llama.cpp detenido',
    'toast.stopFailed': 'No se pudo detener el motor',
    'palette.eject': 'Expulsar modelo local (liberar VRAM)',
    'palette.stop': 'Detener servidor llama.cpp',
    'palette.ejectDetail.idle': 'sin modelo cargado',
    'palette.ejectDetail.loaded': (model, vram) => (vram ? `${model} · VRAM ${vram}` : model),
    'palette.stopDetail.up': 'motor en marcha',
    'palette.stopDetail.down': 'motor detenido',
    'keybind.category': 'Runtime local',
    'keybind.eject': 'Expulsar modelo local',
    'settings.title': 'Local Eject',
    'settings.language': 'Idioma',
    'settings.languageHint':
      'Incluye inglés, español, japonés y chino. «Auto» sigue el idioma de la app.',
    'settings.auto': 'Auto',
    'settings.idleLabel': 'Texto al cargar',
    'settings.ejectLabel': 'Texto al expulsar',
    'settings.idleIcon': 'Icono al cargar',
    'settings.loadedIcon': 'Icono al expulsar',
    'settings.overrideHint':
      'Vacío = el texto traducido por defecto. El texto y los iconos propios valen para todos los idiomas.',
    'settings.reset': 'Restablecer',
    'hooks.title': "Hooks de ciclo de vida",
    'hooks.hint': "Llamadas HTTP alrededor de una carga de modelo: antes de cargarlo, al terminar y después de expulsarlo. \"Antes\" se dispara con cualquier forma de cargar un modelo local: el botón Mount del chip, el selector nativo, la CLI y cron. Añade los endpoints que tus otras apps necesiten escuchar.",
    'hooks.needsRestart': "El backend de hooks aún no está cargado — reinicia el gateway una vez para activarlo.",
    'hooks.save': "Guardar hooks",
    'hooks.saving': "Guardando…",
    'hooks.saved': "Hooks guardados",
    'hooks.saveError': "No se pudieron guardar los hooks",
    'hooks.test': "Probar",
    'hooks.add': "Añadir hook",
    'hooks.remove': "Quitar hook",
    'hooks.name': "Nombre",
    'hooks.url': "http://127.0.0.1:8188/free",
    'hooks.body': "{\"unload_models\": true, \"free_memory\": true}",
    'hooks.timeout': "segundos",
    'hooks.empty': "sin hooks",
    'hooks.badJson': "El cuerpo no es JSON válido",
    'hooks.on': "Sí",
    'hooks.off': "No",
    'hooks.event.before_load': "Antes de cargar un modelo",
    'hooks.event.after_load': "Al cargar un modelo",
    'hooks.event.after_unload': "Al expulsar un modelo"
  },
  ja: {
    'chip.mount': '読み込み',
    'chip.eject': '排出',
    'chip.loading': '読み込み中',
    'chip.unloading': '排出中',
    'chip.cleaning': '掃除中',
    'tip.loading': 'モデルを VRAM に読み込み中…',
    'tip.unloading': 'モデルを VRAM から解放中…',
    'tip.cleaning': 'モデル・ビジョンサイドカー・残存プロセスを解放中…',
    'tip.loaded': (model, vram) => `${model} 読み込み済み${vram ? ` · VRAM ${vram}` : ''} — クリックで排出して VRAM を解放`,
    'tip.idle': 'モデル未読み込み — クリックで VRAM に読み込み',
    'tip.down': 'エンジン停止中 — クリックで起動してモデルを読み込み',
    'toast.title': 'ローカルモデル',
    'toast.mountFailed': 'ローカルモデルを読み込めませんでした',
    'toast.engineDown': 'ローカルエンジンが停止しています — Settings → Local models → Start で起動して再試行してください',
    'status.loaded': '読込済み',
    'status.loading': '読込中…',
    'status.unloaded': '未読込',
    'status.unknown': '不明',
    'refresh.label': 'モデルを再スキャン',
    'refresh.hint': 'presets.ini とモデルフォルダーを読み直します。削除したモデルは消え、新しい .gguf が現れます。',
    'refresh.done': count => `${count} 件のローカルモデル`,
    'refresh.meta': (count, time) => `${count} 件 · 走査 ${time}`,
    'refresh.stale': 'ゲートウェイが旧バージョンのプラグイン処理のままです — `hermes gateway restart` で再起動すると再スキャンできます',
    'refresh.title': 'ローカルモデル',
    'refresh.staged': 'プリセット',
    'refresh.unstaged': 'プリセット無し',
    'refresh.empty': 'ローカルモデルがありません',
    'model.unstaged': 'ディスク上・プリセット無し',
    'menu.empty': '読み込めるモデルがありません',
    'gc.label': 'VRAM を掃除',
    'gc.hint': 'ローカルモデルをすべて降ろし、ビジョン側のサイドカーを停止し、前のゲートウェイが残したプロセスを終了します。',
    'gc.run': '今すぐ掃除',
    'palette.gc': 'VRAM を掃除',
    'palette.gcDetail': 'モデルを降ろし、サイドカーを停止し、残存プロセスを終了',
    'toast.gcTitle': 'VRAM 掃除',
    'toast.gcDone': (detail, freed) => `${detail}${freed ? ` · ${freed} 解放` : ''}`,
    'toast.gcModels': count => `${count} 件のモデルを降ろしました`,
    'toast.gcNone': '掃除するものはありません',
    'toast.gcStale': 'ゲートウェイが旧バージョンのプラグイン処理のままです — `hermes gateway restart` で再起動すると、モデルとサイドカーも解放されます',
    'toast.gcProcs': count => `${count} 件の残存プロセスを終了`,
    'toast.gcSidecar': 'ビジョンサイドカーを停止',
    'toast.stopTitle': 'ローカルランタイム',
    'toast.stopped': 'llama.cpp エンジンを停止しました',
    'toast.stopFailed': 'エンジンを停止できませんでした',
    'palette.eject': 'ローカルモデルを排出（VRAM 解放）',
    'palette.stop': 'llama.cpp サーバーを停止',
    'palette.ejectDetail.idle': 'モデル未読み込み',
    'palette.ejectDetail.loaded': (model, vram) => (vram ? `${model} · VRAM ${vram}` : model),
    'palette.stopDetail.up': 'エンジン稼働中',
    'palette.stopDetail.down': 'エンジン停止',
    'keybind.category': 'ローカルランタイム',
    'keybind.eject': 'ローカルモデルを排出',
    'settings.title': 'Local Eject',
    'settings.language': '言語',
    'settings.languageHint':
      '英語・スペイン語・日本語・中国語に対応。「自動」はアプリの言語に従います。',
    'settings.auto': '自動',
    'settings.idleLabel': '読み込み時の表示',
    'settings.ejectLabel': '排出時の表示',
    'settings.idleIcon': '読み込みアイコン',
    'settings.loadedIcon': '排出アイコン',
    'settings.overrideHint': '空欄なら言語ごとの既定値。独自のテキストとアイコンは全言語に適用されます。',
    'settings.reset': '既定に戻す',
    'hooks.title': "ライフサイクルフック",
    'hooks.hint': "モデルの読み込み前・読み込み後・解放後に送る HTTP 呼び出しです。「読み込み前」はチップの Mount・ネイティブのモデル選択・CLI・cron のすべてで発火します。他のアプリに伝えたいエンドポイントを追加してください。",
    'hooks.needsRestart': "フックのバックエンドがまだ読み込まれていません — ゲートウェイを一度再起動してください。",
    'hooks.save': "フックを保存",
    'hooks.saving': "保存中…",
    'hooks.saved': "保存しました",
    'hooks.saveError': "フックを保存できませんでした",
    'hooks.test': "テスト",
    'hooks.add': "フックを追加",
    'hooks.remove': "フックを削除",
    'hooks.name': "名前",
    'hooks.url': "http://127.0.0.1:8188/free",
    'hooks.body': "{\"unload_models\": true, \"free_memory\": true}",
    'hooks.timeout': "秒",
    'hooks.empty': "フックなし",
    'hooks.badJson': "本文が有効な JSON ではありません",
    'hooks.on': "オン",
    'hooks.off': "オフ",
    'hooks.event.before_load': "モデル読み込み前",
    'hooks.event.after_load': "モデル読み込み後",
    'hooks.event.after_unload': "モデル解放後"
  },
  zh: {
    'chip.mount': '加载',
    'chip.eject': '弹出',
    'chip.loading': '加载中',
    'chip.unloading': '卸载中',
    'chip.cleaning': '清理中',
    'tip.loading': '正在将模型加载到显存…',
    'tip.unloading': '正在从显存中释放模型…',
    'tip.cleaning': '正在释放模型、视觉 sidecar 与遗留进程…',
    'tip.loaded': (model, vram) => `${model} 已加载${vram ? ` · VRAM ${vram}` : ''} — 点击弹出并释放 VRAM`,
    'tip.idle': '未加载模型 — 点击加载到 VRAM',
    'tip.down': '引擎已停止 — 点击启动并加载模型',
    'toast.title': '本地模型',
    'toast.mountFailed': '无法加载本地模型',
    'toast.engineDown': '本地引擎未运行 — 请在 Settings → Local models → Start 启动后重试',
    'status.loaded': '已加载',
    'status.loading': '加载中…',
    'status.unloaded': '未加载',
    'status.unknown': '未知',
    'refresh.label': '重新扫描模型',
    'refresh.hint': '重新读取 presets.ini 与模型文件夹：删除的模型会消失，新的 .gguf 会出现。',
    'refresh.done': count => `发现 ${count} 个本地模型`,
    'refresh.meta': (count, time) => `${count} 个 · 扫描于 ${time}`,
    'refresh.stale': '网关仍在运行旧版插件后端 — 用 `hermes gateway restart` 重启后可重新扫描模型',
    'refresh.title': '本地模型',
    'refresh.staged': '已配置',
    'refresh.unstaged': '未配置',
    'refresh.empty': '未发现本地模型',
    'model.unstaged': '磁盘上 · 无预设',
    'menu.empty': '没有可加载的模型',
    'gc.label': '清理显存',
    'gc.hint': '卸载所有本地模型、停止视觉 sidecar，并结束上一个网关遗留的进程。',
    'gc.run': '立即清理',
    'palette.gc': '清理显存',
    'palette.gcDetail': '卸载模型、停止 sidecar、结束遗留进程',
    'toast.gcTitle': '显存清理',
    'toast.gcDone': (detail, freed) => `${detail}${freed ? ` · 释放 ${freed}` : ''}`,
    'toast.gcModels': count => `已卸载 ${count} 个模型`,
    'toast.gcNone': '没有需要清理的内容',
    'toast.gcStale': '网关仍在运行旧版插件后端 — 用 `hermes gateway restart` 重启后，清理显存即可同时卸载模型与 sidecar',
    'toast.gcProcs': count => `已结束 ${count} 个遗留进程`,
    'toast.gcSidecar': '已停止视觉 sidecar',
    'toast.stopTitle': '本地运行时',
    'toast.stopped': 'llama.cpp 引擎已停止',
    'toast.stopFailed': '无法停止引擎',
    'palette.eject': '弹出本地模型（释放 VRAM）',
    'palette.stop': '停止 llama.cpp 服务器',
    'palette.ejectDetail.idle': '未加载模型',
    'palette.ejectDetail.loaded': (model, vram) => (vram ? `${model} · VRAM ${vram}` : model),
    'palette.stopDetail.up': '引擎运行中',
    'palette.stopDetail.down': '引擎已停止',
    'keybind.category': '本地运行时',
    'keybind.eject': '弹出本地模型',
    'settings.title': 'Local Eject',
    'settings.language': '语言',
    'settings.languageHint': '内置英语、西班牙语、日语和中文。“自动”跟随应用语言。',
    'settings.auto': '自动',
    'settings.idleLabel': '加载文本',
    'settings.ejectLabel': '弹出文本',
    'settings.idleIcon': '加载图标',
    'settings.loadedIcon': '弹出图标',
    'settings.overrideHint': '留空则使用对应语言的默认值。自定义文本和图标适用于所有语言。',
    'settings.reset': '恢复默认',
    'hooks.title': "生命周期钩子",
    'hooks.hint': "在模型加载前、加载后和释放后发送的 HTTP 调用。「加载前」会在所有本地模型加载方式下触发：卡片上的 Mount、原生模型选择器、CLI 和 cron。添加你其他应用需要接收的端点。",
    'hooks.needsRestart': "钩子后端尚未加载——重启一次网关即可启用。",
    'hooks.save': "保存钩子",
    'hooks.saving': "保存中…",
    'hooks.saved': "钩子已保存",
    'hooks.saveError': "无法保存钩子",
    'hooks.test': "测试",
    'hooks.add': "添加钩子",
    'hooks.remove': "删除钩子",
    'hooks.name': "名称",
    'hooks.url': "http://127.0.0.1:8188/free",
    'hooks.body': "{\"unload_models\": true, \"free_memory\": true}",
    'hooks.timeout': "秒",
    'hooks.empty': "没有钩子",
    'hooks.badJson': "正文不是有效的 JSON",
    'hooks.on': "开",
    'hooks.off': "关",
    'hooks.event.before_load': "模型加载前",
    'hooks.event.after_load': "模型加载后",
    'hooks.event.after_unload': "模型释放后"
  }
}

/** Flat dotted keys → the nested tree `ctx.i18n` resolves (it walks `a.b.c`). */
const nest = messages => {
  const tree = {}

  for (const [key, value] of Object.entries(messages)) {
    const parts = key.split('.')
    let node = tree

    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] || {}
      node = node[part]
    }

    node[parts[parts.length - 1]] = value
  }

  return tree
}

const NESTED = Object.fromEntries(Object.entries(MESSAGES).map(([locale, bundle]) => [locale, nest(bundle)]))

/** Forced-language lookup: chosen bundle → English → the key itself. */
const pick = (lang, key, args = []) => {
  const bundle = MESSAGES[lang] || MESSAGES.en
  const value = bundle[key] ?? MESSAGES.en[key] ?? key

  return typeof value === 'function' ? value(...args) : value
}

/** The user's pick: 'auto' (app language) or one of en/es/ja/zh. */
const $lang = atom('auto')

// ── customizable chip ────────────────────────────────────────

/** No plain down arrow in the icon set: flip the up arrow. */
const ArrowDown = props => jsx(icons.ArrowUp, { ...props, className: cn('rotate-180', props.className) })

/** Icons offered in Settings ▸ Plugins ▸ Local Eject. */
const ICONS = {
  'arrow-down': ArrowDown,
  'arrow-up': icons.ArrowUp,
  activity: icons.Activity,
  check: icons.CheckCircle2,
  circle: icons.CircleIcon,
  cpu: icons.Cpu,
  eject: icons.Eject,
  plug: icons.Plug,
  power: icons.Power,
  zap: icons.Zap
}

const ICON_KEYS = Object.keys(ICONS)
const OVR_KEY = 'overrides'
const OVERRIDE_DEFAULTS = { ejectText: '', idleIcon: 'arrow-up', idleText: '', loadedIcon: 'arrow-down' }

/** Empty string = "use the localized default"; icons fall back to arrow-up/arrow-down. */
const $overrides = atom({ ...OVERRIDE_DEFAULTS })

/** In-flight mount/eject: { kind: 'loading'|'unloading', model?: string, at: number }. */
const $busy = atom(null)

const saveOverrides = (ctx, patch) => {
  const next = { ...$overrides.get(), ...patch }

  $overrides.set(next)
  ctx.storage.set(OVR_KEY, next)
}

// `auto` asks the SDK (app locale); anything else reads our own bundle.
const makeT = pluginT => (key, ...args) => ($lang.get() === 'auto' ? pluginT(key, ...args) : pick($lang.get(), key, args))

// ── model helpers ────────────────────────────────────────────

const shortName = id => {
  if (!id) {
    return 'local'
  }

  // orcarouter_Qwen3.8-27B-Uncensored-Q4_K_M -> Qwen3.8-27B
  const segments = String(id).split('_')
  const seg = segments.length > 1 && segments[1].length >= 4 ? segments[1] : segments[0]
  const parts = seg.split('-')

  while (parts.length > 1 && /^(uncensored|abliterated|q\d|iq\d|f16|bf16|gguf|mxfp)/i.test(parts[parts.length - 1])) {
    parts.pop()
  }

  return parts.join('-').slice(0, 24) || 'local'
}

const gb = mb => (typeof mb === 'number' ? `${(mb / 1024).toFixed(1)} GB` : null)

const QUANT_RE = /(IQ\d+_[A-Z0-9_]+|Q\d+_K(?:_[SML])?|Q\d+_\d+|F16|BF16|MXFP\d+[A-Z0-9_]*)$/i

/** The identity shortName() trims away: source, tuning and quant. */
const modelMeta = id => {
  const raw = String(id || '')
  const bits = []
  const source = raw.match(/^([a-z0-9]+)_(?=[A-Z])/i)

  if (source) {
    bits.push(source[1])
  }

  if (/uncensored/i.test(raw)) {
    bits.push('Uncensored')
  } else if (/abliterated/i.test(raw)) {
    bits.push('Abliterated')
  }

  const quant = raw.match(QUANT_RE)

  if (quant) {
    bits.push(quant[1].toUpperCase())
  }

  return bits.join(' · ')
}

/** Router statuses that mean "this model is in VRAM". */
const RESIDENT = new Set(['loaded', 'ready'])

/** Localized status label, falling back to the raw router status. */
const statusText = (t, status) => {
  const key = `status.${status}`
  const text = t(key)

  return text === key ? String(status || '') : text
}

// ── actions ──────────────────────────────────────────────────

async function ejectModel(ctx) {
  $busy.set({ at: Date.now(), kind: 'unloading' })

  try {
    const res = await ctx.rest('/eject', { body: {}, method: 'POST', timeoutMs: 180_000 })

    // No success toast on purpose: the chip goes to "Ejecting…" and then to Mount by itself,
    // which says everything a popup would.
    if (!res?.ejected?.length) {
      $busy.set(null)
    }
  } catch (err) {
    $busy.set(null)
    host.notifyError(err)
  } finally {
    queryClient.invalidateQueries({ queryKey: STATE_KEY })
  }
}

async function cleanVram(ctx) {
  const t = makeT(ctx.i18n.t)

  $busy.set({ at: Date.now(), kind: 'cleaning' })

  try {
    const res = await ctx.rest('/gc', { body: { dry_run: false }, method: 'POST', timeoutMs: 180_000 })

    // A gateway started before this backend existed answers with the old shape (only `killed`),
    // which used to surface as a cheerful "nothing to clean" while models and the sidecar stayed.
    if (res && !('ejected' in res) && !('stopped' in res)) {
      host.notify({
        durationMs: 9000,
        kind: 'error',
        message: t('toast.gcStale'),
        title: t('toast.gcTitle')
      })

      return
    }

    const freed =
      typeof res?.vram_before_mb === 'number' && typeof res?.vram_after_mb === 'number'
        ? gb(res.vram_before_mb - res.vram_after_mb)
        : null
    const parts = []

    if (res?.ejected?.length) {
      parts.push(t('toast.gcModels', res.ejected.length))
    }

    if (res?.stopped?.length) {
      parts.push(t('toast.gcSidecar'))
    }

    if (res?.killed?.length) {
      parts.push(t('toast.gcProcs', res.killed.length))
    }

    host.notify({
      durationMs: 6000,
      kind: parts.length ? 'success' : 'info',
      message: parts.length ? t('toast.gcDone', parts.join(' · '), freed) : t('toast.gcNone'),
      title: t('toast.gcTitle')
    })
  } catch (err) {
    host.notifyError(err)
  } finally {
    $busy.set(null)
    queryClient.invalidateQueries({ queryKey: STATE_KEY })
  }
}

/** Re-read presets.ini + the model folders (the Refresh button and the menu item). */
async function refreshModels(ctx) {
  const t = makeT(ctx.i18n.t)

  try {
    const res = await ctx.rest('/discover', { body: { force: true }, method: 'POST', timeoutMs: 30_000 })

    host.notify({
      durationMs: 4000,
      kind: 'success',
      message: t('refresh.done', res?.count ?? 0),
      title: t('toast.title')
    })
  } catch (err) {
    const text = String(err?.message || err || '')

    // Same trap as Clean VRAM: a gateway started before this backend 404s the route.
    if (text.includes('404')) {
      host.notify({
        durationMs: 9000,
        kind: 'error',
        message: t('refresh.stale'),
        title: t('toast.title')
      })
    } else {
      host.notifyError(err)
    }
  } finally {
    queryClient.invalidateQueries({ queryKey: STATE_KEY })
  }
}

async function mountModel(ctx, modelId) {
  const t = makeT(ctx.i18n.t)

  $busy.set({ at: Date.now(), kind: 'loading', model: modelId || null })

  try {
    const res = await ctx.rest('/mount', {
      body: modelId ? { model_id: modelId } : {},
      method: 'POST',
      timeoutMs: 60_000
    })

    if (!res?.ok) {
      $busy.set(null)

      host.notify({
        durationMs: 6000,
        kind: 'error',
        message: res?.error === 'engine_not_running' ? t('toast.engineDown') : t('toast.mountFailed'),
        title: t('toast.title')
      })
    }
  } catch (err) {
    host.notifyError(err)
  } finally {
    queryClient.invalidateQueries({ queryKey: STATE_KEY })
  }
}

async function stopServer(ctx) {
  const t = makeT(ctx.i18n.t)

  try {
    const res = await ctx.rest('/stop', { body: {}, method: 'POST', timeoutMs: 120_000 })

    host.notify({
      durationMs: 4000,
      kind: res?.ok ? 'success' : 'error',
      message: res?.ok ? t('toast.stopped') : res?.error || t('toast.stopFailed'),
      title: t('toast.stopTitle')
    })
  } catch (err) {
    host.notifyError(err)
  } finally {
    queryClient.invalidateQueries({ queryKey: STATE_KEY })
  }
}

// ── UI ───────────────────────────────────────────────────────

function EjectChip({ ctx }) {
  const pluginT = usePluginI18n(PLUGIN_ID)
  const t = makeT(pluginT)
  useValue($lang)
  const ov = useValue($overrides)
  const busyState = useValue($busy)

  const { data } = useQuery({
    queryFn: () => ctx.rest('/state'),
    queryKey: STATE_KEY,
    placeholderData: previous => previous,
    refetchInterval: 8000,
    retry: false,
    staleTime: 4000
  })

  // `data` is undefined on the first render and whenever a poll fails while the
  // gateway is restarting — reading through it crashed the whole contribution
  // boundary ("Cannot read properties of undefined (reading 'resident')").
  if (!data || data.enabled === false) {
    return null
  }

  const resident = data.resident || []
  const loaded = resident.length > 0
  const vram = gb(data.vram?.used_mb)
  const model = loaded ? shortName(resident[0]) : 'local'
  const idleLabel = ov.idleText?.trim() || t('chip.mount')
  const ejectLabel = ov.ejectText?.trim() || t('chip.eject')
  const label = loaded ? `${model} · ${ejectLabel}` : idleLabel
  const StatusIcon = ICONS[loaded ? ov.loadedIcon : ov.idleIcon] || icons.ArrowUp
  const models = Object.entries(data.models || {})
  const scan = data.scan || {}
  const missing = new Set(scan.missing || [])
  const unstaged = scan.unstaged || []

  // The picker must work with the engine DOWN too. When the router is not answering,
  // `data.models` is empty and the old chip fell through to `mountModel(ctx)` with no id —
  // the route then mounted whichever model it saw first, so the user paid 20 GB of VRAM
  // for a choice they never made. Presets + the GGUFs on disk still describe the catalog,
  // so idle options come from both sources and every click names its model.
  const routerKnown = new Set(models.map(([id]) => id))
  const pickable = models.filter(([id]) => !missing.has(id))
  for (const entry of scan.entries || []) {
    if (!entry?.id || routerKnown.has(entry.id) || !entry.exists || missing.has(entry.id)) continue
    pickable.push([entry.id, 'unloaded'])
  }
  const tipLabel = loaded
    ? t('tip.loaded', resident.join(', '), vram)
    : data.server
      ? t('tip.idle')
      : t('tip.down')

  // In-flight work beats the polled state: while a model loads or unloads the router keeps
  // reporting the *previous* status, so the chip would look frozen for up to a poll interval.
  // Two sources: the router saying "loading" (whoever triggered it) and our own request.
  const loadingModel = models.find(([, status]) => status === 'loading')?.[0] || null
  const clientBusy = busyState && Date.now() - (busyState.at || 0) < 180_000 ? busyState : null
  let busyKind = null

  if (loadingModel) {
    busyKind = 'loading'
  } else if (clientBusy) {
    if (clientBusy.kind === 'loading') {
      busyKind = loaded ? null : 'loading'
    } else if (clientBusy.kind === 'unloading') {
      busyKind = loaded ? 'unloading' : null
    } else {
      // A cleaning run has no router status to derive from: it lasts as long as the request.
      busyKind = clientBusy.kind
    }
  }
  const busyModel = loadingModel || clientBusy?.model || null

  if (busyKind) {
    const busyLabel = busyModel
      ? `${t(`chip.${busyKind}`)} ${shortName(busyModel)}`
      : t(`chip.${busyKind}`)

    return jsx(Tip, {
      label: t(`tip.${busyKind}`),
      children: jsxs('span', {
        className: 'inline-flex h-full cursor-default items-center gap-1.5 px-1.5 text-[0.6875rem] text-(--ui-text-secondary)',
        children: [
          jsx(icons.Loader2, {
            'aria-hidden': true,
            className: 'size-3 shrink-0 animate-spin text-(--ui-text-tertiary)',
            strokeWidth: 2
          }),
          jsx('span', { children: busyLabel }),
          // Animated ellipsis: `animate-pulse` ships in the built CSS, `animate-bounce` does not,
          // and a CSS animation keeps running without re-rendering the chip every 400 ms.
          jsx('span', {
            'aria-hidden': true,
            className: 'inline-flex',
            children: [0, 1, 2].map(index =>
              jsx(
                'span',
                {
                  className: 'animate-pulse',
                  style: { animationDelay: `${index * 220}ms`, animationDuration: '1.1s' },
                  children: '·'
                },
                String(index)
              )
            )
          })
        ]
      })
    })
  }

  // Native model-pill chrome: same row metrics, a quiet hover and the chevron
  // that says "there is a list" — the same three ingredients ModelPill uses.
  const chipClass = cn(
    'inline-flex h-full min-w-0 items-center gap-1 rounded-md px-2 text-xs font-normal',
    'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
    loaded && 'text-(--ui-text-secondary) hover:text-foreground'
  )

  const chipBody = [
    jsx(StatusIcon, {
      'aria-hidden': true,
      className: cn('size-3 shrink-0', loaded ? 'text-emerald-500' : 'text-(--ui-text-quaternary)'),
      strokeWidth: 1.75
    }),
    jsx('span', { className: 'truncate', children: label }),
    jsx(icons.ChevronDown, {
      'aria-hidden': true,
      className: 'size-2.5 shrink-0 opacity-50',
      strokeWidth: 1.75
    })
  ]

  // Loaded: the chip ejects. Idle: it ALWAYS opens the model picker — never a blind
  // "mount the first one", so the choice of which model to pay VRAM for stays explicit.
  if (loaded) {
    return jsx(Tip, {
      label: tipLabel,
      children: jsxs('button', {
        className: chipClass,
        onClick: () => void ejectModel(ctx),
        type: 'button',
        children: chipBody
      })
    })
  }

  return jsxs(DropdownMenu, {
    children: [
      jsx(DropdownMenuTrigger, { className: cn(chipClass, 'data-[state=open]:text-(--ui-text-primary)'), children: chipBody }),
      jsx(DropdownMenuContent, {
        align: 'end',
        className: 'w-72 p-0',
        side: 'top',
        sideOffset: 8,
        children: [
          pickable.length === 0
            ? jsx(
                DropdownMenuItem,
                {
                  className: 'gap-2 rounded-none px-2.5 py-1 text-xs',
                  disabled: true,
                  children: jsx('span', {
                    className: 'text-(--ui-text-quaternary)',
                    children: t('menu.empty')
                  })
                },
                'no-models'
              )
            : null,
          ...pickable
            .map(([id, status], index) => {
              const current = resident.includes(id)

              return jsxs(
                DropdownMenuItem,
                {
                  className: 'gap-2 rounded-none px-2.5 py-1 text-xs',
                  disabled: status === 'loading' || RESIDENT.has(status),
                  onSelect: () => void mountModel(ctx, id),
                  children: [
                    jsx('span', {
                      'aria-hidden': true,
                      className: 'grid size-4 shrink-0 place-items-center text-(--ui-text-quaternary)',
                      children: jsx(icons.ArrowUp, { className: 'size-3.5', strokeWidth: 1.75 })
                    }),
                    jsxs('span', {
                      className: 'flex min-w-0 flex-1 flex-col',
                      children: [
                        jsx('span', { className: 'min-w-0 truncate', children: shortName(id) }),
                        jsx('span', {
                          className: 'truncate text-[0.625rem] text-(--ui-text-quaternary)',
                          children: modelMeta(id)
                        })
                      ]
                    }),
                    current
                      ? jsx(icons.Check, {
                          'aria-hidden': true,
                          className: 'size-3 shrink-0 text-(--ui-text-secondary)',
                          strokeWidth: 2
                        })
                      : jsx('span', {
                          className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)',
                          children: statusText(t, status)
                        })
                  ]
                },
                `${id}-${index}`
              )
            }),
          ...(unstaged.length
            ? [
                jsx(DropdownMenuSeparator, {}, 'unstaged-sep'),
                ...unstaged.map((id, index) =>
                  jsxs(
                    DropdownMenuItem,
                    {
                      className: 'gap-2 rounded-none px-2.5 py-1 text-xs',
                      disabled: true,
                      children: [
                        jsx('span', {
                          'aria-hidden': true,
                          className: 'grid size-4 shrink-0 place-items-center text-(--ui-text-quaternary)',
                          children: jsx(icons.Package, { className: 'size-3.5', strokeWidth: 1.75 })
                        }),
                        jsxs('span', {
                          className: 'flex min-w-0 flex-1 flex-col',
                          children: [
                            jsx('span', { className: 'min-w-0 truncate text-(--ui-text-quaternary)', children: shortName(id) }),
                            jsx('span', {
                              className: 'truncate text-[0.625rem] text-(--ui-text-quaternary)',
                              children: modelMeta(id)
                            })
                          ]
                        }),
                        jsx('span', {
                          className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)',
                          children: t('model.unstaged')
                        })
                      ]
                    },
                    `unstaged-${id}-${index}`
                  )
                )
              ]
            : []),
          jsx(DropdownMenuSeparator, { className: 'mx-0' }, 'gc-sep'),
          jsxs(
            DropdownMenuItem,
            {
              className: 'gap-2 rounded-none px-2.5 py-1 text-xs text-(--ui-text-tertiary)',
              onSelect: () => void cleanVram(ctx),
              children: [
                jsx('span', {
                  'aria-hidden': true,
                  className: 'grid size-4 shrink-0 place-items-center',
                  children: jsx(icons.Trash2, { className: 'size-3', strokeWidth: 1.75 })
                }),
                jsx('span', { children: t('gc.label') })
              ]
            },
            'gc'
          )
        ]
      })
    ]
  })
}

const LANGUAGE_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
  { id: 'ja', label: '日本語' },
  { id: 'zh', label: '中文' }
]

function TextRow({ label, onChange, placeholder, value }) {
  return jsxs('div', {
    className: 'flex flex-col gap-1.5',
    children: [
      jsx('div', { className: 'text-[0.8125rem] font-medium', children: label }),
      jsx(Input, {
        className: 'max-w-xs',
        onChange: event => onChange(event.target.value.slice(0, 28)),
        placeholder,
        value
      })
    ]
  })
}

function IconRow({ label, onChange, value }) {
  return jsxs('div', {
    className: 'flex flex-col gap-1.5',
    children: [
      jsx('div', { className: 'text-[0.8125rem] font-medium', children: label }),
      jsx('div', {
        className: 'flex flex-wrap items-center gap-1',
        children: ICON_KEYS.map(key =>
          jsx('button', {
            'aria-pressed': value === key,
            className: cn(
              'inline-flex size-7 items-center justify-center rounded-[5px] transition-colors',
              value === key
                ? 'bg-(--ui-bg-tertiary) text-(--ui-text-primary)'
                : 'text-(--ui-text-tertiary) hover:text-(--ui-text-primary)'
            ),
            onClick: () => onChange(key),
            title: key,
            type: 'button',
            children: jsx(ICONS[key], { 'aria-hidden': true, className: 'size-4', strokeWidth: 1.75 })
          })
        )
      })
    ]
  })
}

// ── lifecycle hooks (settings) ───────────────────────────────
//
// Every mutation edits a DRAFT held in an atom; nothing is sent until Save. The draft is seeded by
// the query, so a failed first fetch leaves it empty and the section renders the "restart the
// gateway" hint instead of pretending the list is empty.

const HOOKS_KEY = [PLUGIN_ID, 'hooks']
const HOOK_EVENTS = ['before_load', 'after_load', 'after_unload']
const $hooksDraft = atom(null)
const $hooksNote = atom('')
const $hooksBusy = atom(false)

const cloneEvents = events => {
  const next = {}
  for (const event of HOOK_EVENTS) {
    next[event] = (events?.[event] || []).map(hook => ({
      name: hook.name || '',
      enabled: hook.enabled !== false,
      method: hook.method || 'POST',
      url: hook.url || '',
      bodyText: hook.json ? JSON.stringify(hook.json) : '',
      timeout: hook.timeout ?? 10,
      headers: hook.headers || {},
      expect: hook.expect || []
    }))
  }
  return next
}

const blankHook = () => ({
  name: '',
  enabled: true,
  method: 'POST',
  url: '',
  bodyText: '',
  timeout: 10,
  headers: {},
  expect: []
})

function HookFields({ hook, onChange, onRemove, t }) {
  return jsxs('div', {
    className: 'flex flex-col gap-2 rounded-md border border-(--border) px-3 py-2.5',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Input, {
            className: 'min-w-0 flex-1',
            onChange: event => onChange({ name: event.target.value.slice(0, 40) }),
            placeholder: t('hooks.name'),
            value: hook.name
          }),
          jsx(SegmentedControl, {
            onChange: next => onChange({ enabled: next === 'on' }),
            options: [
              { id: 'on', label: t('hooks.on') },
              { id: 'off', label: t('hooks.off') }
            ],
            sizing: 'content',
            value: hook.enabled ? 'on' : 'off'
          }),
          jsx('button', {
            className:
              'shrink-0 rounded-md border border-(--border) px-2 py-1 text-[0.625rem] text-(--ui-text-tertiary) transition-colors hover:border-(--ui-text-quaternary) hover:text-(--ui-text-primary)',
            onClick: onRemove,
            title: t('hooks.remove'),
            type: 'button',
            children: '✕'
          })
        ]
      }),
      jsx(Input, {
        onChange: event => onChange({ url: event.target.value.trim() }),
        placeholder: t('hooks.url'),
        value: hook.url
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(SegmentedControl, {
            onChange: next => onChange({ method: next }),
            options: [
              { id: 'POST', label: 'POST' },
              { id: 'GET', label: 'GET' }
            ],
            sizing: 'content',
            value: hook.method === 'GET' ? 'GET' : 'POST'
          }),
          jsx(Input, {
            className: 'w-16',
            onChange: event => onChange({ timeout: event.target.value }),
            placeholder: t('hooks.timeout'),
            value: String(hook.timeout ?? '')
          })
        ]
      }),
      jsx(Input, {
        className: 'font-mono text-[0.6875rem]',
        onChange: event => onChange({ bodyText: event.target.value }),
        placeholder: t('hooks.body'),
        value: hook.bodyText
      })
    ]
  })
}

function HooksSection({ ctx, t }) {
  const draft = useValue($hooksDraft)
  const note = useValue($hooksNote)
  const busy = useValue($hooksBusy)

  const { data, isError } = useQuery({
    queryFn: async () => {
      const res = await ctx.rest('/hooks/config')

      // Seed the draft once per session: a later refetch must not clobber unsaved edits.
      if (res && res.ok && !$hooksDraft.get()) {
        $hooksDraft.set({ events: cloneEvents(res.events), poll_seconds: res.poll_seconds })
      }

      return res
    },
    placeholderData: previous => previous,
    queryKey: HOOKS_KEY,
    retry: false,
    staleTime: 10_000
  })

  const patch = (event, index, changes) => {
    const current = $hooksDraft.get()

    if (!current) {
      return
    }

    $hooksDraft.set({
      ...current,
      events: {
        ...current.events,
        [event]: current.events[event].map((hook, i) => (i === index ? { ...hook, ...changes } : hook))
      }
    })
  }

  const remove = (event, index) => {
    const current = $hooksDraft.get()

    if (!current) {
      return
    }

    $hooksDraft.set({
      ...current,
      events: { ...current.events, [event]: current.events[event].filter((_, i) => i !== index) }
    })
  }

  const add = event => {
    const current = $hooksDraft.get()

    if (!current) {
      return
    }

    $hooksDraft.set({
      ...current,
      events: { ...current.events, [event]: [...current.events[event], blankHook()] }
    })
  }

  const save = async () => {
    const current = $hooksDraft.get()

    if (!current) {
      return
    }

    const events = {}

    for (const event of HOOK_EVENTS) {
      events[event] = current.events[event].map(hook => {
        let parsed = null

        if (hook.bodyText && hook.bodyText.trim()) {
          try {
            parsed = JSON.parse(hook.bodyText)
          } catch {
            throw new Error(`${t('hooks.badJson')}: ${event} → ${hook.name || hook.url}`)
          }
        }

        return {
          name: hook.name || hook.url,
          enabled: hook.enabled,
          method: hook.method,
          url: hook.url,
          json: parsed,
          headers: hook.headers,
          timeout: Number(hook.timeout) || 10,
          expect: hook.expect
        }
      })
    }

    $hooksBusy.set(true)
    $hooksNote.set('')

    try {
      const res = await ctx.rest('/hooks/save', { body: { events, poll_seconds: current.poll_seconds }, method: 'POST' })

      if (res && res.ok) {
        $hooksDraft.set({ events: cloneEvents(res.events), poll_seconds: res.poll_seconds })
        $hooksNote.set(t('hooks.saved'))
        queryClient.invalidateQueries({ queryKey: HOOKS_KEY })
      } else {
        $hooksNote.set(`${t('hooks.saveError')}: ${res?.error || '?'}`)
      }
    } catch (error) {
      $hooksNote.set(`${t('hooks.saveError')}: ${error?.message || error}`)
    } finally {
      $hooksBusy.set(false)
    }
  }

  const test = async event => {
    $hooksNote.set('')

    try {
      const res = await ctx.rest('/hooks/run', { body: { event }, method: 'POST' })

      if (res && res.ok) {
        const rows = (res.results || []).map(row => `${row.hook}: ${row.ok ? row.status : row.error}`)
        $hooksNote.set(rows.length ? `${event} → ${rows.join(' · ')}` : `${event} → ${t('hooks.empty')}`)
      } else {
        $hooksNote.set(`${event} → ${res?.error || '?'}`)
      }
    } catch (error) {
      $hooksNote.set(`${event} → ${error?.message || error}`)
    }
  }

  // A brand-new backend route 404s until the gateway restarts; say so instead of "no hooks".
  if (!draft) {
    return jsxs('div', {
      className: 'flex flex-col gap-2 border-t border-(--border) pt-4',
      children: [
        jsx('div', { className: 'text-[0.8125rem] font-medium', children: t('hooks.title') }),
        isError || (data && data.ok === false)
          ? jsx('p', {
              className: 'max-w-md text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
              children: t('hooks.needsRestart')
            })
          : null
      ]
    })
  }

  const field = (event, index, hook) =>
    jsx(
      HookFields,
      {
        hook,
        onChange: changes => patch(event, index, changes),
        onRemove: () => remove(event, index),
        t
      },
      `${event}-${index}`
    )

  return jsxs('div', {
    className: 'flex flex-col gap-3 border-t border-(--border) pt-4',
    children: [
      jsx('div', { className: 'text-[0.8125rem] font-medium', children: t('hooks.title') }),
      jsx('p', {
        className: 'max-w-md text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
        children: t('hooks.hint')
      }),
      ...HOOK_EVENTS.map(event =>
        jsxs(
          'div',
          {
            className: 'flex flex-col gap-2',
            children: [
              jsxs('div', {
                className: 'flex items-center justify-between gap-3',
                children: [
                  jsx('div', {
                    className: 'text-[0.75rem] font-medium text-(--ui-text-secondary)',
                    children: t(`hooks.event.${event}`)
                  }),
                  jsxs('div', {
                    className: 'flex shrink-0 items-center gap-2',
                    children: [
                      jsx('button', {
                        className:
                          'rounded-md border border-(--border) px-2 py-1 text-[0.625rem] text-(--ui-text-tertiary) transition-colors hover:border-(--ui-text-quaternary) hover:text-(--ui-text-primary)',
                        onClick: () => void test(event),
                        type: 'button',
                        children: t('hooks.test')
                      }),
                      jsx('button', {
                        className:
                          'rounded-md border border-(--border) px-2 py-1 text-[0.625rem] text-(--ui-text-tertiary) transition-colors hover:border-(--ui-text-quaternary) hover:text-(--ui-text-primary)',
                        onClick: () => add(event),
                        type: 'button',
                        children: `+ ${t('hooks.add')}`
                      })
                    ]
                  })
                ]
              }),
              draft.events[event].length
                ? draft.events[event].map((hook, index) => field(event, index, hook))
                : jsx('span', {
                    className: 'text-[0.625rem] text-(--ui-text-quaternary)',
                    children: t('hooks.empty')
                  })
            ]
          },
          event
        )
      ),
      jsxs('div', {
        className: 'flex items-center gap-3',
        children: [
          jsx('button', {
            className:
              'rounded-md border border-(--border) px-2.5 py-1 text-[0.6875rem] text-(--ui-text-secondary) transition-colors hover:border-(--ui-text-quaternary) hover:text-(--ui-text-primary) disabled:opacity-50',
            disabled: busy,
            onClick: () => void save().catch(error => $hooksNote.set(String(error?.message || error))),
            type: 'button',
            children: busy ? t('hooks.saving') : t('hooks.save')
          }),
          jsx('span', {
            className: 'min-w-0 flex-1 truncate text-[0.625rem] text-(--ui-text-quaternary)',
            children: note
          })
        ]
      })
    ]
  })
}

function PluginSettings({ ctx }) {
  const pluginT = usePluginI18n(PLUGIN_ID)
  const t = makeT(pluginT)
  const lang = useValue($lang)
  const ov = useValue($overrides)

  // Same key as the chip: React Query shares the cache, so the scan info costs no extra request.
  const { data } = useQuery({
    queryFn: () => ctx.rest('/state'),
    queryKey: STATE_KEY,
    placeholderData: previous => previous,
    refetchInterval: 15_000,
    retry: false,
    staleTime: 4000
  })
  const scan = data?.scan || {}
  const scanReady = typeof scan.count === 'number'
  const found = (scan.entries || []).filter(row => row.exists !== false)

  const options = LANGUAGE_OPTIONS.map(option =>
    option.id === 'auto' ? { ...option, label: t('settings.auto') } : option
  )

  const changeLang = next => {
    $lang.set(LANGS.includes(next) ? next : 'auto')
    ctx.storage.set(LANG_KEY, $lang.get())
  }

  return jsxs('div', {
    className: 'flex flex-col gap-5',
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-1.5',
        children: [
          jsx('div', { className: 'text-[0.8125rem] font-medium', children: t('settings.language') }),
          jsx(SegmentedControl, { onChange: changeLang, options, sizing: 'content', value: lang }),
          jsx('p', {
            className: 'max-w-md text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
            children: t('settings.languageHint')
          })
        ]
      }),
      jsx('div', { className: 'h-px w-full max-w-md bg-(--ui-stroke-secondary)' }),
      jsx(TextRow, {
        label: t('settings.idleLabel'),
        onChange: next => saveOverrides(ctx, { idleText: next }),
        placeholder: t('chip.mount'),
        value: ov.idleText || ''
      }),
      jsx(TextRow, {
        label: t('settings.ejectLabel'),
        onChange: next => saveOverrides(ctx, { ejectText: next }),
        placeholder: t('chip.eject'),
        value: ov.ejectText || ''
      }),
      jsx(IconRow, {
        label: t('settings.idleIcon'),
        onChange: next => saveOverrides(ctx, { idleIcon: next }),
        value: ov.idleIcon
      }),
      jsx(IconRow, {
        label: t('settings.loadedIcon'),
        onChange: next => saveOverrides(ctx, { loadedIcon: next }),
        value: ov.loadedIcon
      }),
      jsxs('div', {
        className: 'flex flex-col gap-2',
        children: [
          jsx('p', {
            className: 'max-w-md text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
            children: t('settings.overrideHint')
          }),
          jsx('button', {
            className:
              'w-fit text-[0.6875rem] text-(--ui-text-tertiary) underline-offset-2 hover:text-(--ui-text-primary) hover:underline',
            onClick: () => saveOverrides(ctx, { ...OVERRIDE_DEFAULTS }),
            type: 'button',
            children: t('settings.reset')
          })
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-2',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between gap-3',
            children: [
              jsx('div', { className: 'text-[0.8125rem] font-medium', children: t('refresh.title') }),
              jsx('button', {
                className:
                  'w-fit shrink-0 rounded-md border border-(--border) px-2.5 py-1 text-[0.6875rem] text-(--ui-text-secondary) transition-colors hover:border-(--ui-text-quaternary) hover:text-(--ui-text-primary)',
                onClick: () => void refreshModels(ctx),
                type: 'button',
                children: t('refresh.label')
              })
            ]
          }),
          jsx('p', {
            className: 'max-w-md text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
            children: t('refresh.hint')
          }),
          jsx('div', {
            className: 'flex max-w-md flex-col gap-1 rounded-md border border-(--border) px-3 py-2',
            children: !scanReady
              ? jsx('span', {
                  className: 'text-[0.6875rem] leading-relaxed text-(--ui-text-quaternary)',
                  children: t('refresh.stale')
                })
              : found.length
                ? found.map((row, index) =>
                  jsxs(
                    'div',
                    {
                      className: 'flex items-baseline justify-between gap-3',
                      children: [
                        jsxs('span', {
                          className: 'flex min-w-0 flex-col',
                          children: [
                            jsx('span', { className: 'truncate text-[0.6875rem]', children: shortName(row.id) }),
                            jsx('span', {
                              className: 'truncate text-[0.625rem] text-(--ui-text-quaternary)',
                              children: modelMeta(row.id)
                            })
                          ]
                        }),
                        jsx('span', {
                          className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)',
                          children: `${row.size_mb ? gb(row.size_mb) : '—'} · ${
                            row.staged ? t('refresh.staged') : t('refresh.unstaged')
                          }`
                        })
                      ]
                    },
                    `model-${row.id}-${index}`
                  )
                )
              : jsx('span', {
                  className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
                  children: t('refresh.empty')
                })
          }),
          jsx('span', {
            className: 'text-[0.625rem] text-(--ui-text-quaternary)',
            children:
              typeof scan.count === 'number'
                ? t('refresh.meta', found.length, String(scan.scanned_at || '—'))
                : ''
          })
        ]
      }),
      jsx(HooksSection, { ctx, t }),
      jsxs('div', {
        className: 'flex flex-col gap-2 border-t border-(--border) pt-4',
        children: [
          jsx('p', {
            className: 'max-w-md text-[0.6875rem] leading-relaxed text-(--ui-text-tertiary)',
            children: t('gc.hint')
          }),
          jsx('button', {
            className:
              'w-fit rounded-md border border-(--border) px-2.5 py-1 text-[0.6875rem] text-(--ui-text-secondary) transition-colors hover:border-(--ui-text-quaternary) hover:text-(--ui-text-primary)',
            onClick: () => void cleanVram(ctx),
            type: 'button',
            children: t('gc.run')
          })
        ]
      })
    ]
  })
}

// ── plugin ───────────────────────────────────────────────────

export default {
  id: PLUGIN_ID,
  name: 'Local Eject',
  register(ctx) {
    // Persisted choice; English is the built-in default (auto + an en app).
    const stored = ctx.storage.get(LANG_KEY, 'auto')

    $lang.set(LANGS.includes(stored) ? stored : 'auto')

    const storedOverrides = ctx.storage.get(OVR_KEY, {}) || {}

    $overrides.set({
      ejectText: typeof storedOverrides.ejectText === 'string' ? storedOverrides.ejectText : '',
      idleIcon: ICONS[storedOverrides.idleIcon] ? storedOverrides.idleIcon : OVERRIDE_DEFAULTS.idleIcon,
      idleText: typeof storedOverrides.idleText === 'string' ? storedOverrides.idleText : '',
      loadedIcon: ICONS[storedOverrides.loadedIcon] ? storedOverrides.loadedIcon : OVERRIDE_DEFAULTS.loadedIcon
    })

    ctx.i18n.register(NESTED)

    ctx.register({
      area: STATUSBAR_AREAS.right,
      id: 'chip',
      order: 115,
      render: () => jsx(EjectChip, { ctx })
    })

    // Palette + keybind labels are static once registered, so re-publish them
    // whenever the language changes (our pick or the app's locale).
    let disposeStatic = null

    const publish = () => {
      const t = makeT(ctx.i18n.t)

      disposeStatic?.()
      disposeStatic = ctx.registerMany([
        {
          area: PALETTE_AREA,
          data: {
            detail: () => {
              const read = makeT(ctx.i18n.t)
              const state = queryClient.getQueryData(STATE_KEY)

              if (!state) {
                return ''
              }

              const resident = state.resident || []

              return resident.length
                ? read('palette.ejectDetail.loaded', shortName(resident[0]), gb(state.vram?.used_mb))
                : read('palette.ejectDetail.idle')
            },
            detailVariant: 'state',
            id: `${PLUGIN_ID}.eject`,
            keywords: ['eject', 'unload', 'vram', 'llama', 'local', 'expulsar', 'liberar', '排出', '弹出'],
            label: t('palette.eject'),
            run: () => void ejectModel(ctx)
          },
          id: 'palette-eject'
        },
        {
          area: PALETTE_AREA,
          data: {
            detail: () => {
              const read = makeT(ctx.i18n.t)
              const state = queryClient.getQueryData(STATE_KEY)

              return state ? read(state.server ? 'palette.stopDetail.up' : 'palette.stopDetail.down') : ''
            },
            detailVariant: 'state',
            id: `${PLUGIN_ID}.stop`,
            keywords: ['stop', 'server', 'llama', 'detener', 'apagar', '停止'],
            label: t('palette.stop'),
            run: () => void stopServer(ctx)
          },
          id: 'palette-stop'
        },
        {
          area: PALETTE_AREA,
          data: {
            detail: () => makeT(ctx.i18n.t)('refresh.hint'),
            detailVariant: 'state',
            id: `${PLUGIN_ID}.refresh`,
            keywords: ['refresh', 'reload', 'scan', 'modelos', 'refrescar', 'モデル', '扫描'],
            label: t('refresh.label'),
            run: () => void refreshModels(ctx)
          },
          id: 'palette-refresh'
        },
        {
          area: PALETTE_AREA,
          data: {
            detail: () => makeT(ctx.i18n.t)('palette.gcDetail'),
            detailVariant: 'state',
            id: `${PLUGIN_ID}.gc`,
            keywords: ['zombie', 'gc', 'clean', 'orphan', 'vram', 'limpiar', 'huerfano', 'ゾンビ', '清理'],
            label: t('palette.gc'),
            run: () => void cleanVram(ctx)
          },
          id: 'palette-gc'
        },
        {
          area: KEYBINDS_AREA,
          data: {
            category: t('keybind.category'),
            defaults: ['mod+alt+e'],
            id: `${PLUGIN_ID}.eject-key`,
            label: t('keybind.eject'),
            run: () => void ejectModel(ctx)
          },
          id: 'keybind-eject'
        }
      ])
    }

    publish()
    ctx.i18n.onLocaleChange(publish)
    ctx.onDispose($lang.subscribe(publish))

    ctx.registerSettingsPage?.({
      id: 'settings',
      icon: 'zap',
      order: 120,
      render: () => jsx(PluginSettings, { ctx }),
      title: ctx.i18n.t('settings.title')
    })
  }
}
