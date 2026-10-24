/**
 * `read_image_text` over the real local filesystem, the real local attachment
 * store, and a scripted `llm` adapter: route validation, media sniffing, the
 * durable image commit, the one-shot vision dispatch, every refusal arm, the
 * deadline, cancellation, and disposal.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { AttachmentError, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as ToolImageText from '../src/index.ts'
import {
  IMAGE_TEXT_PROMPT,
  IMAGE_TEXT_TIMEOUT_CODE,
  resolveImageTextRoute,
  sniffImageMediaType,
} from '../src/read-image-text.ts'

/** 1x1 red PNG (valid signature, IHDR, IDAT). */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
/** 1x1 red GIF (GIF89a). */
const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

/** Exact instruction the vision request is pinned to. */
const IMAGE_TEXT_SYSTEM = 'You extract information from one image and answer with plain text.'

const VISION_MODEL = 'vision-model'

/** Scripted adapter: it answers from `behavior` and records every request. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private models: LlmModelInfo[]

  constructor(models: LlmModelInfo[] = [
    { provider: 'vision', id: VISION_MODEL, name: 'Vision', inputModalities: ['text', 'image'] },
    { provider: 'vision', id: 'text-only', name: 'Text Only', inputModalities: ['text'] },
  ]) {
    super()
    this.models = models
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const info = this.models.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: info?.name ?? model,
      ...info?.inputModalities === undefined ? {} : { inputModalities: [...info.inputModalities] },
    })
  }

  behavior: (options: GenerateOptions) => AsyncIterable<StreamChunk> = () => textStream('extracted text')

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return this.behavior(options)
  }
}

/** Emit one text block in two deltas. */
async function* textStream(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: text.slice(0, 4) }
  yield { type: 'text-delta', index: 0, text: text.slice(4) }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Attachment store double for the deployment and storage failure arms. */
class FailureStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1024,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1024,
    maxImagePixels: 1024,
    maxImageDimension: 16,
    mediaTypes: ['image/png'],
  }

  constructor(ctx: Context, private readonly failure: Error) {
    super(ctx)
  }

  override validateImage(): Promise<void> {
    return Promise.resolve()
  }

  override saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    throw this.failure
  }

  override readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error('FailureStore never reads images')
  }
}

let dir: string
let home: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-image-text-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-image-text-home-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

interface SetupOptions {
  attachments?: boolean
  workingDirectory?: boolean
  store?: (ctx: Context) => Promise<void>
  adapter?: ScriptedAdapter
  config?: Partial<ToolImageText.Config>
}

interface Harness {
  ctx: Context
  adapter: ScriptedAdapter
}

/** Mount the real local backends and the plugin under test. */
async function setup(options: SetupOptions = {}): Promise<Harness> {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const adapter = options.adapter ?? new ScriptedAdapter()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['vision'], adapter)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  if (options.workingDirectory === true) provideWorkingDirectory(ctx, dir)
  if (options.store !== undefined) await options.store(ctx)
  else if (options.attachments !== false) await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(ToolImageText, configOverride(options.config))
  return { ctx, adapter }
}

/** A structurally valid working-directory collaborator pinned to one directory. */
function provideWorkingDirectory(ctx: Context, directory: string): void {
  ctx.provide('workingDirectory', {
    defaultDirectory: directory,
    get: () => directory,
    ensure: () => Promise.resolve(directory),
  })
}

/** Default route values with per-test overrides. */
function configOverride(overrides: Partial<ToolImageText.Config> = {}): ToolImageText.Config {
  return { provider: 'vision', model: VISION_MODEL, maxOutputTokens: 256, timeoutMs: 5_000, ...overrides }
}

let callCounter = 0

/** Execute one `read_image_text` call through the real tool pipeline. */
function call(
  ctx: Context,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; agent?: object } = {},
) {
  return ctx.tools.execute({
    signal: options.signal ?? new AbortController().signal,
    callId: ToolCallId(`image-text-${++callCounter}`),
    name: 'read_image_text',
    arguments: args,
    ...options.agent === undefined ? {} : { agent: options.agent as never },
  })
}

/** A calling agent stub pinned to one session directory. */
function agentOn(cwd: string): object {
  return {
    options: {},
    session: { header: { cwd }, requestHeader: () => undefined, deriveMessages: () => [], append: () => undefined },
  }
}

/** Concatenate the text blocks of one tool result. */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('')
}

describe('resolveImageTextRoute', () => {
  it('fills the default prompt and freezes the resolved route', () => {
    const route = resolveImageTextRoute({ provider: 'vision', model: VISION_MODEL, maxOutputTokens: 64, timeoutMs: 1 })
    expect(route).toEqual({
      provider: 'vision',
      model: VISION_MODEL,
      maxOutputTokens: 64,
      timeoutMs: 1,
      prompt: IMAGE_TEXT_PROMPT,
    })
    expect(Object.isFrozen(route)).toBe(true)
  })

  it('keeps a deployment-supplied prompt verbatim', () => {
    const route = resolveImageTextRoute({ provider: 'vision', model: VISION_MODEL, maxOutputTokens: 64, timeoutMs: 1, prompt: 'Read the diagram.' })
    expect(route.prompt).toBe('Read the diagram.')
  })

  it('refuses an incomplete route instead of defaulting provider or model', () => {
    expect(() => resolveImageTextRoute(configOverride({ provider: ' ' }))).toThrow(/provider must be a non-empty string/)
    expect(() => resolveImageTextRoute(configOverride({ model: '' }))).toThrow(/model must be a non-empty string/)
  })

  it('refuses non-positive and non-integer request bounds', () => {
    expect(() => resolveImageTextRoute(configOverride({ maxOutputTokens: 0 }))).toThrow(/maxOutputTokens must be a positive integer/)
    expect(() => resolveImageTextRoute(configOverride({ maxOutputTokens: 1.5 }))).toThrow(/maxOutputTokens must be a positive integer/)
    expect(() => resolveImageTextRoute(configOverride({ timeoutMs: 0 }))).toThrow(/timeoutMs must be a positive integer/)
    expect(() => resolveImageTextRoute(configOverride({ timeoutMs: Number.POSITIVE_INFINITY })))
      .toThrow(/timeoutMs must be a positive integer/)
    expect(() => resolveImageTextRoute(configOverride({ timeoutMs: MAX_TIMER_DELAY_MS + 1 }))).toThrow(/must not exceed/)
    expect(() => resolveImageTextRoute(configOverride({ prompt: '   ' }))).toThrow(/prompt must be a non-empty string/)
  })
})

describe('sniffImageMediaType', () => {
  it('identifies each supported container from its signature', () => {
    expect(sniffImageMediaType(new Uint8Array(PNG_1X1))).toBe('image/png')
    expect(sniffImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMediaType(new TextEncoder().encode('GIF87a...'))).toBe('image/gif')
    expect(sniffImageMediaType(new Uint8Array(GIF_1X1))).toBe('image/gif')
    expect(sniffImageMediaType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
  })

  it('returns undefined for other bytes and incomplete signatures', () => {
    expect(sniffImageMediaType(new Uint8Array())).toBeUndefined()
    expect(sniffImageMediaType(new TextEncoder().encode('plain text'))).toBeUndefined()
    expect(sniffImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e]))).toBeUndefined()
    expect(sniffImageMediaType(Uint8Array.from([0xff]))).toBeUndefined()
    expect(sniffImageMediaType(new TextEncoder().encode('GIF90a'))).toBeUndefined()
    expect(sniffImageMediaType(new TextEncoder().encode('RIFF'))).toBeUndefined()
    expect(sniffImageMediaType(new TextEncoder().encode('RIFF\0\0\0\0WAVE'))).toBeUndefined()
  })
})

describe('read_image_text extraction', () => {
  it('saves the image durably, dispatches the configured route, and returns its text', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx, adapter } = await setup({ workingDirectory: true })

    const result = await call(ctx, { file_path: 'red.png' }, { agent: agentOn(dir) })

    if (result.isError) throw new Error(`expected success: ${textOf(result)}`)
    expect(result.value).toEqual({
      path: join(await realpath(dir), 'red.png'),
      text: 'extracted text',
      provider: 'vision',
      model: VISION_MODEL,
    })
    expect(textOf(result)).toBe('extracted text')

    // The request carries the committed image block and the fixed prompt.
    const request = adapter.requests[0]
    expect(request).toBeDefined()
    if (request === undefined) throw new Error('no request recorded')
    expect(request.provider).toBe('vision')
    expect(request.model).toBe(VISION_MODEL)
    expect(request.maxTokens).toBe(256)
    expect(request.system).toBe(IMAGE_TEXT_SYSTEM)
    const message = request.messages[0]
    expect(message?.role).toBe('user')
    if (message === undefined) throw new Error('no message recorded')
    const image = message.content[0]
    expect(image?.type).toBe('image')
    if (image?.type !== 'image') throw new Error('the image block is missing')
    expect(image.attachment.mediaType).toBe('image/png')
    expect(image.attachment.width).toBe(1)
    const instruction = message.content[1]
    expect(instruction).toEqual({ type: 'text', text: IMAGE_TEXT_PROMPT })

    // The bytes are durably committed, not only referenced.
    const stored = await ctx.attachments.readImage(image.attachment)
    expect(Buffer.from(stored.data).equals(PNG_1X1)).toBe(true)
  })

  it('identifies an extension-less image from its bytes', async () => {
    await writeFile(join(dir, 'blob'), PNG_1X1)
    const { ctx } = await setup()
    const result = await call(ctx, { file_path: 'blob' })
    if (result.isError) throw new Error(`expected success: ${textOf(result)}`)
    expect(result.value).toEqual({
      path: join(await realpath(dir), 'blob'),
      text: 'extracted text',
      provider: 'vision',
      model: VISION_MODEL,
    })
  })

  it('concatenates every text block and ignores non-text blocks', async () => {
    const adapter = new ScriptedAdapter()
    adapter.behavior = async function* clamped(): AsyncIterable<StreamChunk> {
      yield { type: 'reasoning-delta', index: 0, text: 'thinking' }
      yield { type: 'text-delta', index: 1, text: 'alpha ' }
      yield { type: 'text-delta', index: 2, text: 'beta' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx } = await setup({ adapter })
    const result = await call(ctx, { file_path: 'red.png' })
    if (result.isError) throw new Error(`expected success: ${textOf(result)}`)
    expect(result.value.text).toBe('alpha beta')
  })

  it('presents a read card for the pending call and renders only its text', async () => {
    const { ctx } = await setup()
    const definition = ctx.tools.get('read_image_text')
    expect(definition?.presentCall?.({ file_path: 'red.png' })).toEqual({
      card: 'generic',
      title: 'Read image text red.png',
      kind: 'read',
      locations: [{ path: 'red.png' }],
    })
    expect(definition?.isConcurrencySafe?.({ file_path: 'red.png' })).toBe(true)
    expect(definition?.output.render({ file_path: 'red.png' }, {
      path: '/tmp/red.png',
      text: 'text',
      provider: 'vision',
      model: VISION_MODEL,
    })).toEqual([{ type: 'text', text: 'text' }])
  })
})

describe('read_image_text refusals', () => {
  it('refuses an empty path before any filesystem work', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, { file_path: '   ' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('file_path must be a non-empty string')
  })

  it('refuses a path whose extension declares another format', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, { file_path: 'notes.txt' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('does not declare a supported image format')
  })

  it('refuses an extension-less file whose bytes are not an image', async () => {
    await writeFile(join(dir, 'notes'), 'just text')
    const { ctx } = await setup()
    const result = await call(ctx, { file_path: 'notes' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('the file content is not a supported image format')
  })

  it('refuses when no attachment store is mounted', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx } = await setup({ attachments: false })
    const result = await call(ctx, { file_path: 'red.png' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no attachment service is mounted')
  })

  it('reports a missing file and a non-file target with filesystem codes', async () => {
    await mkdir(join(dir, 'folder'))
    const { ctx } = await setup()
    const missing = await call(ctx, { file_path: 'missing.png' })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('not found')
    const directory = await call(ctx, { file_path: 'folder' })
    expect(directory.isError).toBe(true)
    expect(textOf(directory)).toContain('not a regular file')
  })

  it('refuses a configured route that does not declare image input', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx, adapter } = await setup({ config: { model: 'text-only' } })
    const result = await call(ctx, { file_path: 'red.png' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('configured vision model "text-only" does not declare image input')
    expect(adapter.requests).toHaveLength(0)
  })

  it('refuses a media type the deployment does not accept', async () => {
    await writeFile(join(dir, 'red.gif'), GIF_1X1)
    const { ctx } = await setup({ store: async (ctx) => { await ctx.plugin(FailureStore, new AttachmentError('unused', 'UNSUPPORTED_IMAGE_TYPE')) } })
    const result = await call(ctx, { file_path: 'red.gif' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('image/gif images are not accepted by this deployment')
  })

  it('surfaces an attachment-store refusal with the file path', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx } = await setup({ store: async (ctx) => { await ctx.plugin(FailureStore, new AttachmentError('image exceeds the byte limit', 'IMAGE_TOO_LARGE')) } })
    const result = await call(ctx, { file_path: 'red.png' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('the attachment store refused the image: image exceeds the byte limit')
  })

  it('propagates a non-attachment storage failure unchanged', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx } = await setup({ store: async (ctx) => { await ctx.plugin(FailureStore, new Error('disk full')) } })
    const result = await call(ctx, { file_path: 'red.png' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('disk full')
  })

  it('surfaces a provider failure and an aborted stream as tool errors', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const failing = new ScriptedAdapter()
    failing.behavior = async function* failed(): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'PROVIDER_ERROR' } } }
    }
    const first = await setup({ adapter: failing })
    const failure = await call(first.ctx, { file_path: 'red.png' })
    expect(failure.isError).toBe(true)
    expect(textOf(failure)).toContain('provider exploded')

    const aborted = new ScriptedAdapter()
    aborted.behavior = async function* cancelled(): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'caller cancelled', code: 'ABORTED' } } }
    }
    const second = await setup({ adapter: aborted })
    const cancellation = await call(second.ctx, { file_path: 'red.png' })
    expect(cancellation.isError).toBe(true)
    expect(textOf(cancellation)).toContain('caller cancelled')
  })

  it('refuses a response that carries no text', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const silent = new ScriptedAdapter()
    silent.behavior = async function* silentStream(): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const { ctx } = await setup({ adapter: silent })
    const result = await call(ctx, { file_path: 'red.png' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(`the configured vision model "${VISION_MODEL}" returned no text`)
  })
})

describe('read_image_text cancellation and deadline', () => {
  it('stops at the configured deadline and names its timeout code', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const slow = new ScriptedAdapter()
    slow.behavior = options => (async function* pending(): AsyncIterable<StreamChunk> {
      const signal = options.signal
      if (signal === undefined) throw new Error('the vision dispatch must carry a deadline signal')
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
    })()
    const { ctx } = await setup({ adapter: slow, config: { timeoutMs: 20 } })
    const result = await call(ctx, { file_path: 'red.png' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain(`${IMAGE_TEXT_TIMEOUT_CODE} after 20ms`)
    expect(slow.requests).toHaveLength(1)
  })

  it('honors a caller signal that is already aborted', async () => {
    await writeFile(join(dir, 'red.png'), PNG_1X1)
    const { ctx, adapter } = await setup()
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const result = await call(ctx, { file_path: 'red.png' }, { signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(adapter.requests).toHaveLength(0)
  })
})

describe('read_image_text lifecycle', () => {
  it('removes the tool when its contributing fiber is disposed', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter())
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await ctx.plugin(LocalAttachmentStore, { dshHome: home })

    const fiber = ctx.plugin(ToolImageText, configOverride())
    await fiber
    expect(ctx.tools.get('read_image_text')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('read_image_text')).toBeUndefined()
  })

  it('fails plugin load on an incomplete route', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['vision'], new ScriptedAdapter())
    await ctx.plugin(LocalFileSystem, { cwd: dir })
    await expect(ctx.plugin(ToolImageText, configOverride({ provider: '' }))).rejects.toThrow(/provider must be a non-empty string/)
  })
})
