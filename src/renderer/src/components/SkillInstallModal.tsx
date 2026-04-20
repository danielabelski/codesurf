/**
 * SkillInstallModal — confirmation dialog shown when the user drops a .skill
 * archive onto the canvas or double-clicks one in Finder. Uses the main-process
 * `skills:inspect` / `skills:install` IPC endpoints exposed in preload.
 *
 * Theming: default CSS is light. `body.dark` overrides supply dark-mode values
 * (per the project theming rule: never use `prefers-color-scheme`; use solid
 * hex, not rgba opacity, so blur backdrops stay readable).
 */

import { useEffect, useRef, useState } from 'react'

interface SkillManifest {
  name: string
  description: string
  topFolder: string
  entryCount: number
  hasSkillMd: boolean
  preview: string
  zipPath: string
  sizeBytes: number
}

const STYLE_ID = 'skill-install-modal-styles-v1'

function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
/* ── Light (default) ────────────────────────────────────────────────────── */
.skill-install-overlay {
  position: fixed; inset: 0; z-index: 100000;
  display: flex; align-items: center; justify-content: center;
  background: rgba(30, 34, 46, 0.42);
  backdrop-filter: blur(8px);
  -webkit-app-region: no-drag;
}
.skill-install-panel {
  width: 560px; max-height: 82vh;
  display: flex; flex-direction: column; gap: 14px;
  padding: 22px 26px;
  border-radius: 12px;
  font-family: var(--chat-font-sans, -apple-system, system-ui, sans-serif);
  background: #ffffff;
  color: #1f2430;
  border: 1px solid #d7dde4;
  box-shadow: 0 20px 60px rgba(15, 20, 30, 0.22);
}
.skill-install-eyebrow {
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: #6b7280; margin-bottom: 4px;
}
.skill-install-title {
  font-size: 16px; font-weight: 600;
  color: #111827;
}
.skill-install-desc {
  font-size: 12px; color: #4b5563;
  margin-top: 4px; line-height: 1.4;
}
.skill-install-close {
  background: transparent; border: none;
  color: #6b7280; cursor: pointer;
  font-size: 20px; line-height: 1; padding: 2px;
}
.skill-install-close:hover { color: #111827; }
.skill-install-close:disabled { cursor: not-allowed; opacity: 0.5; }

.skill-install-info {
  font-size: 12px;
  background: #f6f8fa;
  color: #1f2430;
  border: 1px solid #e3e7ec;
  border-radius: 8px;
  padding: 10px 12px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
}
.skill-install-info .k { color: #6b7280; }
.skill-install-info .v { color: #1f2430; }
.skill-install-info .mono {
  font-family: var(--chat-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px; word-break: break-all;
}
.skill-install-info .good { color: #107a3b; }
.skill-install-info .warn { color: #9a5b10; }

.skill-install-label {
  font-size: 11px; color: #6b7280;
  text-transform: uppercase; letter-spacing: 0.06em;
  margin-bottom: 4px;
}
.skill-install-hint {
  font-size: 10px; color: #6b7280; margin-top: 4px;
}
.skill-install-input {
  width: 100%;
  background: #ffffff;
  color: #1f2430;
  border: 1px solid #d7dde4;
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 12px;
  font-family: var(--chat-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  outline: none;
}
.skill-install-input:focus {
  border-color: #3d74f4;
  box-shadow: 0 0 0 2px rgba(61, 116, 244, 0.18);
}
.skill-install-input:disabled { background: #f3f4f6; color: #6b7280; }

.skill-install-details { font-size: 12px; color: #4b5563; }
.skill-install-details summary { cursor: pointer; color: #1f2430; }
.skill-install-preview {
  margin-top: 6px;
  background: #f6f8fa;
  color: #1f2430;
  border: 1px solid #e3e7ec;
  border-radius: 6px;
  padding: 10px;
  max-height: 220px;
  overflow: auto;
  font-size: 11px;
  white-space: pre-wrap;
  font-family: var(--chat-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.skill-install-checkbox {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: #4b5563;
  cursor: pointer; user-select: none;
}
.skill-install-checkbox[aria-disabled="true"] { cursor: not-allowed; opacity: 0.6; }

.skill-install-actions {
  display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;
}
.skill-install-btn {
  padding: 7px 14px; border-radius: 6px;
  font-size: 12px; cursor: pointer;
  border: 1px solid transparent;
  font-family: inherit;
}
.skill-install-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.skill-install-btn.secondary {
  background: #ffffff; border-color: #d7dde4; color: #1f2430;
}
.skill-install-btn.secondary:hover:not(:disabled) {
  background: #f3f4f6;
}
.skill-install-btn.primary {
  background: #3d74f4; border-color: #3d74f4; color: #ffffff;
  font-weight: 600;
}
.skill-install-btn.primary:hover:not(:disabled) {
  background: #2f63e0; border-color: #2f63e0;
}

.skill-install-loading {
  font-size: 12px; color: #6b7280; padding: 8px 0;
}
.skill-install-error {
  background: #fdecec;
  border: 1px solid #f1c1c1;
  color: #9a1f1f;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  white-space: pre-wrap;
}
.skill-install-success {
  background: #e8f6ec;
  border: 1px solid #bcddc5;
  color: #1d6333;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
}
.skill-install-success .title { font-weight: 600; margin-bottom: 4px; }
.skill-install-success .path {
  margin-top: 4px;
  font-family: var(--chat-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  color: #18522a;
  word-break: break-all;
}

/* ── Dark overrides (body.dark) ────────────────────────────────────────── */
body.dark .skill-install-overlay {
  background: rgba(0, 0, 0, 0.6);
}
body.dark .skill-install-panel {
  background: #1e1e1e;
  color: #d9dde3;
  border-color: #2f2f33;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
body.dark .skill-install-eyebrow { color: #6b7280; }
body.dark .skill-install-title { color: #f3f4f6; }
body.dark .skill-install-desc { color: #a0a4ac; }
body.dark .skill-install-close { color: #888c92; }
body.dark .skill-install-close:hover { color: #f3f4f6; }
body.dark .skill-install-info {
  background: #161616; border-color: #262626; color: #cfd3da;
}
body.dark .skill-install-info .k { color: #6b7280; }
body.dark .skill-install-info .v { color: #cfd3da; }
body.dark .skill-install-info .good { color: #8fe0a5; }
body.dark .skill-install-info .warn { color: #e0a55f; }
body.dark .skill-install-label { color: #6b7280; }
body.dark .skill-install-hint { color: #6b7280; }
body.dark .skill-install-input {
  background: #111; color: #d9dde3; border-color: #2a2a2a;
}
body.dark .skill-install-input:focus {
  border-color: #3d74f4;
  box-shadow: 0 0 0 2px rgba(61, 116, 244, 0.3);
}
body.dark .skill-install-input:disabled { background: #161616; color: #6b7280; }
body.dark .skill-install-details { color: #a0a4ac; }
body.dark .skill-install-details summary { color: #cfd3da; }
body.dark .skill-install-preview {
  background: #111; color: #cfd3da; border-color: #222;
}
body.dark .skill-install-checkbox { color: #a0a4ac; }
body.dark .skill-install-btn.secondary {
  background: transparent; border-color: #333; color: #cfd3da;
}
body.dark .skill-install-btn.secondary:hover:not(:disabled) {
  background: #242424;
}
body.dark .skill-install-btn.primary {
  background: #3d74f4; border-color: #3d74f4; color: #ffffff;
}
body.dark .skill-install-btn.primary:hover:not(:disabled) {
  background: #4a80ff; border-color: #4a80ff;
}
body.dark .skill-install-loading { color: #6b7280; }
body.dark .skill-install-error {
  background: #3a1414; border-color: #5a2020; color: #ff9090;
}
body.dark .skill-install-success {
  background: #10321a; border-color: #1f5d33; color: #8fe0a5;
}
body.dark .skill-install-success .path { color: #c7e8d0; }
`
  document.head.appendChild(style)
}

export function SkillInstallModal({
  zipPath,
  onClose,
}: {
  zipPath: string
  onClose: () => void
}): JSX.Element {
  const [manifest, setManifest] = useState<SkillManifest | null>(null)
  const [targetDir, setTargetDir] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<null | { installedPath: string; entries: number }>(null)
  const [overwrite, setOverwrite] = useState(false)
  const cancelledRef = useRef(false)

  useEffect(() => { ensureStyles() }, [])

  useEffect(() => {
    cancelledRef.current = false
    setLoading(true)
    setError(null)

    const api = (window as any).electron?.skills
    if (!api) {
      setError('Skills IPC is unavailable. Restart the app and try again.')
      setLoading(false)
      return
    }

    Promise.all([
      api.inspect(zipPath) as Promise<SkillManifest>,
      api.getDefaultTargetDir() as Promise<string>,
    ])
      .then(([m, dir]) => {
        if (cancelledRef.current) return
        setManifest(m)
        setTargetDir(dir)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelledRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      cancelledRef.current = true
    }
  }, [zipPath])

  const install = async (): Promise<void> => {
    const api = (window as any).electron?.skills
    if (!api) return
    setInstalling(true)
    setError(null)
    try {
      const res = await api.install({ zipPath, targetDir, overwrite }) as {
        installedPath: string
        entries: string[]
        targetDir: string
      }
      setDone({ installedPath: res.installedPath, entries: res.entries.length })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      if (/already installed/i.test(msg)) setOverwrite(true)
    } finally {
      setInstalling(false)
    }
  }

  const baseName = zipPath.split('/').pop() ?? zipPath

  return (
    <div
      className="skill-install-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !installing) onClose()
      }}
    >
      <div className="skill-install-panel">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div className="skill-install-eyebrow">Install Skill</div>
            <div className="skill-install-title">{manifest?.name || baseName}</div>
            {manifest?.description && (
              <div className="skill-install-desc">{manifest.description}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => { if (!installing) onClose() }}
            disabled={installing}
            className="skill-install-close"
            aria-label="Close"
          >×</button>
        </div>

        {loading && (
          <div className="skill-install-loading">Inspecting skill archive…</div>
        )}

        {error && !done && (
          <div className="skill-install-error">{error}</div>
        )}

        {done && (
          <div className="skill-install-success">
            <div className="title">Installed.</div>
            <div>{done.entries} files extracted to</div>
            <div className="path">{done.installedPath}</div>
          </div>
        )}

        {manifest && !done && (
          <>
            <div className="skill-install-info">
              <div className="k">Archive</div>
              <div className="v mono">{baseName}</div>
              <div className="k">Folder</div>
              <div className="v mono">{manifest.topFolder}</div>
              <div className="k">Files</div>
              <div className="v">{manifest.entryCount}</div>
              <div className="k">Size</div>
              <div className="v">{formatSize(manifest.sizeBytes)}</div>
              <div className="k">SKILL.md</div>
              <div className={manifest.hasSkillMd ? 'good' : 'warn'}>
                {manifest.hasSkillMd ? 'present' : 'missing (folder will still install)'}
              </div>
            </div>

            <div>
              <div className="skill-install-label">Install to</div>
              <input
                type="text"
                value={targetDir}
                onChange={e => setTargetDir(e.target.value)}
                disabled={installing}
                spellCheck={false}
                className="skill-install-input"
              />
              <div className="skill-install-hint">
                Defaults to the Claude skills directory so both CodeSurf and Claude pick it up.
              </div>
            </div>

            {manifest.preview && (
              <details className="skill-install-details">
                <summary>Preview SKILL.md</summary>
                <pre className="skill-install-preview">{manifest.preview}</pre>
              </details>
            )}

            <label
              className="skill-install-checkbox"
              aria-disabled={installing}
            >
              <input
                type="checkbox"
                checked={overwrite}
                onChange={e => setOverwrite(e.target.checked)}
                disabled={installing}
              />
              Overwrite if a skill with this name already exists
            </label>
          </>
        )}

        <div className="skill-install-actions">
          <button
            type="button"
            onClick={onClose}
            disabled={installing}
            className="skill-install-btn secondary"
          >
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button
              type="button"
              onClick={install}
              disabled={loading || installing || !manifest}
              className="skill-install-btn primary"
            >
              {installing ? 'Installing…' : 'Install skill'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
