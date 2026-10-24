/**
 * Contract tests for the vendored pstack skill provider: the asset tree must
 * expose every shipped skill, keep invocation flags from frontmatter, and load
 * bodies without their frontmatter block.
 */
import { describe, expect, it } from 'vitest'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createPstackProvider } from '../src/index.ts'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'

const ASSETS = fileURLToPath(new URL('../assets/skills/', import.meta.url))
const provider = createPstackProvider()
const options = { signal: undefined }

/** The provider always answers with a complete array; narrow the declared union once. */
async function allCandidates(): Promise<readonly SkillCandidate[]> {
  const listed = await provider.list(options)
  if (!Array.isArray(listed)) throw new Error('expected a complete candidate array')
  return listed
}

describe('pstack skill provider', () => {
  it('lists one candidate per vendored skill directory', async () => {
    const directories = (await readdir(ASSETS, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
    const candidates = await allCandidates()
    expect(candidates.length).toBe(directories.length)
    expect(candidates.length).toBeGreaterThan(50)
  })

  it('advertises bundled source, directory resources, and kebab-case names', async () => {
    for (const candidate of await allCandidates()) {
      expect(candidate.provider).toBe('pstack')
      expect(candidate.source).toBe('bundled')
      expect(candidate.rank).toBe(600)
      expect(candidate.resourceBase?.kind).toBe('directory')
      expect(candidate.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(candidate.description.length).toBeGreaterThan(0)
    }
  })

  it('maps disable-model-invocation to a user-only skill', async () => {
    const candidates = await allCandidates()
    const bro = candidates.find(candidate => candidate.name === 'bro')
    expect(bro).toBeDefined()
    expect(bro?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
  })

  it('loads a body without frontmatter and keeps resources addressable', async () => {
    const candidates = await allCandidates()
    const poteto = candidates.find(candidate => candidate.name === 'poteto-mode')
    expect(poteto).toBeDefined()
    const definition = await provider.get(poteto!, options)
    expect(definition).toBeDefined()
    expect(definition?.content.startsWith('---')).toBe(false)
    expect(definition?.content).toContain('# Poteto mode')
    expect(definition?.resourceBase?.kind).toBe('directory')
  })

  it('returns undefined for a candidate without a usable locator', async () => {
    const candidates = await allCandidates()
    const candidate = candidates[0]!
    expect(await provider.get({ ...candidate, locator: undefined }, options)).toBeUndefined()
  })

  it('honours an aborted lookup signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(provider.list({ signal: controller.signal })).rejects.toThrow()
  })
})
