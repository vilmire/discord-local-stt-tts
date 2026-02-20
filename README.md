# discord-local-stt-tts (OpenClaw plugin, macOS)

**Discord voice assistant plugin for OpenClaw** focused on **low-latency local STT + local TTS on macOS**.

This repo contains the **plugin code**.

## Installer skill (recommended)
For easiest install/update on macOS, use the companion **ClawHub skill**:
- Slug: `discord-local-stt-tts-installer`
- Install/update: installs into `~/.openclaw/openclaw-extensions/plugins/discord-local-stt-tts`

(You can find it on ClawHub by searching the slug above.)

## What you get
- Join a Discord voice channel
- Capture user speech (STT)
- Run the OpenClaw agent for replies
- Play speech back in the voice channel (TTS)

## Supported platforms
- **macOS only** (intended)

## Local mode (recommended)
This plugin uses macOS built-in APIs for low latency when configured for `local` providers:
- **Local TTS**: macOS built-in `say`
- **Local STT**: choose one
  - **Apple Speech** (`apple-speech`): macOS **SFSpeechRecognizer** via `bin/apple_stt`
  - **faster-whisper** (`faster-whisper`): Python subprocess + local models

## Requirements (macOS)
### Runtime
- `ffmpeg` in PATH (used for audio conversion/streaming to Discord)
- macOS permissions:
  - **Microphone** (Discord / OpenClaw)
  - **Speech Recognition** (required if you use the `apple-speech` local STT engine)

### Local STT engines
Local STT can be configured via `config.local.stt.engine`:
- `apple-speech` (default-friendly): uses macOS **SFSpeechRecognizer** via `bin/apple_stt` (no Python deps)
- `faster-whisper`: uses a local Python runtime + faster-whisper models (higher setup cost)

### Build (only if installing from source)
- `pnpm`

## Install
### Option A (recommended): installer skill
1) Install the ClawHub skill `discord-local-stt-tts-installer`
2) Run:

```bash
bash bin/install.sh
openclaw gateway restart
```

### Option B: install from source
Clone this repo into:

```text
~/.openclaw/openclaw-extensions/plugins/discord-local-stt-tts
```

Then:

```bash
cd ~/.openclaw/openclaw-extensions/plugins/discord-local-stt-tts
pnpm i
pnpm build
openclaw gateway restart
```

## Configuration
Add to `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "discord-local-stt-tts": {
        "enabled": true,
        "config": {
          "sttProvider": "local",
          "ttsProvider": "local",
          "ttsVoice": "Samantha",
          "autoJoinChannel": "<VOICE_CHANNEL_ID>"
        }
      }
    }
  }
}
```

### Notes
- `autoJoinChannel` is a Discord **voice channel ID**.
- If you don’t want auto-join, omit it and join manually.

## CLI
This plugin registers the `dvoice` CLI namespace:

```bash
openclaw dvoice status
openclaw dvoice join <channelId>
openclaw dvoice say "Hello. This is a voice connection test."
```

> The CLI name is `dvoice` even though the plugin ID is `discord-local-stt-tts`.

## Origin / Attribution
This plugin is based on the original OpenClaw Discord voice plugin:
- ClawHub: https://clawhub.ai/avatarneil/discord-voice

Historical source reference (may not match the ClawHub canonical page):
- https://github.com/clawdbot/discord-voice

This fork focuses on **macOS local STT + local TTS** and packaging for public distribution.

## Troubleshooting
- If audio is silent: ensure Discord voice permissions are correct and `ffmpeg` is installed.
- If local STT (apple-speech) fails:
  - macOS **System Settings → Privacy & Security → Speech Recognition**: allow
  - also check **Microphone** permission
- If local STT (faster-whisper) fails: ensure `python3` is available and the faster-whisper dependencies/models are installed.
