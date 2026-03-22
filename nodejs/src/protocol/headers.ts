import { randomBytes } from 'node:crypto'

/**
 * Generate the X-WECHAT-UIN header value.
 * Algorithm: random uint32 → decimal string → base64
 */
export function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

/**
 * Build the standard iLink Bot API headers for POST requests.
 */
export function buildAuthHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': randomWechatUin(),
  }
}
