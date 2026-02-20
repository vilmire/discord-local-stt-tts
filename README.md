# discord-local-stt-tts (OpenClaw plugin, macOS)

**Discord voice assistant plugin for OpenClaw** focused on **low-latency local STT + local TTS on macOS**.

This repo contains the **plugin code**.
- If you want one-command install/update, use the companion ClawHub skill: `discord-local-stt-tts-installer`.

## What you get
- Join a Discord voice channel
- Capture user speech (STT)
- Run the OpenClaw agent for replies
- Play speech back in the voice channel (TTS)

## Supported platforms
- **macOS only** (intended)

## Local mode (recommended)
- **TTS**: macOS built-in `say`
- **STT**: local faster-whisper (via the plugin `local` STT provider)

## Requirements (macOS)
- `ffmpeg` in PATH
- `python3` in PATH (for local STT)
- Optional: `pnpm` if you install from source and need to build

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
This plugin is based on the original OpenClaw Discord voice plugin repository:
- https://github.com/clawdbot/discord-voice

This fork focuses on **macOS local STT + local TTS** and packaging for public distribution.

## Troubleshooting
- If audio is silent: ensure Discord voice permissions are correct and `ffmpeg` is installed.
- If local STT fails: ensure `python3` is available and the faster-whisper dependencies/models are installed per plugin docs.
