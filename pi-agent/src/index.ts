/**
 * Pi Extension: WeChat Bridge
 *
 * Scan a QR code in WeChat → chat with your Pi coding agent from your phone.
 *
 * Uses the @anthropic/wechatbot SDK for all WeChat iLink protocol operations.
 *
 * Architecture:
 *   ┌──────────────┐      ┌──────────────┐      ┌──────────┐
 *   │  WeChat User │ ←──→ │  iLink API   │ ←──→ │ Pi Agent │
 *   │  (phone)     │      │  (Tencent)   │      │ (laptop) │
 *   └──────────────┘      └──────────────┘      └──────────┘
 *                                 ↑
 *                          @anthropic/wechatbot SDK
 *
 * Install:
 *   pi -e /path/to/wechatbot/pi-agent/src/index.ts
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { WeChatBot, type IncomingMessage } from '@anthropic/wechatbot'

export default function wechatBridge(pi: ExtensionAPI) {
  let bot: WeChatBot | null = null
  let connected = false
  let activeUserId: string | null = null
  let pendingReply: IncomingMessage | null = null

  // ── Collect assistant response for WeChat reply ───────────────────
  let assistantText = ''
  let isStreaming = false

  // When agent finishes → send accumulated reply to WeChat
  pi.on('agent_end', async (event, ctx) => {
    if (!bot || !connected || !pendingReply) return

    const reply = pendingReply
    pendingReply = null
    isStreaming = false

    // Extract the assistant's last message text
    const messages = event.messages ?? []
    let finalText = ''
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        for (const block of msg.content) {
          if (block.type === 'text') finalText += block.text
        }
      }
    }

    if (!finalText.trim()) {
      finalText = assistantText || '[No response from agent]'
    }

    try {
      await bot.stopTyping(reply.userId)
      await bot.reply(reply, finalText)
      ctx.ui.setStatus('wechat', `✓ Replied to WeChat user`)
    } catch (e) {
      ctx.ui.setStatus('wechat', `✗ Reply failed: ${e instanceof Error ? e.message : e}`)
    }

    assistantText = ''
  })

  // Track streaming text
  pi.on('message_update', async (event) => {
    if (!isStreaming) return
    const msg = event.message
    if (msg.role === 'assistant') {
      let text = ''
      for (const block of msg.content) {
        if (block.type === 'text') text += block.text
      }
      assistantText = text
    }
  })

  // ── /wechat command — start the bridge ────────────────────────────

  pi.registerCommand('wechat', {
    description: 'Connect WeChat — scan QR code to chat with Pi from your phone',
    handler: async (args, ctx) => {
      // Already connected? Show menu.
      if (connected && bot) {
        const action = await ctx.ui.select('WeChat is already connected', [
          'Disconnect',
          'Show status',
          'Cancel',
        ])
        if (action === 'Disconnect') {
          bot.stop()
          connected = false
          ctx.ui.setStatus('wechat', undefined)
          ctx.ui.notify('WeChat disconnected', 'info')
        } else if (action === 'Show status') {
          const creds = bot.getCredentials()
          ctx.ui.notify(
            `Connected as ${creds?.accountId ?? 'unknown'}\nUser: ${creds?.userId ?? 'unknown'}`,
            'info',
          )
        }
        return
      }

      // ── Create a new WeChatBot instance using our SDK ──────────────
      bot = new WeChatBot({
        storage: 'file',      // Persist credentials to ~/.wechatbot/
        logLevel: 'warn',     // Quiet — we show status via pi TUI instead
      })

      const forceLogin = args?.trim() === '--force'

      ctx.ui.notify('Starting WeChat login...', 'info')
      ctx.ui.setStatus('wechat', '⏳ Waiting for QR scan...')

      try {
        // ── Login using the SDK ──────────────────────────────────────
        const creds = await bot.login({
          force: forceLogin,
          callbacks: {
            onQrUrl: (url) => {
              // Show the QR URL in pi TUI widget
              ctx.ui.setWidget('wechat-qr', [
                '╔══════════════════════════════════════════╗',
                '║    📱 Scan this QR code in WeChat        ║',
                '╚══════════════════════════════════════════╝',
                '',
                url,
                '',
                'Open this URL in WeChat to login.',
                'Or scan the QR code from the URL page.',
              ])
            },
            onScanned: () => {
              ctx.ui.setStatus('wechat', '📱 QR scanned — confirm in WeChat...')
            },
            onExpired: () => {
              ctx.ui.setStatus('wechat', '⏳ QR expired — requesting new one...')
            },
          },
        })

        // Clear QR widget after successful login
        ctx.ui.setWidget('wechat-qr', undefined)
        ctx.ui.setStatus('wechat', `✓ WeChat: ${creds.accountId}`)
        ctx.ui.notify(`WeChat connected! Account: ${creds.accountId}`, 'info')
        connected = true

        // ── Register message handler ─────────────────────────────────
        // WeChat messages → pi prompts (via SDK's onMessage)
        bot.onMessage(async (msg: IncomingMessage) => {
          if (msg.type !== 'text' || !msg.text.trim()) {
            await bot!.reply(msg, `[Received ${msg.type} — only text messages are supported currently]`)
            return
          }

          activeUserId = msg.userId
          pendingReply = msg
          isStreaming = true
          assistantText = ''

          // Show typing indicator in WeChat (SDK handles getconfig + sendtyping)
          try { await bot!.sendTyping(msg.userId) } catch { /* non-fatal */ }

          // Show in pi TUI footer
          ctx.ui.setStatus('wechat', `📱 ${msg.userId.slice(0, 20)}…: ${msg.text.slice(0, 50)}`)

          // ★ Core bridge: inject WeChat message as a pi prompt
          pi.sendUserMessage(msg.text)
        })

        // ── SDK error handling ────────────────────────────────────────
        bot.on('error', (err) => {
          ctx.ui.setStatus('wechat', `⚠ ${err instanceof Error ? err.message : String(err)}`)
        })

        bot.on('session:expired', () => {
          ctx.ui.setStatus('wechat', '⚠ WeChat session expired — re-login...')
        })

        bot.on('session:restored', (newCreds) => {
          ctx.ui.setStatus('wechat', `✓ WeChat reconnected: ${newCreds.accountId}`)
        })

        // ── Start the SDK's long-poll loop (runs in background) ──────
        bot.start().catch((e) => {
          ctx.ui.setStatus('wechat', `✗ WeChat poll error: ${e instanceof Error ? e.message : e}`)
          connected = false
        })

      } catch (e) {
        ctx.ui.setWidget('wechat-qr', undefined)
        ctx.ui.setStatus('wechat', undefined)
        ctx.ui.notify(`WeChat login failed: ${e instanceof Error ? e.message : e}`, 'error')
        bot = null
      }
    },
  })

  // ── /wechat-disconnect ────────────────────────────────────────────

  pi.registerCommand('wechat-disconnect', {
    description: 'Disconnect WeChat bridge',
    handler: async (_args, ctx) => {
      if (bot) { bot.stop(); bot = null }
      connected = false
      activeUserId = null
      pendingReply = null
      ctx.ui.setStatus('wechat', undefined)
      ctx.ui.setWidget('wechat-qr', undefined)
      ctx.ui.notify('WeChat disconnected', 'info')
    },
  })

  // ── /wechat-send — manual send ────────────────────────────────────

  pi.registerCommand('wechat-send', {
    description: 'Send a message to the connected WeChat user',
    handler: async (args, ctx) => {
      if (!bot || !connected || !activeUserId) {
        ctx.ui.notify('No WeChat user connected. Run /wechat first.', 'error')
        return
      }
      const text = args?.trim()
      if (!text) {
        ctx.ui.notify('Usage: /wechat-send <message>', 'error')
        return
      }
      try {
        await bot.send(activeUserId, text)
        ctx.ui.notify(`Sent to WeChat: ${text.slice(0, 50)}…`, 'info')
      } catch (e) {
        ctx.ui.notify(`Send failed: ${e instanceof Error ? e.message : e}`, 'error')
      }
    },
  })

  // ── Cleanup on shutdown ───────────────────────────────────────────

  pi.on('session_shutdown', async () => {
    if (bot) { bot.stop(); bot = null }
    connected = false
  })

  // ── Restore status on session start ───────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    if (connected && bot) {
      const creds = bot.getCredentials()
      ctx.ui.setStatus('wechat', `✓ WeChat: ${creds?.accountId ?? 'connected'}`)
    }
  })
}
