# opencode-tts

An OpenCode plugin that speaks a very short summary of the assistant response instead of reading the whole answer aloud.

The core idea is simple:

- wait until the OpenCode session goes idle
- grab the latest assistant message
- ask a fast follow-up model call to compress it to at most two sentences
- speak that summary with the local TTS engine

It also exposes a `tts_summary` tool for manual use.

## Why this plugin

Raw text-to-speech for long coding responses is usually too verbose. This plugin makes TTS practical by turning each answer into short spoken audio copy first.

## Current behavior

- Automatic mode runs on `session.idle`
- Summaries are capped to `2` sentences by default
- TTS defaults to the locally installed `edge_tts` package
- Default voice is `en-US-AvaMultilingualNeural`
- Default speech rate is `+25%`
- A throwaway OpenCode session is used for the summarization pass so the spoken output is model-generated, not truncated raw text

## Configuration

OpenCode's main config schema is strict, so arbitrary plugin keys are rejected. This plugin uses a sidecar config file at `~/.config/opencode/plugins/opencode-tts.jsonc`. Preferred: use OpenCode's native `small_model` in your main config. The plugin will use that first for the summary pass, then fall back to the main response model if `small_model` is not set.

Example:

```json
{
  "model": "mlx-local/mlx-community/Qwen3.5-35B-A3B-4bit",
  "small_model": "mlx-local/qwen3.5-0.8b-mlx"
}
```

```jsonc
// ~/.config/opencode/plugins/opencode-tts.jsonc
{
  "enabled": true,
  "debug": true,
  "backend": "edge_tts",
  "edge_tts": {
    "command": ["/Users/stefano/.opencode-tts/.venv/bin/python", "-m", "edge_tts"],
    "voice": "en-US-AvaMultilingualNeural",
    "rate": "+25%",
    "volume": "+0%"
  }
}
```

Optional overrides: set environment variables before launching OpenCode:

```bash
export OPENCODE_TTS_AUTO=true
export OPENCODE_TTS_VOICE=Samantha
export OPENCODE_TTS_SUMMARY_PROVIDER=openai
export OPENCODE_TTS_SUMMARY_MODEL=gpt-4.1-mini
export OPENCODE_TTS_MAX_SENTENCES=2
```

Notes:

- If OpenCode `small_model` is set, the plugin uses that for summaries.
- If `OPENCODE_TTS_SUMMARY_PROVIDER` and `OPENCODE_TTS_SUMMARY_MODEL` are set, they override `small_model`.
- If neither is set, the plugin falls back to the provider/model used for the original assistant response.
- `OPENCODE_TTS_MAX_SENTENCES` is clamped to `1-3`.

## Summary Fallback Order

The plugin currently resolves summary generation in this order:

1. `small_model` from OpenCode config, if set
2. the same provider/model that produced the assistant response
3. a local text fallback that trims the assistant response to the first couple of sentences if the summary call fails

This means the plugin can still speak something useful even when the configured small model is unavailable or broken.

## Current MLX Notes

During local testing against the MLX server on `localhost:8080`:

- `mlx-community/Qwen3.5-0.8B-OptiQ-4bit` failed to load
- `mlx-community/Qwen3.5-2B-OptiQ-4bit` failed to load with missing `vision_tower` parameters
- `mlx-community/Qwen2.5-1.5B-Instruct-4bit` failed because the current `mlx_vlm` install did not support that model type

Because of that, the recommended current setup is to leave `small_model` unset and let the plugin fall back to the main model until the MLX model compatibility issue is fixed.

## OpenCode Route Bug

While debugging the summary path, we found a separate OpenCode server bug in:

- `/Users/stefano/repos/opencode/packages/opencode/src/server/routes/session.ts`

The `POST /session/:sessionID/message` route used Hono's streaming helper and called `stream.write(JSON.stringify(msg))` without awaiting it. In this runtime, that let the callback return before the write flushed, so the server could respond with:

- `HTTP 200`
- `Content-Length: 0`
- empty body

That made the plugin look like it was failing to parse summary output, but the real issue was that the route returned no bytes even though the throwaway summary session had already generated text internally.

The fix is to `await stream.write(...)` before the callback exits.

## Files

Current locations:

- Plugin source: `/Users/stefano/repos/opencode-tts/src/index.ts`
- Plugin README: `/Users/stefano/repos/opencode-tts/README.md`
- OpenCode config: `/Users/stefano/.config/opencode/opencode.json`
- Plugin config: `/Users/stefano/.config/opencode/plugins/opencode-tts.jsonc`
- Private TTS environment: `/Users/stefano/.opencode-tts/.venv`
- Debug log: `/Users/stefano/.opencode-tts/plugin.log`

## TTS configuration

Speech settings live in `~/.config/opencode/plugins/opencode-tts.jsonc`. Example:

```jsonc
{
  "enabled": true,
  "backend": "edge_tts",
  "edge_tts": {
    "command": ["edge-tts"],
    "voice": "en-US-AvaMultilingualNeural",
    "rate": "+25%",
    "volume": "+0%"
  }
}
```

If the local package command is not on your PATH, point `command` at the installed executable or use:

```jsonc
{
  "edge_tts": {
    "command": ["python3", "-m", "edge_tts"]
  }
}
```

## Install for local development

```bash
cd ~/repos/opencode-tts
npm install
npm run build
```

Then add the plugin in your OpenCode config:

```json
{
  "plugin": ["file:///Users/stefano/repos/opencode-tts/src/index.ts"]
}
```

If you want a bundled artifact for publishing, point OpenCode at `dist/index.js` after `npm run build`.

## Manual tool

The plugin exports a `tts_summary` tool with:

- `text`: source text to summarize and speak
- `voice`: optional voice override

## Next useful upgrades

- configurable summary prompt styles such as `brief`, `status`, and `next-step`
- output audio file support
- per-project voice settings
- debounce rules so only user-visible assistant turns are spoken
