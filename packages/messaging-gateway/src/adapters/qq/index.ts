/** Official QQ Open Platform adapter: C2C/group text, attachments and commands. */
import { QQBot, type QQBotOptions, type QQBotInboundMessage, type ReplyTarget } from '@tencent-connect/qqbot-nodejs'
import { basename, extname } from 'node:path'
import { loadQQAttachments, QQ_MAX_FILE_BYTES } from './attachments'
import type {
  PlatformAdapter, PlatformConfig, AdapterCapabilities, IncomingMessage,
  SentMessage, InlineButton, ButtonPress, MessagingPlatformRuntimeState,
} from '../../types'

export interface QQCredentials {
  appId: string
  appSecret: string
}

export function parseQQCredentials(token: string | undefined): QQCredentials {
  if (!token) throw new Error('QQ credentials are missing')
  let value: unknown
  try { value = JSON.parse(token) } catch { throw new Error('QQ credentials must be valid JSON') }
  if (!value || typeof value !== 'object') throw new Error('Invalid QQ credentials')
  const { appId, appSecret } = value as Partial<QQCredentials>
  if (typeof appId !== 'string' || !/^\d+$/.test(appId.trim())) {
    throw new Error('QQ App ID must contain digits only')
  }
  if (typeof appSecret !== 'string' || !appSecret.trim()) throw new Error('QQ App Secret is empty')
  return { appId: appId.trim(), appSecret: appSecret.trim() }
}

export async function testQQCredentials(input: QQCredentials): Promise<{ success: boolean; error?: string }> {
  try {
    const creds = parseQQCredentials(JSON.stringify(input))
    const response = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: creds.appId, clientSecret: creds.appSecret }),
      signal: AbortSignal.timeout(15_000),
    })
    const value = await response.json() as { access_token?: string }
    // Do not surface raw authentication responses or secrets to the UI/logs.
    if (!response.ok || !value.access_token) throw new Error('QQ rejected the credentials. Check App ID and App Secret.')
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Could not verify QQ credentials' }
  }
}

type StatusHandler = (state: MessagingPlatformRuntimeState, error?: string) => void

export class QQAdapter implements PlatformAdapter {
  readonly platform = 'qq' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: false, inlineButtons: false, maxButtons: 0,
    maxMessageLength: 2000, markdown: 'plain', webhookSupport: false,
  }
  private bot: QQBot | null = null
  private connected = false
  private messageHandler?: (msg: IncomingMessage) => Promise<void>
  private statusHandler?: StatusHandler
  private abort?: AbortController
  private rejectStartup?: (error: Error) => void
  private replyTargets = new Map<string, ReplyTarget>()
  private seen = new Set<string>()
  private queues = new Map<string, Promise<void>>()

  constructor(private readonly createBot: (options: QQBotOptions) => QQBot = (options) => new QQBot(options)) {}

  async initialize(config: PlatformConfig): Promise<void> {
    await this.destroy()
    const creds = parseQQCredentials(config.token)
    this.statusHandler = typeof config.onStatus === 'function' ? config.onStatus as StatusHandler : undefined
    const bot = this.createBot({
      ...creds, accountId: creds.appId, transport: 'websocket',
      markdownSupport: false, intents: 1 << 25,
      // The SDK's default logger is silent; do not log protocol payloads/tokens.
    })
    this.bot = bot
    const abort = new AbortController()
    this.abort = abort
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        this.rejectStartup = reject
        const ready = () => {
          if (this.bot !== bot) return
          this.connected = true
          this.statusHandler?.('connected')
          resolve()
        }
        bot.on('ready', ready)
        bot.on('resumed', ready)
        bot.on('error', () => {
          if (this.bot !== bot) return
          this.connected = false
          this.statusHandler?.('connecting', 'QQ connection interrupted; reconnecting.')
        })
        bot.on('message', async (_ctx, msg) => {
          if (this.bot !== bot) return
          await this.receive(msg)
        })
        timer = setTimeout(() => reject(new Error('QQ connection timed out. Check bot permissions and WebSocket access.')), 30_000)
        void bot.start(abort.signal).then(() => {
          if (this.bot !== bot) return
          this.connected = false
          this.statusHandler?.('error', 'QQ connection stopped. Reconnect in Settings → Messaging.')
          reject(new Error('QQ connection stopped before becoming ready'))
        }, () => {
          if (this.bot !== bot) return
          this.connected = false
          const error = new Error('Could not connect to QQ. Check credentials, permissions and network.')
          this.statusHandler?.('error', error.message)
          reject(error)
        })
      })
    } catch (err) {
      await this.destroy()
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      this.rejectStartup = undefined
    }
  }

  async destroy(): Promise<void> {
    this.rejectStartup?.(new Error('QQ connection cancelled'))
    this.rejectStartup = undefined
    const bot = this.bot
    this.bot = null
    this.connected = false
    this.abort?.abort()
    this.abort = undefined
    bot?.stop()
    this.replyTargets.clear()
    this.seen.clear()
    this.queues.clear()
  }

  isConnected(): boolean { return this.connected }
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void { this.messageHandler = handler }
  onButtonPress(_handler: (press: ButtonPress) => Promise<void>): void {}

  private async receive(msg: QQBotInboundMessage): Promise<void> {
    if (msg.senderIsBot || (msg.kind !== 'c2c' && msg.kind !== 'group')) return
    // Only explicit @mentions trigger group work. Never ingest ambient group traffic.
    if (msg.kind === 'group' && msg.rawEventType !== 'GROUP_AT_MESSAGE_CREATE') return
    const text = msg.content.replace(/^\s*<@!?\d+>\s*/, '').trim()
    const attachments = msg.attachments ?? []
    const signal = this.abort?.signal
    if ((!text && !attachments.length) || !msg.senderId || !msg.messageId || !msg.replyTarget.targetId) return
    const channelId = `${msg.replyTarget.scope}:${msg.replyTarget.targetId}`
    const key = `${channelId}:${msg.messageId}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!)
    this.replyTargets.delete(channelId)
    this.replyTargets.set(channelId, { ...msg.replyTarget })
    if (this.replyTargets.size > 1000) this.replyTargets.delete(this.replyTargets.keys().next().value!)
    await this.messageHandler?.({
      platform: 'qq', channelId, messageId: msg.messageId, senderId: msg.senderId,
      senderName: msg.senderName, text: text || '请查看并处理这些附件。',
      ...(attachments.length ? { loadAttachments: () => loadQQAttachments(attachments, signal) } : {}),
      timestamp: Date.parse(msg.timestamp) || Date.now(), raw: msg.raw,
    })
  }

  async sendText(channelId: string, text: string): Promise<SentMessage> {
    const bot = this.bot
    if (!bot || !this.connected) throw new Error('QQ is not connected')
    const match = /^(c2c|group):(.+)$/.exec(channelId)
    if (!match) throw new Error('Invalid QQ chat ID')
    const target = this.replyTargets.get(channelId) ?? {
      scope: match[1] as ReplyTarget['scope'], targetId: match[2]!,
    }
    let messageId = ''
    const previous = this.queues.get(channelId) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      if (this.bot !== bot) throw new Error('QQ connection changed')
      const chars = Array.from(text)
      for (let offset = 0; offset < chars.length; offset += this.capabilities.maxMessageLength) {
        const sent = await bot.sendText(target, chars.slice(offset, offset + this.capabilities.maxMessageLength).join(''))
        messageId = sent.id
      }
    })
    this.queues.set(channelId, task)
    try { await task } finally { if (this.queues.get(channelId) === task) this.queues.delete(channelId) }
    return { platform: 'qq', channelId, messageId }
  }

  async editMessage(): Promise<void> { throw new Error('QQ text editing is not supported') }
  async sendButtons(channelId: string, text: string, _buttons: InlineButton[]): Promise<SentMessage> {
    return this.sendText(channelId, text)
  }
  async sendTyping(): Promise<void> {}
  async sendFile(channelId: string, file: Buffer, filename: string, caption?: string): Promise<SentMessage> {
    const bot = this.bot
    if (!bot || !this.connected) throw new Error('QQ is not connected')
    const match = /^(c2c|group):(.+)$/.exec(channelId)
    if (!match) throw new Error('Invalid QQ chat ID')
    if (!file.length || file.length > QQ_MAX_FILE_BYTES) throw new Error('QQ 附件必须为 1 字节至 20 MB')
    const target = this.replyTargets.get(channelId) ?? { scope: match[1] as ReplyTarget['scope'], targetId: match[2]! }
    const name = basename(filename.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '_')
    let messageId = ''
    const previous = this.queues.get(channelId) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      if (this.bot !== bot) throw new Error('QQ connection changed')
      const extension = extname(name).toLowerCase()
      const result = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)
        ? await bot.sendImage(target, { buffer: file }, { content: caption })
        : await bot.sendFile(target, { buffer: file }, { fileName: name, content: caption })
      messageId = result.message?.id ?? ''
    })
    this.queues.set(channelId, task)
    try { await task } finally { if (this.queues.get(channelId) === task) this.queues.delete(channelId) }
    return { platform: 'qq', channelId, messageId }
  }
}
