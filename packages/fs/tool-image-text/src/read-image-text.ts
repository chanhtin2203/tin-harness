/**
 * The model-facing `read_image_text` tool commits a PNG/JPEG/WebP/GIF file and
 * sends it to a separately configured vision-capable route, returning the text
 * that route extracts. It exists for callers whose own model route declares no
 * image input, so the calling route's capabilities never gate the read.
 *
 * The mounted `ctx.fs` backend owns path resolution and read access; the
 * configured route is validated once at plugin load and re-checked for declared
 * image input at execution, because a route's modality list is adapter-supplied
 * metadata that can change between loads.
 * @module @deepseek-ai/dsh-tool-image-text/read-image-text
 */

import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-tool-image-text': { kind: 'dsh-tool-image-text' } & ContextFormed
  }
}

/** Capability-owned timeout reason code for one vision extraction request. */
export const IMAGE_TEXT_TIMEOUT_CODE = 'IMAGE_TEXT_TIMEOUT'

/** Fixed instruction sent beside the image; a deployment may replace it through {@link ImageTextConfig.prompt}. */
export const IMAGE_TEXT_PROMPT =
  'Transcribe every piece of text visible in this image exactly as it appears, preserving reading order and line breaks. '
  + 'When the image contains no text, describe what it shows instead.'

/**
 * Fixed system prompt for the vision request. It names the job only: the
 * per-call instruction and image carry everything else.
 */
const IMAGE_TEXT_SYSTEM = 'You extract information from one image and answer with plain text.'

/** Extensions `read_image_text` accepts; attachment-store decoding stays authoritative. */
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const

function matchesBytes(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (data.byteLength < offset + expected.length) return false
  return expected.every((byte, index) => data[offset + index] === byte)
}

function matchesAscii(data: Uint8Array, offset: number, value: string): boolean {
  if (data.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

/**
 * Identify the media type declared by a supported image file signature.
 *
 * This duplicates `sniffImageMediaType` from `@deepseek-ai/dsh-tool-fs`
 * deliberately: importing that package would add a whole tool suite's peer
 * closure (sandbox, approvals, session, system prompt) to a package that needs
 * one four-signature check.
 * @param data - file bytes read through the current filesystem backend.
 * @returns the detected supported media type, or undefined for other bytes.
 */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesBytes(data, 0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif'
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}

/** Deployment-provided route selection before resolution. */
export interface ImageTextConfig {
  /** Registered provider route that owns the vision model; required, with no default. */
  provider: string
  /** Exact vision model id passed to that route; required, with no default. */
  model: string
  /** Output-token cap for one extraction request. */
  maxOutputTokens: number
  /** End-to-end extraction deadline in milliseconds. */
  timeoutMs: number
  /** Instruction sent beside the image; defaults to {@link IMAGE_TEXT_PROMPT}. */
  prompt?: string
}

/** Validated, immutable route and request controls for one plugin instance. */
export interface ImageTextRoute {
  /** Registered provider route that owns the vision model. */
  readonly provider: string
  /** Exact vision model id passed to that route. */
  readonly model: string
  /** Output-token cap for one extraction request. */
  readonly maxOutputTokens: number
  /** End-to-end extraction deadline in milliseconds. */
  readonly timeoutMs: number
  /** Instruction sent beside the image. */
  readonly prompt: string
}

/** The structured outcome declared by the `read_image_text` output schema. */
export interface ImageTextReadValue {
  /** Canonical absolute path in the filesystem provider's execution world. */
  path: string
  /** Text the configured vision model produced for the image. */
  text: string
  /** Provider route that served the extraction. */
  provider: string
  /** Exact model id that served the extraction. */
  model: string
}

/** Reject a non-positive-integer request bound. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`tool-image-text: ${name} must be a positive integer`)
  }
}

/**
 * Validate one deployment configuration and detach it from Loader-owned state.
 * Every bound is explicit: provider and model have no defaults, so an
 * incomplete route fails at plugin load instead of at the first call.
 * @param config - candidate deployment configuration.
 * @returns the immutable route used by this plugin instance.
 * @throws {Error} when the route is incomplete or a bound is not a positive integer, or the timeout exceeds the timer limit.
 */
export function resolveImageTextRoute(config: ImageTextConfig): ImageTextRoute {
  if (config.provider.trim().length === 0) throw new Error('tool-image-text: provider must be a non-empty string')
  if (config.model.trim().length === 0) throw new Error('tool-image-text: model must be a non-empty string')
  assertPositiveInteger('maxOutputTokens', config.maxOutputTokens)
  assertPositiveInteger('timeoutMs', config.timeoutMs)
  if (config.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-image-text: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  const prompt = config.prompt ?? IMAGE_TEXT_PROMPT
  if (prompt.trim().length === 0) {
    throw new Error('tool-image-text: prompt must be a non-empty string')
  }
  return Object.freeze({
    provider: config.provider,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    prompt,
  })
}

/**
 * Resolution options for one filesystem call. A mounted working-directory
 * service supplies the calling session's current directory; without one, the
 * filesystem provider's own default applies.
 * @param ctx - plugin context, read for the optional working-directory service.
 * @param exec - current tool execution providing the agent and cancellation.
 * @returns filesystem resolution options for this call.
 */
async function resolveOptions(
  ctx: Context,
  exec: ToolExecution,
): Promise<{ cwd?: string; signal?: AbortSignal }> {
  const workingDirectory = ctx.get('workingDirectory')
  const cwd = workingDirectory === undefined || exec.agent === undefined
    ? undefined
    : await workingDirectory.ensure(exec.agent, exec.signal)
  return { ...cwd === undefined ? {} : { cwd }, signal: exec.signal }
}

/**
 * Collect the text blocks of one assembled response in stream order.
 * @param blocks - assembled content blocks.
 * @returns the concatenated text.
 */
function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) if (block.type === 'text') parts.push(block.text)
  return parts.join('')
}

/**
 * Dispatch one image request through the configured route and return its text.
 * @param ctx - context carrying the required LLM service.
 * @param route - resolved route and request bounds.
 * @param message - user message holding the image block and the instruction.
 * @param signal - caller cancellation, forwarded to preparation, dispatch, and the deadline.
 * @returns the text the configured model produced.
 * @throws {Error} when the caller or deadline aborts, the provider fails, or the response contains no text.
 */
async function extractImageText(
  ctx: Context,
  route: ImageTextRoute,
  message: Message,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  using callDeadline = deadline(signal, route.timeoutMs, IMAGE_TEXT_TIMEOUT_CODE)
  const call = await ctx.llm.prepareCall({
    provider: route.provider,
    model: route.model,
    maxTokens: route.maxOutputTokens,
  }, callDeadline.signal)
  const options: GenerateOptions = {
    ...call.config,
    messages: [message],
    system: IMAGE_TEXT_SYSTEM,
    signal: callDeadline.signal,
  }
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of call.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const failure = new Error(finish.failure.message) as Error & { code?: string }
    failure.code = finish.failure.code
    throw failure
  }
  const text = textOf(assembler.blocks())
  if (text.trim().length === 0) {
    throw new Error(`the configured vision model "${route.model}" returned no text for this image`)
  }
  return text
}

/**
 * Register the `read_image_text` tool into the given context.
 *
 * The composing plugin owns route validation: `src/index.ts` resolves the
 * route at load, so an invalid deployment fails before the tool exists. The
 * tool itself is stateless: attachment writes are content-addressed and each
 * call owns its own request, so concurrent calls cannot conflict.
 * @param ctx - registration scope carrying `tools`, `fs`, and `llm`.
 * @param route - validated route and request bounds for this instance.
 */
export function applyReadImageTextTool(ctx: Context, route: ImageTextRoute): void {
  ctx.tools.register(defineTool({
    name: 'read_image_text',
    description: 'Read a PNG/JPEG/WebP/GIF file and return the text it contains as plain text. '
      + 'Use this when images cannot be attached to the current model. '
      + 'Do not install image libraries or create thumbnails to inspect an image.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          text: { type: 'string', required: true, description: 'Text extracted from the image.' },
          provider: { type: 'string', required: true, description: 'Provider route that served the extraction.' },
          model: { type: 'string', required: true, description: 'Exact model id that served the extraction.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requestedPath = args.file_path
      if (requestedPath.trim().length === 0) throw new Error('file_path must be a non-empty string')

      // Pre-read refusals run before any filesystem or attachment work. An
      // extension-less path declares no format, so its media type waits for
      // the bytes; the route check never waits, because a route without image
      // input would fail the request after committing storage.
      const extension = extname(requestedPath).toLowerCase()
      const declared = IMAGE_EXTENSIONS[extension]
      if (declared === undefined && extension !== '') {
        throw new Error(
          `cannot read "${requestedPath}": the ${extension} extension does not declare a supported image format; read_image_text accepts PNG/JPEG/WebP/GIF files`,
        )
      }
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error(`cannot read "${requestedPath}" as an image: no attachment service is mounted`)
      }
      const active = await ctx.llm.resolveModelInfo(route.provider, route.model, exec.signal)
      if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
        throw new Error(
          `cannot read "${requestedPath}" as an image: configured vision model "${route.model}" does not declare image input; configure tool-image-text with a model that accepts images`,
        )
      }

      const target = await ctx.fs.resolve(requestedPath, await resolveOptions(ctx, exec))
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      // One request carries one image, so the per-message aggregate bound
      // applies beside the per-image bound.
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
      const mediaType = declared ?? sniffImageMediaType(data)
      if (mediaType === undefined) {
        throw new Error(
          `cannot read "${target.displayPath}": the file content is not a supported image format; read_image_text accepts PNG/JPEG/WebP/GIF`,
        )
      }
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`cannot read "${target.displayPath}": ${mediaType} images are not accepted by this deployment`)
      }
      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
      } catch (error: unknown) {
        if (!(error instanceof AttachmentError)) throw error
        throw new Error(`cannot read "${target.displayPath}": the attachment store refused the image: ${error.message}`, { cause: error })
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

      const message = createUserMessage({
        content: [
          { type: 'image', attachment: ref },
          { type: 'text', text: route.prompt },
        ],
        source: { kind: 'dsh-tool-image-text' },
      })
      const text = await extractImageText(ctx, route, message, exec.signal)
      return {
        path: ctx.fs.processPath(target),
        text,
        provider: route.provider,
        model: route.model,
      }
    },
    // Pure display: a generic read card with a follow-along location.
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read image text ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
