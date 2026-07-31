import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCodexExecArgs,
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
import { PEER_CONTEXT_LIMITS } from '../../packages/codesurf-daemon/bin/peer-context-policy.mjs'

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

test('daemon memory bounding reserves an appended higher-precedence room context', () => {
  const roomContext = 'ROOM-CONTEXT-MUST-SURVIVE'
  const baseMemory = `MEMORY-START\n${'m'.repeat(MAX_AGGREGATE_INSTRUCTION_BYTES)}\nMEMORY-END`
  const result = revalidateDaemonContextRequest({
    memoryPrompt: `${baseMemory}\n\n${roomContext}`,
    roomContext,
  })

  assert.ok(Buffer.byteLength(result.request.memoryPrompt, 'utf8') <= MAX_AGGREGATE_INSTRUCTION_BYTES)
  assert.equal(result.request.roomContext, roomContext)
  assert.match(result.request.memoryPrompt, /maximum aggregate instruction bytes/)
  assert.ok(result.request.memoryPrompt.endsWith(roomContext))
  assert.equal(result.request.memoryPrompt.match(/ROOM-CONTEXT-MUST-SURVIVE/g)?.length, 1)
  assert.equal(result.metadata.memoryPrompt.truncated, true)
})

test('daemon revalidates peer context before Claude and Codex provider prompt construction', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-peer-context-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const peers = Array.from({ length: PEER_CONTEXT_LIMITS.peers + 5 }, (_, peerIndex) => ({
    peerId: `peer-${String(peerIndex).padStart(2, '0')}`,
    peerType: 'browser',
    tools: Array.from({ length: PEER_CONTEXT_LIMITS.toolsPerPeer + 5 }, (_, toolIndex) => `browser_tool_${toolIndex}`),
    actions: Array.from({ length: PEER_CONTEXT_LIMITS.actionsPerPeer + 5 }, (_, actionIndex) => ({
      name: `action_${actionIndex}`,
      description: '界'.repeat(1_000),
    })),
    context: Object.fromEntries(Array.from(
      { length: PEER_CONTEXT_LIMITS.contextEntriesPerPeer + 5 },
      (_, contextIndex) => [
        `ctx-${contextIndex}`,
        'é'.repeat(contextIndex === 0 ? 100_000 : 4_000),
      ],
    )),
  }))
  const validated = revalidateDaemonContextRequest({ peers })
  assert.equal(validated.request.peers.length, PEER_CONTEXT_LIMITS.peers)
  assert.equal(validated.metadata.peerContext.omittedPeerCount, 5)
  assert.ok(validated.metadata.peerContext.renderedBytes <= PEER_CONTEXT_LIMITS.promptRenderedBytes)

  let claudePrompt = null
  const manager = createChatJobManager({
    homeDir,
    claudeQuery: ({ options }) => (async function* () {
      claudePrompt = options?.agents?.codesurf?.prompt ?? null
      yield {
        type: 'result',
        result: 'bounded',
        session_id: 'peer-context-bounds',
        total_cost_usd: 0,
        num_turns: 1,
      }
    })(),
  })
  const job = await manager.startJob({
    cardId: 'peer-context-bounds',
    workspaceId: 'peer-context-bounds-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'use peers' }],
    peers,
  })
  await waitFor(async () => {
    const state = await manager.getJobState(job.id)
    return state && state.status !== 'running' && state.status !== 'queued' ? state : null
  })
  assert.ok(claudePrompt)
  assert.match(claudePrompt, /Peer prompt truncated:/)
  assert.ok(Buffer.byteLength(claudePrompt, 'utf8') < PEER_CONTEXT_LIMITS.promptRenderedBytes + 8 * 1024)

  let harnessPeerPrompt = null
  const harnessManager = createChatJobManager({
    homeDir,
    harnessRunnerFactory: () => ({
      runHarnessJob: async (harnessJob, _request, _workspaceDir, _instructionPrompt, options) => {
        harnessPeerPrompt = options.peerPrompt
        await options.appendEvent(harnessJob.id, { type: 'text', text: 'bounded' })
        await options.appendEvent(harnessJob.id, { type: 'done' })
      },
    }),
  })
  const harnessJob = await harnessManager.startJob({
    cardId: 'peer-context-harness',
    workspaceId: 'peer-context-harness-workspace',
    provider: 'claude',
    model: 'claude-test',
    mode: 'bypassPermissions',
    runMode: 'background',
    useHarness: true,
    workspaceDir,
    messages: [{ role: 'user', content: 'use peers in the background' }],
    peers,
  })
  await waitFor(async () => {
    const state = await harnessManager.getJobState(harnessJob.id)
    return state && state.status !== 'running' && state.status !== 'queued' ? state : null
  })
  assert.match(harnessPeerPrompt, /## Connected peer blocks/)
  assert.match(harnessPeerPrompt, /Peer prompt truncated:/)
  assert.ok(Buffer.byteLength(harnessPeerPrompt, 'utf8') <= PEER_CONTEXT_LIMITS.promptRenderedBytes)

  const codexArgs = buildCodexExecArgs({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'use peers' }],
    peers,
  }, workspaceDir)
  const codexPrompt = codexArgs.at(-1)
  assert.match(codexPrompt, /## Agent room/)
  assert.match(codexPrompt, /Peer prompt truncated:/)
  assert.ok(Buffer.byteLength(codexPrompt, 'utf8') < PEER_CONTEXT_LIMITS.promptRenderedBytes + 8 * 1024)
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
