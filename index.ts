/**
 * Discord Voice Plugin for Clawdbot
 * 
 * Enables real-time voice conversations in Discord voice channels.
 * 
 * Features:
 * - Join/leave voice channels via slash commands (/voice join, /voice leave)
 * - Listen to user speech with VAD (Voice Activity Detection)
 * - Speech-to-text via Whisper API or Deepgram
 * - Routes transcribed text through Clawdbot agent
 * - Text-to-speech via OpenAI or ElevenLabs
 * - Plays audio responses back to the voice channel
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client, GatewayIntentBits, type VoiceBasedChannel, type GuildMember } from "discord.js";

import { parseConfig, type DiscordVoiceConfig } from "./src/config.js";
import { VoiceConnectionManager } from "./src/voice-connection.js";
import { loadCoreAgentDeps, type CoreConfig } from "./src/core-bridge.js";

interface PluginApi {
  pluginConfig: unknown;
  config: unknown;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug?(msg: string): void;
  };
  runtime: {
    discord?: {
      getClient(accountId?: string): Client | null;
    };
    agent?: {
      chat(params: {
        sessionKey: string;
        message: string;
        channel?: string;
        senderId?: string;
      }): Promise<{ text: string }>;
    };
  };
  registerGatewayMethod(
    name: string,
    handler: (ctx: { params: unknown; respond: (ok: boolean, payload?: unknown) => void }) => void | Promise<void>
  ): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
      details?: unknown;
    }>;
  }): void;
  registerService(service: {
    id: string;
    start: () => Promise<void> | void;
    stop: () => Promise<void> | void;
  }): void;
  registerCli(
    register: (ctx: { program: unknown }) => void,
    opts?: { commands: string[] }
  ): void;
}

const VoiceToolSchema = {}; // NOTE: simplified schema to avoid external deps (@sinclair/typebox)


// Guard against duplicate register() calls from the plugin framework.
let _registered = false;

const discordVoicePlugin = {
  id: "discord-local-stt-tts",
  name: "Discord Voice",
  description: "Real-time voice conversations in Discord voice channels",

  configSchema: {
    parse(value: unknown): DiscordVoiceConfig {
      return parseConfig(value);
    },
  },

  register(api: PluginApi) {

    const cfg = parseConfig(api.pluginConfig);
    api.logger.info?.(`[discord-local-stt-tts] config loaded: sttProvider=${cfg.sttProvider} streamingSTT=${cfg.streamingSTT} ttsProvider=${cfg.ttsProvider} ttsVoice=${cfg.ttsVoice} autoJoinChannel=${cfg.autoJoinChannel || ""}`);

    // ── CLI early-exit: register RPC-based CLI commands only, NO Discord client ──
    // Plugins are loaded by short-lived CLI helper processes (e.g. `openclaw dvoice join`).
    // Previously, every CLI invocation created a Discord client + login, which kept the
    // process alive as a zombie. Now CLI commands call the gateway via RPC and exit.
    //
    // Detection: We check BOTH the env var AND process.argv to ensure this is a real
    // gateway process. The env var OPENCLAW_SERVICE_KIND="gateway" can leak from the
    // launchd plist into the user's shell environment, causing CLI commands like
    // `openclaw gateway stop` to mistakenly create a Discord client.
    //
    // A true gateway process:
    // 1. Has OPENCLAW_SERVICE_KIND="gateway" in env (set by launchd/systemd plist), AND
    // 2. Was started with `openclaw gateway` or `openclaw gateway run` (NOT stop/restart/start/install/etc.)
    const hasGatewayEnv = process.env.OPENCLAW_SERVICE_KIND === "gateway";
    const gatewayCliSubcommands = ["stop", "start", "restart", "install", "uninstall", "status", "health", "probe", "discover", "call", "usage-cost"];
    const argv = process.argv.map(a => a.toLowerCase());
    const gatewayArgIdx = argv.findIndex(a => a === "gateway");
    const nextArg = gatewayArgIdx >= 0 ? argv[gatewayArgIdx + 1] : undefined;
    // True gateway: `openclaw gateway` (no subcommand) or `openclaw gateway run`
    // CLI: `openclaw gateway stop`, `openclaw gateway restart`, `openclaw dvoice join`, etc.
    const isGatewayRunCommand = gatewayArgIdx >= 0 && (!nextArg || nextArg === "run" || nextArg.startsWith("-"));
    const isGatewayProcess = hasGatewayEnv && isGatewayRunCommand;
    const isCliInvocation = !isGatewayProcess;

    if (isCliInvocation) {
      // Register CLI commands that talk to the gateway via RPC.
      // NO Discord client, NO voice manager, NO services – just command registration.
      api.registerCli(
        ({ program }) => {
          const prog = program as any;
          const voiceCmd = prog.command("dvoice").description("Discord voice channel commands");

          // Helper: dynamically discover and call callGateway from the openclaw dist.
          // We search for the gateway-rpc chunk by glob to avoid depending on hashed filenames.
          async function rpcCall(method: string, params?: unknown): Promise<any> {
            // Discover the callGateway function from openclaw internals.
            const opPath = "/opt/homebrew/lib/node_modules/openclaw/dist";
            const fsP = await import("node:fs/promises");
            const pathP = await import("node:path");
            const files = await fsP.readdir(opPath);
            const callFile = files.find((f: string) => f.startsWith("call-") && f.endsWith(".js"));
            if (!callFile) throw new Error("Cannot find openclaw gateway call module");
            const mod = await import(pathP.join(opPath, callFile));
            const callGateway = mod.n || mod.callGateway;
            if (typeof callGateway !== "function") throw new Error("callGateway not found in module");
            return callGateway({ method, params, timeoutMs: 15_000 });
          }

          voiceCmd
            .command("join")
            .description("Join a Discord voice channel (via gateway)")
            .argument("<channelId>", "Voice channel ID")
            .action(async (channelId: string) => {
              try {
                const result = await rpcCall("discord-local-stt-tts.join", { channelId });
                console.log(result?.joined ? `Joined voice channel (guild ${result.guildId})` : JSON.stringify(result));
              } catch (error) {
                console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            });

          voiceCmd
            .command("leave")
            .description("Leave the current voice channel (via gateway)")
            .option("-g, --guild <guildId>", "Guild ID")
            .action(async (opts: { guild?: string }) => {
              try {
                const result = await rpcCall("discord-local-stt-tts.leave", { guildId: opts.guild });
                console.log(result?.left ? `Left voice channel (guild ${result.guildId})` : (result?.reason || "Not in any voice channel"));
              } catch (error) {
                console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            });

          voiceCmd
            .command("status")
            .description("Show voice connection status (from gateway)")
            .action(async () => {
              try {
                const result = await rpcCall("discord-local-stt-tts.status");
                const sessions = result?.sessions || [];
                if (sessions.length === 0) {
                  console.log("Not connected to any voice channels");
                  return;
                }
                for (const s of sessions) {
                  console.log(`Guild: ${s.guildId}`);
                  console.log(`  Channel: ${s.channelId}`);
                  console.log(`  Speaking: ${s.speaking}`);
                  console.log(`  Users listening: ${s.usersListening}`);
                }
              } catch (error) {
                console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            });

          voiceCmd
            .command("say")
            .description("Speak text in the voice channel (via gateway)")
            .argument("<text...>", "Text to speak")
            .option("-g, --guild <guildId>", "Guild ID")
            .action(async (textParts: string[], opts: { guild?: string }) => {
              try {
                const text = textParts.join(" ");
                const result = await rpcCall("discord-local-stt-tts.speak", { text, guildId: opts.guild });
                console.log(result?.spoken ? "Speaking..." : JSON.stringify(result));
              } catch (error) {
                console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            });

          voiceCmd
            .command("reset")
            .description("Force-reset voice sessions (via gateway)")
            .option("-g, --guild <guildId>", "Reset only this guild")
            .action(async (opts: { guild?: string }) => {
              try {
                const result = await rpcCall("discord-local-stt-tts.reset", { guildId: opts.guild });
                const items = result?.reset || [];
                if (items.length === 0) {
                  console.log("No active sessions to reset.");
                } else {
                  for (const r of items) {
                    console.log(`Reset: guild=${r.guildId} channel=${r.channelId || "unknown"}`);
                  }
                  console.log(`${items.length} session(s) reset.`);
                }
              } catch (error) {
                console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            });
        },
        { commands: ["dvoice"] }
      );

      // CLI early exit: do NOT proceed to create Discord client, voice manager, services, etc.
      return;
    }

    // ── Gateway mode: full runtime initialization ──
    let voiceManager: VoiceConnectionManager | null = null;

    // Session override store (lets you route voice transcripts into an arbitrary sessionKey)
    // Keys: "user:<discordUserId>" or "guild:<discordGuildId>"
    const coreConfigForWorkspace = api.config as any;
    const workspaceRoot: string =
      coreConfigForWorkspace?.agents?.defaults?.workspace ||
      coreConfigForWorkspace?.agents?.workspace ||
      process.cwd();
    const overridesPath = path.join(workspaceRoot, "memory", "discord-local-stt-tts-session-overrides.json");
    const autoJoinSuppressPath = path.join(workspaceRoot, "memory", "discord-local-stt-tts-autojoin-suppressed.json");
    let sessionOverrides: Record<string, string> = {};
    let autoJoinSuppressed = false;

    function loadSessionOverrides() {
      try {
        const raw = fs.readFileSync(overridesPath, "utf8");
        const json = JSON.parse(raw);
        if (json && typeof json === "object") sessionOverrides = json;
      } catch {
        sessionOverrides = {};
      }
    }

    function saveSessionOverrides() {
      try {
        fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
        fs.writeFileSync(overridesPath, JSON.stringify(sessionOverrides, null, 2), "utf8");
      } catch (e) {
        api.logger.warn(`[discord-local-stt-tts] Failed to save session overrides: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    function loadAutoJoinSuppressed() {
      try {
        const raw = fs.readFileSync(autoJoinSuppressPath, "utf8");
        const json = JSON.parse(raw);
        autoJoinSuppressed = !!json?.suppressed;
      } catch {
        autoJoinSuppressed = false;
      }
    }

    function setAutoJoinSuppressed(value: boolean, reason?: string) {
      autoJoinSuppressed = value;
      try {
        fs.mkdirSync(path.dirname(autoJoinSuppressPath), { recursive: true });
        fs.writeFileSync(
          autoJoinSuppressPath,
          JSON.stringify({ suppressed: value, at: Date.now(), reason: reason || undefined }, null, 2),
          "utf8"
        );
      } catch (e) {
        api.logger.warn(
          `[discord-local-stt-tts] Failed to persist autoJoin suppression: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    function clearAutoJoinSuppressed() {
      autoJoinSuppressed = false;
      try {
        fs.rmSync(autoJoinSuppressPath, { force: true });
      } catch {
        // ignore
      }
    }

    loadSessionOverrides();
    loadAutoJoinSuppressed();

    function resolveVoiceSessionKey(userId: string, guildId: string): string {
      // Highest priority: hard config override (advanced)
      if (cfg.sessionKeyOverride && cfg.sessionKeyOverride.trim()) return cfg.sessionKeyOverride.trim();

      // Next: persisted overrides
      const userKey = sessionOverrides[`user:${userId}`];
      if (userKey) return userKey;
      const guildKey = sessionOverrides[`guild:${guildId}`];
      if (guildKey) return guildKey;

      // Default behavior
      return cfg.sessionMode === "user" ? `discord:${userId}` : `discord:voice:${guildId}`;
    }
    let discordClient: Client | null = null;
    let clientReady = false;
    let botId: string | null = null;

    if (!cfg.enabled) {
      api.logger.info("[discord-local-stt-tts] Plugin disabled");
      return;
    }

    // Guard: prevent duplicate gateway initialization in the same process.
    // CLI register() calls above are fine to repeat, but Discord client must only be created once.
    if (_registered) {
      api.logger.warn("[discord-local-stt-tts] Gateway already initialized — skipping duplicate");
      return;
    }
    _registered = true;

    // Prefer reusing the main Discord channel client's connection.
    // Creating a second discord.js Client with the same bot token can cause session churn and
    // "ready" never firing reliably after restarts.
    const runtimeClient =
      api.runtime?.discord?.getClient?.("default") ||
      api.runtime?.discord?.getClient?.() ||
      null;
    if (runtimeClient) {
      discordClient = runtimeClient;
      clientReady = runtimeClient.isReady();
      botId = runtimeClient.user?.id || null;
      api.logger.info(`[discord-local-stt-tts] Using shared Discord client (ready=${clientReady})`);
    } else {
      api.logger.warn(`[discord-local-stt-tts] Shared Discord client not available from runtime; falling back to private client`);

      // Fallback: create our own Discord client with voice intents.
      // Get Discord token from main config
      const mainConfig = api.config as { discord?: { token?: string }, channels?: { discord?: { token?: string } } };
      const discordToken = mainConfig?.channels?.discord?.token || mainConfig?.discord?.token;

      if (!discordToken) {
        api.logger.error("[discord-local-stt-tts] No Discord token found in config. Plugin requires discord token to be configured.");
        return;
      }

      discordClient = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.GuildMessages,
        ],
      });

      // Keep a conservative view of readiness; on disconnects/errors we flip clientReady back to false
      // so the watchdog can kick in.
      discordClient.on("shardDisconnect", (event) => {
        clientReady = false;
        api.logger.warn(`[discord-local-stt-tts] Discord shard disconnect: ${event?.code ?? "?"}`);
      });
      discordClient.on("shardError", (error) => {
        clientReady = false;
        api.logger.warn(`[discord-local-stt-tts] Discord shard error: ${error instanceof Error ? error.message : String(error)}`);
      });
      discordClient.on("error", (error) => {
        clientReady = false;
        api.logger.warn(`[discord-local-stt-tts] Discord client error: ${error instanceof Error ? error.message : String(error)}`);
      });

      // Login only for the private client.
      discordClient.login(discordToken).catch((err) => {
        api.logger.error(`[discord-local-stt-tts] Failed to login: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // isGatewayProcess is already defined at the top of register() – reuse it.
    const isGatewayService = isGatewayProcess;




    // Voice state tracking (debugging disconnects)
    // We log only the bot's own voice state transitions to avoid spamming.
    discordClient.on("voiceStateUpdate", (oldState, newState) => {
      try {
        const uid = newState?.id || oldState?.id;
        const bid = botId || discordClient?.user?.id;
        if (!bid || uid !== bid) return;

        const guildName = newState.guild?.name || oldState.guild?.name || "?";
        const guildId = newState.guild?.id || oldState.guild?.id || "?";
        const oldCh = oldState.channel;
        const newCh = newState.channel;

        api.logger.warn(
          `[discord-local-stt-tts] BOT voiceStateUpdate: guild=${guildName}(${guildId}) ` +
          `channel ${oldCh ? `${oldCh.name}(${oldCh.id})` : "<none>"} -> ${newCh ? `${newCh.name}(${newCh.id})` : "<none>"} ` +
          `deaf=${newState.deaf} selfDeaf=${newState.selfDeaf} mute=${newState.mute} selfMute=${newState.selfMute} suppress=${newState.suppress}`
        );

        // Also log current voice-manager session snapshot for correlation
        if (voiceManager) {
          const sessions = voiceManager.getAllSessions().map((s) => ({ guildId: s.guildId, channelId: s.channelId }));
          api.logger.warn(`[discord-local-stt-tts] BOT voiceStateUpdate: voiceManager.sessions=${JSON.stringify(sessions)}`);
        }
      } catch {
        // ignore
      }
    });


    const onReady = async () => {
      clientReady = true;
      botId = discordClient?.user?.id || null;
      api.logger.info(`[discord-local-stt-tts] Discord client ready as ${discordClient?.user?.tag}`);

      // Set bot user ID on voice manager for echo filtering
      if (discordClient?.user?.id && voiceManager) {
        voiceManager.setBotUserId(discordClient.user.id);
      }

      // Auto-join channel if configured.
      if (cfg.autoJoinChannel && isGatewayService) {
        if (autoJoinSuppressed || voiceManager?.resetSuppressAutoJoin) {
          api.logger.info(`[discord-local-stt-tts] Auto-join suppressed after reset. Use 'dvoice join' to rejoin.`);
        } else {
          try {
            api.logger.info(`[discord-local-stt-tts] Auto-joining channel ${cfg.autoJoinChannel}`);
            await new Promise(resolve => setTimeout(resolve, 2000));

            const channel = await discordClient!.channels.fetch(cfg.autoJoinChannel);
            if (channel && channel.isVoiceBased()) {
              const vm = ensureVoiceManager();
              await vm.join(channel as VoiceBasedChannel);
              api.logger.info(`[discord-local-stt-tts] Auto-joined voice channel: ${channel.name}`);
            } else {
              api.logger.warn(`[discord-local-stt-tts] Auto-join channel ${cfg.autoJoinChannel} is not a voice channel`);
            }
          } catch (error) {
            api.logger.error(`[discord-local-stt-tts] Failed to auto-join: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    };

    if (discordClient && discordClient.isReady()) {
      // shared client already connected
      void onReady();
    } else {
      discordClient?.once("ready", () => { void onReady(); });
    }

    /**
     * Handle transcribed speech - route to agent and get response
     */
    // Cache OpenClaw embedded-agent helpers (do not depend on hashed dist paths).
    interface EmbeddedDeps {
      runEmbeddedPiAgent: (...args: unknown[]) => Promise<unknown>;
      resolveStorePath: (...args: unknown[]) => string;
      loadSessionStore: (...args: unknown[]) => Record<string, unknown>;
      saveSessionStore: (...args: unknown[]) => void;
      resolveSessionFilePath: (...args: unknown[]) => string;
      resolveAgentDir: (...args: unknown[]) => string;
      resolveAgentWorkspaceDir: (...args: unknown[]) => string;
      resolveAgentIdentity: (...args: unknown[]) => { name?: string } | null;
      resolveAgentTimeoutMs: (...args: unknown[]) => number;
      ensureAgentWorkspace: (...args: unknown[]) => Promise<void>;
      DEFAULT_MODEL: string;
      DEFAULT_PROVIDER: string;
    }

    let _embeddedDepsPromise: Promise<EmbeddedDeps> | null = null;

    async function _getEmbeddedDeps(): Promise<EmbeddedDeps> {
      if (_embeddedDepsPromise) return _embeddedDepsPromise;
      // @ts-ignore — extensionAPI.js has no type declarations; cast to our interface.
      _embeddedDepsPromise = import("/opt/homebrew/lib/node_modules/openclaw/dist/extensionAPI.js") as Promise<EmbeddedDeps>;
      return _embeddedDepsPromise!;
    }

    async function handleTranscript(
      userId: string,
      guildId: string,
      channelId: string,
      text: string
    ): Promise<string> {
      api.logger.info(`[discord-local-stt-tts] Processing transcript from ${userId}: "${text}"`);

      try {
        const deps = await _getEmbeddedDeps();

        const coreConfig = api.config as CoreConfig;
        const agentId = "main";

        const sessionKey = resolveVoiceSessionKey(userId, guildId);

        const storePath = deps.resolveStorePath(coreConfig.session?.store, { agentId });
        const agentDir = deps.resolveAgentDir(coreConfig, agentId);
        const workspaceDir = deps.resolveAgentWorkspaceDir(coreConfig, agentId);
        await deps.ensureAgentWorkspace({ dir: workspaceDir });

        const sessionStore = deps.loadSessionStore(storePath);
        const now = Date.now();
        type SessionEntry = { sessionId: string; updatedAt: number };
        let sessionEntry = sessionStore[sessionKey] as SessionEntry | undefined;

        if (!sessionEntry) {
          sessionEntry = { sessionId: crypto.randomUUID(), updatedAt: now };
          sessionStore[sessionKey] = sessionEntry;
          await deps.saveSessionStore(storePath, sessionStore);
        }

        const sessionId = sessionEntry.sessionId;
        const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, { agentId });

        const modelRef = cfg.model || `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
        const slashIndex = modelRef.indexOf("/");
        const provider = slashIndex === -1 ? deps.DEFAULT_PROVIDER : modelRef.slice(0, slashIndex);
        const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);
        const thinkLevel = cfg.thinkLevel || "off";

        const identity = deps.resolveAgentIdentity(coreConfig, agentId);
        const agentName = identity?.name?.trim() || "assistant";
        const extraSystemPrompt = `You are ${agentName}, speaking in a Discord voice channel. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The user's Discord ID is ${userId}.`;

        const timeoutMs = deps.resolveAgentTimeoutMs({ cfg: coreConfig });
        const runId = `discord-local-stt-tts:${guildId}:${Date.now()}`;

        const result = await deps.runEmbeddedPiAgent({
          sessionId,
          sessionKey,
          messageProvider: "discord",
          sessionFile,
          workspaceDir,
          config: coreConfig,
          prompt: text,
          provider,
          model,
          thinkLevel,
          verboseLevel: "off",
          timeoutMs,
          runId,
          extraSystemPrompt,
          agentDir,
        });

        const payloads = (result as any)?.payloads ?? [];

        // Debug: payload inspection (why are we returning empty?)
        try {
          const summary = Array.isArray(payloads)
            ? payloads.map((p: any) => ({
              type: p?.type,
              isError: !!p?.isError,
              hasText: !!p?.text,
              textLen: (typeof p?.text === "string") ? p.text.length : 0,
            }))
            : [{ type: "<non-array>", isError: false, hasText: false, textLen: 0 }];
          api.logger.warn(`[discord-local-stt-tts] Agent payload summary: ${JSON.stringify(summary)}`);
        } catch {
          // ignore
        }

        const texts = (Array.isArray(payloads) ? payloads : [])
          .filter((p: any) => typeof p?.text === "string" && p.text.trim().length > 0 && !p.isError)
          .map((p: any) => p.text.trim());

        const out = texts.join(" ").trim();

        // Sync voice I/O to user's DM for text record
        if (out && discordClient) {
          try {
            const user = await discordClient.users.fetch(userId);
            const dm = await user.createDM();
            await dm.send(`🎙️ **You (voice):** ${text}\n🤖 **${agentName}:** ${out}`);
          } catch (dmErr) {
            // DM sync is best-effort; don't disrupt voice
            api.logger.debug?.(`[discord-local-stt-tts] DM sync failed: ${dmErr instanceof Error ? dmErr.message : String(dmErr)}`);
          }
        }

        return out || "";
      } catch (error) {
        api.logger.error(`[discord-local-stt-tts] Agent chat error: ${error instanceof Error ? error.message : String(error)}`);
        return "I'm sorry, I encountered an error processing your request.";
      }
    }

    /**
     * Ensure voice manager is initialized
     */
    function ensureVoiceManager(): VoiceConnectionManager {
      if (!voiceManager) {
        const botUserId = discordClient?.user?.id;
        voiceManager = new VoiceConnectionManager(cfg, api.logger, handleTranscript, botUserId);
      }
      return voiceManager;
    }

    /**
     * Get Discord client
     */
    async function waitForDiscordClientReady(timeoutMs = 15_000): Promise<Client> {
      if (clientReady && discordClient) return discordClient;

      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (clientReady && discordClient) return discordClient;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Discord client not ready after ${timeoutMs}ms`);
    }

    function getDiscordClient(): Client | null {
      if (!clientReady || !discordClient) {
        api.logger.warn("[discord-local-stt-tts] Discord client not ready yet");
        return null;
      }
      return discordClient;
    }

    // Register Gateway RPC methods

    // Session override control
    api.registerGatewayMethod("discord-local-stt-tts.session.get", async ({ respond }) => {
      respond(true, { overrides: sessionOverrides });
    });

    api.registerGatewayMethod("discord-local-stt-tts.session.set", async ({ params, respond }) => {
      try {
        const p = params as { scope?: "user" | "guild"; userId?: string; guildId?: string; sessionKey?: string } | null;
        const scope = p?.scope;
        const sessionKey = p?.sessionKey?.trim();

        if (!scope) {
          respond(false, { error: "scope required (user|guild)" });
          return;
        }
        if (!sessionKey) {
          respond(false, { error: "sessionKey required" });
          return;
        }

        if (scope === "user") {
          const uid = p?.userId?.trim();
          if (!uid) {
            respond(false, { error: "userId required for scope=user" });
            return;
          }
          sessionOverrides[`user:${uid}`] = sessionKey;
        } else {
          const gid = p?.guildId?.trim();
          if (!gid) {
            respond(false, { error: "guildId required for scope=guild" });
            return;
          }
          sessionOverrides[`guild:${gid}`] = sessionKey;
        }

        saveSessionOverrides();
        respond(true, { ok: true, overrides: sessionOverrides });
      } catch (e) {
        respond(false, { error: e instanceof Error ? e.message : String(e) });
      }
    });

    api.registerGatewayMethod("discord-local-stt-tts.session.clear", async ({ params, respond }) => {
      try {
        const p = params as { scope?: "user" | "guild"; userId?: string; guildId?: string } | null;
        const scope = p?.scope;
        if (!scope) {
          respond(false, { error: "scope required (user|guild)" });
          return;
        }
        if (scope === "user") {
          const uid = p?.userId?.trim();
          if (!uid) {
            respond(false, { error: "userId required for scope=user" });
            return;
          }
          delete sessionOverrides[`user:${uid}`];
        } else {
          const gid = p?.guildId?.trim();
          if (!gid) {
            respond(false, { error: "guildId required for scope=guild" });
            return;
          }
          delete sessionOverrides[`guild:${gid}`];
        }
        saveSessionOverrides();
        respond(true, { ok: true, overrides: sessionOverrides });
      } catch (e) {
        respond(false, { error: e instanceof Error ? e.message : String(e) });
      }
    });

    // Single-flight join: merge concurrent join requests for the same channel
    let joinInFlightRpc: Promise<{ guildId: string; channelId: string }> | null = null;
    let joinInFlightChannelId: string | null = null;

    api.registerGatewayMethod("discord-local-stt-tts.join", async ({ params, respond }) => {
      try {
        const p = params as { channelId?: string; guildId?: string } | null;
        const channelId = p?.channelId;

        if (!channelId) {
          respond(false, { error: "channelId required" });
          return;
        }

        // Check if already joined to this channel (no-op)
        const vm = ensureVoiceManager();
        const existingSessions = vm.getAllSessions();
        const alreadyJoined = existingSessions.find((s) => s.channelId === channelId);
        if (alreadyJoined) {
          respond(true, {
            joined: true,
            guildId: alreadyJoined.guildId,
            channelId: alreadyJoined.channelId,
            note: "already joined",
          });
          return;
        }

        // Single-flight: if a join for the same channel is in progress, wait for it
        if (joinInFlightRpc && joinInFlightChannelId === channelId) {
          api.logger.info(`[discord-local-stt-tts] Join single-flight: merging request for ${channelId}`);
          const result = await joinInFlightRpc;
          respond(true, { joined: true, ...result, note: "merged" });
          return;
        }

        const client = getDiscordClient();
        if (!client) {
          respond(false, { error: "Discord client not available" });
          return;
        }

        // Clear auto-join suppression on explicit join
        clearAutoJoinSuppressed();
        vm.resetSuppressAutoJoin = false;

        joinInFlightChannelId = channelId;
        joinInFlightRpc = (async () => {
          const channel = await client.channels.fetch(channelId);
          if (!channel || !("guild" in channel) || !channel.isVoiceBased()) {
            throw new Error("Invalid voice channel");
          }
          const session = await vm.join(channel as VoiceBasedChannel);
          return { guildId: session.guildId, channelId: session.channelId };
        })();

        try {
          const result = await joinInFlightRpc;
          respond(true, { joined: true, ...result });
        } finally {
          joinInFlightRpc = null;
          joinInFlightChannelId = null;
        }
      } catch (error) {
        respond(false, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    api.registerGatewayMethod("discord-local-stt-tts.leave", async ({ params, respond }) => {
      try {
        const p = params as { guildId?: string } | null;
        let guildId = p?.guildId;

        const vm = ensureVoiceManager();

        // If no guildId provided, leave all
        if (!guildId) {
          const sessions = vm.getAllSessions();
          if (sessions.length === 0) {
            respond(true, { left: false, reason: "Not in any voice channel" });
            return;
          }
          guildId = sessions[0].guildId;
        }

        const left = await vm.leave(guildId);
        respond(true, { left, guildId });
      } catch (error) {
        respond(false, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    api.registerGatewayMethod("discord-local-stt-tts.speak", async ({ params, respond }) => {
      try {
        const p = params as { text?: string; guildId?: string } | null;
        const text = p?.text;
        let guildId = p?.guildId;

        if (!text) {
          respond(false, { error: "text required" });
          return;
        }

        const vm = ensureVoiceManager();

        if (!guildId) {
          const sessions = vm.getAllSessions();
          if (sessions.length === 0) {
            respond(false, { error: "Not in any voice channel" });
            return;
          }
          guildId = sessions[0].guildId;
        }

        await vm.speak(guildId, text);
        respond(true, { spoken: true });
      } catch (error) {
        respond(false, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    api.registerGatewayMethod("discord-local-stt-tts.reset", async ({ params, respond }) => {
      try {
        const p = params as { guildId?: string } | null;
        const vm = ensureVoiceManager();
        const result = vm.forceReset(p?.guildId || undefined);
        respond(true, { reset: result, autoJoinSuppressed: true });
      } catch (error) {
        respond(false, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    api.registerGatewayMethod("discord-local-stt-tts.status", async ({ respond }) => {
      try {
        const vm = ensureVoiceManager();
        const sessions = vm.getAllSessions().map((s) => ({
          guildId: s.guildId,
          channelId: s.channelId,
          speaking: s.speaking,
          usersListening: s.userAudioStates.size,
        }));
        respond(true, { sessions });
      } catch (error) {
        respond(false, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    // Register agent tool
    api.registerTool({
      name: "discord_voice",
      label: "Discord Voice",
      description: "Control Discord voice channel - join, leave, speak, or get status",
      parameters: VoiceToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const p = params as { action: string; channelId?: string; guildId?: string; text?: string };
          const vm = ensureVoiceManager();
          const client = getDiscordClient();

          switch (p.action) {
            case "join": {
              if (!p.channelId) throw new Error("channelId required");
              if (!client) throw new Error("Discord client not available");

              const channel = await client.channels.fetch(p.channelId);
              if (!channel || !("guild" in channel) || !channel.isVoiceBased()) {
                throw new Error("Invalid voice channel");
              }

              const session = await vm.join(channel as VoiceBasedChannel);
              return json({ joined: true, guildId: session.guildId, channelId: session.channelId });
            }

            case "leave": {
              let guildId = p.guildId;
              if (!guildId) {
                const sessions = vm.getAllSessions();
                if (sessions.length === 0) {
                  return json({ left: false, reason: "Not in any voice channel" });
                }
                guildId = sessions[0].guildId;
              }
              const left = await vm.leave(guildId);
              return json({ left, guildId });
            }

            case "speak": {
              if (!p.text) throw new Error("text required");
              let guildId = p.guildId;
              if (!guildId) {
                const sessions = vm.getAllSessions();
                if (sessions.length === 0) {
                  throw new Error("Not in any voice channel");
                }
                guildId = sessions[0].guildId;
              }
              await vm.speak(guildId, p.text);
              return json({ spoken: true });
            }

            case "status": {
              const sessions = vm.getAllSessions().map((s) => ({
                guildId: s.guildId,
                channelId: s.channelId,
                speaking: s.speaking,
                usersListening: s.userAudioStates.size,
              }));
              return json({ sessions });
            }

            case "session_get": {
              return json({ overrides: sessionOverrides, path: overridesPath });
            }

            case "session_set": {
              const scope = (p as any).scope as "user" | "guild" | undefined;
              const sessionKey = (p as any).sessionKey as string | undefined;
              if (!scope) throw new Error("scope required (user|guild)");
              if (!sessionKey) throw new Error("sessionKey required");

              if (scope === "user") {
                const uid = (p as any).userId as string | undefined;
                if (!uid) throw new Error("userId required for scope=user");
                sessionOverrides[`user:${uid}`] = sessionKey;
              } else {
                const gid = (p as any).guildId as string | undefined;
                if (!gid) throw new Error("guildId required for scope=guild");
                sessionOverrides[`guild:${gid}`] = sessionKey;
              }
              saveSessionOverrides();
              return json({ ok: true, overrides: sessionOverrides });
            }

            case "session_clear": {
              const scope = (p as any).scope as "user" | "guild" | undefined;
              if (!scope) throw new Error("scope required (user|guild)");
              if (scope === "user") {
                const uid = (p as any).userId as string | undefined;
                if (!uid) throw new Error("userId required for scope=user");
                delete sessionOverrides[`user:${uid}`];
              } else {
                const gid = (p as any).guildId as string | undefined;
                if (!gid) throw new Error("guildId required for scope=guild");
                delete sessionOverrides[`guild:${gid}`];
              }
              saveSessionOverrides();
              return json({ ok: true, overrides: sessionOverrides });
            }

            default:
              throw new Error(`Unknown action: ${p.action}`);
          }
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    });

    // NOTE: CLI commands for `dvoice` are now registered in the CLI early-exit block above.
    // The gateway process does NOT need to register CLI commands – only gateway RPC methods
    // and background services (watchdog, auto-join, etc.).

    // ---- Auto-join watchdog (gateway only) ----
    // We observed cases where the gateway is running but the embedded discord-local-stt-tts client
    // never reaches the "ready" event (or joins, then silently drops). This watchdog makes
    // the desired state explicit: if configured, stay joined.
    //
    // CRITICAL: This must NOT spam join attempts. Use single-flight + backoff.
    const SINGLE_ATTEMPT_DEBUG_MODE = false;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let lastWatchdogStatusLogAt = 0;
    let joinInFlight: Promise<void> | null = null;
    let consecutiveJoinFailures = 0;
    let backoffUntilMs = 0;

    function _computeBackoffMs(failures: number): number {
      // 1s, 2s, 4s, 8s, ... capped at 10 minutes
      const ms = Math.min(10 * 60_000, 1000 * Math.pow(2, Math.max(0, failures - 1)));
      // minimum 5s after repeated failures to reduce churn
      return failures <= 1 ? ms : Math.max(ms, 5_000);
    }

    async function watchdogEnsureJoined() {
      if (!cfg.autoJoinChannel) return;
      if (!isGatewayService) return;
      if (autoJoinSuppressed || voiceManager?.resetSuppressAutoJoin) return;

      const now = Date.now();
      if (backoffUntilMs && now < backoffUntilMs) {
        if (now - lastWatchdogStatusLogAt > 30_000) {
          lastWatchdogStatusLogAt = now;
          api.logger.warn(`[discord-local-stt-tts] Watchdog: backoff active for ${backoffUntilMs - now}ms (failures=${consecutiveJoinFailures})`);
        }
        return;
      }

      if (joinInFlight) return;

      // Client readiness
      if (!discordClient) return;
      if (!clientReady) {
        const now = Date.now();
        if (now - lastWatchdogStatusLogAt > 30_000) {
          lastWatchdogStatusLogAt = now;
          api.logger.warn("[discord-local-stt-tts] Watchdog: discord client not ready yet; waiting...");
        }
        return;
      }

      // If we are already in a voice session for the target guild, do nothing.
      let channel: any;
      try {
        channel = await discordClient.channels.fetch(cfg.autoJoinChannel);
      } catch (e) {
        api.logger.warn(
          `[discord-local-stt-tts] Watchdog: failed to fetch autoJoinChannel ${cfg.autoJoinChannel}: ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }

      if (!channel || !channel.isVoiceBased?.()) {
        api.logger.warn(`[discord-local-stt-tts] Watchdog: autoJoinChannel ${cfg.autoJoinChannel} is not a voice channel`);
        return;
      }

      const targetGuildId = ("guild" in channel && channel.guild?.id) ? channel.guild.id : undefined;
      const vm = ensureVoiceManager();

      // Ensure echo-filter has bot user id (in case manager was created before ready)
      if (discordClient.user?.id) vm.setBotUserId(discordClient.user.id);

      if (targetGuildId) {
        const existing = vm.getAllSessions().find((s) => s.guildId === targetGuildId);
        if (existing) return;
      } else {
        // Fallback: if ANY session exists, assume joined.
        if (vm.getAllSessions().length > 0) return;
      }

      try {
        api.logger.info(`[discord-local-stt-tts] Watchdog: joining voice channel ${channel.name} (${cfg.autoJoinChannel})`);
        joinInFlight = (async () => {
          await vm.join(channel as VoiceBasedChannel);
        })();
        await joinInFlight;

        // success
        consecutiveJoinFailures = 0;
        backoffUntilMs = 0;
      } catch (e) {
        consecutiveJoinFailures++;
        const backoffMs = _computeBackoffMs(consecutiveJoinFailures);
        backoffUntilMs = Date.now() + backoffMs;

        api.logger.error(
          `[discord-local-stt-tts] Watchdog: join failed: ${e instanceof Error ? e.message : String(e)} ` +
          `(failures=${consecutiveJoinFailures}, backoffMs=${backoffMs})`
        );

        // After too many failures, suppress auto-join until an explicit manual join.
        if (consecutiveJoinFailures >= 10) {
          setAutoJoinSuppressed(true, `watchdog: too many join failures (${consecutiveJoinFailures})`);
          api.logger.error(`[discord-local-stt-tts] Watchdog: auto-join suppressed after repeated failures. Use 'dvoice join' to rejoin.`);
        }
      } finally {
        joinInFlight = null;
      }
    }

    // Register background service
    api.registerService({
      id: "discord-local-stt-tts",
      start: async () => {
        api.logger.info("[discord-local-stt-tts] Service started (single-attempt debug build A)");

        // Reset watchdog failure/backoff state on every gateway start.
        // Gateway restarts (SIGUSR1) can reuse the same process/module cache; without this,
        // a previous OpenAI-TTS misconfig can leave auto-join stuck in backoff for minutes.
        consecutiveJoinFailures = 0;
        backoffUntilMs = 0;
        joinInFlight = null;

        // Explicit manual join should clear suppression; on gateway start we also clear it
        // so config fixes take effect immediately.
        clearAutoJoinSuppressed();

        // IMPORTANT: watchdog runs only in the long-running gateway service.
        if (!isGatewayService) {
          api.logger.debug?.("[discord-local-stt-tts] Service start: watchdog disabled (not gateway service)");
          return;
        }

        // If a previous session called forceReset(), it flips resetSuppressAutoJoin=true and watchdog will never join again.
        // In gateway service mode, clear that flag on startup so autoJoinChannel works after restarts.
        try {
          const vm = ensureVoiceManager();
          vm.resetSuppressAutoJoin = false;
        } catch {
          // ignore
        }

        // Kick once shortly after service starts.
        setTimeout(() => {
          watchdogEnsureJoined().catch(() => void 0);
        }, 5_000);

        if (SINGLE_ATTEMPT_DEBUG_MODE) {
          api.logger.warn("[discord-local-stt-tts] Service start: SINGLE_ATTEMPT_DEBUG_MODE enabled; periodic watchdog disabled");

          // In single-attempt mode, do a short burst of retries waiting for discord client readiness,
          // then stop completely (avoids reconnect/destroy churn).
          let tries = 0;
          const maxTries = 15; // ~15s
          const burst = setInterval(() => {
            tries++;
            if (tries > maxTries) {
              clearInterval(burst);
              return;
            }
            watchdogEnsureJoined().catch(() => void 0);
          }, 1000);

          return;
        }

        // Then keep checking.
        if (watchdogTimer) clearInterval(watchdogTimer);
        watchdogTimer = setInterval(() => {
          watchdogEnsureJoined().catch((e) => {
            api.logger.error(
              `[discord-local-stt-tts] Watchdog tick error: ${e instanceof Error ? e.message : String(e)}`
            );
          });
        }, 30_000);
      },
      stop: async () => {
        if (watchdogTimer) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
        }
        if (voiceManager) {
          await voiceManager.destroy();
          voiceManager = null;
        }
        // Destroy the Discord client to close its WebSocket and release the event loop.
        // Without this, the old gateway process lingers after restart (zombie process).
        if (discordClient) {
          try {
            api.logger.info("[discord-local-stt-tts] Destroying Discord client...");
            discordClient.destroy();
            discordClient = null;
            clientReady = false;
          } catch (e) {
            api.logger.warn(
              `[discord-local-stt-tts] Discord client destroy error: ${e instanceof Error ? e.message : String(e)}`
            );
          }
        }
        api.logger.info("[discord-local-stt-tts] Service stopped");
        _registered = false; // Allow re-registration on hot-reload
      },
    });

    // ── Process-level cleanup: safety net for gateway restart ──
    // If the framework sends SIGTERM/SIGINT but does not call service.stop(),
    // the Discord client WebSocket would keep the process alive as a zombie.
    // This ensures the old process always exits cleanly on restart.
    if (isGatewayService) {
      const cleanupAndExit = (signal: string) => {
        api.logger.info(`[discord-local-stt-tts] Received ${signal}, cleaning up...`);
        if (watchdogTimer) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
        }
        try {
          voiceManager?.destroy();
        } catch { /* ignore */ }
        voiceManager = null;
        try {
          discordClient?.destroy();
        } catch { /* ignore */ }
        discordClient = null;
        clientReady = false;
        _registered = false;
        // Allow the process to exit naturally after cleanup.
        // Don't call process.exit() – let the framework handle it.
      };
      process.once("SIGTERM", () => cleanupAndExit("SIGTERM"));
      process.once("SIGINT", () => cleanupAndExit("SIGINT"));
    }
  },
};

export default discordVoicePlugin;
