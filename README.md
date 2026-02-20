# discord-local-stt-tts (OpenClaw plugin)

Discord voice assistant plugin for OpenClaw with **local STT + local TTS on macOS** (low latency).

## What it does
- Joins a Discord voice channel
- Listens to users (STT)
- Responds with the OpenClaw agent
- Speaks back in the voice channel (TTS)

## macOS Local Mode
- **TTS**: macOS built-in `say`
- **STT**: local faster-whisper (via plugin local provider)

## Requirements (macOS)
- `ffmpeg` available in PATH
- Python runtime for faster-whisper script (if using local STT)

## OpenClaw config example
```jsonc
{
  "plugins": {
    "entries": {
      "discord-local-stt-tts": {
        "enabled": true,
        "config": {
          "sttProvider": "local",
          "ttsProvider": "local",
          "ttsVoice": "Yuna",
          "autoJoinChannel": "<VOICE_CHANNEL_ID>"
        }
      }
    }
  }
}
```

## CLI
This plugin registers a CLI namespace:
```bash
openclaw dvoice status
openclaw dvoice join <channelId>
openclaw dvoice say "보이스 연결 테스트입니다."
```

> Note: the CLI command name may remain `dvoice` even if the plugin ID changes; update later if needed.
