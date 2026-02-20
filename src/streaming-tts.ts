/**
 * Streaming Text-to-Speech providers
 * 
 * Streams audio chunks as they arrive from the TTS API,
 * reducing time-to-first-audio significantly.
 */

import { Readable, PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscordVoiceConfig } from "./config.js";

export interface StreamingTTSResult {
  stream: Readable;
  format: "pcm" | "opus" | "mp3";
  sampleRate: number;
}

export interface StreamingTTSProvider {
  /** 
   * Synthesize text to audio stream
   * Returns a readable stream that emits audio chunks as they arrive
   */
  synthesizeStream(text: string): Promise<StreamingTTSResult>;

  /**
   * Check if streaming is supported
   */
  supportsStreaming(): boolean;
}

/**
 * OpenAI Streaming TTS Provider
 * 
 * OpenAI TTS supports streaming responses - we can start playing
 * audio before the full response is received.
 */
export class OpenAIStreamingTTS implements StreamingTTSProvider {
  private apiKey: string;
  private model: string;
  private voice: string;

  constructor(config: DiscordVoiceConfig) {
    this.apiKey = config.openai?.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = config.openai?.ttsModel || "tts-1";
    this.voice = config.ttsVoice || "nova";

    if (!this.apiKey) {
      throw new Error("OpenAI API key required for OpenAI TTS");
    }
  }

  supportsStreaming(): boolean {
    return true;
  }

  async synthesizeStream(text: string): Promise<StreamingTTSResult> {
    const t0 = Date.now();
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        voice: this.voice,
        response_format: "opus", // Best for Discord voice
      }),
    });
    const t_headers = Date.now();
    console.debug(`[discord-local-stt-tts] ⏱ OpenAI TTS: request=${t0}, headers=${t_headers} (+${t_headers - t0}ms)`);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS error: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error("OpenAI TTS returned no body");
    }

    // Convert web ReadableStream to Node.js Readable
    const nodeStream = Readable.fromWeb(response.body as any);

    return {
      stream: nodeStream,
      format: "opus",
      sampleRate: 48000,
    };
  }
}

/**
 * ElevenLabs Streaming TTS Provider
 * 
 * ElevenLabs supports streaming via their streaming endpoint.
 * Audio chunks are returned as they're generated.
 */
export class ElevenLabsStreamingTTS implements StreamingTTSProvider {
  private apiKey: string;
  private voiceId: string;
  private modelId: string;

  constructor(config: DiscordVoiceConfig) {
    this.apiKey = config.elevenlabs?.apiKey || process.env.ELEVENLABS_API_KEY || "";
    this.voiceId = config.elevenlabs?.voiceId || config.ttsVoice || "21m00Tcm4TlvDq8ikWAM";
    this.modelId = config.elevenlabs?.modelId || "eleven_turbo_v2_5"; // Turbo model is faster

    if (!this.apiKey) {
      throw new Error("ElevenLabs API key required for ElevenLabs TTS");
    }
  }

  supportsStreaming(): boolean {
    return true;
  }

  async synthesizeStream(text: string): Promise<StreamingTTSResult> {
    const t0 = Date.now();
    // Use the streaming endpoint
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: this.modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
          optimize_streaming_latency: 3, // 0-4, higher = lower latency but quality tradeoff
        }),
      }
    );
    const t_headers = Date.now();
    console.debug(`[discord-local-stt-tts] ⏱ ElevenLabs TTS: request=${t0}, headers=${t_headers} (+${t_headers - t0}ms)`);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs TTS error: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error("ElevenLabs TTS returned no body");
    }

    // Convert web ReadableStream to Node.js Readable
    const nodeStream = Readable.fromWeb(response.body as any);

    return {
      stream: nodeStream,
      format: "mp3",
      sampleRate: 44100,
    };
  }
}

/**
 * Create streaming TTS provider based on config
 */
export class LocalStreamingTTS implements StreamingTTSProvider {
  private voice: string;
  private rate?: number;

  constructor(config: DiscordVoiceConfig) {
    // Default to config.ttsVoice, but allow local.tts.voice override
    this.voice = (config.local?.tts?.voice || config.ttsVoice || "Yuna").trim() || "Yuna";
    this.rate = config.local?.tts?.rate;
  }

  supportsStreaming(): boolean {
    // We return a stream, but generation is file-based; still okay for the voice pipeline.
    return true;
  }

  async synthesizeStream(text: string): Promise<StreamingTTSResult> {
    const t0 = Date.now();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tts-"));
    const aiffPath = path.join(tmpDir, "say.aiff");

    // 1) say -> aiff
    const sayArgs = ["-v", this.voice];
    if (this.rate && Number.isFinite(this.rate)) {
      sayArgs.push("-r", String(this.rate));
    }
    sayArgs.push("-o", aiffPath, text);

    await new Promise<void>((resolve, reject) => {
      const p = spawn("say", sayArgs, { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString("utf-8")));
      p.on("error", reject);
      p.on("close", (code) => {
        if (code === 0) return resolve();
        reject(new Error(`say failed (code=${code}): ${err.slice(-1000)}`));
      });
    });

    // 2) ffmpeg -> ogg/opus (stdout) — must be Ogg container for StreamType.OggOpus
    const ff = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        aiffPath,
        "-c:a",
        "libopus",
        "-b:a",
        "48k",
        "-vbr",
        "on",
        "-application",
        "voip",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "ogg",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    // Cleanup when stream ends
    const outStream = ff.stdout!;
    outStream.on("close", async () => {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    const t_headers = Date.now();
    console.debug(`[discord-local-stt-tts] ⏱ Local TTS: prep=${t_headers - t0}ms (voice=${this.voice})`);

    return {
      stream: outStream,
      format: "opus",
      sampleRate: 48000,
    };
  }
}

export class HttpStreamingTTS implements StreamingTTSProvider {
  private baseUrl: string;
  private ttsStreamPath: string;
  private apiKey?: string;
  private voice?: string;

  constructor(config: DiscordVoiceConfig) {
    const baseUrl = config.http?.baseUrl?.trim();
    if (!baseUrl) throw new Error("HTTP streaming TTS requires http.baseUrl in config");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.ttsStreamPath = config.http?.ttsStreamPath || "/tts/stream";
    this.apiKey = config.http?.apiKey || undefined;
    this.voice = config.ttsVoice || undefined;
  }

  supportsStreaming(): boolean {
    return true;
  }

  async synthesizeStream(text: string): Promise<StreamingTTSResult> {
    const t0 = Date.now();
    const url = `${this.baseUrl}${this.ttsStreamPath.startsWith("/") ? "" : "/"}${this.ttsStreamPath}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "audio/webm",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ text, language: "Korean", speaker: this.voice || "sohee", voice: this.voice }),
    });
    const t_headers = Date.now();
    console.debug(`[discord-local-stt-tts] ⏱ HTTP TTS: request=${t0}, headers=${t_headers} (+${t_headers - t0}ms)`);

    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      throw new Error(`HTTP streaming TTS error: ${resp.status} ${resp.statusText} ${err}`);
    }
    if (!resp.body) {
      throw new Error("HTTP streaming TTS returned no body");
    }

    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    const rawNodeStream = Readable.fromWeb(resp.body as any);
    // Readable.fromWeb() yields Uint8Array chunks; @discordjs/voice + prism expect Buffer chunks.
    // Normalize to Buffer to avoid immediate AudioPlayer "terminated" errors.
    const nodeStream = new PassThrough();
    rawNodeStream.on("data", (chunk: any) => nodeStream.write(Buffer.from(chunk)));
    rawNodeStream.on("end", () => nodeStream.end());
    rawNodeStream.on("error", (e) => nodeStream.destroy(e));

    // Expect WebM/Opus for Discord.
    if (!contentType.includes("webm") && !contentType.includes("opus")) {
      // Still return; discord.js may try to decode, but this is likely misconfigured.
    }

    return {
      stream: nodeStream,
      format: "opus",
      sampleRate: 48000,
    };
  }
}

export function createStreamingTTSProvider(config: DiscordVoiceConfig): StreamingTTSProvider {
  switch (config.ttsProvider) {
    case "local":
      return new LocalStreamingTTS(config);
    case "http":
      return new HttpStreamingTTS(config);
    case "elevenlabs":
      return new ElevenLabsStreamingTTS(config);
    case "openai":
    default:
      return new OpenAIStreamingTTS(config);
  }
}

/**
 * Utility to buffer a stream with timeout
 * Useful when we need to wait for minimum data before starting playback
 */
export function bufferStreamWithMinimum(
  source: Readable,
  minBytes: number,
  timeoutMs: number
): Promise<{ buffer: Buffer; remaining: Readable }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved && totalBytes > 0) {
        resolved = true;
        // Return what we have
        const buffer = Buffer.concat(chunks);
        resolve({ buffer, remaining: source });
      }
    }, timeoutMs);

    source.on("data", (chunk: Buffer) => {
      if (resolved) return;

      chunks.push(chunk);
      totalBytes += chunk.length;

      if (totalBytes >= minBytes) {
        resolved = true;
        clearTimeout(timeout);
        const buffer = Buffer.concat(chunks);
        resolve({ buffer, remaining: source });
      }
    });

    source.on("end", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        const buffer = Buffer.concat(chunks);
        resolve({ buffer, remaining: source });
      }
    });

    source.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
  });
}
