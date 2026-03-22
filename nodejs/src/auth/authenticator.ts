import { setTimeout as delay } from 'node:timers/promises'
import { AuthError } from '../core/errors.js'
import type { Logger } from '../logger/types.js'
import type { ILinkApi } from '../protocol/api.js'
import { DEFAULT_BASE_URL } from '../protocol/types.js'
import type { Storage } from '../storage/interface.js'
import { STORAGE_KEYS } from '../storage/interface.js'
import type { Credentials, QrLoginCallbacks } from './types.js'

const QR_POLL_INTERVAL_MS = 2_000

/**
 * Handles the entire QR login flow with credential persistence.
 * Separated from the main client so it can be tested / replaced independently.
 */
export class Authenticator {
  private readonly logger: Logger

  constructor(
    private readonly api: ILinkApi,
    private readonly storage: Storage,
    logger: Logger,
  ) {
    this.logger = logger.child('auth')
  }

  /**
   * Attempt to load stored credentials. Returns undefined if none exist.
   */
  async loadCredentials(): Promise<Credentials | undefined> {
    return this.storage.get<Credentials>(STORAGE_KEYS.CREDENTIALS)
  }

  /**
   * Full login: try stored credentials first, fall back to QR flow.
   */
  async login(options: {
    force?: boolean
    baseUrl?: string
    callbacks?: QrLoginCallbacks
  } = {}): Promise<Credentials> {
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL

    if (!options.force) {
      const stored = await this.loadCredentials()
      if (stored) {
        this.logger.info('Loaded stored credentials', { userId: stored.userId })
        return stored
      }
    }

    return this.qrLogin(baseUrl, options.callbacks)
  }

  /**
   * Clear stored credentials and related state.
   */
  async clearAll(): Promise<void> {
    await Promise.all([
      this.storage.delete(STORAGE_KEYS.CREDENTIALS),
      this.storage.delete(STORAGE_KEYS.CURSOR),
      this.storage.delete(STORAGE_KEYS.CONTEXT_TOKENS),
      this.storage.delete(STORAGE_KEYS.TYPING_TICKETS),
    ])
    this.logger.info('Cleared all stored credentials and state')
  }

  /**
   * Execute the QR code scanning login flow.
   */
  private async qrLogin(baseUrl: string, callbacks?: QrLoginCallbacks): Promise<Credentials> {
    for (;;) {
      this.logger.info('Requesting QR code...')
      const qr = await this.api.getQrCode(baseUrl)

      // Notify caller about the QR URL
      if (callbacks?.onQrUrl) {
        callbacks.onQrUrl(qr.qrcode_img_content)
      } else {
        this.logger.info(`Scan this URL in WeChat: ${qr.qrcode_img_content}`)
      }

      let lastStatus: string | undefined

      for (;;) {
        const status = await this.api.pollQrStatus(baseUrl, qr.qrcode)

        if (status.status !== lastStatus) {
          lastStatus = status.status

          if (status.status === 'scaned') {
            this.logger.info('QR scanned — confirm in WeChat')
            callbacks?.onScanned?.()
          } else if (status.status === 'expired') {
            this.logger.warn('QR expired — requesting new one')
            callbacks?.onExpired?.()
          } else if (status.status === 'confirmed') {
            this.logger.info('Login confirmed')
          }
        }

        if (status.status === 'confirmed') {
          if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
            throw new AuthError('Login confirmed but server did not return credentials')
          }

          const credentials: Credentials = {
            token: status.bot_token,
            baseUrl: status.baseurl ?? baseUrl,
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id,
            savedAt: new Date().toISOString(),
          }

          await this.storage.set(STORAGE_KEYS.CREDENTIALS, credentials)
          this.logger.info('Credentials saved', {
            accountId: credentials.accountId,
            userId: credentials.userId,
          })

          return credentials
        }

        if (status.status === 'expired') {
          break // Outer loop will request a new QR
        }

        await delay(QR_POLL_INTERVAL_MS)
      }
    }
  }
}
