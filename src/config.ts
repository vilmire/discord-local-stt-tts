/**
 * Discord Voice Plugin Configuration
 */

// Placeholder for core TTS config compatibility
export interface VoiceCallTtsConfig {
  enabled?: boolean;
  voice?: string;
  [key: string]: unknown;
}

export interface DiscordVoiceConfig {
  enabled: boolean;
  /**
   * STT provider
   * - whisper: OpenAI Whisper API
   * - deepgram: Deepgram API
   * - http: offload server
   * - local: run locally on this host (mac) via subprocess
   */
  sttProvider: "whisper" | "deepgram" | "http" | "local";
  streamingSTT: boolean;  // Use streaming STT (Deepgram only) for lower latency

  /**
   * TTS provider
   * - openai/elevenlabs/http: existing providers
   * - local: run locally on this host (mac) via `say` + ffmpeg
   */
  ttsProvider: "openai" | "elevenlabs" | "http" | "local";
  /**
   * Voice id/name. For local TTS, this is the macOS `say -v <voice>` name.
   * Example: "Yuna".
   */
  ttsVoice: string;

  local?: {
    /** Faster-whisper local STT settings */
    stt?: {
      engine?: "faster-whisper" | "whisper-cli" | "apple-speech";
      pythonPath?: string; // used for faster-whisper engine
      scriptPath?: string; // optional override
      model?: string; // e.g. small/medium
      device?: string; // cpu/mps/cuda
      computeType?: string; // int8/float16
      language?: string; // ko
      task?: string; // transcribe
    };
    /** macOS say settings */
    tts?: {
      voice?: string; // overrides ttsVoice
      rate?: number; // say -r
    };
  };
  vadSensitivity: "low" | "medium" | "high";
  bargeIn: boolean;       // Stop speaking when user starts talking
  allowedUsers: string[];
  silenceThresholdMs: number;
  minAudioMs: number;
  maxRecordingMs: number;
  autoJoinChannel?: string; // Channel ID to auto-join on startup
  heartbeatIntervalMs?: number;  // Connection health check interval

  // LLM settings for voice responses (use fast models for low latency)
  model?: string;         // e.g. "anthropic/claude-3-5-haiku-latest" or "openai/gpt-4o-mini"
  thinkLevel?: string;    // "off", "low", "medium", "high" - lower = faster

  // Session mode: "guild" = separate session per voice channel (default), "user" = shared session with user's text DMs
  sessionMode?: "guild" | "user";

  // Optional hard override: if set, ALL transcripts use this sessionKey (advanced)
  sessionKeyOverride?: string;

  openai?: {
    apiKey?: string;
    whisperModel?: string;
    ttsModel?: string;
  };
  elevenlabs?: {
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
  };
  deepgram?: {
    apiKey?: string;
    model?: string;
  };

  // Local/LAN offload server (e.g., a Windows 3090 box running STT/TTS)
  http?: {
    baseUrl?: string; // e.g. "http://192.168.0.23:7777"
    sttPath?: string; // default: "/stt"
    ttsPath?: string; // default: "/tts" (buffered)
    ttsStreamPath?: string; // default: "/tts/stream" (streaming Ogg/Opus)
    apiKey?: string;  // optional shared secret header
    timeoutMs?: number; // per-request timeout
  };
}

export const DEFAULT_CONFIG: DiscordVoiceConfig = {
  enabled: true,
  // Public distribution defaults: macOS local STT + local TTS
  sttProvider: "local",
  streamingSTT: true,       // Enable streaming by default when using Deepgram
  ttsProvider: "local",
  ttsVoice: "Samantha",
  vadSensitivity: "medium",
  bargeIn: true,            // Enable barge-in by default
  allowedUsers: [],
  silenceThresholdMs: 1000, // 1 second - faster response after speech ends
  minAudioMs: 300,          // 300ms minimum - filter very short noise
  maxRecordingMs: 30000,
  heartbeatIntervalMs: 30000,
  // model: undefined - uses system default, recommend "anthropic/claude-3-5-haiku-latest" for speed
  // thinkLevel: undefined - defaults to "off" for voice (fastest)
};

export function parseConfig(raw: unknown): DiscordVoiceConfig {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_CONFIG;
  }

  const obj = raw as Record<string, unknown>;

  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled,
    sttProvider:
      obj.sttProvider === "deepgram"
        ? "deepgram"
        : obj.sttProvider === "http"
          ? "http"
          : obj.sttProvider === "local"
            ? "local"
            : "whisper",
    streamingSTT: typeof obj.streamingSTT === "boolean" ? obj.streamingSTT : DEFAULT_CONFIG.streamingSTT,
    ttsProvider:
      obj.ttsProvider === "elevenlabs"
        ? "elevenlabs"
        : obj.ttsProvider === "http"
          ? "http"
          : obj.ttsProvider === "local"
            ? "local"
            : "openai",
    ttsVoice: typeof obj.ttsVoice === "string" ? obj.ttsVoice : DEFAULT_CONFIG.ttsVoice,

    local: obj.local && typeof obj.local === "object"
      ? {
        stt: (obj.local as any).stt && typeof (obj.local as any).stt === "object"
          ? {
            engine: ((obj.local as any).stt.engine as any) || undefined,
            pythonPath: ((obj.local as any).stt.pythonPath as any) || undefined,
            scriptPath: ((obj.local as any).stt.scriptPath as any) || undefined,
            model: ((obj.local as any).stt.model as any) || undefined,
            device: ((obj.local as any).stt.device as any) || undefined,
            computeType: ((obj.local as any).stt.computeType as any) || undefined,
            language: ((obj.local as any).stt.language as any) || undefined,
            task: ((obj.local as any).stt.task as any) || undefined,
          }
          : undefined,
        tts: (obj.local as any).tts && typeof (obj.local as any).tts === "object"
          ? {
            voice: ((obj.local as any).tts.voice as any) || undefined,
            rate: typeof (obj.local as any).tts.rate === "number" ? (obj.local as any).tts.rate : undefined,
          }
          : undefined,
      }
      : undefined,
    vadSensitivity: ["low", "medium", "high"].includes(obj.vadSensitivity as string)
      ? (obj.vadSensitivity as "low" | "medium" | "high")
      : DEFAULT_CONFIG.vadSensitivity,
    bargeIn: typeof obj.bargeIn === "boolean" ? obj.bargeIn : DEFAULT_CONFIG.bargeIn,
    allowedUsers: Array.isArray(obj.allowedUsers)
      ? obj.allowedUsers.filter((u): u is string => typeof u === "string")
      : [],
    silenceThresholdMs:
      typeof obj.silenceThresholdMs === "number"
        ? obj.silenceThresholdMs
        : DEFAULT_CONFIG.silenceThresholdMs,
    minAudioMs:
      typeof obj.minAudioMs === "number"
        ? obj.minAudioMs
        : DEFAULT_CONFIG.minAudioMs,
    maxRecordingMs:
      typeof obj.maxRecordingMs === "number"
        ? obj.maxRecordingMs
        : DEFAULT_CONFIG.maxRecordingMs,
    autoJoinChannel:
      typeof obj.autoJoinChannel === "string" && obj.autoJoinChannel.trim()
        ? obj.autoJoinChannel.trim()
        : undefined,
    heartbeatIntervalMs:
      typeof obj.heartbeatIntervalMs === "number"
        ? obj.heartbeatIntervalMs
        : DEFAULT_CONFIG.heartbeatIntervalMs,
    model: typeof obj.model === "string" ? obj.model : undefined,
    thinkLevel: typeof obj.thinkLevel === "string" ? obj.thinkLevel : undefined,
    sessionMode: obj.sessionMode === "user" ? "user" : "guild",
    sessionKeyOverride: typeof obj.sessionKeyOverride === "string" ? obj.sessionKeyOverride : undefined,
    openai: obj.openai && typeof obj.openai === "object"
      ? {
        apiKey: (obj.openai as Record<string, unknown>).apiKey as string | undefined,
        whisperModel: ((obj.openai as Record<string, unknown>).whisperModel as string) || "whisper-1",
        ttsModel: ((obj.openai as Record<string, unknown>).ttsModel as string) || "tts-1",
      }
      : undefined,
    elevenlabs: obj.elevenlabs && typeof obj.elevenlabs === "object"
      ? {
        apiKey: (obj.elevenlabs as Record<string, unknown>).apiKey as string | undefined,
        voiceId: (obj.elevenlabs as Record<string, unknown>).voiceId as string | undefined,
        modelId: ((obj.elevenlabs as Record<string, unknown>).modelId as string) || "eleven_multilingual_v2",
      }
      : undefined,
    deepgram: obj.deepgram && typeof obj.deepgram === "object"
      ? {
        apiKey: (obj.deepgram as Record<string, unknown>).apiKey as string | undefined,
        model: ((obj.deepgram as Record<string, unknown>).model as string) || "nova-2",
      }
      : undefined,

    http: obj.http && typeof obj.http === "object"
      ? {
        baseUrl: ((obj.http as Record<string, unknown>).baseUrl as string) || undefined,
        sttPath: ((obj.http as Record<string, unknown>).sttPath as string) || "/stt",
        ttsPath: ((obj.http as Record<string, unknown>).ttsPath as string) || "/tts",
        ttsStreamPath: ((obj.http as Record<string, unknown>).ttsStreamPath as string) || "/tts/stream",
        apiKey: (obj.http as Record<string, unknown>).apiKey as string | undefined,
        timeoutMs: (obj.http as Record<string, unknown>).timeoutMs as number | undefined,
      }
      : undefined,
  };
}

/**
 * Get VAD threshold based on sensitivity setting
 */
export function getVadThreshold(sensitivity: "low" | "medium" | "high"): number {
  switch (sensitivity) {
    case "low":
      return 0.01; // Very sensitive - picks up quiet speech
    case "high":
      return 0.05; // Less sensitive - requires louder speech
    case "medium":
    default:
      return 0.02;
  }
}
