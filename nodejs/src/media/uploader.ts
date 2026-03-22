import { createHash, randomBytes } from 'node:crypto'
import { MediaError } from '../core/errors.js'
import type { Logger } from '../logger/types.js'
import type { ILinkApi } from '../protocol/api.js'
import { CDN_BASE_URL, type CDNMedia, type MediaType } from '../protocol/types.js'
import {
  encodeAesKeyBase64,
  encodeAesKeyHex,
  encryptAesEcb,
  encryptedSize,
  generateAesKey,
} from './crypto.js'

export interface UploadResult {
  /** CDNMedia reference to include in sendmessage */
  media: CDNMedia
  /** The AES key used (raw 16 bytes) */
  aesKey: Buffer
  /** Encrypted file size */
  encryptedFileSize: number
}

export interface UploadOptions {
  /** File content as Buffer */
  data: Buffer
  /** Target user ID */
  userId: string
  /** Media type for the upload */
  mediaType: MediaType
}

/**
 * Handles file encryption and CDN upload.
 * Implements the full upload pipeline: getuploadurl → encrypt → CDN POST.
 */
export class MediaUploader {
  private readonly logger: Logger

  constructor(
    private readonly api: ILinkApi,
    private readonly cdnBaseUrl: string = CDN_BASE_URL,
    logger: Logger,
  ) {
    this.logger = logger.child('upload')
  }

  async upload(
    baseUrl: string,
    token: string,
    options: UploadOptions,
  ): Promise<UploadResult> {
    const { data, userId, mediaType } = options

    // 1. Generate AES key and encrypt
    const aesKey = generateAesKey()
    const ciphertext = encryptAesEcb(data, aesKey)
    const filekey = randomBytes(16).toString('hex')
    const rawMd5 = createHash('md5').update(data).digest('hex')

    this.logger.debug('Encrypted file', {
      rawSize: data.length,
      encryptedSize: ciphertext.length,
      filekey,
    })

    // 2. Get upload URL
    const uploadParams = await this.api.getUploadUrl(baseUrl, token, {
      filekey,
      media_type: mediaType,
      to_user_id: userId,
      rawsize: data.length,
      rawfilemd5: rawMd5,
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: encodeAesKeyHex(aesKey),
    })

    if (!uploadParams.upload_param) {
      throw new MediaError('getuploadurl did not return upload_param')
    }

    this.logger.debug('Got upload params', { filekey })

    // 3. Upload to CDN
    const uploadUrl = `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParams.upload_param)}&filekey=${encodeURIComponent(filekey)}`

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: ciphertext as unknown as BodyInit,
      signal: AbortSignal.timeout(60_000),
    })

    if (!response.ok) {
      const errorMsg = response.headers.get('x-error-message') ?? `HTTP ${response.status}`
      throw new MediaError(`CDN upload failed: ${errorMsg}`)
    }

    const encryptQueryParam = response.headers.get('x-encrypted-param')
    if (!encryptQueryParam) {
      throw new MediaError('CDN upload succeeded but x-encrypted-param header is missing')
    }

    this.logger.info('Upload complete', { filekey, mediaType })

    return {
      media: {
        encrypt_query_param: encryptQueryParam,
        aes_key: encodeAesKeyBase64(aesKey),
        encrypt_type: 1,
      },
      aesKey,
      encryptedFileSize: ciphertext.length,
    }
  }
}
