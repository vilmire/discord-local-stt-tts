/**
 * Discord Voice Connection Manager
 * Handles joining, leaving, listening, and speaking in voice channels
 * 
 * Features:
 * - Barge-in: Stops speaking when user starts talking
 * - Auto-reconnect heartbeat: Keeps connection alive
 * - Streaming STT: Real-time transcription with Deepgram
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  EndBehaviorType,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
  type AudioReceiveStream,
} from "@discordjs/voice";
import type {
  VoiceChannel,
  StageChannel,
  GuildMember,
  VoiceBasedChannel,
} from "discord.js";
import { Readable, PassThrough } from "stream";
import { pipeline } from "stream/promises";
import * as prism from "prism-media";

import type { DiscordVoiceConfig } from "./config.js";
import { getVadThreshold } from "./config.js";

/**
 * Get RMS threshold based on VAD sensitivity
 * Higher = less sensitive (filters more noise)
 */
function getRmsThreshold(sensitivity: "low" | "medium" | "high"): number {
  switch (sensitivity) {
    case "low":
      return 100;   // Very sensitive - picks up quieter speech
    case "high":
      return 800;   // Less sensitive - requires louder speech, filters more noise
    case "medium":
    default:
      return 400;   // Balanced default
  }
}
import { createSTTProvider, type STTProvider } from "./stt.js";
import { createTTSProvider, type TTSProvider } from "./tts.js";
import { StreamingSTTManager, createStreamingSTTProvider } from "./streaming-stt.js";
import {
  bufferStreamWithMinimum,
  createStreamingTTSProvider,
  type StreamingTTSProvider,
} from "./streaming-tts.js";

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

interface UserAudioState {
  chunks: Buffer[];
  lastActivityMs: number;
  isRecording: boolean;
  silenceTimer?: ReturnType<typeof setTimeout>;
  opusStream?: AudioReceiveStream;
  decoder?: prism.opus.Decoder;
}

export interface VoiceSession {
  guildId: string;
  channelId: string;
  channelName?: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  userAudioStates: Map<string, UserAudioState>;
  speaking: boolean;
  processing: boolean;           // Lock to prevent concurrent processing
  lastSpokeAt?: number;          // Timestamp when bot finished speaking (for cooldown)
  startedSpeakingAt?: number;    // Timestamp when bot started speaking (for echo suppression)
  thinkingPlayer?: AudioPlayer;  // Separate player for thinking sound
  heartbeatInterval?: ReturnType<typeof setInterval>;
  lastHeartbeat?: number;
  reconnecting?: boolean;
}

export class VoiceConnectionManager {
  private sessions: Map<string, VoiceSession> = new Map();
  private config: DiscordVoiceConfig;
  private sttProvider: STTProvider | null = null;
  private streamingSTT: StreamingSTTManager | null = null;
  private ttsProvider: TTSProvider | null = null;
  private streamingTTS: StreamingTTSProvider | null = null;
  private logger: Logger;
  private onTranscript: (userId: string, guildId: string, channelId: string, text: string) => Promise<string>;
  private botUserId: string | null = null;

  /** When true, autoJoin should be suppressed (set by forceReset, cleared by explicit join) */
  public resetSuppressAutoJoin = false;

  // Heartbeat configuration (can be overridden via config.heartbeatIntervalMs)
  private readonly DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;  // 30 seconds
  private readonly HEARTBEAT_TIMEOUT_MS = 60_000;   // 60 seconds before reconnect
  private readonly MAX_RECONNECT_ATTEMPTS = 3;

  private get HEARTBEAT_INTERVAL_MS(): number {
    return this.config.heartbeatIntervalMs ?? this.DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  constructor(
    config: DiscordVoiceConfig,
    logger: Logger,
    onTranscript: (userId: string, guildId: string, channelId: string, text: string) => Promise<string>,
    botUserId?: string
  ) {
    this.config = config;
    this.logger = logger;
    this.onTranscript = onTranscript;
    this.botUserId = botUserId || null;
  }

  /**
   * Set the bot's user ID (for filtering out echo)
   */
  setBotUserId(userId: string): void {
    this.botUserId = userId;
    this.logger.info(`[discord-local-stt-tts] Bot user ID set to ${userId}`);
  }

  /**
   * Initialize providers lazily
   */
  private ensureProviders(): void {
    if (!this.sttProvider) {
      this.sttProvider = createSTTProvider(this.config);
    }
    if (!this.ttsProvider) {
      this.ttsProvider = createTTSProvider(this.config);
    }
    // Initialize streaming TTS (always, for lower latency)
    if (!this.streamingTTS) {
      this.streamingTTS = createStreamingTTSProvider(this.config);
    }
    // Initialize streaming STT if using Deepgram with streaming enabled
    if (!this.streamingSTT && this.config.sttProvider === "deepgram" && this.config.streamingSTT) {
      this.streamingSTT = createStreamingSTTProvider(this.config);
    }
  }

  /**
   * Join a voice channel
   */
  async join(channel: VoiceBasedChannel): Promise<VoiceSession> {
    const existingSession = this.sessions.get(channel.guildId);
    if (existingSession) {
      if (existingSession.channelId === channel.id) {
        return existingSession;
      }
      // Leave current channel first
      await this.leave(channel.guildId);
    }

    this.ensureProviders();

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // We need to hear users
      selfMute: false,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    const session: VoiceSession = {
      guildId: channel.guildId,
      channelId: channel.id,
      channelName: channel.name,
      connection,
      player,
      userAudioStates: new Map(),
      speaking: false,
      processing: false,
      lastHeartbeat: Date.now(),
    };

    // Attach early state/error logging (helps diagnose IP discovery failures)
    this.attachConnectionDebug(connection, channel, session);

    this.sessions.set(channel.guildId, session);

    // Wait for the connection to be ready
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.logger.info(`[discord-local-stt-tts] Joined voice channel ${channel.name} in ${channel.guild.name}`);
    } catch (error) {
      connection.destroy();
      this.sessions.delete(channel.guildId);
      throw new Error(`Failed to join voice channel: ${error}`);
    }

    // Start listening to users
    this.startListening(session);

    // Start heartbeat for connection health monitoring
    this.startHeartbeat(session);

    // Self-test: speak a short phrase after join so we can verify TTS/playback without user mic.
    // IMPORTANT: only do this in the long-running gateway service (never in CLI helper processes).
    if (process.env.OPENCLAW_SERVICE_KIND === "gateway") {
      try {
        await this.speak(session.guildId, "보이스 연결 테스트입니다.");
      } catch (e) {
        this.logger.warn(`[discord-local-stt-tts] Join self-test speak failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Handle connection state changes
    this.setupConnectionHandlers(session, channel);

    return session;
  }

  /**
   * Best-effort debug logging for voice connection internals.
   * (The root cause we keep seeing is UDP IP discovery failing: socket closed.)
   */
  private attachConnectionDebug(connection: VoiceConnection, channel: VoiceBasedChannel, session: VoiceSession): void {
    this.logger.info(`[discord-local-stt-tts] Debug hooks attached for ${channel.name}`);

    const safeState = (st: any) => {
      const networking = st?.networking;
      return {
        status: st?.status,
        reason: st?.reason,
        networkingStatus: networking?.state?.status,
        udp: {
          local: networking?.state?.udp?.local,
          remote: networking?.state?.udp?.remote,
        },
        ws: {
          gateway: networking?.state?.ws?.gateway,
          state: networking?.state?.ws?.state,
        },
      };
    };

    // Try to hook UDP socket close/error for IP discovery failures.
    // We can’t rely on stable types here because @discordjs/voice networking is internal.
    const maybeAttachUdpSocketDebug = () => {
      try {
        const st: any = (connection as any).state;
        const udpSocket = st?.networking?.state?.udp?.socket;
        if (!udpSocket) return false;
        if ((udpSocket as any).__openclawDebugAttached) return true;
        (udpSocket as any).__openclawDebugAttached = true;

        // Best-effort: local bind address
        try {
          const addr = udpSocket.address?.();
          this.logger.info(`[discord-local-stt-tts] UDP socket address (${channel.name}): ${JSON.stringify(addr)}`);
        } catch {
          // ignore
        }

        udpSocket.on?.("close", () => {
          this.logger.warn(`[discord-local-stt-tts] UDP socket close (${channel.name})`);
        });
        udpSocket.on?.("error", (e: any) => {
          this.logger.error(`[discord-local-stt-tts] UDP socket error (${channel.name}): ${e?.message || String(e)}`);
        });
        return true;
      } catch {
        return false;
      }
    };

    // Poll briefly until networking.udp.socket exists.
    const udpPoll = setInterval(() => {
      const ok = maybeAttachUdpSocketDebug();
      if (ok) clearInterval(udpPoll);
    }, 250);
    setTimeout(() => clearInterval(udpPoll), 10_000);

    // Also hook WS close/error if present
    const maybeAttachWsDebug = () => {
      try {
        const st: any = (connection as any).state;
        const ws = st?.networking?.state?.ws?.socket;
        if (!ws) return false;
        if ((ws as any).__openclawDebugAttached) return true;
        (ws as any).__openclawDebugAttached = true;
        ws.on?.("close", (code: any) => {
          this.logger.warn(`[discord-local-stt-tts] WS socket close (${channel.name}) code=${code}`);
        });
        ws.on?.("error", (e: any) => {
          this.logger.error(`[discord-local-stt-tts] WS socket error (${channel.name}): ${e?.message || String(e)}`);
        });
        return true;
      } catch {
        return false;
      }
    };

    const wsPoll = setInterval(() => {
      const ok = maybeAttachWsDebug();
      if (ok) clearInterval(wsPoll);
    }, 250);
    setTimeout(() => clearInterval(wsPoll), 10_000);


    (connection as any).on?.("stateChange", (oldState: any, newState: any) => {
      try {
        this.logger.info(
          `[discord-local-stt-tts] stateChange (${channel.name}) ${oldState?.status} -> ${newState?.status} ` +
          `net=${oldState?.networking?.state?.status} -> ${newState?.networking?.state?.status}`
        );
        this.logger.info(
          `[discord-local-stt-tts] stateDump (${channel.name}) new=${JSON.stringify(safeState(newState))}`
        );

        // If the connection is destroyed, ensure we don't leave behind a zombie session + heartbeat timer.
        // This also allows a clean explicit re-join even when autoJoinChannel is disabled.
        if (newState?.status === VoiceConnectionStatus.Destroyed) {
          this.logger.warn(`[discord-local-stt-tts] Connection destroyed (${channel.name}); cleaning up session`);
          try {
            if (session.heartbeatInterval) {
              clearInterval(session.heartbeatInterval);
              session.heartbeatInterval = undefined;
            }
          } catch {
            // ignore
          }
          try {
            this.sessions.delete(session.guildId);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    });

    (connection as any).on?.("error", (err: any) => {
      const msg = err?.message || String(err);
      this.logger.error(`[discord-local-stt-tts] Connection error event (${channel.name}): ${msg}`);
      if (err?.stack) {
        this.logger.info(`[discord-local-stt-tts] Connection error stack: ${err.stack}`);
      }
      try {
        this.logger.info(
          `[discord-local-stt-tts] Connection error stateDump: ${JSON.stringify(safeState((connection as any).state))}`
        );
      } catch {
        // ignore
      }

      // Auto-recover: IP discovery failures are fatal for sending audio. Try reconnect.
      if (typeof msg === "string" && msg.includes("Cannot perform IP discovery")) {
        // If autoJoinChannel is disabled, don't churn reconnects.
        if (!this.config.autoJoinChannel) {
          this.logger.warn(`[discord-local-stt-tts] IP discovery failure detected but autoJoinChannel is empty; not reconnecting`);
          return;
        }
        if (session.reconnecting) return;
        session.reconnecting = true;
        this.logger.warn(`[discord-local-stt-tts] IP discovery failure detected. Attempting reconnect...`);
        void this.attemptReconnect(session, channel).catch((e) => {
          this.logger.error(
            `[discord-local-stt-tts] attemptReconnect after IP discovery failure failed: ${e instanceof Error ? e.message : String(e)}`
          );
        });
      }
    });
  }

  /**
   * Setup connection event handlers for auto-reconnect
   */
  private setupConnectionHandlers(session: VoiceSession, channel: VoiceBasedChannel): void {
    const connection = session.connection;

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (session.reconnecting) return;

      this.logger.warn(`[discord-local-stt-tts] Disconnected from voice channel in ${channel.guild.name}`);

      // If autoJoinChannel is disabled, do NOT auto-reconnect.
      // This prevents “infinite rejoin” when a human manually disconnects the bot.
      if (!this.config.autoJoinChannel) {
        this.logger.warn("[discord-local-stt-tts] Auto-reconnect disabled (autoJoinChannel is empty); staying disconnected");
        return;
      }

      try {
        // Try to reconnect within 5 seconds
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        this.logger.info(`[discord-local-stt-tts] Reconnecting to voice channel...`);
      } catch {
        // Connection is not recovering, attempt manual reconnect
        await this.attemptReconnect(session, channel);
      }
    });

    connection.on(VoiceConnectionStatus.Ready, () => {
      session.lastHeartbeat = Date.now();
      session.reconnecting = false;
      this.logger.info(`[discord-local-stt-tts] Connection ready for ${channel.name}`);
    });

    // NOTE: errors are logged in attachConnectionDebug(); keep minimal handler here too
    connection.on("error", (error) => {
      this.logger.error(`[discord-local-stt-tts] Connection error: ${error.message}`);
    });
  }

  /**
   * Attempt to reconnect to voice channel
   */
  private async attemptReconnect(session: VoiceSession, channel: VoiceBasedChannel, attempt = 1): Promise<void> {
    if (attempt > this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(`[discord-local-stt-tts] Max reconnection attempts reached, giving up`);
      await this.leave(session.guildId);
      return;
    }

    session.reconnecting = true;
    this.logger.info(`[discord-local-stt-tts] Reconnection attempt ${attempt}/${this.MAX_RECONNECT_ATTEMPTS}`);

    try {
      // Destroy old connection
      session.connection.destroy();

      // Wait before reconnecting (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));

      // Create new connection
      const newConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      const newPlayer = createAudioPlayer();
      newConnection.subscribe(newPlayer);

      // Update session
      session.connection = newConnection;
      session.player = newPlayer;

      // Wait for ready
      await entersState(newConnection, VoiceConnectionStatus.Ready, 20_000);

      session.reconnecting = false;
      session.lastHeartbeat = Date.now();

      // Restart listening
      this.startListening(session);

      // Setup handlers for new connection
      this.setupConnectionHandlers(session, channel);

      this.logger.info(`[discord-local-stt-tts] Reconnected successfully`);
    } catch (error) {
      this.logger.error(`[discord-local-stt-tts] Reconnection failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.attemptReconnect(session, channel, attempt + 1);
    }
  }

  /**
   * Start heartbeat monitoring for session
   */
  private startHeartbeat(session: VoiceSession): void {
    // Clear any existing heartbeat FIRST.
    // This prevents a zombie interval from a previous session continuing to run.
    if (session.heartbeatInterval) {
      try {
        clearInterval(session.heartbeatInterval);
      } catch {
        // ignore
      }
      session.heartbeatInterval = undefined;
    }

    // TEMPORARY: Disable heartbeat watchdog.
    // We are seeing spurious "destroyed" timeouts that kill otherwise healthy connections.
    // We'll reintroduce a safer watchdog after we identify the real disconnect signal.
    this.logger.warn(`[discord-local-stt-tts] Heartbeat watchdog disabled (temporary)`);
    return;

    session.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const connectionState = session.connection.state.status;

      // If the connection is already destroyed, stop the heartbeat and drop the session.
      // Otherwise we spam logs forever and block clean manual re-joins.
      if (connectionState === VoiceConnectionStatus.Destroyed) {
        this.logger.warn(`[discord-local-stt-tts] Heartbeat sees Destroyed connection; stopping heartbeat + deleting session (guild=${session.guildId})`);
        try {
          if (session.heartbeatInterval) {
            clearInterval(session.heartbeatInterval);
            session.heartbeatInterval = undefined;
          }
        } catch {
          // ignore
        }
        try {
          this.sessions.delete(session.guildId);
        } catch {
          // ignore
        }
        return;
      }

      // Update heartbeat if connection is healthy
      if (connectionState === VoiceConnectionStatus.Ready) {
        session.lastHeartbeat = now;
        this.logger.debug?.(`[discord-local-stt-tts] Heartbeat OK for guild ${session.guildId}`);
      } else if (session.lastHeartbeat && (now - session.lastHeartbeat > this.HEARTBEAT_TIMEOUT_MS)) {
        // Connection has been unhealthy for too long
        this.logger.warn(`[discord-local-stt-tts] Heartbeat timeout, connection state: ${connectionState}`);

        // If autoJoinChannel is disabled, don't churn reconnects.
        if (!this.config.autoJoinChannel) {
          this.logger.warn("[discord-local-stt-tts] Heartbeat timeout but autoJoinChannel is empty; not reconnecting");
          return;
        }

        // Don't attempt reconnect if already doing so
        if (!session.reconnecting) {
          // Trigger reconnection by destroying and rejoining
          // Guard against double-destroy (can throw from @discordjs/voice)
          session.reconnecting = true;
          this.logger.info(`[discord-local-stt-tts] Triggering reconnection due to heartbeat timeout`);
          try {
            if ((session.connection.state.status as string) !== VoiceConnectionStatus.Destroyed) {
              session.connection.destroy();
            }
          } catch (err) {
            this.logger.warn(`[discord-local-stt-tts] Heartbeat destroy failed: ${(err as any)?.message || err}`);
          }
        }
      }
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Leave a voice channel
   */
  async leave(guildId: string): Promise<boolean> {
    const session = this.sessions.get(guildId);
    if (!session) {
      return false;
    }

    // Clear heartbeat
    if (session.heartbeatInterval) {
      clearInterval(session.heartbeatInterval);
    }

    // Clear all user timers and streams
    for (const state of session.userAudioStates.values()) {
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
      }
      if (state.opusStream) {
        state.opusStream.destroy();
      }
      if (state.decoder) {
        state.decoder.destroy();
      }
    }

    // Close streaming STT sessions
    if (this.streamingSTT) {
      for (const userId of session.userAudioStates.keys()) {
        this.streamingSTT.closeSession(userId);
      }
    }

    session.connection.destroy();
    this.sessions.delete(guildId);
    this.logger.info(`[discord-local-stt-tts] Left voice channel in guild ${guildId}`);
    return true;
  }

  /**
   * Start listening to voice in the channel
   */
  private startListening(session: VoiceSession): void {
    const receiver = session.connection.receiver;

    this.logger.info(
      `[discord-local-stt-tts] Listening started (guild=${session.guildId}, channel=${session.channelId})`
    );

    receiver.speaking.on("start", (userId: string) => {
      // ═══════════════════════════════════════════════════════════════
      // ECHO FILTER: Ignore speech events from the bot itself
      // This is the primary defense against echo-triggered barge-in
      // ═══════════════════════════════════════════════════════════════
      if (this.botUserId && userId === this.botUserId) {
        this.logger.debug?.(`[discord-local-stt-tts] Ignoring speech from bot itself (echo filter)`);
        return;
      }

      if (!this.isUserAllowed(userId)) {
        this.logger.debug?.(`[discord-local-stt-tts] Ignoring speech from user ${userId} (not in allowedUsers allowlist)`);
        return;
      }

      // Ignore audio during cooldown period (prevents residual echo)
      const SPEAK_COOLDOWN_MS = 500;
      if (session.lastSpokeAt && (Date.now() - session.lastSpokeAt) < SPEAK_COOLDOWN_MS) {
        this.logger.debug?.(`[discord-local-stt-tts] Ignoring speech during cooldown (likely residual echo)`);
        return;
      }

      this.logger.debug?.(`[discord-local-stt-tts] User ${userId} started speaking`);

      // ═══════════════════════════════════════════════════════════════
      // BARGE-IN: If we're speaking and a REAL user starts talking, stop
      // Now that we filter out bot's own userId, we can safely do barge-in
      // ═══════════════════════════════════════════════════════════════
      if (session.speaking) {
        if (this.config.bargeIn) {
          this.logger.info(`[discord-local-stt-tts] Barge-in detected from user ${userId}! Stopping speech.`);
          this.stopSpeaking(session);
          session.lastSpokeAt = Date.now();
        }
        // Clear streaming transcripts and wait for next speech event
        if (this.streamingSTT) {
          this.streamingSTT.closeSession(userId);
        }
        return;
      }

      if (session.processing) {
        // While processing a request, don't start new recordings
        if (this.streamingSTT) {
          this.streamingSTT.closeSession(userId);
        }
        this.logger.debug?.(`[discord-local-stt-tts] Ignoring speech while processing`);
        return;
      }

      let state = session.userAudioStates.get(userId);
      if (!state) {
        state = {
          chunks: [],
          lastActivityMs: Date.now(),
          isRecording: false,
        };
        session.userAudioStates.set(userId, state);
      }

      // Clear any existing silence timer
      if (state.silenceTimer) {
        clearTimeout(state.silenceTimer);
        state.silenceTimer = undefined;
      }

      if (!state.isRecording) {
        state.isRecording = true;
        state.chunks = [];
        this.startRecording(session, userId);
      }

      state.lastActivityMs = Date.now();
    });

    receiver.speaking.on("end", (userId: string) => {
      if (!this.isUserAllowed(userId)) {
        this.logger.debug?.(`[discord-local-stt-tts] Ignoring speech end from user ${userId} (not in allowedUsers allowlist)`);
        return;
      }

      this.logger.debug?.(`[discord-local-stt-tts] User ${userId} stopped speaking`);

      const state = session.userAudioStates.get(userId);
      if (!state || !state.isRecording) {
        return;
      }

      state.lastActivityMs = Date.now();

      // Set silence timer to process the recording
      state.silenceTimer = setTimeout(async () => {
        // If we already finalized/cleaned up (e.g., via decoder "end" fallback), do nothing.
        if (!state.isRecording) return;

        const vadEndAt = Date.now();

        // Finalize this utterance and ALWAYS reset recording state.
        // Otherwise a 0-chunk recording can leave us stuck in isRecording=true forever.
        state.isRecording = false;
        const chunksToProcess = state.chunks;
        state.chunks = [];

        // Clean up streams regardless of whether we captured any PCM.
        this.cleanupRecordingState(state);

        if (!chunksToProcess || chunksToProcess.length === 0) {
          this.logger.debug?.(`[discord-local-stt-tts] No decoded audio captured for user ${userId}; recording state reset`);
          return;
        }

        await this.processRecording(session, userId, chunksToProcess, vadEndAt);
      }, this.config.silenceThresholdMs);
    });
  }

  /**
   * Stop any current speech output (for barge-in)
   */
  private stopSpeaking(session: VoiceSession): void {
    // Stop main player
    if (session.player.state.status !== AudioPlayerStatus.Idle) {
      session.player.stop(true);
    }

    // Stop thinking player if active
    if (session.thinkingPlayer && session.thinkingPlayer.state.status !== AudioPlayerStatus.Idle) {
      session.thinkingPlayer.stop(true);
      session.thinkingPlayer.removeAllListeners();
      session.thinkingPlayer = undefined;
    }

    session.speaking = false;
  }

  /**
   * Ensure we never get stuck in a permanent "isRecording=true but no audio" state.
   *
   * This can happen if Discord emits a speaking start/end but the Opus stream yields 0 decoded PCM chunks
   * (muted user, packet loss, decode error, etc.). If we don't reset the state, future speech won't re-subscribe.
   */
  private cleanupRecordingState(state: UserAudioState): void {
    // Stop timers
    if (state.silenceTimer) {
      try {
        clearTimeout(state.silenceTimer);
      } catch {
        // ignore
      }
      state.silenceTimer = undefined;
    }

    // Stop streams/decoders
    if (state.opusStream) {
      try {
        state.opusStream.destroy();
      } catch {
        // ignore
      }
      state.opusStream = undefined;
    }
    if (state.decoder) {
      try {
        state.decoder.destroy();
      } catch {
        // ignore
      }
      state.decoder = undefined;
    }

    state.isRecording = false;
  }

  /**
   * Start recording audio from a user
   */
  private startRecording(session: VoiceSession, userId: string): void {
    const state = session.userAudioStates.get(userId);
    if (!state) return;

    const opusStream = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.config.silenceThresholdMs,
      },
    });

    state.opusStream = opusStream;

    opusStream.on("end", () => {
      this.logger.debug?.(`[discord-local-stt-tts] Opus stream ended for user ${userId}`);
    });

    opusStream.on("error", (error: Error) => {
      this.logger.error(`[discord-local-stt-tts] Opus stream error for user ${userId}: ${error.message}`);
      // Reset recording state so subsequent speech can re-subscribe.
      this.cleanupRecordingState(state);
    });

    // Decode Opus to PCM
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 1,
      frameSize: 960,
    });

    state.decoder = decoder;
    opusStream.pipe(decoder);

    // If streaming STT is available and enabled, use it
    const useStreaming = this.streamingSTT && this.config.sttProvider === "deepgram" && this.config.streamingSTT;

    if (useStreaming && this.streamingSTT) {
      // Create streaming session for this user
      const streamingSession = this.streamingSTT.getOrCreateSession(userId, (text, isFinal) => {
        if (isFinal) {
          this.logger.debug?.(`[discord-local-stt-tts] Streaming transcript (final): "${text}"`);
        } else {
          this.logger.debug?.(`[discord-local-stt-tts] Streaming transcript (interim): "${text}"`);
        }
      });

      decoder.on("data", (chunk: Buffer) => {
        if (state.isRecording) {
          // Send to streaming STT
          this.streamingSTT?.sendAudio(userId, chunk);

          // Also buffer for fallback/debugging
          state.chunks.push(chunk);
          state.lastActivityMs = Date.now();

          // Check max recording length
          const totalSize = state.chunks.reduce((sum, c) => sum + c.length, 0);
          const durationMs = (totalSize / 2) / 48; // 16-bit samples at 48kHz
          if (durationMs >= this.config.maxRecordingMs) {
            this.logger.debug?.(`[discord-local-stt-tts] Max recording length reached for user ${userId}`);
            const vadEndAt = Date.now();

            // Finalize immediately; otherwise we may keep a dead stream/decoder around.
            state.isRecording = false;
            const chunksToProcess = state.chunks;
            state.chunks = [];
            this.cleanupRecordingState(state);

            void this.processRecording(session, userId, chunksToProcess, vadEndAt).catch((e) => {
              this.logger.error(
                `[discord-local-stt-tts] Error processing max-length recording: ${e instanceof Error ? e.message : String(e)}`
              );
            });
          }
        }
      });
    } else {
      // Batch mode - just buffer audio
      decoder.on("data", (chunk: Buffer) => {
        if (state.isRecording) {
          state.chunks.push(chunk);
          state.lastActivityMs = Date.now();

          // Check max recording length
          const totalSize = state.chunks.reduce((sum, c) => sum + c.length, 0);
          const durationMs = (totalSize / 2) / 48; // 16-bit samples at 48kHz
          if (durationMs >= this.config.maxRecordingMs) {
            this.logger.debug?.(`[discord-local-stt-tts] Max recording length reached for user ${userId}`);
            const vadEndAt = Date.now();

            state.isRecording = false;
            const chunksToProcess = state.chunks;
            state.chunks = [];
            this.cleanupRecordingState(state);

            void this.processRecording(session, userId, chunksToProcess, vadEndAt).catch((e) => {
              this.logger.error(
                `[discord-local-stt-tts] Error processing max-length recording: ${e instanceof Error ? e.message : String(e)}`
              );
            });
          }
        }
      });
    }

    decoder.on("end", () => {
      this.logger.debug?.(`[discord-local-stt-tts] Decoder stream ended for user ${userId}`);

      // Fallback finalization path: if the speaking "end" event doesn't fire reliably,
      // the Opus stream will still end (EndBehaviorType.AfterSilence) and the decoder will follow.
      // If we're still marked as recording here, flush what we captured.
      if (!state.isRecording) return;

      const vadEndAt = Date.now();
      state.isRecording = false;
      const chunksToProcess = state.chunks;
      state.chunks = [];
      this.cleanupRecordingState(state);

      if (!chunksToProcess || chunksToProcess.length === 0) {
        this.logger.debug?.(`[discord-local-stt-tts] Decoder ended with no audio for user ${userId}; recording state reset`);
        return;
      }

      void this.processRecording(session, userId, chunksToProcess, vadEndAt).catch((e) => {
        this.logger.error(
          `[discord-local-stt-tts] Error processing recording on decoder end: ${e instanceof Error ? e.message : String(e)}`
        );
      });
    });

    decoder.on("error", (error: Error) => {
      this.logger.error(`[discord-local-stt-tts] Decoder error for user ${userId}: ${error.message}`);
      // Don't get stuck in a permanent recording state.
      this.cleanupRecordingState(state);
    });
  }

  /**
   * Process recorded audio through STT and get response
   */
  private async processRecording(session: VoiceSession, userId: string, chunks: Buffer[], vadEndAt?: number): Promise<void> {
    if (!this.sttProvider || !this.ttsProvider) {
      return;
    }

    // ── Timing: VAD end ──
    const t_vad_end = vadEndAt || Date.now();

    // Skip if already speaking (prevents overlapping responses)
    if (session.speaking) {
      this.logger.debug?.(`[discord-local-stt-tts] Skipping processing - already speaking`);
      return;
    }

    // Skip if already processing another request (prevents duplicate responses)
    if (session.processing) {
      this.logger.debug?.(`[discord-local-stt-tts] Skipping processing - already processing another request`);
      return;
    }

    // Cooldown after speaking to prevent echo/accidental triggers (500ms)
    const SPEAK_COOLDOWN_MS = 500;
    if (session.lastSpokeAt && (Date.now() - session.lastSpokeAt) < SPEAK_COOLDOWN_MS) {
      this.logger.debug?.(`[discord-local-stt-tts] Skipping processing - in cooldown period after speaking`);
      return;
    }

    const audioBuffer = Buffer.concat(chunks);

    // Skip very short recordings (likely noise) - check BEFORE setting processing lock
    const durationMs = (audioBuffer.length / 2) / 48; // 16-bit samples at 48kHz
    if (durationMs < this.config.minAudioMs) {
      this.logger.debug?.(`[discord-local-stt-tts] Skipping short recording (${Math.round(durationMs)}ms < ${this.config.minAudioMs}ms) for user ${userId}`);
      return;
    }

    // Calculate RMS amplitude to filter out quiet sounds (keystrokes, background noise)
    const rms = this.calculateRMS(audioBuffer);
    const minRMS = getRmsThreshold(this.config.vadSensitivity);
    if (rms < minRMS) {
      this.logger.debug?.(`[discord-local-stt-tts] Skipping quiet audio (RMS ${Math.round(rms)} < ${minRMS}) for user ${userId}`);
      return;
    }

    // Set processing lock AFTER passing all filters
    session.processing = true;

    this.logger.info(`[discord-local-stt-tts] Processing ${Math.round(durationMs)}ms of audio (RMS: ${Math.round(rms)}) from user ${userId}`);

    try {
      let transcribedText: string;

      // ── Timing: STT ──
      const t_stt_request_start = Date.now();

      // Check if we have streaming transcript available
      if (this.streamingSTT && this.config.sttProvider === "deepgram" && this.config.streamingSTT) {
        // Get accumulated transcript from streaming session
        transcribedText = this.streamingSTT.finalizeSession(userId);

        // Fallback to batch if streaming didn't capture anything
        if (!transcribedText || transcribedText.trim().length === 0) {
          this.logger.debug?.(`[discord-local-stt-tts] Streaming empty, falling back to batch STT`);
          const sttResult = await this.sttProvider.transcribe(audioBuffer, 48000);
          transcribedText = sttResult.text;
        }
      } else {
        // Batch transcription
        const sttResult = await this.sttProvider.transcribe(audioBuffer, 48000);
        transcribedText = sttResult.text;
      }

      const t_stt_done = Date.now();
      const stt_total_ms = t_stt_done - t_stt_request_start;
      const post_vad_ms = t_stt_done - t_vad_end;

      // ── Timing log: STT ──
      this.logger.debug?.(
        `[discord-local-stt-tts] ⏱ STT timing: ` +
        `vad_end_at=${t_vad_end}, ` +
        `stt_request_start_at=${t_stt_request_start}, ` +
        `stt_done_at=${t_stt_done}, ` +
        `stt_total_ms=${stt_total_ms}, ` +
        `post_vad_ms=${post_vad_ms}`
      );

      if (!transcribedText || transcribedText.trim().length === 0) {
        this.logger.debug?.(`[discord-local-stt-tts] Empty transcription for user ${userId}`);
        session.processing = false;
        return;
      }

      this.logger.info(`[discord-local-stt-tts] Transcribed: "${transcribedText}"`);

      // Play looping thinking sound while processing
      const stopThinking = await this.startThinkingLoop(session);

      let response: string;
      try {
        // Agent request with soft "thinking" notification.
        // Tool-calling agents can take 30-60s+, so we use a long hard timeout (120s)
        // but play a "thinking" notice after 12s so the user knows it's still working.
        const SOFT_NOTICE_MS = 12_000;
        const HARD_TIMEOUT_MS = 120_000;
        this.logger.info(`[discord-local-stt-tts] Agent request start (soft=${SOFT_NOTICE_MS}ms, hard=${HARD_TIMEOUT_MS}ms)`);

        const agentPromise = this.onTranscript(userId, session.guildId, session.channelId, transcribedText);

        // Soft notice: after SOFT_NOTICE_MS, speak "thinking" without cancelling the agent.
        let softNoticeTimer: ReturnType<typeof setTimeout> | null = setTimeout(async () => {
          softNoticeTimer = null;
          this.logger.info(`[discord-local-stt-tts] Agent still working after ${SOFT_NOTICE_MS}ms, playing thinking notice`);
          try {
            stopThinking();
            await new Promise(resolve => setTimeout(resolve, 100));
            session.connection.subscribe(session.player);
            await this.speak(session.guildId, "잠시만요, 생각 중입니다.");
            // Restart thinking sound while we continue waiting
            const newStop = await this.startThinkingLoop(session);
            // Replace stopThinking so finally block cleans up the new one
            (stopThinking as any).__replacement = newStop;
          } catch {
            // ignore speak errors during notice
          }
        }, SOFT_NOTICE_MS);

        // Hard timeout: reject after HARD_TIMEOUT_MS
        const hardTimeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`agent_timeout_${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS)
        );

        response = await Promise.race([agentPromise, hardTimeoutPromise]) as string;

        // Cancel soft notice if agent finished before it fired
        if (softNoticeTimer) {
          clearTimeout(softNoticeTimer);
          softNoticeTimer = null;
        }

        const len = response?.length ?? 0;
        this.logger.info(`[discord-local-stt-tts] Agent request done (len=${len})`);

        // If the agent returns empty, force a minimal audible reply so the pipeline doesn't go silent.
        if (!response || response.trim().length === 0) {
          response = "네.";
          this.logger.warn(`[discord-local-stt-tts] Agent returned empty; using fallback reply`);
        }
      } finally {
        // Always stop thinking sound, even on error
        const replacementStop = (stopThinking as any).__replacement;
        if (typeof replacementStop === "function") {
          try { replacementStop(); } catch { /* ignore */ }
        }
        stopThinking();
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (!response || response.trim().length === 0) {
        session.processing = false;
        return;
      }

      // Ensure main player is subscribed before speaking
      session.connection.subscribe(session.player);

      // Synthesize and play response (pass vadEndAt for end-to-end timing)
      await this.speak(session.guildId, response, t_vad_end);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[discord-local-stt-tts] Error processing audio: ${msg}`);

      // Hard timeout: agent truly hung for 120s
      if (typeof msg === "string" && msg.startsWith("agent_timeout_")) {
        try {
          await this.speak(session.guildId, "요청 처리에 시간이 너무 오래 걸렸습니다. 다시 시도해 주세요.");
        } catch {
          // ignore
        }
      }
    } finally {
      session.processing = false;
    }
  }

  /**
   * Speak text in the voice channel
   */
  async speak(guildId: string, text: string, vadEndAt?: number): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) {
      throw new Error("Not connected to voice channel");
    }

    this.ensureProviders();

    if (!this.streamingTTS && !this.ttsProvider) {
      throw new Error("TTS provider not initialized");
    }

    session.speaking = true;
    session.startedSpeakingAt = Date.now();

    try {
      // Log full text for debugging (helps verify what was generated vs what was heard)
      this.logger.info(`[discord-local-stt-tts] Speaking: "${text.substring(0, 50)}${text.length > 50 ? "..." : ""}"`);
      this.logger.debug?.(`[discord-local-stt-tts] Speaking (full): ${JSON.stringify(text)}`);

      let resource;

      // ── Timing: TTS ──
      const t_tts_request_start = Date.now();
      let t_tts_headers: number | undefined;
      let t_tts_first_audio_chunk: number | undefined;
      let t_tts_64kb: number | undefined;
      let t_tts_stream_end: number | undefined;
      let tts_total_bytes = 0;
      let tts_mode: "streaming" | "buffered" = "streaming";

      // Try streaming TTS first (lower latency)
      // HTTP offload server returns Ogg/Opus; this is Discord-friendly and should reduce time-to-first-audio.
      if (this.streamingTTS) {
        try {
          const streamResult = await this.streamingTTS.synthesizeStream(text);
          t_tts_headers = Date.now();
          this.logger.debug?.(`[discord-local-stt-tts] streamingTTS.synthesizeStream headers in ${t_tts_headers - t_tts_request_start}ms (fmt=${streamResult.format}, sr=${streamResult.sampleRate})`);

          const originalStream = streamResult.stream;

          // Wait for first audio bytes (otherwise streaming can "succeed" with headers but never deliver audio)
          const minBytes = 2048;
          // M1 CPU-local TTS can take a long time before producing the first audio bytes.
          // Keep this generous to preserve true streaming behavior (fallback handled separately).
          const firstByteTimeoutMs = 45_000;
          const t_wait_start = Date.now();
          const { buffer: initialBuf, remaining } = await bufferStreamWithMinimum(
            originalStream as any,
            minBytes,
            firstByteTimeoutMs
          );
          const t_wait_end = Date.now();
          this.logger.debug?.(
            `[discord-local-stt-tts] streamingTTS first-bytes wait: ${t_wait_end - t_wait_start}ms (initialBytes=${initialBuf?.length ?? 0})`
          );

          if (!initialBuf || initialBuf.length === 0) {
            throw new Error(`Streaming TTS produced no audio within ${firstByteTimeoutMs}ms`);
          }

          this.logger.debug?.(
            `[discord-local-stt-tts] streamingTTS got first bytes: len=${initialBuf.length}, total_bytes=${tts_total_bytes + initialBuf.length}`
          );

          // Record first-chunk timing at the moment we confirm bytes exist
          if (!t_tts_first_audio_chunk) t_tts_first_audio_chunk = Date.now();
          tts_total_bytes += initialBuf.length;
          if (!t_tts_64kb && tts_total_bytes >= 65536) t_tts_64kb = Date.now();

          // Reconstruct a full stream: (initial buffered bytes) + (remaining stream)
          const playbackStream = new PassThrough();
          playbackStream.write(Buffer.from(initialBuf));

          remaining.on("data", (chunk: Buffer) => {
            const buf = Buffer.from(chunk);
            tts_total_bytes += buf.length;
            if (!t_tts_64kb && tts_total_bytes >= 65536) t_tts_64kb = Date.now();
          });
          remaining.on("end", () => {
            t_tts_stream_end = Date.now();
          });
          remaining.on("error", (e) => playbackStream.destroy(e));

          // Pipe the remainder into our playback stream
          remaining.pipe(playbackStream);

          // Create audio resource from reconstructed stream
          if (streamResult.format === "opus") {
            resource = createAudioResource(playbackStream, {
              inputType: StreamType.OggOpus,
            });
          } else {
            resource = createAudioResource(playbackStream);
          }

          this.logger.debug?.(`[discord-local-stt-tts] Using streaming TTS`);
        } catch (streamError) {
          const msg = streamError instanceof Error ? streamError.message : String(streamError);
          // For now we want to force the streaming path (Windows 3090 offload later). Disable buffered fallback.
          const disableFallback = true;
          if (disableFallback) {
            this.logger.error(`[discord-local-stt-tts] Streaming TTS failed (fallback disabled): ${msg}`);
            throw streamError;
          }
          this.logger.warn(`[discord-local-stt-tts] Streaming TTS failed, falling back to buffered: ${msg}`);
          // Fall through to buffered TTS
        }
      }

      // Fallback to buffered TTS
      if (!resource && this.ttsProvider) {
        tts_mode = "buffered";
        const ttsResult = await this.ttsProvider.synthesize(text);
        t_tts_headers = Date.now();
        t_tts_first_audio_chunk = t_tts_headers; // buffered: all at once
        t_tts_stream_end = t_tts_headers;
        tts_total_bytes = ttsResult.audioBuffer.length;
        this.logger.debug?.(`[discord-local-stt-tts] ttsProvider.synthesize ok in ${t_tts_headers - t_tts_request_start}ms (fmt=${ttsResult.format})`);

        if (ttsResult.format === "opus") {
          resource = createAudioResource(Readable.from(ttsResult.audioBuffer), {
            inputType: StreamType.OggOpus,
          });
        } else {
          resource = createAudioResource(Readable.from(ttsResult.audioBuffer));
        }

        this.logger.debug?.(`[discord-local-stt-tts] Using buffered TTS`);
      }

      if (!resource) {
        throw new Error("Failed to create audio resource");
      }

      // ── Timing: Playback ──
      const t_audio_resource_ready = Date.now();

      session.player.play(resource);
      const t_player_play = Date.now();

      // Confirm we actually start playing (helps debug "Using streaming TTS but no audio heard")
      // NOTE: entersState() can be a false negative if the player hits Playing before the await is attached.
      // So we also register a one-shot Playing listener.
      let sawPlayingEvent = false;
      let t_player_playing: number | undefined;
      const onPlaying = () => {
        sawPlayingEvent = true;
        t_player_playing = Date.now();
        this.logger.debug?.(`[discord-local-stt-tts] Playback started (event: AudioPlayerStatus.Playing)`);
      };
      session.player.once(AudioPlayerStatus.Playing, onPlaying);

      try {
        await entersState(session.player, AudioPlayerStatus.Playing, 3_000);
        if (!t_player_playing) t_player_playing = Date.now();
        this.logger.debug?.(`[discord-local-stt-tts] Playback started (entersState: AudioPlayerStatus.Playing)`);
      } catch {
        if (!sawPlayingEvent) {
          this.logger.warn(`[discord-local-stt-tts] Playback did not reach Playing state within 3s (may be muted/terminated/connection issue)`);
        }
      }

      // ── Timing log: TTS ──
      this.logger.debug?.(
        `[discord-local-stt-tts] ⏱ TTS timing (${tts_mode}): ` +
        `tts_request_start_at=${t_tts_request_start}, ` +
        `tts_headers_at=${t_tts_headers ?? "N/A"}, ` +
        `tts_first_audio_chunk_at=${t_tts_first_audio_chunk ?? "N/A"}, ` +
        `tts_64kb_at=${t_tts_64kb ?? "N/A"}, ` +
        `tts_stream_end_at=${t_tts_stream_end ?? "pending"}, ` +
        `request_to_headers_ms=${t_tts_headers ? t_tts_headers - t_tts_request_start : "N/A"}, ` +
        `headers_to_first_chunk_ms=${(t_tts_headers && t_tts_first_audio_chunk) ? t_tts_first_audio_chunk - t_tts_headers : "N/A"}, ` +
        `total_bytes=${tts_total_bytes}`
      );

      // ── Timing log: Playback ──
      this.logger.debug?.(
        `[discord-local-stt-tts] ⏱ Playback timing: ` +
        `audio_resource_ready_at=${t_audio_resource_ready}, ` +
        `player_play_at=${t_player_play}, ` +
        `player_playing_at=${t_player_playing ?? "N/A"}, ` +
        `resource_to_playing_ms=${t_player_playing ? t_player_playing - t_audio_resource_ready : "N/A"}` +
        (vadEndAt ? `, end_to_end_ms=${(t_player_playing || Date.now()) - vadEndAt}` : "")
      );

      // Wait for playback to finish
      await new Promise<void>((resolve) => {
        const onIdle = () => {
          session.speaking = false;
          session.lastSpokeAt = Date.now(); // Set cooldown timestamp
          session.player.off(AudioPlayerStatus.Idle, onIdle);
          session.player.off("error", onError);

          // ── Timing log: TTS stream end (deferred for streaming) ──
          if (tts_mode === "streaming" && t_tts_stream_end) {
            this.logger.debug?.(
              `[discord-local-stt-tts] ⏱ TTS stream completed: ` +
              `tts_stream_end_at=${t_tts_stream_end}, ` +
              `total_stream_ms=${t_tts_stream_end - t_tts_request_start}, ` +
              `total_bytes=${tts_total_bytes}`
            );
          }

          resolve();
        };

        const onError = (error: Error) => {
          this.logger.error(`[discord-local-stt-tts] Playback error: ${error.message}`);
          session.speaking = false;
          session.lastSpokeAt = Date.now(); // Set cooldown timestamp
          session.player.off(AudioPlayerStatus.Idle, onIdle);
          session.player.off("error", onError);
          resolve();
        };

        session.player.on(AudioPlayerStatus.Idle, onIdle);
        session.player.on("error", onError);
      });
    } catch (error) {
      session.speaking = false;
      session.lastSpokeAt = Date.now(); // Set cooldown timestamp
      throw error;
    }
  }

  /**
   * Start looping thinking sound, returns stop function
   */
  private async startThinkingLoop(session: VoiceSession): Promise<() => void> {
    let stopped = false;

    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const thinkingPath = path.join(__dirname, "..", "assets", "thinking.mp3");

      if (!fs.existsSync(thinkingPath)) {
        return () => { };
      }

      const audioData = fs.readFileSync(thinkingPath);

      // Create separate player for thinking sound
      const thinkingPlayer = createAudioPlayer();
      session.thinkingPlayer = thinkingPlayer;
      session.connection.subscribe(thinkingPlayer);

      const playLoop = () => {
        if (stopped || !thinkingPlayer) return;
        const resource = createAudioResource(Readable.from(Buffer.from(audioData)), {
          inlineVolume: true,
        });
        resource.volume?.setVolume(0.7);
        thinkingPlayer.play(resource);
      };

      thinkingPlayer.on(AudioPlayerStatus.Idle, playLoop);
      playLoop(); // Start first play

      return () => {
        stopped = true;
        if (thinkingPlayer) {
          thinkingPlayer.removeAllListeners();
          thinkingPlayer.stop(true);
        }
        session.thinkingPlayer = undefined;
        // Re-subscribe main player immediately
        session.connection.subscribe(session.player);
      };
    } catch (error) {
      this.logger.debug?.(`[discord-local-stt-tts] Error starting thinking loop: ${error instanceof Error ? error.message : String(error)}`);
      return () => {
        session.thinkingPlayer = undefined;
        session.connection.subscribe(session.player);
      };
    }
  }

  /**
   * Play thinking sound once (simple version - uses main player, no loop)
   */
  private async playThinkingSoundSimple(session: VoiceSession): Promise<void> {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const thinkingPath = path.join(__dirname, "..", "assets", "thinking.mp3");

      if (!fs.existsSync(thinkingPath)) {
        return;
      }

      const audioBuffer = fs.readFileSync(thinkingPath);
      const resource = createAudioResource(Readable.from(audioBuffer), {
        inlineVolume: true,
      });
      resource.volume?.setVolume(0.5);

      session.player.play(resource);

      // Don't wait for it to finish - let it play while processing
      // The response TTS will interrupt it naturally
    } catch (error) {
      this.logger.debug?.(`[discord-local-stt-tts] Error playing thinking sound: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Calculate RMS (Root Mean Square) amplitude of audio buffer
   * Used to filter out quiet sounds like keystrokes and background noise
   */
  private calculateRMS(audioBuffer: Buffer): number {
    // Audio is 16-bit signed PCM
    const samples = audioBuffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < audioBuffer.length; i += 2) {
      const sample = audioBuffer.readInt16LE(i);
      sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
  }

  /**
   * Check if a user is allowed to use voice
   */
  private isUserAllowed(userId: string): boolean {
    if (this.config.allowedUsers.length === 0) {
      return true;
    }
    return this.config.allowedUsers.includes(userId);
  }

  /**
   * Get session for a guild
   */
  getSession(guildId: string): VoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): VoiceSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Force-reset one or all sessions.
   * Every destructive call is wrapped in try/catch so the reset always completes.
   * Returns an array of { guildId, channelId } that were reset.
   */
  forceReset(guildId?: string): Array<{ guildId: string; channelId?: string }> {
    this.resetSuppressAutoJoin = true;

    const targets: string[] = guildId
      ? (this.sessions.has(guildId) ? [guildId] : [])
      : Array.from(this.sessions.keys());

    if (targets.length === 0) {
      this.logger.info(`[discord-local-stt-tts] forceReset: no sessions to reset${guildId ? ` (guild=${guildId})` : ""}`);
      return [];
    }

    const result: Array<{ guildId: string; channelId?: string }> = [];

    for (const gid of targets) {
      const session = this.sessions.get(gid);
      if (!session) continue;

      const channelId = session.channelId;
      const channelName = session.channelName || channelId;
      this.logger.info(`[discord-local-stt-tts] Reset session guild=${gid} channel=${channelName}`);

      // 1. Stop heartbeat timer
      try {
        if (session.heartbeatInterval) {
          clearInterval(session.heartbeatInterval);
          session.heartbeatInterval = undefined;
        }
      } catch (e) {
        this.logger.warn(`[discord-local-stt-tts] Reset: heartbeat clearInterval failed: ${(e as any)?.message || e}`);
      }

      // 2. Stop thinking player
      try {
        if (session.thinkingPlayer) {
          session.thinkingPlayer.stop(true);
          session.thinkingPlayer.removeAllListeners();
          session.thinkingPlayer = undefined;
        }
      } catch (e) {
        this.logger.warn(`[discord-local-stt-tts] Reset: thinkingPlayer stop failed: ${(e as any)?.message || e}`);
      }

      // 3. Stop main player
      try {
        session.player.stop(true);
        session.player.removeAllListeners();
      } catch (e) {
        this.logger.warn(`[discord-local-stt-tts] Reset: player stop failed: ${(e as any)?.message || e}`);
      }

      // 4. Clean up user audio states (silence timers, opus streams, decoders)
      for (const [userId, state] of session.userAudioStates) {
        try {
          if (state.silenceTimer) clearTimeout(state.silenceTimer);
          if (state.opusStream) state.opusStream.destroy();
          if (state.decoder) state.decoder.destroy();
        } catch (e) {
          this.logger.warn(`[discord-local-stt-tts] Reset: user audio cleanup failed for ${userId}: ${(e as any)?.message || e}`);
        }

        // Close streaming STT session
        try {
          if (this.streamingSTT) this.streamingSTT.closeSession(userId);
        } catch (e) {
          this.logger.warn(`[discord-local-stt-tts] Reset: streamingSTT close failed for ${userId}: ${(e as any)?.message || e}`);
        }
      }

      // 5. Destroy connection
      try {
        session.connection.removeAllListeners();
        if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
          session.connection.destroy();
        }
      } catch (e) {
        this.logger.warn(`[discord-local-stt-tts] Reset: connection.destroy failed: ${(e as any)?.message || e}`);
      }

      // 6. Clear flags
      session.speaking = false;
      session.processing = false;
      session.reconnecting = false;

      // 7. Remove from map
      this.sessions.delete(gid);
      result.push({ guildId: gid, channelId });
    }

    this.logger.info(`[discord-local-stt-tts] forceReset complete: ${result.length} session(s) reset. autoJoin suppressed until explicit join.`);
    return result;
  }

  /**
   * Destroy all connections
   */
  async destroy(): Promise<void> {
    // Close streaming STT
    if (this.streamingSTT) {
      this.streamingSTT.closeAll();
    }

    const guildIds = Array.from(this.sessions.keys());
    for (const guildId of guildIds) {
      await this.leave(guildId);
    }
  }
}
