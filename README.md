# opencode-tts

An [OpenCode](https://opencode.ai) plugin that automatically speaks assistant responses when a session goes idle.

https://github.com/user-attachments/assets/cf1c3166-dbd7-43b8-8215-1ea12d336463

## How it works

The plugin listens for session idle events and automatically:

1. Captures the latest assistant message
2. Either summarizes it (default) or uses the full text (configurable)
3. Converts it to speech using a local TTS engine

## Install

Tell OpenCode:

```text
Install plugin opencode-tts
```

Or add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["opencode-tts"]
}
```

## Modes

- **summary** (default): Auto-speaks a summarized version of each response
- **full**: Auto-speaks the complete response text

## User controls

Use these slash commands to manage TTS behavior:

| Command | Effect |
| --- | --- |
| `/tts-mode-summary` | Switch to summary mode (default) |
| `/tts-mode-full` | Switch to full text mode |
| `/tts-on` | Enable automatic TTS |
| `/tts-off` | Disable automatic TTS |
| `/tts-speak <text>` | Speak arbitrary text immediately |
| `/tts-repeat` | Re-speak the last response in the current session |
| `/tts-uninstall` | Remove plugin files and clean up `opencode.json` |

Mode and status changes persist across sessions.

## Configuration

Plugin settings live in `~/.config/opencode/plugins/opencode-tts.jsonc`:

```jsonc
{
  "enabled": true,          // false to disable TTS — persisted across sessions
  "mode": "summary",        // "summary" | "full" — persisted across sessions
  "debug": false,
  "backend": "edge_tts",    // "edge_tts" | "say"
  "voice": "...",           // voice override for the active backend
  "summaryLength": "2 sentences", // free-text length hint passed to the LLM (e.g. "30 words", "3 short sentences")
  "summaryProvider": "...", // provider ID for the summary model
  "summaryModel": "...",    // model ID for the summary model
  "edge_tts": {
    "voice": "en-US-AvaNeural",
    "rate": "+25%",
    "volume": "+0%"
  }
}
```

The plugin auto-installs `edge-tts` into a managed Python venv at `~/.config/opencode/tts-venv` on first use.

### Summary model

The plugin resolves the model for summary generation in this order:

1. `summaryProvider` + `summaryModel` from the plugin config
2. `small_model` from your OpenCode config
3. The same model that produced the assistant response
4. Text fallback: first 40 words of the raw response

## TTS backends

**`edge_tts`** (default): Uses Microsoft Edge's neural TTS. Auto-installed. Requires an audio player: `afplay` (macOS built-in), `ffplay`, or `mpg123`.

The default voice is `en-US-AvaNeural`, which is recommended for English. Edge TTS supports a wide range of languages and locales — you can use any multilingual voice (e.g. `en-US-AvaMultilingualNeural`) or switch to a completely different language (e.g. `it-IT-ElsaNeural` for Italian, `fr-FR-DeniseNeural` for French). Run `edge-tts --list-voices` to see all available voices.

**`say`**: Uses macOS `say` or Linux `spd-say`/`espeak`. No install needed.

To use a custom edge-tts executable:

```jsonc
{
  "edge_tts": {
    "command": ["python3", "-m", "edge_tts"]
  }
}
```

## Local development

Build:

```bash
npm install
npm run build
```

Checkout and point to local plugin:

```json
{
  "plugin": ["file:///path/to/opencode-tts/dist/index.js"]
}
```
