import type { Plugin } from "@opencode-ai/plugin"
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk"
import os from "node:os"
import path from "node:path"
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"

type SummaryModel = {
  providerID: string
  modelID: string
}

type OpenCodeConfig = {
  model?: string
  small_model?: string
  provider?: Record<string, unknown>
}

type MaybeData<T> = T | { data: T }

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

const spokenAssistantMessages = new Set<string>()
const ignoredSessionIDs = new Set<string>()
const inFlightSessions = new Set<string>()
const latestAssistantMessageBySession = new Map<string, { messageID: string; model?: AssistantMessage["model"] }>()
const assistantTextByMessage = new Map<string, string>()
const latestTextMessageBySession = new Map<string, string>()
const summarySessionIdleResolvers = new Map<string, () => void>()

const AUTO_ENABLED = readBooleanEnv("OPENCODE_TTS_AUTO", true)
const DEFAULT_VOICE = process.env.OPENCODE_TTS_VOICE
const MAX_SENTENCES = clampNumber(readNumberEnv("OPENCODE_TTS_MAX_SENTENCES", 2), 1, 3)
const SUMMARY_PROVIDER = process.env.OPENCODE_TTS_SUMMARY_PROVIDER
const SUMMARY_MODEL = process.env.OPENCODE_TTS_SUMMARY_MODEL
const DEFAULT_EDGE_TTS_COMMAND = ["edge-tts"]
const PRIVATE_EDGE_TTS_COMMAND = [path.join(os.homedir(), ".opencode-tts", ".venv", "bin", "python"), "-m", "edge_tts"]
const DEFAULT_EDGE_TTS_VOICE = "en-US-AvaMultilingualNeural"
const DEFAULT_EDGE_TTS_RATE = "+25%"
const DEFAULT_EDGE_TTS_VOLUME = "+0%"
const PLUGIN_CONFIG_PATHS = [
  path.join(os.homedir(), ".config", "opencode", "plugins", "opencode-tts.jsonc"),
  path.join(os.homedir(), ".config", "opencode", "plugin", "opencode-tts.jsonc"),
]
const LOG_DIR = path.join(os.homedir(), ".opencode-tts")
const LOG_PATH = path.join(LOG_DIR, "plugin.log")
let currentPluginConfig: TTSPluginConfig = {}

function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]
  if (!value) return fallback
  return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

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
    mkdirSync(LOG_DIR, { recursive: true })
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

function getPluginConfig() {
  if (Object.keys(currentPluginConfig).length === 0) {
    currentPluginConfig = loadPluginConfigFromDisk()
  }
  return currentPluginConfig
}

async function resolveEdgeTtsCommand(shell: Parameters<Plugin>[0]["$"], configured?: string[]) {
  if (configured?.length) return configured

  const [privatePython] = PRIVATE_EDGE_TTS_COMMAND
  const privateCheck = await shell`${privatePython} -c "import edge_tts"`.nothrow().quiet()
  if (privateCheck.exitCode === 0) return PRIVATE_EDGE_TTS_COMMAND

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
  source?: AssistantMessage["model"],
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

async function legacySessionCreate(client: Parameters<Plugin>[0]["client"], directory: string, title: string) {
  return client.session.create({
    query: { directory },
    body: { title },
    throwOnError: true,
  } as any)
}

async function legacySessionPromptAsync(
  client: Parameters<Plugin>[0]["client"],
  input: {
    sessionID: string
    directory: string
    model?: SummaryModel
    system?: string
    tools?: Record<string, boolean>
    format?: { type: "text" }
    parts: Array<{ type: "text"; text: string }>
  },
) {
  return (client.session as any).promptAsync({
    path: { id: input.sessionID },
    query: { directory: input.directory },
    body: {
      model: input.model,
      system: input.system,
      tools: input.tools,
      format: input.format,
      parts: input.parts,
    },
    throwOnError: false,
  })
}

async function legacySessionDelete(client: Parameters<Plugin>[0]["client"], directory: string, sessionID: string) {
  return client.session.delete({
    path: { id: sessionID },
    query: { directory },
    throwOnError: false,
  } as any)
}

async function summarizeText(
  client: Parameters<Plugin>[0]["client"],
  directory: string,
  inputText: string,
  sourceModel?: AssistantMessage["model"],
) {
  logLine("summarize.start", { directory, inputLength: inputText.length, sourceModel })
  const created = await legacySessionCreate(client, directory, "opencode-tts-summary")

  const summarySessionID = unwrapData(created as MaybeData<{ id: string }>).id
  ignoredSessionIDs.add(summarySessionID)
  logLine("summarize.session.created", { summarySessionID })

  try {
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

    const summaryModel = await resolveSummaryModel(client, directory, sourceModel)
    logLine("summarize.model", { summaryModel })
    const requestBody = {
      ...(summaryModel ? { model: summaryModel } : {}),
      format: { type: "text" },
      system: "You are a compression model. Never call tools. Reply with plain text only.",
      tools: {},
      parts: [
        {
          type: "text",
          text: summaryPrompt,
        },
      ],
    }
    logLine("summarize.client.prompt.request", { summarySessionID, body: requestBody })
    const idlePromise = new Promise<void>((resolve) => {
      summarySessionIdleResolvers.set(summarySessionID, resolve)
    })
    await legacySessionPromptAsync(client, {
      sessionID: summarySessionID,
      directory,
      ...requestBody,
    })
    await idlePromise
    logLine("summarize.session.idle.received", { summarySessionID })

    const messageID = latestTextMessageBySession.get(summarySessionID)
    const rawSummary = messageID ? (assistantTextByMessage.get(messageID) ?? "") : ""
    const summary = sanitizeForSpeech(rawSummary)
    logLine("summarize.response.text", { summarySessionID, messageID, summary })
    if (!summary) throw new Error("summary model returned no text")
    logLine("summarize.success", { summarySessionID, summary })
    return summary
  } finally {
    await legacySessionDelete(client, directory, summarySessionID)
    logLine("summarize.session.deleted", { summarySessionID })
  }
}

async function runTts(
  shell: Parameters<Plugin>[0]["$"],
  text: string,
  voice = DEFAULT_VOICE,
) {
  const normalized = sanitizeForSpeech(text)
  if (!normalized) return

  const config = getPluginConfig()
  if (config.enabled === false) return

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
  sourceModel?: AssistantMessage["model"],
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

export const OpenCodeTTSPlugin: Plugin = async (input) => {
  setPluginConfig(loadPluginConfigFromDisk())

  return {
    event: async ({ event }) => {
      logLine("event.received", { type: event.type })

      if (event.type === "message.updated") {
        const info = event.properties.info as Message
        if (info.role === "assistant") {
          latestAssistantMessageBySession.set(info.sessionID, {
            messageID: info.id,
            model: info.model,
          })
          logLine("message.updated.assistant", { sessionID: info.sessionID, messageID: info.id })
        }
      }

      if (event.type === "message.part.updated") {
        const part = event.properties.part
        if (part.type === "text") {
          latestTextMessageBySession.set(part.sessionID, part.messageID)
          assistantTextByMessage.set(part.messageID, sanitizeForSpeech(part.text))
          logLine("message.part.updated.text", { messageID: part.messageID, length: part.text.length })
        }
      }

      if (event.type === "message.part.delta") {
        latestTextMessageBySession.set(event.properties.sessionID, event.properties.messageID)
        const existing = assistantTextByMessage.get(event.properties.messageID) ?? ""
        const next = sanitizeForSpeech(`${existing} ${event.properties.delta}`)
        assistantTextByMessage.set(event.properties.messageID, next)
      }

      if (event.type === "session.error") {
        logLine("event.session.error", serializeUnknown(event.properties))
      }

      if (event.type === "session.idle") {
        const resolver = summarySessionIdleResolvers.get(event.properties.sessionID)
        if (resolver) {
          summarySessionIdleResolvers.delete(event.properties.sessionID)
          resolver()
        }
      }

      if (!AUTO_ENABLED) return
      if (event.type !== "session.idle") return

      const sessionID = event.properties.sessionID
      logLine("event.session.idle", { sessionID, inputDirectory: input.directory })
      if (ignoredSessionIDs.has(sessionID)) return
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

        const summary = await summarizeAndSpeak(input, text, latest.model)
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
  }
}

export default OpenCodeTTSPlugin
