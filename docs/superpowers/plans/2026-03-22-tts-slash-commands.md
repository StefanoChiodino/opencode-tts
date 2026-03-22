# TTS Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/tts full|summary|off|repeat|say <text>` slash command support to the opencode-tts plugin.

**Architecture:** All changes are in the single file `src/index.ts`. We retire `AUTO_ENABLED`, fix the `AssistantMessage` type usage, add a `savePluginConfig` helper, wire in the `command.execute.before` hook, and update the `session.idle` handler to branch on the new `ttsMode` variable.

**Tech Stack:** TypeScript, `@opencode-ai/plugin` SDK, Node.js `fs` module (built-in)

---

## File Map

| File | Change |
| --- | --- |
| `src/index.ts` | Only file modified — all changes are here |

---

### Task 1: Fix the `AssistantMessage` model type and rename `input` → `pluginInput`

**Files:**

- Modify: `src/index.ts`

The existing `latestAssistantMessageBySession` map stores `model?: AssistantMessage["model"]` which resolves to `never` because `AssistantMessage` has flat `modelID`/`providerID` fields, not a nested `model` object. Fix the value type and update all call sites. Also rename the `input` parameter of `OpenCodeTTSPlugin` to `pluginInput` throughout to avoid shadowing in the command hook added in Task 3.

- [ ] **Step 1: Fix the map value type**

In `src/index.ts`, find this line (around line 39):

```ts
const latestAssistantMessageBySession = new Map<string, { messageID: string; model?: AssistantMessage["model"] }>()
```

Replace with:

```ts
const latestAssistantMessageBySession = new Map<string, { messageID: string; providerID?: string; modelID?: string }>()
```

- [ ] **Step 2: Fix the write site for the map**

Find the `message.updated` handler (around line 491) that sets the map value:

```ts
latestAssistantMessageBySession.set(info.sessionID, {
  messageID: info.id,
  model: info.model,
})
```

Replace with:

```ts
latestAssistantMessageBySession.set(info.sessionID, {
  messageID: info.id,
  providerID: info.providerID,
  modelID: info.modelID,
})
```

- [ ] **Step 3: Fix the read site for the map**

Find the `session.idle` handler (around line 516) where `latest.model` is used as `sourceModel`:

```ts
const summary = await summarizeAndSpeak(input, text, latest.model)
```

Replace with:

```ts
const sourceModel = latest.providerID && latest.modelID
  ? { providerID: latest.providerID, modelID: latest.modelID }
  : undefined
const summary = await summarizeAndSpeak(pluginInput, text, sourceModel)
```

(The `pluginInput` rename happens in Step 4 — do both in the same edit pass.)

- [ ] **Step 4: Fix `resolveSummaryModel` and `summarizeText` parameter types**

Find `resolveSummaryModel` (around line 278):

```ts
async function resolveSummaryModel(
  client: Parameters<Plugin>[0]["client"],
  directory: string,
  source?: AssistantMessage["model"],
): Promise<SummaryModel | undefined> {
```

Replace the `source` parameter type:

```ts
async function resolveSummaryModel(
  client: Parameters<Plugin>[0]["client"],
  directory: string,
  source?: SummaryModel,
): Promise<SummaryModel | undefined> {
```

Find `summarizeText` (around line 311):

```ts
async function summarizeText(
  client: Parameters<Plugin>[0]["client"],
  directory: string,
  inputText: string,
  sourceModel?: AssistantMessage["model"],
) {
```

Replace:

```ts
async function summarizeText(
  client: Parameters<Plugin>[0]["client"],
  directory: string,
  inputText: string,
  sourceModel?: SummaryModel,
) {
```

- [ ] **Step 5: Fix `summarizeAndSpeak` parameter type**

Find `summarizeAndSpeak` (around line 460):

```ts
async function summarizeAndSpeak(
  input: Parameters<Plugin>[0],
  text: string,
  sourceModel?: AssistantMessage["model"],
  voice?: string,
) {
```

Replace the `sourceModel` parameter type:

```ts
async function summarizeAndSpeak(
  input: Parameters<Plugin>[0],
  text: string,
  sourceModel?: SummaryModel,
  voice?: string,
) {
```

- [ ] **Step 6: Rename `input` to `pluginInput` in `OpenCodeTTSPlugin`**

The exported plugin function currently starts:

```ts
export const OpenCodeTTSPlugin: Plugin = async (input) => {
  setPluginConfig(loadPluginConfigFromDisk())

  return {
    event: async ({ event }) => {
```

Rename `input` to `pluginInput` everywhere inside `OpenCodeTTSPlugin`. The usages are:

- `summarizeAndSpeak(input, text, ...)` in the `session.idle` handler (line 528)
- `logLine("event.session.idle", { sessionID, inputDirectory: input.directory })` (line 511)
- Any other reference to `input.$`, `input.client`, `input.directory` inside the function body

Replace all occurrences of `input` (as the plugin parameter) with `pluginInput`:

```ts
export const OpenCodeTTSPlugin: Plugin = async (pluginInput) => {
  setPluginConfig(loadPluginConfigFromDisk())

  return {
    event: async ({ event }) => {
      // ... (uses of `input` inside event handler become `pluginInput`)
```

- [ ] **Step 7: Build and verify no TypeScript errors**

```bash
cd /Users/stefano/repos/opencode-tts && node build.mjs
```

Expected: build succeeds with no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/stefano/repos/opencode-tts
git add src/index.ts
git commit -m "fix: correct AssistantMessage model type and rename plugin input param"
```

---

### Task 2: Replace `AUTO_ENABLED` with `ttsMode` and add `savePluginConfig`

**Files:**

- Modify: `src/index.ts`

Remove the `AUTO_ENABLED` constant and the `OPENCODE_TTS_AUTO` env var. Introduce `let ttsMode`. Add `savePluginConfig`. Update `session.idle` to branch on `ttsMode`. Add `writeFileSync` and `mkdirSync` to imports.

- [ ] **Step 1: Add `writeFileSync` and `mkdirSync` to fs imports**

Find the existing import (around line 5):

```ts
import { appendFileSync, readFileSync, unlinkSync } from "node:fs"
```

Replace with:

```ts
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
```

- [ ] **Step 2: Add `mode` field to `TTSPluginConfig`**

Find the type definition (around line 25):

```ts
type TTSPluginConfig = {
  enabled?: boolean
  debug?: boolean
  backend?: "edge_tts" | "say"
  edge_tts?: {
    command?: string[]
    voice?: string
    rate?: string
    volume?: string
  }
}
```

Replace with:

```ts
type TTSPluginConfig = {
  enabled?: boolean
  mode?: "full" | "summary"
  debug?: boolean
  backend?: "edge_tts" | "say"
  edge_tts?: {
    command?: string[]
    voice?: string
    rate?: string
    volume?: string
  }
}
```

- [ ] **Step 3: Replace `AUTO_ENABLED` constant with `ttsMode` variable**

Find and remove this line (around line 42):

```ts
const AUTO_ENABLED = readBooleanEnv("OPENCODE_TTS_AUTO", true)
```

Replace with:

```ts
let ttsMode: "full" | "summary" | "off" = "summary"
```

Also remove the `readBooleanEnv` helper function entirely if it is no longer used anywhere after this change. Check if any other call site uses it — if `AUTO_ENABLED` was the only use, delete `readBooleanEnv`.

- [ ] **Step 4: Initialize `ttsMode` from config inside `OpenCodeTTSPlugin`**

At the top of `OpenCodeTTSPlugin`, after `setPluginConfig(loadPluginConfigFromDisk())`, add:

```ts
const cfg = getPluginConfig()
ttsMode = cfg.enabled === false ? "off" : (cfg.mode ?? "summary")
```

- [ ] **Step 5: Remove the `config.enabled` guard inside `runTts`**

Find inside `runTts` (around line 383):

```ts
const config = getPluginConfig()
if (config.enabled === false) return
```

Remove just the `if (config.enabled === false) return` line. Keep the `const config = getPluginConfig()` line if it is used below for `backend` etc. (it is — `config.backend` is read on the next line).

- [ ] **Step 6: Update `session.idle` handler to branch on `ttsMode`**

Find the block inside the `session.idle` handler that currently reads (around line 507):

```ts
if (!AUTO_ENABLED) return
if (event.type !== "session.idle") return
```

Remove the `if (!AUTO_ENABLED) return` line entirely. The `ttsMode` check goes later, just before the speak call. Find the block (around line 528):

```ts
const summary = await summarizeAndSpeak(pluginInput, text, sourceModel)
spokenAssistantMessages.add(latest.messageID)
```

Replace with (the replacement must cover lines 528–534, including the `console.log` and `logLine` calls that use `summary` — do not stop at `spokenAssistantMessages.add`):

```ts
if (ttsMode === "off") return

let summary: string
if (ttsMode === "full") {
  await runTts(pluginInput.$, text)
  summary = text
} else {
  summary = await summarizeAndSpeak(pluginInput, text, sourceModel)
}
spokenAssistantMessages.add(latest.messageID)

if (getPluginConfig().debug) {
  console.log(`[opencode-tts] ${summary}`)
}
logLine("event.session.idle.spoken", { sessionID, messageID: latest.messageID, summary })
```

- [ ] **Step 7: Add `savePluginConfig` function**

Add this function after `setPluginConfig` (around line 131):

```ts
function savePluginConfig(updates: Partial<TTSPluginConfig>) {
  Object.assign(currentPluginConfig, updates)
  try {
    const dir = path.dirname(PLUGIN_CONFIG_PATHS[0])
    mkdirSync(dir, { recursive: true })
    writeFileSync(PLUGIN_CONFIG_PATHS[0], JSON.stringify(currentPluginConfig, null, 2), "utf8")
  } catch (err) {
    logLine("savePluginConfig.error", serializeUnknown(err))
  }
}
```

- [ ] **Step 8: Build and verify**

```bash
cd /Users/stefano/repos/opencode-tts && node build.mjs
```

Expected: build succeeds with no errors.

- [ ] **Step 9: Commit**

```bash
cd /Users/stefano/repos/opencode-tts
git add src/index.ts
git commit -m "feat: replace AUTO_ENABLED with ttsMode, add savePluginConfig, branch session.idle on mode"
```

---

### Task 3: Add `command.execute.before` hook for `/tts` commands

**Files:**

- Modify: `src/index.ts`

Add the `"command.execute.before"` hook to the returned `Hooks` object. Implement dispatch for all five subcommands: `full`, `summary`, `off`, `repeat`, `say`.

- [ ] **Step 1: Add the hook to the returned Hooks object**

Find the end of `OpenCodeTTSPlugin` where it returns the hooks object (around line 484):

```ts
return {
  event: async ({ event }) => {
    // ...
  },
}
```

Add the `"command.execute.before"` hook alongside `event`:

```ts
return {
  event: async ({ event }) => {
    // ... (unchanged)
  },
  "command.execute.before": async (cmdInput, output) => {
    if (cmdInput.command !== "tts") return

    const args = cmdInput.arguments.trim()
    const spaceIdx = args.indexOf(" ")
    const subcommand = spaceIdx === -1 ? args : args.slice(0, spaceIdx)
    const rest = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim()

    const pushText = (text: string) => {
      output.parts.push({ type: "text", text, synthetic: true } as Part)
    }

    if (subcommand === "full" || subcommand === "summary" || subcommand === "off") {
      ttsMode = subcommand
      savePluginConfig({
        enabled: subcommand !== "off",
        mode: subcommand === "off" ? undefined : subcommand,
      })
      pushText(`TTS mode set to: ${subcommand}`)
      return
    }

    if (subcommand === "say") {
      if (!rest) {
        pushText("Usage: /tts say <text>")
        return
      }
      try {
        await runTts(pluginInput.$, rest)
        pushText(`Speaking: ${rest}`)
      } catch (err) {
        pushText(`TTS error: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (subcommand === "repeat") {
      const latest = latestAssistantMessageBySession.get(cmdInput.sessionID)
      if (!latest) {
        pushText("No assistant message found in this session")
        return
      }
      const text = assistantTextByMessage.get(latest.messageID)
      if (!text) {
        pushText("No assistant message found in this session")
        return
      }
      const sourceModel = latest.providerID && latest.modelID
        ? { providerID: latest.providerID, modelID: latest.modelID }
        : undefined
      try {
        if (ttsMode === "full") {
          await runTts(pluginInput.$, text)
        } else {
          await summarizeAndSpeak(pluginInput, text, sourceModel)
        }
        pushText("Repeating last message")
      } catch (err) {
        pushText(`TTS error: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    pushText("Unknown /tts subcommand. Use: full, summary, off, repeat, say <text>")
  },
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/stefano/repos/opencode-tts && node build.mjs
```

Expected: build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/stefano/repos/opencode-tts
git add src/index.ts
git commit -m "feat: add /tts slash command handler (full, summary, off, repeat, say)"
```

---

### Task 4: Smoke test manually and tag

**Files:**

- None modified

Manual verification that the plugin loads and the commands work end-to-end in a live opencode session.

- [ ] **Step 1: Rebuild the plugin**

```bash
cd /Users/stefano/repos/opencode-tts && node build.mjs
```

- [ ] **Step 2: Verify the built output exists**

```bash
ls -la /Users/stefano/repos/opencode-tts/dist/
```

Expected: `index.js` (or similar) present with a recent timestamp.

- [ ] **Step 3: Manual smoke test checklist**

Start opencode in a project directory. Try each command and confirm the expected behavior:

1. `/tts off` — response: `"TTS mode set to: off"`. Auto-TTS silent on next assistant reply.
2. `/tts full` — response: `"TTS mode set to: full"`. Auto-TTS speaks full text on next reply.
3. `/tts summary` — response: `"TTS mode set to: summary"`. Auto-TTS summarizes on next reply.
4. `/tts say hello world` — speaks "hello world" immediately. Response: `"Speaking: hello world"`.
5. `/tts repeat` — re-speaks the last assistant message. Response: `"Repeating last message"`.
6. `/tts repeat` with no prior message — response: `"No assistant message found in this session"`.
7. `/tts` with no subcommand — response: `"Unknown /tts subcommand. Use: full, summary, off, repeat, say <text>"`.
8. After `/tts off`, run `/tts say test` — should still speak (explicit command bypasses off mode).
9. After `/tts off` and a reply, run `/tts repeat` — should still speak (explicit command bypasses off mode).
10. Restart opencode after `/tts full`, verify mode is restored from config file.

- [ ] **Step 4: Commit if any fixups were needed, then create a version bump commit**

```bash
cd /Users/stefano/repos/opencode-tts
git add src/index.ts
git commit -m "chore: bump version for /tts slash command release"
```

(Skip the commit if no fixups were needed — the previous commits are the release.)
