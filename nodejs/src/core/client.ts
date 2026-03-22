import { TypedEmitter, type BotEventMap } from './events.js'
import { NoContextError } from './errors.js'

import { Authenticator, type Credentials, type QrLoginCallbacks } from '../auth/index.js'
import { createLogger, type Logger, type LogLevel } from '../logger/index.js'
import { MediaDownloader, MediaUploader, type UploadOptions, type UploadResult } from '../media/index.js'
import { MessageBuilder, MessageParser, type IncomingMessage } from '../message/index.js'
import { MiddlewareEngine, type Middleware } from '../middleware/index.js'
import { ContextStore, MessagePoller, MessageSender, TypingService } from '../messaging/index.js'
import { ILinkApi } from '../protocol/api.js'
import { DEFAULT_BASE_URL, type CDNMedia, type MediaType, type WireMessageItem } from '../protocol/types.js'
import { FileStorage, MemoryStorage, type Storage } from '../storage/index.js'
import { HttpClient } from '../transport/http.js'

// ═══════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════

export interface WeChatBotOptions {
  /** Base URL for the iLink API (default: https://ilinkai.weixin.qq.com) */
  baseUrl?: string
  /** Storage backend: 'file', 'memory', or a custom Storage instance */
  storage?: 'file' | 'memory' | Storage
  /** Directory for file storage (only used when storage is 'file') */
  storageDir?: string
  /** Log level */
  logLevel?: LogLevel
  /** Custom logger instance */
  logger?: Logger
  /** QR login callbacks (for rendering QR codes, etc.) */
  loginCallbacks?: QrLoginCallbacks
}

// ═══════════════════════════════════════════════════════════════════════
// Main Client
// ═══════════════════════════════════════════════════════════════════════

/**
 * WeChatBot — the main entry point.
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────────┐
 *   │                   WeChatBot                      │
 *   │                                                 │
 *   │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
 *   │  │  Poller   │  │  Sender  │  │   Typing     │  │
 *   │  │ (receive) │  │  (send)  │  │  (indicator) │  │
 *   │  └────┬─────┘  └─────┬────┘  └──────┬───────┘  │
 *   │       │              │               │          │
 *   │  ┌────┴──────────────┴───────────────┴──────┐   │
 *   │  │            Context Store                  │   │
 *   │  │        (context_token cache)              │   │
 *   │  └──────────────────┬───────────────────────┘   │
 *   │                     │                           │
 *   │  ┌──────────────────┴───────────────────────┐   │
 *   │  │            iLink API                      │   │
 *   │  │         (protocol layer)                  │   │
 *   │  └──────────────────┬───────────────────────┘   │
 *   │                     │                           │
 *   │  ┌──────────────────┴───────────────────────┐   │
 *   │  │           HTTP Client                     │   │
 *   │  │      (transport + retry)                  │   │
 *   │  └─────────────────────────────────────────┘   │
 *   └─────────────────────────────────────────────────┘
 *
 * Usage:
 *   const bot = new WeChatBot({ storage: 'file' })
 *   await bot.login()
 *
 *   bot.use(loggingMiddleware(bot.logger))
 *   bot.onMessage(async (msg) => {
 *     await bot.reply(msg, `Echo: ${msg.text}`)
 *   })
 *
 *   await bot.start()
 */
export class WeChatBot extends TypedEmitter<BotEventMap> {
  // ── Public components (accessible for advanced use) ─────────────────
  readonly logger: Logger
  readonly storage: Storage
  readonly uploader: MediaUploader
  readonly downloader: MediaDownloader

  // ── Internal services ───────────────────────────────────────────────
  private readonly http: HttpClient
  private readonly api: ILinkApi
  private readonly auth: Authenticator
  private readonly parser: MessageParser
  private readonly middleware: MiddlewareEngine
  private readonly contextStore: ContextStore
  private readonly poller: MessagePoller
  private readonly sender: MessageSender
  private readonly typing: TypingService

  // ── State ───────────────────────────────────────────────────────────
  private baseUrl: string
  private credentials?: Credentials
  private messageHandlers: Array<(msg: IncomingMessage) => void | Promise<void>> = []
  private runPromise: Promise<void> | null = null

  constructor(options: WeChatBotOptions = {}) {
    super()

    // Initialize foundational components
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.logger = options.logger ?? createLogger({ level: options.logLevel ?? 'info' })
    this.storage = resolveStorage(options)

    // Build the layered architecture
    this.http = new HttpClient({ logger: this.logger })
    this.api = new ILinkApi(this.http)
    this.auth = new Authenticator(this.api, this.storage, this.logger)
    this.parser = new MessageParser()
    this.middleware = new MiddlewareEngine()
    this.contextStore = new ContextStore(this.storage, this.logger)
    this.poller = new MessagePoller(this.api, this.storage, this.logger)
    this.sender = new MessageSender(this.api, this.contextStore, this.logger)
    this.typing = new TypingService(this.api, this.contextStore, this.logger)
    this.uploader = new MediaUploader(this.api, undefined, this.logger)
    this.downloader = new MediaDownloader(undefined, this.logger)

    // Wire up internal events
    this.setupPollerEvents()
  }

  // ═══════════════════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Login to WeChat. Uses stored credentials if available, otherwise starts QR flow.
   */
  async login(options: { force?: boolean; callbacks?: QrLoginCallbacks } = {}): Promise<Credentials> {
    const creds = await this.auth.login({
      force: options.force,
      baseUrl: this.baseUrl,
      callbacks: options.callbacks,
    })

    this.setCredentials(creds)
    this.emit('login', creds)
    return creds
  }

  /** Get current credentials (undefined if not logged in). */
  getCredentials(): Credentials | undefined {
    return this.credentials
  }

  // ═══════════════════════════════════════════════════════════════════
  // Middleware
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Register middleware for the message processing pipeline.
   * Middleware runs before message handlers, in order of registration.
   *
   * @example
   *   bot.use(loggingMiddleware(bot.logger))
   *   bot.use(rateLimitMiddleware({ maxMessages: 10, windowMs: 60_000 }))
   */
  use(middleware: Middleware): this {
    this.middleware.use(middleware)
    return this
  }

  // ═══════════════════════════════════════════════════════════════════
  // Message Handlers
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Register a message handler.
   * Called after middleware for every incoming user message.
   */
  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): this {
    this.messageHandlers.push(handler)
    return this
  }

  /**
   * Event-style alias for onMessage.
   */
  on(event: 'message', handler: (msg: IncomingMessage) => void | Promise<void>): this
  on<K extends keyof BotEventMap>(event: K, handler: (...args: BotEventMap[K]) => void | Promise<void>): this
  on(event: string, handler: (...args: any[]) => void | Promise<void>): this {
    if (event === 'message') {
      return this.onMessage(handler as (msg: IncomingMessage) => void | Promise<void>)
    }
    return super.on(event as keyof BotEventMap, handler as any)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Sending
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Reply to an incoming message with text.
   * Automatically uses the correct context_token and cancels typing.
   */
  async reply(message: IncomingMessage, text: string): Promise<void> {
    const creds = this.requireCredentials()
    this.contextStore.set(message.userId, message._contextToken)
    await this.sender.sendText(creds.baseUrl, creds.token, message.userId, text, message._contextToken)
    // Auto-cancel typing
    this.typing.stopTyping(creds.baseUrl, creds.token, message.userId).catch(() => {})
  }

  /**
   * Send text to a user (requires a prior context_token from that user).
   */
  async send(userId: string, text: string): Promise<void> {
    const creds = this.requireCredentials()
    await this.sender.sendText(creds.baseUrl, creds.token, userId, text)
  }

  /**
   * Send a pre-built message (for advanced use with MessageBuilder).
   */
  async sendMessage(payload: ReturnType<MessageBuilder['build']>): Promise<void> {
    const creds = this.requireCredentials()
    await this.sender.sendRaw(creds.baseUrl, creds.token, payload)
  }

  /**
   * Upload a file and send it as a media message.
   */
  async sendMedia(
    userId: string,
    options: UploadOptions & { contextToken?: string },
  ): Promise<UploadResult> {
    const creds = this.requireCredentials()
    const result = await this.uploader.upload(creds.baseUrl, creds.token, options)
    return result
  }

  /**
   * Download and decrypt a media file from a message.
   */
  async downloadMedia(media: CDNMedia, aeskeyOverride?: string): Promise<Buffer> {
    return this.downloader.download(media, aeskeyOverride)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Typing
  // ═══════════════════════════════════════════════════════════════════

  /** Show "typing..." indicator to a user. */
  async sendTyping(userId: string): Promise<void> {
    const creds = this.requireCredentials()
    await this.typing.startTyping(creds.baseUrl, creds.token, userId)
  }

  /** Cancel "typing..." indicator for a user. */
  async stopTyping(userId: string): Promise<void> {
    const creds = this.requireCredentials()
    await this.typing.stopTyping(creds.baseUrl, creds.token, userId)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Start receiving messages (long-poll loop).
   * Call login() first if not already authenticated.
   */
  async start(): Promise<void> {
    if (this.runPromise) return this.runPromise

    const creds = this.requireCredentials()

    // Load persisted state
    await Promise.all([
      this.contextStore.load(),
      this.poller.loadCursor(),
    ])

    this.emit('poll:start')
    this.runPromise = this.poller.start(creds.baseUrl, creds.token)

    try {
      await this.runPromise
    } finally {
      this.runPromise = null
      this.emit('poll:stop')
    }
  }

  /**
   * Convenience method: login + start in one call.
   * Equivalent to `await bot.login(); await bot.start()`.
   */
  async run(options?: { force?: boolean; callbacks?: QrLoginCallbacks }): Promise<void> {
    await this.login(options)
    await this.start()
  }

  /** Stop the bot gracefully. */
  stop(): void {
    this.poller.stop()
    this.contextStore.flush().catch(() => {})
    this.emit('close')
  }

  /** Whether the bot is currently polling for messages. */
  get isRunning(): boolean {
    return this.poller.isRunning
  }

  // ═══════════════════════════════════════════════════════════════════
  // Utility
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Create a MessageBuilder for composing complex messages.
   */
  createMessage(userId: string): MessageBuilder {
    const ctx = this.contextStore.get(userId)
    if (!ctx) throw new NoContextError(userId)
    return MessageBuilder.to(userId, ctx)
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal wiring
  // ═══════════════════════════════════════════════════════════════════

  private setupPollerEvents(): void {
    // Process incoming messages through the pipeline
    this.poller.on('messages', async (messages) => {
      for (const wire of messages) {
        // Always remember context tokens
        this.contextStore.remember(wire)

        // Parse to user-friendly format
        const incoming = this.parser.parse(wire)
        if (!incoming) continue

        // Run through middleware chain
        const ctx = await this.middleware.run(incoming)
        if (ctx.handled) continue

        // Dispatch to message handlers
        this.emit('message', incoming)
        await this.dispatchToHandlers(incoming)
      }

      // Persist context tokens after batch
      this.contextStore.flush().catch(() => {})
    })

    // Handle session expiry → re-login
    this.poller.on('session:expired', async () => {
      this.logger.warn('Session expired — initiating re-login')
      this.emit('session:expired')

      try {
        await this.auth.clearAll()
        this.typing.clearCache()
        const creds = await this.login({ force: true })
        this.emit('session:restored', creds)

        // Restart polling with new credentials
        await this.poller.resetCursor()
        // The poller loop will pick up new credentials automatically
      } catch (error) {
        this.logger.error(`Re-login failed: ${error instanceof Error ? error.message : String(error)}`)
        this.emit('error', error)
      }
    })

    // Forward poller errors
    this.poller.on('error', (error) => {
      this.emit('error', error)
    })
  }

  private async dispatchToHandlers(message: IncomingMessage): Promise<void> {
    const results = await Promise.allSettled(
      this.messageHandlers.map((handler) => handler(message)),
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(`Handler error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        this.emit('error', result.reason)
      }
    }
  }

  private setCredentials(creds: Credentials): void {
    const previousToken = this.credentials?.token
    this.credentials = creds
    this.baseUrl = creds.baseUrl

    // If token changed, clear stale state
    if (previousToken && previousToken !== creds.token) {
      this.contextStore.clear().catch(() => {})
      this.typing.clearCache()
      this.poller.resetCursor().catch(() => {})
    }
  }

  private requireCredentials(): Credentials {
    if (!this.credentials) {
      throw new Error('Not logged in. Call login() first.')
    }
    return this.credentials
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function resolveStorage(options: WeChatBotOptions): Storage {
  if (options.storage === undefined || options.storage === 'file') {
    return new FileStorage(options.storageDir)
  }
  if (options.storage === 'memory') {
    return new MemoryStorage()
  }
  return options.storage // Custom Storage instance
}
