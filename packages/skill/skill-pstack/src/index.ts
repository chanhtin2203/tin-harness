/**
 * Bundled `pstack` skill provider.
 *
 * Vendors Lauren Tan's pstack skill set (MIT, https://github.com/cursor/plugins)
 * into the harness so every profile and the desktop application carry the same
 * skills without a user-level skills directory. Bodies are read from
 * `assets/skills/` next to this module, so their relative `scripts/` references
 * keep working.
 * @module @deepseek-ai/dsh-skill-pstack
 */

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillInvocationPolicy,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { parse } from 'yaml'

const PROVIDER_NAME = 'pstack'
const SKILLS_ROOT = fileURLToPath(new URL('../assets/skills/', import.meta.url))

/** Frontmatter fields this provider understands; everything else rides in `metadata`. */
const KNOWN_FIELDS = new Set(['name', 'description', 'disable-model-invocation', 'when-to-use'])

const DEFAULT_INVOCATION: SkillInvocationPolicy = { modelInvocable: true, userInvocable: true }

/** One vendored skill directory, captured while scanning the asset tree. */
interface VendoredSkill {
  readonly candidate: SkillCandidate
  readonly path: string
}

/**
 * Split YAML frontmatter from a skill body.
 * @param raw - the whole SKILL.md file.
 * @returns parsed frontmatter data and the remaining body, or undefined when absent.
 */
function splitFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (match === null) return undefined
  const parsed: unknown = parse(match[1] ?? '')
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: raw.slice(match[0].length) }
}

/** Resolve the invocation policy from pstack's `disable-model-invocation` flag. */
function invocationOf(data: Record<string, unknown>): SkillInvocationPolicy {
  return data['disable-model-invocation'] === true
    ? { modelInvocable: false, userInvocable: true }
    : DEFAULT_INVOCATION
}

/** Read every skill directory under the vendored root, skipping unusable entries. */
async function scanSkills(): Promise<VendoredSkill[]> {
  const found: VendoredSkill[] = []
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(SKILLS_ROOT, entry.name)
    const path = join(directory, 'SKILL.md')
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const split = splitFrontmatter(raw)
    if (split === undefined) continue
    const name = typeof split.data.name === 'string' ? split.data.name : entry.name
    const description = typeof split.data.description === 'string' ? split.data.description : undefined
    if (description === undefined || !isSkillName(name)) continue
    const metadata = Object.fromEntries(
      Object.entries(split.data).filter(([key]) => !KNOWN_FIELDS.has(key)),
    )
    const whenToUse = typeof split.data['when-to-use'] === 'string' ? split.data['when-to-use'] : undefined
    found.push({
      path,
      candidate: {
        name,
        description,
        ...(whenToUse === undefined ? {} : { whenToUse }),
        invocation: invocationOf(split.data),
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: directory },
        rank: BUNDLED_SKILL_RANK,
        locator: { path, directory },
        metadata,
      },
    })
  }
  return found.sort((left, right) => left.candidate.name.localeCompare(right.candidate.name))
}

/**
 * Create the provider over one scan of the vendored tree.
 * @returns a provider whose `list` re-scans and whose `get` reads the exact file.
 */
export function createPstackProvider(): SkillProvider {
  return {
    name: PROVIDER_NAME,
    async list(options) {
      options.signal?.throwIfAborted()
      const skills = await scanSkills()
      return skills.map(skill => skill.candidate)
    },
    async get(candidate, options): Promise<SkillDefinition | undefined> {
      options.signal?.throwIfAborted()
      const locator = candidate.locator as { path?: string } | undefined
      if (locator?.path === undefined) return undefined
      const raw = await readFile(locator.path, 'utf8')
      const split = splitFrontmatter(raw)
      const content = split === undefined ? raw : split.body
      return {
        name: candidate.name,
        description: candidate.description,
        ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
        invocation: candidate.invocation,
        provider: PROVIDER_NAME,
        source: 'bundled',
        ...(candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase }),
        content,
        ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
      }
    },
  }
}

/** Cordis plugin name. */
export const name = 'skill-pstack'
/** Service required by the bundled provider. */
export const inject = ['skills']

/** Register the vendored pstack provider on `ctx.skills`. */
export function apply(ctx: Context): void {
  const provider = createPstackProvider()
  ctx.skills.registerProvider(() => provider)
}
