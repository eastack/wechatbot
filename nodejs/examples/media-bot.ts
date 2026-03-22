#!/usr/bin/env npx tsx
/**
 * Media Bot — demonstrates image/file download and upload
 *
 * Shows how to:
 *   - Download images from incoming messages
 *   - Upload files to users
 *   - Use the MessageBuilder for complex messages
 *   - Handle different media types
 */

import { writeFile, readFile } from 'node:fs/promises'
import { WeChatBot, MessageBuilder, MediaType } from '../src/index.js'

const bot = new WeChatBot({ storage: 'file', logLevel: 'info' })
await bot.login({
  callbacks: {
    onQrUrl: (url) => console.log(`\nScan to login: ${url}\n`),
  },
})

bot.onMessage(async (msg) => {
  console.log(`[${msg.type}] from ${msg.userId}: ${msg.text}`)

  switch (msg.type) {
    case 'image': {
      // Download the image
      if (msg.images.length > 0 && msg.images[0]!.media) {
        await bot.sendTyping(msg.userId)
        try {
          const imageData = await bot.downloadMedia(
            msg.images[0]!.media,
            msg.images[0]!.aeskey,
          )
          // Save locally
          const filename = `/tmp/wechat-image-${Date.now()}.jpg`
          await writeFile(filename, imageData)
          await bot.reply(msg, `✓ Downloaded image (${imageData.length} bytes) → ${filename}`)
        } catch (err) {
          await bot.reply(msg, `✗ Failed to download: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        await bot.reply(msg, 'Received image but no media reference found.')
      }
      break
    }

    case 'file': {
      if (msg.files.length > 0 && msg.files[0]!.media) {
        await bot.sendTyping(msg.userId)
        try {
          const fileData = await bot.downloadMedia(msg.files[0]!.media)
          const filename = `/tmp/wechat-file-${msg.files[0]!.fileName ?? Date.now()}`
          await writeFile(filename, fileData)
          await bot.reply(msg, `✓ Downloaded file "${msg.files[0]!.fileName}" (${fileData.length} bytes)`)
        } catch (err) {
          await bot.reply(msg, `✗ Failed to download: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      break
    }

    case 'voice': {
      const voice = msg.voices[0]
      const transcription = voice?.text
      if (transcription) {
        await bot.reply(msg, `🎤 You said: "${transcription}" (${voice?.durationMs ?? 0}ms)`)
      } else {
        await bot.reply(msg, `🎤 Received voice message (${voice?.durationMs ?? 0}ms, no transcription)`)
      }
      break
    }

    case 'video': {
      await bot.reply(msg, `🎬 Received video (${msg.videos[0]?.durationMs ?? 0}ms)`)
      break
    }

    case 'text': {
      if (msg.text === '/upload') {
        await bot.reply(msg, 'Upload feature: use bot.sendMedia() to upload files programmatically.')
      } else if (msg.quotedMessage) {
        await bot.reply(msg, `You quoted: "${msg.quotedMessage.title ?? msg.quotedMessage.text ?? '(unknown)'}"`)
      } else {
        await bot.reply(msg, `Echo: ${msg.text}`)
      }
      break
    }
  }
})

process.on('SIGINT', () => bot.stop())
console.log('Media bot listening...')
await bot.start()
