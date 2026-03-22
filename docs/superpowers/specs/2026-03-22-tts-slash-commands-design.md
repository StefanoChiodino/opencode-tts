# TTS Slash Commands Design

**Date:** 2026-03-22
**Status:** Approved

## Overview

Add `/tts` slash command support to the opencode-tts plugin, giving users runtime control over TTS mode and on-demand speech without leaving opencode.

## Commands

| Command | Behavior |
| --- | --- |
| `/tts full` | Switch to full mode — speak raw sanitized assistant text |
| `/tts summary` | Switch to summary mode — summarize then speak (existing auto behavior) |
| `/tts off` | Disable automatic TTS |
| `/tts repeat` | Re-summarize and speak the last assistant message in the current session |
| `/tts say <text>` | Speak the provided text immediately using current backend/voice |

All mode commands (`full`, `summary`, `off`) confirm the change with a text part response visible in the session. `/tts repeat` and `/tts say` work even when `ttsMode === "off"` — they are explicit user actions and always fire.

## State

### In-memory

A module-level `let ttsMode: "full" | "summary" | "off"` variable replaces the `AUTO_ENABLED` constant. Initialized inside `OpenCodeTTSPlugin` from persisted config (not at declaration time). `AUTO_ENABLED` and the `OPENCODE_TTS_AUTO` environment variable are both retired — users should use `/tts off` instead.

### Persistence

Mode changes write to `~/.config/opencode/plugins/opencode-tts.jsonc` (`PLUGIN_CONFIG_PATHS[0]`):

- `enabled: false` when mode is `"off"`, `true` otherwise
- New `mode: "full" | "summary"` field stores the active non-off mode

Note: if the user's existing config lives at `PLUGIN_CONFIG_PATHS[1]` (the `plugin/` path), the first `/tts` mode change will create a new file at `PLUGIN_CONFIG_PATHS[0]`. From that point forward `PLUGIN_CONFIG_PATHS[0]` wins on load (it is checked first). The old file at `[1]` is left in place but ignored. This is an acceptable silent migration.

`TTSPluginConfig` gains:

```ts
mode?: "full" | "summary"
```

### Load logic

```text
if config.enabled === false → ttsMode = "off"
else ttsMode = config.mode ?? "summary"
```

## Command Handler

Registered as the `"command.execute.before"` key in the returned `Hooks` object:

```ts
return {
  event: ...,
  "command.execute.before": async (cmdInput, output) => { ... }
}
```

The hook callback parameter is named `cmdInput` (not `input`) to avoid shadowing the outer `pluginInput` from the `OpenCodeTTSPlugin` closure. The outer plugin parameter should be renamed `pluginInput` at the top of `OpenCodeTTSPlugin` to make this clear.

The hook fires with:

- `cmdInput.command` — the command name (we check `=== "tts"`)
- `cmdInput.sessionID` — the current session
- `cmdInput.arguments` — everything after `/tts`

The `pluginInput.$`, `pluginInput.client`, and `pluginInput.directory` needed by `summarizeAndSpeak` and `runTts` come from the outer `OpenCodeTTSPlugin` closure.

### Dispatch

Split `cmdInput.arguments` on the first space to get `subcommand` and `rest`.

| subcommand | action |
| --- | --- |
| `"full"` \| `"summary"` \| `"off"` | set `ttsMode`, persist config, push confirmation text part |
| `"repeat"` | re-speak last session message (see below), push status part |
| `"say"` | call `runTts(pluginInput.$, rest)`, push status part |
| anything else | push error part: `"Unknown /tts subcommand. Use: full, summary, off, repeat, say <text>"` |

`output.parts` always receives at least one part so the user gets visible feedback.

### Part construction

`TextPart` in the installed SDK requires `id`, `sessionID`, `messageID`, `type`, and `text`. For synthetic command-response parts, cast to satisfy the type and set `synthetic: true`:

```ts
output.parts.push({ type: "text", text: "TTS mode set to: full", synthetic: true } as Part)
```

Use `as Part` cast since we cannot supply a real `id`/`sessionID`/`messageID` in a command handler context.

## `runTts` guard change

The existing `if (config.enabled === false) return` guard inside `runTts` is **removed**. `ttsMode` is now the sole runtime gate. This ensures `/tts say` and `/tts repeat` always fire even when auto-TTS is off.

## Auto-TTS behavior (session.idle)

The `session.idle` handler checks `ttsMode` instead of `AUTO_ENABLED`:

- `"off"` → return early (no speech)
- `"summary"` → existing `summarizeAndSpeak` path
- `"full"` → call `runTts` directly with full sanitized text, skip summarization

## repeat behavior

1. Look up `latestAssistantMessageBySession.get(cmdInput.sessionID)`
2. Get text from `assistantTextByMessage.get(messageID)`
3. If no text: push error part `"No assistant message found in this session"` and return
4. Dispatch on mode: `"full"` → call `runTts` directly; `"summary"` or `"off"` → run `summarizeAndSpeak`
5. Push confirmation part: `"Repeating last message"`

The dispatch rule is: `"full"` maps to raw speech; everything else (including `"off"`) maps to summarize-and-speak.

### latestAssistantMessageBySession value type

`AssistantMessage` in the installed SDK has flat `modelID: string` and `providerID: string` fields — there is no nested `model` property. The existing map value type `{ messageID: string; model?: AssistantMessage["model"] }` resolves `model` to `never`. Fix the value type to:

```ts
{ messageID: string; providerID?: string; modelID?: string }
```

Store `providerID` and `modelID` from the `AssistantMessage` directly. When passing to `summarizeAndSpeak`/`resolveSummaryModel`, construct `sourceModel` as `{ providerID, modelID }` if both are present, otherwise `undefined`.

Also update the `sourceModel` parameter type in `resolveSummaryModel` and `summarizeText` from `AssistantMessage["model"]` to `SummaryModel | undefined`. `SummaryModel` is already defined in the file and has exactly the right shape (`{ providerID: string; modelID: string }`).

`/tts repeat` does **not** touch `inFlightSessions`. If auto-TTS is concurrently in flight the audio may overlap — this is acceptable.

## Config file write

Add `writeFileSync` and `mkdirSync` to the `node:fs` imports.

A new `savePluginConfig(updates: Partial<TTSPluginConfig>)` function:

- Merges `updates` directly into the in-memory `currentPluginConfig` object (does not re-read from disk)
- Calls `mkdirSync(dir, { recursive: true })` on the parent directory before writing
- Writes the merged object as pretty-printed JSON (`JSON.stringify(obj, null, 2)`) to `PLUGIN_CONFIG_PATHS[0]`
- On write failure: logs if debug enabled, silently continues. The in-memory mode change takes effect for the session regardless
- Does not update `currentPluginConfig` on write failure (the merge into `currentPluginConfig` happens before the write attempt, so it is already reflected in memory)

## Out of scope

- `/tts uninstall` — opencode does not persist slash commands; nothing to clean up
- Tests — no test infrastructure exists in this repo; consistent with current codebase
- Voice/rate/volume control via commands — not requested
