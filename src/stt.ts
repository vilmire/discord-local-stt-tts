/**
 * Speech-to-Text providers
 */

import type { DiscordVoiceConfig } from "./config.js";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface STTResult {
  text: string;
  confidence?: number;
  language?: string;
}

export interface STTProvider {
  transcribe(audioBuffer: Buffer, sampleRate: number): Promise<STTResult>;
}

/**
 * OpenAI Whisper STT Provider
 */
export class WhisperSTT implements STTProvider {
  private apiKey: string;
  private model: string;

  constructor(config: DiscordVoiceConfig) {
    this.apiKey = config.openai?.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = config.openai?.whisperModel || "whisper-1";

    if (!this.apiKey) {
      throw new Error("OpenAI API key required for Whisper STT");
    }
  }

  async transcribe(audioBuffer: Buffer, sampleRate: number): Promise<STTResult> {
    const t0 = Date.now();
    // Convert raw PCM to WAV format for Whisper API
    const wavBuffer = this.pcmToWav(audioBuffer, sampleRate);

    const formData = new FormData();
    formData.append("file", new Blob([new Uint8Array(wavBuffer)], { type: "audio/wav" }), "audio.wav");
    formData.append("model", this.model);
    formData.append("response_format", "json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });
    const t_first_byte = Date.now();

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Whisper API error: ${response.status} ${error}`);
    }

    const result = (await response.json()) as { text: string; language?: string };
    const t_done = Date.now();
    console.debug(`[discord-local-stt-tts] ⏱ WhisperSTT: request=${t0}, first_byte=${t_first_byte} (+${t_first_byte - t0}ms), done=${t_done} (+${t_done - t0}ms)`);
    return {
      text: result.text.trim(),
      language: result.language,
    };
  }

  /**
   * Convert raw PCM audio to WAV format
   */
  private pcmToWav(pcmBuffer: Buffer, sampleRate: number): Buffer {
    const numChannels = 1; // Mono
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmBuffer.length;
    const headerSize = 44;
    const fileSize = headerSize + dataSize - 8;

    const buffer = Buffer.alloc(headerSize + dataSize);

    // RIFF header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(fileSize, 4);
    buffer.write("WAVE", 8);

    // fmt chunk
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16); // Chunk size
    buffer.writeUInt16LE(1, 20); // Audio format (PCM)
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);
    pcmBuffer.copy(buffer, headerSize);

    return buffer;
  }
}

/**
 * Deepgram STT Provider
 */
export class DeepgramSTT implements STTProvider {
  private apiKey: string;
  private model: string;

  constructor(config: DiscordVoiceConfig) {
    this.apiKey = config.deepgram?.apiKey || process.env.DEEPGRAM_API_KEY || "";
    this.model = config.deepgram?.model || "nova-2";

    if (!this.apiKey) {
      throw new Error("Deepgram API key required for Deepgram STT");
    }
  }

  async transcribe(audioBuffer: Buffer, sampleRate: number): Promise<STTResult> {
    const t0 = Date.now();
    // Deepgram expects: encoding=linear16, sample_rate, channels=1
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", this.model);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", sampleRate.toString());
    url.searchParams.set("channels", "1");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("smart_format", "true");

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: audioBuffer,
    }
    );
    const t_first_byte = Date.now();

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Deepgram API error: ${response.status} ${error}`);
    }

    const result = (await response.json()) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string;
            confidence?: number;
          }>;
        }>;
      };
    };
    const t_done = Date.now();
    console.debug(`[discord-local-stt-tts] ⏱ DeepgramSTT: request=${t0}, first_byte=${t_first_byte} (+${t_first_byte - t0}ms), done=${t_done} (+${t_done - t0}ms)`);

    const transcript = result.results?.channels?.[0]?.alternatives?.[0];
    return {
      text: transcript?.transcript?.trim() || "",
      confidence: transcript?.confidence,
    };
  }
}

/**
 * HTTP STT Provider (LAN/offload server)
 *
 * Sends audio as WAV (16-bit, mono) to a local HTTP endpoint.
 * Expected response: JSON { text: string }
 */

/**
 * Apple Speech STT Provider (macOS native)
 *
 * Uses SFSpeechRecognizer via a compiled Swift binary.
 * Zero external dependencies — runs entirely on Apple Silicon.
 */
export class AppleSpeechSTT implements STTProvider {
  private binaryPath: string;
  private language: string;

  constructor(config: DiscordVoiceConfig) {
    this.binaryPath =
      config.local?.stt?.scriptPath ||
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/apple_stt");
    this.language = config.local?.stt?.language || "ko";
  }

  async transcribe(audioBuffer: Buffer, sampleRate: number): Promise<STTResult> {
    const t0 = Date.now();
    const wavBuffer = pcmToWav(audioBuffer, sampleRate);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-apple-stt-"));
    const audioPath = path.join(tmpDir, "audio.wav");
    try {
      await fs.writeFile(audioPath, wavBuffer);

      const args = [
        "--audio", audioPath,
        "--language", this.language,
      ];

      const out = await new Promise<string>((resolve, reject) => {
        const proc = spawn(this.binaryPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
        proc.stderr.on("data", (d) => (stderr += d.toString("utf-8")));
        proc.on("error", reject);
        proc.on("close", (code) => {
          if (code === 0) return resolve(stdout);
          reject(new Error(`apple_stt failed (code=${code}): ${stderr.slice(-1500)}`));
        });
      });

      const t_done = Date.now();
      console.debug(`[discord-local-stt-tts] ⏱ AppleSpeechSTT: done=${t_done - t0}ms`);

      const parsed = JSON.parse(out) as { text?: string; language?: string; error?: string };
      if (parsed.error) {
        throw new Error(`Apple Speech error: ${parsed.error}`);
      }
      return {
        text: (parsed.text || "").trim(),
        language: parsed.language,
      };
    } finally {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

export class HttpSTT implements STTProvider {
  private baseUrl: string;
  private sttPath: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(config: DiscordVoiceConfig) {
    const baseUrl = config.http?.baseUrl?.trim();
    if (!baseUrl) throw new Error("HTTP STT requires http.baseUrl in config");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.sttPath = config.http?.sttPath || "/stt";
    this.apiKey = config.http?.apiKey || undefined;
    this.timeoutMs = config.http?.timeoutMs || 30000;
  }

  async transcribe(audioBuffer: Buffer, sampleRate: number): Promise<STTResult> {
    const t0 = Date.now();
    const wavBuffer = pcmToWav(audioBuffer, sampleRate);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.baseUrl}${this.sttPath.startsWith("/") ? "" : "/"}${this.sttPath}`;
      const headers: Record<string, string> = {
        "Content-Type": "audio/wav",
      };
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: wavBuffer,
        signal: controller.signal,
      });
      const t_first_byte = Date.now();

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`HTTP STT error: ${response.status} ${response.statusText} ${errText}`);
      }

      const result = (await response.json()) as { text?: string; language?: string; confidence?: number };
      const t_done = Date.now();
      console.debug(`[discord-local-stt-tts] ⏱ HttpSTT: request=${t0}, first_byte=${t_first_byte} (+${t_first_byte - t0}ms), done=${t_done} (+${t_done - t0}ms)`);
      return {
        text: (result.text || "").trim(),
        language: result.language,
        confidence: result.confidence,
      };
    } finally {
      clearTimeout(t);
    }
  }
}

function pcmToWav(pcmBuffer: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize - 8;

  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, headerSize);

  return buffer;
}

/**
 * Create STT provider based on config
 */
export function createSTTProvider(config: DiscordVoiceConfig): STTProvider {
  switch (config.sttProvider) {
    case "local":
      return new AppleSpeechSTT(config);
    case "http":
      return new HttpSTT(config);
    case "deepgram":
      return new DeepgramSTT(config);
    case "whisper":
    default:
      return new WhisperSTT(config);
  }
}
