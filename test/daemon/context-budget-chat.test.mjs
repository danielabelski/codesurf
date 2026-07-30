import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createChatJobManager,
  revalidateDaemonContextRequest,
} from '../../bin/chat-jobs.mjs'
import {
  MAX_AGGREGATE_INSTRUCTION_BYTES,
  MAX_PERSONA_PROMPT_BYTES,
  MAX_SKILLS_PROMPT_BYTES,
  MAX_SKILLS_SUMMARY_BYTES,
  MAX_TRANSCRIPT_CONTEXT_PREVIEW_BYTES,
} from '../../packages/codesurf-daemon/bin/context-budget.mjs'

async function waitFor(check, timeoutMs = 5_000, intervalMs = 15) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

test('daemon revalidates inbound memory, skills, summary, and persona prompts by UTF-8 bytes', () => {
  const result = revalidateDaemonContextRequest({
    memoryPrompt: `${'m'.repeat(MAX_AGGREGATE_INSTRUCTION_BYTES)}é`,
    skillsPrompt: `${'s'.repeat(MAX_SKILLS_PROMPT_BYTES)}é`,
    skillsSummary: `${'u'.repeat(MAX_SKILLS_SUMMARY_BYTES)}é`,
    agentMode: {
      id: 'bounded',
      name: 'Bounded',
      systemPrompt: 'é'.repeat((MAX_PERSONA_PROMPT_BYTES / 2) + 1),
      tools: ['Read'],
    },
  })

  assert.ok(Buffer.byteLength(result.request.memoryPrompt, 'utf8') <= MAX_AGGREGATE_INSTRUCTION_BYTES)
  assert.ok(Buffer.byteLength(result.request.skillsPrompt, 'utf8') <= MAX_SKILLS_PROMPT_BYTES)
  assert.ok(Buffer.byteLength(result.request.skillsSummary, 'utf8') <= MAX_SKILLS_SUMMARY_BYTES)
  assert.ok(Buffer.byteLength(result.request.agentMode.systemPrompt, 'utf8') <= MAX_PERSONA_PROMPT_BYTES)
  assert.match(result.request.memoryPrompt, /maximum aggregate instruction bytes/)
  assert.match(result.request.skillsPrompt, /maximum skills prompt bytes/)
  assert.match(result.request.skillsSummary, /maximum skills summary bytes/)
  assert.match(result.request.agentMode.systemPrompt, /maximum persona prompt bytes/)
  assert.equal(result.metadata.memoryPrompt.truncated, true)
  assert.equal(result.metadata.skillsPrompt.truncated, true)
  assert.equal(result.metadata.skillsSummary.truncated, true)
  assert.equal(result.metadata.personaPrompt.truncated, true)
  assert.doesNotMatch(result.request.agentMode.systemPrompt, /\uFFFD/)
})

test('context transcript inputs stay at 8 KiB while Claude receives the larger bounded prompts', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-context-preview-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  let capturedOptions = null
  const manager = createChatJobManager({
    homeDir,
    claudeQuery: ({ options }) => (async function* () {
      capturedOptions = options
      yield {
        type: 'result',
        result: 'done',
        session_id: 'context-preview',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })
  const memoryPrompt = `MEMORY-START\n${'m'.repeat(40 * 1024)}\nMEMORY-END`
  const skillsPrompt = `SKILLS-START\n${'s'.repeat(20 * 1024)}\nSKILLS-END`
  const job = await manager.startJob({
    cardId: 'context-preview',
    workspaceId: 'context-preview-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'use the context' }],
    memoryPrompt,
    skillsPrompt,
    skillsSummary: 'Included one large test skill.',
  })

  await waitFor(async () => {
    const state = await manager.getJobState(job.id)
    return state && state.status !== 'running' && state.status !== 'queued' ? state : null
  })

  const providerPrompt = capturedOptions?.agents?.codesurf?.prompt
  assert.ok(providerPrompt)
  assert.ok(Buffer.byteLength(providerPrompt, 'utf8') > MAX_TRANSCRIPT_CONTEXT_PREVIEW_BYTES)
  assert.match(providerPrompt, /MEMORY-END/)
  assert.match(providerPrompt, /SKILLS-END/)

  const timeline = (await readFile(join(homeDir, 'timelines', `${job.id}.jsonl`), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const contextInputs = timeline.filter(event =>
    event.type === 'tool_input'
    && (event.toolId === 'codesurf-memory-context' || event.toolId === 'codesurf-skills-context'),
  )
  assert.equal(contextInputs.length, 2)
  for (const event of contextInputs) {
    assert.ok(Buffer.byteLength(event.text, 'utf8') <= MAX_TRANSCRIPT_CONTEXT_PREVIEW_BYTES)
    assert.match(event.text, /maximum transcript context preview bytes/)
  }
})
