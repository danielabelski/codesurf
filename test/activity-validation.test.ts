import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  ACTIVITY_DOCUMENT_VERSION,
  ActivityValidationError,
  MAX_ACTIVITY_DETAIL_LENGTH,
  MAX_ACTIVITY_METADATA_BYTES,
  MAX_ACTIVITY_QUERY_LIMIT,
  MAX_ACTIVITY_TITLE_LENGTH,
  parseActivityDocument,
  validateActivityQuery,
  validateActivityUpsertInput,
  validateActivityWorkspaceId,
} from '../src/main/activity-validation.ts'

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'activity-1',
    tileId: 'tile-1',
    workspaceId: 'workspace-1',
    type: 'task',
    status: 'running',
    title: 'Review the change',
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  }
}

function assertValidationCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => (
    error instanceof ActivityValidationError && error.code === code
  ))
}

describe('activity input validation', () => {
  test('accepts bounded canonical upserts and clones JSON metadata', () => {
    const metadata = { nested: { count: 2 } }
    const result = validateActivityUpsertInput({
      id: 'shared-id',
      tileId: 'tile-a',
      type: 'tool',
      status: 'done',
      title: 'Read file',
      detail: '',
      metadata,
      agent: 'agent-a',
    })

    assert.deepEqual(result, {
      id: 'shared-id',
      tileId: 'tile-a',
      type: 'tool',
      status: 'done',
      title: 'Read file',
      detail: '',
      metadata,
      agent: 'agent-a',
    })
    assert.notEqual(result.metadata, metadata)
    assert.notEqual(result.metadata?.nested, metadata.nested)
  })

  test('rejects traversal and non-canonical workspace identifiers', () => {
    for (const workspaceId of [
      '../escape',
      'nested/workspace',
      'nested\\workspace',
      ' workspace',
      'workspace ',
      '.',
      '..',
      '',
      'workspace\u0000tail',
    ]) {
      assert.throws(() => validateActivityWorkspaceId(workspaceId))
    }
    assert.equal(validateActivityWorkspaceId('release.2026'), 'release.2026')
    assert.equal(validateActivityWorkspaceId('release.candidate'), 'release.candidate')
    assert.throws(() => validateActivityWorkspaceId('release..candidate'))
    assert.throws(() => validateActivityWorkspaceId('a/../b'))
  })

  test('rejects unknown fields, invalid enums, and oversized strings', () => {
    assertValidationCode(() => validateActivityUpsertInput({
      tileId: 'tile-a',
      type: 'task',
      title: 'Task',
      surprise: true,
    }), 'unknown_field')
    assertValidationCode(() => validateActivityUpsertInput({
      tileId: 'tile-a',
      type: 'arbitrary',
      title: 'Task',
    }), 'invalid_activity_type')
    assertValidationCode(() => validateActivityUpsertInput({
      tileId: 'tile-a',
      type: 'task',
      title: 'x'.repeat(MAX_ACTIVITY_TITLE_LENGTH + 1),
    }), 'input_too_large')
    assertValidationCode(() => validateActivityUpsertInput({
      tileId: 'tile-a',
      type: 'task',
      title: 'Task',
      detail: 'x'.repeat(MAX_ACTIVITY_DETAIL_LENGTH + 1),
    }), 'input_too_large')
  })

  test('rejects cyclic, non-JSON, deep, and oversized metadata', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assertValidationCode(() => validateActivityUpsertInput({
      tileId: 'tile-a',
      type: 'task',
      title: 'Task',
      metadata: cyclic,
    }), 'metadata_too_deep')
    assertValidationCode(() => validateActivityUpsertInput({
      tileId: 'tile-a',
      type: 'task',
      title: 'Task',
      metadata: { invalid: BigInt(1) },
    }), 'invalid_metadata')
    assertValidationCode(() => validateActivityUpsertInput({
      tileId: 'tile-a',
      type: 'task',
      title: 'Task',
      metadata: { payload: 'x'.repeat(MAX_ACTIVITY_METADATA_BYTES) },
    }), 'input_too_large')
  })

  test('normalizes query filters and enforces the result limit', () => {
    assert.deepEqual(validateActivityQuery({
      workspaceId: 'workspace-1',
      tileId: 'tile-1',
      type: 'task',
      status: 'done',
      agent: 'agent-1',
      limit: MAX_ACTIVITY_QUERY_LIMIT,
    }), {
      workspaceId: 'workspace-1',
      tileId: 'tile-1',
      type: 'task',
      status: 'done',
      agent: 'agent-1',
      limit: MAX_ACTIVITY_QUERY_LIMIT,
    })
    assertValidationCode(() => validateActivityQuery({
      workspaceId: 'workspace-1',
      limit: MAX_ACTIVITY_QUERY_LIMIT + 1,
    }), 'invalid_limit')
  })
})

describe('activity document validation', () => {
  test('accepts the current envelope and marks legacy arrays for rewrite', () => {
    assert.deepEqual(parseActivityDocument({
      version: ACTIVITY_DOCUMENT_VERSION,
      records: [validRecord()],
    }, 'workspace-1'), {
      records: [validRecord()],
      needsRewrite: false,
    })
    assert.deepEqual(parseActivityDocument([validRecord()], 'workspace-1'), {
      records: [validRecord()],
      needsRewrite: true,
    })
  })

  test('rejects future versions and workspace mismatches without recovery', () => {
    assertValidationCode(() => parseActivityDocument({
      version: ACTIVITY_DOCUMENT_VERSION + 1,
      records: [],
    }, 'workspace-1'), 'future_document_version')
    assertValidationCode(() => parseActivityDocument({
      version: ACTIVITY_DOCUMENT_VERSION,
      records: [validRecord({ workspaceId: 'workspace-2' })],
    }, 'workspace-1'), 'workspace_mismatch')
  })

  test('allows one activity id in different tiles but rejects duplicate tile identities', () => {
    const records = [
      validRecord({ id: 'shared', tileId: 'tile-a' }),
      validRecord({ id: 'shared', tileId: 'tile-b' }),
    ]
    assert.equal(parseActivityDocument({
      version: ACTIVITY_DOCUMENT_VERSION,
      records,
    }, 'workspace-1').records.length, 2)

    assertValidationCode(() => parseActivityDocument({
      version: ACTIVITY_DOCUMENT_VERSION,
      records: [...records, validRecord({ id: 'shared', tileId: 'tile-a' })],
    }, 'workspace-1'), 'duplicate_activity_identity')
  })

  test('rejects malformed records instead of silently discarding them', () => {
    assertValidationCode(() => parseActivityDocument({
      version: ACTIVITY_DOCUMENT_VERSION,
      records: [validRecord({ updatedAt: 50 })],
    }, 'workspace-1'), 'invalid_timestamp')
    assertValidationCode(() => parseActivityDocument({
      version: ACTIVITY_DOCUMENT_VERSION,
      records: [{ ...validRecord(), unknown: true }],
    }, 'workspace-1'), 'unknown_field')
  })
})
