/**
 * Text-to-Speech providers
 */

import type { DiscordVoiceConfig } from "./config.js";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TTSResult {
  audioBuffer: Buffer;
  format: "pcm" | "opus" | "mp3";
  sampleRate: number;
}

export interface TTSProvider {
  synthesize(text: string): Promise<TTSResult>;
}

/**
 * OpenAI TTS Provider
 */
export class OpenAITTS implements TTSProvider {
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

  async synthesize(text: string): Promise<TTSResult> {
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

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS error: ${response.status} ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      audioBuffer: Buffer.from(arrayBuffer),
      format: "opus",
      sampleRate: 48000, // Opus from OpenAI is typically 48kHz
    };
  }
}

/**
 * ElevenLabs TTS Provider
 */
export class ElevenLabsTTS implements TTSProvider {
  private apiKey: string;
  private voiceId: string;
  private modelId: string;

  constructor(config: DiscordVoiceConfig) {
    this.apiKey = config.elevenlabs?.apiKey || process.env.ELEVENLABS_API_KEY || "";
    this.voiceId = config.elevenlabs?.voiceId || config.ttsVoice || "21m00Tcm4TlvDq8ikWAM"; // Default: Rachel
    this.modelId = config.elevenlabs?.modelId || "eleven_multilingual_v2";

    if (!this.apiKey) {
      throw new Error("ElevenLabs API key required for ElevenLabs TTS");
    }
  }

  async synthesize(text: string): Promise<TTSResult> {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`,
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
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs TTS error: ${response.status} ${error}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      audioBuffer: Buffer.from(arrayBuffer),
      format: "mp3",
      sampleRate: 44100,
    };
  }
}

/**
 * HTTP TTS Provider (LAN/offload server)
 *
 * Sends JSON { text, voice? } to a local endpoint.
 * Expected response: audio bytes (ogg/opus preferred, wav also ok).
 */
export class LocalTTS implements TTSProvider {
  private voice: string;
  private rate?: number;

  constructor(config: DiscordVoiceConfig) {
    this.voice = (config.local?.tts?.voice || config.ttsVoice || "Yuna").trim() || "Yuna";
    this.rate = config.local?.tts?.rate;
  }

  async synthesize(text: string): Promise<TTSResult> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tts-"));
    const aiffPath = path.join(tmpDir, "say.aiff");
    const outPath = path.join(tmpDir, "out.webm");

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

    await new Promise<void>((resolve, reject) => {
      const p = spawn(
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
          outPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString("utf-8")));
      p.on("error", reject);
      p.on("close", (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg failed (code=${code}): ${err.slice(-1500)}`));
      });
    });

    const audioBuffer = await fs.readFile(outPath);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);

    return { audioBuffer, format: "opus", sampleRate: 48000 };
  }
}

export class HttpTTS implements TTSProvider {
  private baseUrl: string;
  private ttsPath: string;
  private apiKey?: string;
  private voice?: string;
  private timeoutMs: number;

  constructor(config: DiscordVoiceConfig) {
    const baseUrl = config.http?.baseUrl?.trim();
    if (!baseUrl) throw new Error("HTTP TTS requires http.baseUrl in config");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.ttsPath = config.http?.ttsPath || "/tts";
    this.apiKey = config.http?.apiKey || undefined;
    this.voice = config.ttsVoice || undefined;
    this.timeoutMs = config.http?.timeoutMs || 30000;
  }

  async synthesize(text: string): Promise<TTSResult> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.baseUrl}${this.ttsPath.startsWith("/") ? "" : "/"}${this.ttsPath}`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

      const resp = await fetch(url, {
        method: "POST",
        headers,
        // voice-offload-server expects {text, language, speaker} for preset voice mode.
        // Keep voice for backward compat, but map to speaker so /tts works.
        body: JSON.stringify({ text, language: "Korean", speaker: this.voice || "sohee", voice: this.voice }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`HTTP TTS error: ${resp.status} ${resp.statusText} ${errText}`);
      }

      const contentType = (resp.headers.get("content-type") || "").toLowerCase();
      const arr = await resp.arrayBuffer();
      const audioBuffer = Buffer.from(arr);

      // If server returns Ogg/Opus, tell Discord voice layer explicitly.
      const isOpus = contentType.includes("ogg") || contentType.includes("opus");

      return {
        audioBuffer,
        format: isOpus ? "opus" : "mp3", // non-opus path will be transcoded by discord.js
        sampleRate: 48000,
      };
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * Create TTS provider based on config
 */
export function createTTSProvider(config: DiscordVoiceConfig): TTSProvider {
  switch (config.ttsProvider) {
    case "local":
      return new LocalTTS(config);
    case "http":
      return new HttpTTS(config);
    case "elevenlabs":
      return new ElevenLabsTTS(config);
    case "openai":
    default:
      return new OpenAITTS(config);
  }
}
