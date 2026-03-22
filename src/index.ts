import type { Plugin } from "@opencode-ai/plugin"
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk"
import os from "node:os"
import path from "node:path"
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"

type SummaryModel = {
  providerID: string
  modelID: string
}

type ProviderOptions = {
  baseURL?: string
  apiKey?: string
}

type OpenCodeConfig = {
  model?: string
  small_model?: string
  provider?: Record<string, { options?: ProviderOptions }>
}

type MaybeData<T> = T | { data: T }

type TTSPluginConfig = {
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

type TTSState = {
  mode?: "full" | "summary" | "off"
}

const spokenAssistantMessages = new Set<string>()
const inFlightSessions = new Set<string>()
const latestAssistantMessageBySession = new Map<string, { messageID: string; providerID?: string; modelID?: string }>()
const assistantTextByMessage = new Map<string, string>()

let ttsMode: "full" | "summary" | "off" = "summary"
const DEFAULT_VOICE = process.env.OPENCODE_TTS_VOICE
const MAX_SENTENCES = clampNumber(readNumberEnv("OPENCODE_TTS_MAX_SENTENCES", 2), 1, 3)
const SUMMARY_PROVIDER = process.env.OPENCODE_TTS_SUMMARY_PROVIDER
const SUMMARY_MODEL = process.env.OPENCODE_TTS_SUMMARY_MODEL
const DEFAULT_EDGE_TTS_COMMAND = ["edge-tts"]
const OPENCODE_DIR = path.join(os.homedir(), ".config", "opencode")
const VENV_DIR = path.join(OPENCODE_DIR, "tts-venv")
const VENV_PYTHON = path.join(VENV_DIR, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python")
const VENV_EDGE_TTS_COMMAND = [VENV_PYTHON, "-m", "edge_tts"]
const DEFAULT_EDGE_TTS_VOICE = "en-US-AvaMultilingualNeural"
const DEFAULT_EDGE_TTS_RATE = "+25%"
const DEFAULT_EDGE_TTS_VOLUME = "+0%"
const PLUGIN_CONFIG_PATHS = [
  path.join(OPENCODE_DIR, "plugins", "opencode-tts.jsonc"),
  path.join(OPENCODE_DIR, "plugin", "opencode-tts.jsonc"),
]
const STATE_FILE_PATH = path.join(OPENCODE_DIR, "plugins", "opencode-tts-state.json")
const LOG_PATH = path.join(OPENCODE_DIR, "logs", "opencode-tts.log")
let currentPluginConfig: TTSPluginConfig = {}

function readNumberEnv(name: string, fallback: number) {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function stripThinkingTags(value: string) {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<\/?think>/gi, " ")
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, " ")
    .replace(/<\/?reflection>/gi, " ")
}

function sanitizeForSpeech(value: string) {
  return normalizeText(stripThinkingTags(value))
}

function stripJsonComments(value: string) {
  return value.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
}

function unwrapData<T>(value: MaybeData<T>): T {
  if (value && typeof value === "object" && "data" in value) return value.data
  return value as T
}

function logLine(message: string, extra?: unknown) {
  try {
    const config = getPluginConfig()
    if (!config.debug) return
    const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}${suffix}\n`)
  } catch {
    // Ignore logging failures.
  }
}

function normalizePluginConfig(config?: TTSPluginConfig): TTSPluginConfig {
  return config ?? {}
}

function loadPluginConfigFromDisk(): TTSPluginConfig {
  for (const configPath of PLUGIN_CONFIG_PATHS) {
    try {
      const content = readFileSync(configPath, "utf8")
      return normalizePluginConfig(JSON.parse(stripJsonComments(content)) as TTSPluginConfig)
    } catch {
      // Try the next supported location.
    }
  }
  return {}
}

function setPluginConfig(config?: TTSPluginConfig) {
  currentPluginConfig = normalizePluginConfig(config)
}

function saveState(state: TTSState) {
  try {
    const dir = path.dirname(STATE_FILE_PATH)
    mkdirSync(dir, { recursive: true })
    writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), "utf8")
  } catch (err) {
    logLine("saveState.error", serializeUnknown(err))
  }
}

function loadState(): TTSState {
  try {
    const content = readFileSync(STATE_FILE_PATH, "utf8")
    return JSON.parse(content) as TTSState
  } catch {
    return {}
  }
}

function getPluginConfig() {
  if (Object.keys(currentPluginConfig).length === 0) {
    currentPluginConfig = loadPluginConfigFromDisk()
  }
  return currentPluginConfig
}

async function findPython(shell: Parameters<Plugin>[0]["$"]): Promise<string | undefined> {
  for (const candidate of ["python3", "python"]) {
    const check = await shell`${candidate} --version`.nothrow().quiet()
    if (check.exitCode === 0) return candidate
  }
  return undefined
}

async function ensureEdgeTts(shell: Parameters<Plugin>[0]["$"]): Promise<void> {
  // Already installed in our venv?
  const venvCheck = await shell`${VENV_PYTHON} -c "import edge_tts"`.nothrow().quiet()
  if (venvCheck.exitCode === 0) return

  logLine("edge_tts.install.start", { venvDir: VENV_DIR })

  const python = await findPython(shell)
  if (!python) {
    logLine("edge_tts.install.no-python")
    return
  }

  // Create venv if it doesn't exist yet
  const venvSetup = await shell`${python} -m venv ${VENV_DIR}`.nothrow().quiet()
  if (venvSetup.exitCode !== 0) {
    logLine("edge_tts.install.venv-failed", { stderr: venvSetup.stderr.toString() })
    return
  }

  // Install edge-tts into the venv
  const install = await shell`${VENV_PYTHON} -m pip install --quiet edge-tts`.nothrow().quiet()
  if (install.exitCode !== 0) {
    logLine("edge_tts.install.pip-failed", { stderr: install.stderr.toString() })
    return
  }

  logLine("edge_tts.install.success")
}

async function resolveEdgeTtsCommand(shell: Parameters<Plugin>[0]["$"], configured?: string[]) {
  if (configured?.length) return configured

  // Auto-install into our managed venv if needed
  await ensureEdgeTts(shell)

  // Prefer our managed venv
  const venvCheck = await shell`${VENV_PYTHON} -c "import edge_tts"`.nothrow().quiet()
  if (venvCheck.exitCode === 0) return VENV_EDGE_TTS_COMMAND

  // Fall back to whatever is on PATH
  const binary = await shell`command -v edge-tts`.nothrow().quiet()
  if (binary.exitCode === 0) return DEFAULT_EDGE_TTS_COMMAND

  const pythonModule = await shell`python3 -c "import edge_tts"`.nothrow().quiet()
  if (pythonModule.exitCode === 0) return ["python3", "-m", "edge_tts"]

  return DEFAULT_EDGE_TTS_COMMAND
}

function getTextParts(parts: Part[]) {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .filter((part) => !part.ignored)
    .map((part) => part.text)
}

function extractPromptParts(value: unknown): Part[] {
  if (!value || typeof value !== "object") return []

  const record = value as Record<string, unknown>
  if (Array.isArray(record.parts)) return record.parts as Part[]
  if (record.data && typeof record.data === "object") {
    const nested = record.data as Record<string, unknown>
    if (Array.isArray(nested.parts)) return nested.parts as Part[]
  }
  return []
}

function describeResponseShape(value: unknown) {
  if (!value || typeof value !== "object") return { type: typeof value }
  const record = value as Record<string, unknown>
  return {
    keys: Object.keys(record),
    dataKeys:
      record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? Object.keys(record.data as Record<string, unknown>)
        : undefined,
    hasParts: Array.isArray(record.parts),
    hasDataParts:
      !!record.data && typeof record.data === "object" && Array.isArray((record.data as Record<string, unknown>).parts),
  }
}

function serializeUnknown(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (!value || typeof value !== "object") return value

  const record = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (key === "request") continue
    if (key === "response" && entry && typeof entry === "object") {
      const response = entry as Response
      output.response = {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        url: response.url,
      }
      continue
    }
    output[key] = entry
  }
  return output
}

function fallbackSummaryFromText(text: string) {
  const normalized = sanitizeForSpeech(text)
  const sentences = normalized.match(/[^.!?]+[.!?]+/g) ?? [normalized]
  return normalizeText(sentences.slice(0, MAX_SENTENCES).join(" "))
}

function parseModel(model: string): SummaryModel {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  }
}

async function resolveSummaryModel(
  client: Parameters<Plugin>[0]["client"],
  directory: string,
  source?: SummaryModel,
): Promise<SummaryModel | undefined> {
  if (SUMMARY_PROVIDER && SUMMARY_MODEL) {
    return {
      providerID: SUMMARY_PROVIDER,
      modelID: SUMMARY_MODEL,
    }
  }

  const config = await legacyConfigGet(client, directory)
    .then((result) => unwrapData(result as MaybeData<OpenCodeConfig>))
    .catch(() => undefined)

  if (config?.small_model) return parseModel(config.small_model)
  if (config?.model) return parseModel(config.model)

  const providerID = source?.providerID
  const modelID = source?.modelID
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

async function legacyConfigGet(client: Parameters<Plugin>[0]["client"], directory: string) {
  return client.config.get({
    query: { directory },
    throwOnError: false,
  } as any)
}


async function summarizeText(
  client: Parameters<Plugin>[0]["client"],
  directory: string,
  inputText: string,
  sourceModel?: SummaryModel,
) {
  logLine("summarize.start", { directory, inputLength: inputText.length, sourceModel })

  const summaryModel = await resolveSummaryModel(client, directory, sourceModel)
  logLine("summarize.model", { summaryModel })
  if (!summaryModel) throw new Error("no model available for summarization")

  const config = await legacyConfigGet(client, directory)
    .then((result) => unwrapData(result as MaybeData<OpenCodeConfig>))
    .catch(() => undefined)

  const providerOptions = config?.provider?.[summaryModel.providerID]?.options
  const baseURL = providerOptions?.baseURL
  const apiKey = providerOptions?.apiKey ?? "local"
  if (!baseURL) throw new Error(`no baseURL found for provider ${summaryModel.providerID}`)

  const summaryPrompt = [
    `Summarize the following assistant response as spoken audio copy in no more than ${MAX_SENTENCES} short sentences.`,
    "Keep concrete facts, decisions, and next actions.",
    "Do not mention that this is a summary.",
    "Paraphrase instead of copying the opening words when possible.",
    "Never output chain-of-thought, think tags, reflection tags, or XML-like tags.",
    "Do not use bullets, numbering, markdown, or preamble.",
    "",
    sanitizeForSpeech(inputText),
  ].join("\n")

  logLine("summarize.direct.request", { baseURL, modelID: summaryModel.modelID })
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: summaryModel.modelID,
      messages: [
        { role: "system", content: "You are a compression model. Reply with plain text only." },
        { role: "user", content: summaryPrompt },
      ],
      max_tokens: 200,
      stream: false,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`summarization request failed: ${response.status} ${body}`)
  }

  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const summary = sanitizeForSpeech(json.choices?.[0]?.message?.content ?? "")
  logLine("summarize.response.text", { summary })
  if (!summary) throw new Error("summary model returned no text")
  logLine("summarize.success", { summary })
  return summary
}

async function runTts(
  shell: Parameters<Plugin>[0]["$"],
  text: string,
  voice = DEFAULT_VOICE,
) {
  const normalized = sanitizeForSpeech(text)
  if (!normalized) return

  const config = getPluginConfig()

  const backend = config.backend ?? "edge_tts"

  if (backend === "edge_tts") {
    const command = await resolveEdgeTtsCommand(shell, config.edge_tts?.command)
    const edgeVoice = voice ?? config.edge_tts?.voice ?? DEFAULT_EDGE_TTS_VOICE
    const rate = config.edge_tts?.rate ?? DEFAULT_EDGE_TTS_RATE
    const volume = config.edge_tts?.volume ?? DEFAULT_EDGE_TTS_VOLUME
    const outputPath = path.join(
      os.tmpdir(),
      `opencode-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`,
    )

    try {
      logLine("tts.edge_tts.start", { command, voice: edgeVoice, rate, volume, outputPath })
      const escaped = command.map((item) => shell.escape(item)).join(" ")
      const runner = shell.nothrow()
      const tts = await runner`${{ raw: `${escaped} --voice ${shell.escape(edgeVoice)} --rate ${shell.escape(rate)} --volume ${shell.escape(volume)} --text ${shell.escape(normalized)} --write-media ${shell.escape(outputPath)}` }}`.quiet()
      if (tts.exitCode !== 0) {
        logLine("tts.edge_tts.failed", { exitCode: tts.exitCode, stderr: tts.stderr.toString() })
        throw new Error(`edge_tts exited with code ${tts.exitCode}`)
      }
      logLine("tts.edge_tts.generated", { outputPath })

      if (process.platform === "darwin") {
        await shell`/usr/bin/afplay ${outputPath}`.quiet()
        logLine("tts.playback.afplay.success", { outputPath })
        return
      }

      const ffplay = await shell`command -v ffplay`.nothrow().quiet()
      if (ffplay.exitCode === 0) {
        await shell`ffplay -nodisp -autoexit -loglevel quiet ${outputPath}`.quiet()
        return
      }

      const mpg123 = await shell`command -v mpg123`.nothrow().quiet()
      if (mpg123.exitCode === 0) {
        await shell`mpg123 -q ${outputPath}`.quiet()
        return
      }

      throw new Error("No audio player found for edge_tts output. Install `afplay`, `ffplay`, or `mpg123`.")
    } finally {
      try {
        unlinkSync(outputPath)
      } catch {
        // Ignore cleanup failures for temp audio files.
      }
    }
  }

  if (process.platform === "darwin") {
    if (voice) {
      await shell`/usr/bin/say -v ${voice} ${normalized}`.quiet()
      return
    }
    await shell`/usr/bin/say ${normalized}`.quiet()
    return
  }

  const spdSay = await shell`command -v spd-say`.nothrow().quiet()
  if (spdSay.exitCode === 0) {
    await shell`spd-say ${normalized}`.quiet()
    return
  }

  const espeak = await shell`command -v espeak`.nothrow().quiet()
  if (espeak.exitCode === 0) {
    await shell`espeak ${normalized}`.quiet()
    return
  }

  throw new Error("No supported TTS command found. Install `say`, `spd-say`, or `espeak`.")
}

async function summarizeAndSpeak(
  input: Parameters<Plugin>[0],
  text: string,
  sourceModel?: SummaryModel,
  voice?: string,
) {
  let summary: string
  try {
    summary = await summarizeText(input.client, input.directory, text, sourceModel)
  } catch (error) {
    logLine("summarize.error", serializeUnknown(error))
    summary = fallbackSummaryFromText(text)
    logLine("summarize.fallback", {
      reason: error instanceof Error ? error.message : String(error),
      summary,
    })
  }
  await runTts(input.$, summary, voice)
  return summary
}

export const OpenCodeTTSPlugin: Plugin = async (pluginInput) => {
  setPluginConfig(loadPluginConfigFromDisk())
  const state = loadState()
  ttsMode = state.mode ?? getPluginConfig().mode ?? "summary"

  return {
    event: async ({ event }) => {
      logLine("event.received", { type: event.type })

      if (event.type === "message.updated") {
        const info = event.properties.info as Message
        if (info.role === "assistant") {
          latestAssistantMessageBySession.set(info.sessionID, {
            messageID: info.id,
            providerID: info.providerID,
            modelID: info.modelID,
          })
          logLine("message.updated.assistant", { sessionID: info.sessionID, messageID: info.id })
        }
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part
        if (part.type === "text") {
          assistantTextByMessage.set(part.messageID, sanitizeForSpeech(part.text))
          logLine("message.part.updated.text", { messageID: part.messageID, length: part.text.length })
        }
      }

      if (event.type !== "session.idle") return

      const sessionID = event.properties.sessionID
      logLine("event.session.idle", { sessionID, inputDirectory: pluginInput.directory })
      if (inFlightSessions.has(sessionID)) return

      inFlightSessions.add(sessionID)

      try {
        const latest = latestAssistantMessageBySession.get(sessionID)
        if (!latest) {
          logLine("event.session.idle.no-latest-message", { sessionID })
          return
        }
        if (spokenAssistantMessages.has(latest.messageID)) return

        const text = sanitizeForSpeech(assistantTextByMessage.get(latest.messageID) ?? "")
        logLine("event.session.idle.cached-text", { sessionID, messageID: latest.messageID, textLength: text.length })
        if (!text) return

        const sourceModel = latest.providerID && latest.modelID
          ? { providerID: latest.providerID, modelID: latest.modelID }
          : undefined

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
      } catch (error) {
        console.error("[opencode-tts] failed to summarize and speak", error)
        logLine("event.session.idle.error", {
          sessionID,
          error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
        })
      } finally {
        inFlightSessions.delete(sessionID)
      }
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
        saveState({ mode: subcommand })
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
}

export default OpenCodeTTSPlugin
