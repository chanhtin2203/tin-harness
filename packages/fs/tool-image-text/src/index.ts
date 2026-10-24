/**
 * Registers `read_image_text`, a model-facing tool that sends one image to a
 * separately configured vision-capable route and returns the extracted text.
 * Named exports preserve Loader injection metadata; the plugin has no default
 * export.
 * @module @deepseek-ai/dsh-tool-image-text
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { applyReadImageTextTool, resolveImageTextRoute } from './read-image-text.ts'
import type { ImageTextConfig } from './read-image-text.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-image-text'

/** Services the tool needs before it can register. */
export const inject = ['tools', 'fs', 'llm']

/** Plugin configuration; every route value is an explicit deployment choice. */
export type Config = ImageTextConfig

/** Schemastery schema for {@link Config}; provider and model have no defaults. */
export const Config: z<ImageTextConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  prompt: z.string(),
})

/**
 * Resolve the configured route once, then register the tool.
 * @param ctx - context carrying the required `tools`, `fs`, and `llm` services.
 * @param config - deployment-provided route, bounds, and optional instruction.
 * @returns after the tool registration is installed on this context.
 * @throws {Error} when the route is incomplete or a bound is invalid.
 */
export function apply(ctx: Context, config: Config): void {
  applyReadImageTextTool(ctx, resolveImageTextRoute(config))
}
