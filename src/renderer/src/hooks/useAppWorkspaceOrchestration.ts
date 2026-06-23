import { useCallback, useEffect, type RefObject } from 'react'
import type { CanvasState, GroupState, LayoutTemplate, LockedConnection, TileState, Workspace } from '../../../shared/types'
import {
  createLeaf,
  findLeafById,
  replaceLeafInPanelTree,
  type PanelLeaf,
  type PanelNode,
} from '../components/panelLayoutTree'
import { getCanonicalWorkspaceId } from '../lib/workspaceHelpers'
import { applyEmptyCanvasWorkspaceState, applySavedCanvasState } from '../lib/canvasWorkspaceLoad'
import { dedupeLockedConnections } from '../lib/canvasStateHelpers'
import { generateLayoutFromTemplate } from '../lib/layoutTemplateLaunch'

export type UseAppWorkspaceOrchestrationParams = {
  workspace: Workspace | null
  workspaces: Workspace[]
  openWorkspaceIds: string[]
  tilesRef: RefObject<TileState[]>
  groupsRef: RefObject<GroupState[]>
  panelLayoutRef: RefObject<PanelNode | null>
  activePanelIdRef: RefObject<string | null>
  viewportRef: RefObject<{ tx: number, ty: number, zoom: number }>
  nextZIndexRef: RefObject<number>
  lockedConnectionsRef: RefObject<LockedConnection[]>
  savedLayoutRef: RefObject<PanelNode | null>
  expandedCanvasGroupIdRef: RefObject<string | null>
  expandedCanvasPriorViewportRef: RefObject<CanvasState['viewport'] | null>
  currentWorkspaceIdRef: RefObject<string | null>
  setWorkspace: React.Dispatch<React.SetStateAction<Workspace | null>>
  setWorkspaces: React.Dispatch<React.SetStateAction<Workspace[]>>
  setOpenWorkspaceIds: React.Dispatch<React.SetStateAction<string[]>>
  setShowWorkspacePickerTab: React.Dispatch<React.SetStateAction<boolean>>
  setWorkspacePickerReturnWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>
  setTiles: React.Dispatch<React.SetStateAction<TileState[]>>
  setGroups: React.Dispatch<React.SetStateAction<GroupState[]>>
  setLockedConnections: React.Dispatch<React.SetStateAction<LockedConnection[]>>
  setViewport: React.Dispatch<React.SetStateAction<{ tx: number, ty: number, zoom: number }>>
  setNextZIndex: React.Dispatch<React.SetStateAction<number>>
  setPanelLayout: React.Dispatch<React.SetStateAction<PanelNode | null>>
  setActivePanelId: React.Dispatch<React.SetStateAction<string | null>>
  setExpandedTileId: React.Dispatch<React.SetStateAction<string | null>>
  setExpandedCanvasGroupId: React.Dispatch<React.SetStateAction<string | null>>
  restoreViewport: (viewport: CanvasState['viewport']) => void
  resetViewportState: () => void
  /** Clear undo/redo history stacks on workspace switch (H-3 fix). */
  clearHistory: () => void
  /**
   * Immediately flush any pending debounced save for the given workspace id.
   * Call before setWorkspace() so the outgoing workspace's last edits are not
   * dropped. Provided by useCanvasEngine.
   */
  flushPendingSave: (workspaceId: string) => void
  /**
   * Record that the canvas state for the given workspace id is now loaded.
   * Provided by useCanvasEngine — unblocks the auto-save effect after switch.
   */
  markCanvasLoaded: (id: string) => void
}

export function useAppWorkspaceOrchestration(params: UseAppWorkspaceOrchestrationParams) {
  const {
    workspace,
    workspaces,
    openWorkspaceIds,
    tilesRef,
    groupsRef,
    panelLayoutRef,
    activePanelIdRef,
    viewportRef,
    lockedConnectionsRef,
    savedLayoutRef,
    expandedCanvasGroupIdRef,
    expandedCanvasPriorViewportRef,
    currentWorkspaceIdRef,
    setWorkspace,
    setWorkspaces,
    setOpenWorkspaceIds,
    setShowWorkspacePickerTab,
    setWorkspacePickerReturnWorkspaceId,
    setTiles,
    setGroups,
    setLockedConnections,
    setViewport,
    setNextZIndex,
    setPanelLayout,
    setActivePanelId,
    setExpandedTileId,
    setExpandedCanvasGroupId,
    restoreViewport,
    resetViewportState,
    clearHistory,
    flushPendingSave,
    markCanvasLoaded,
  } = params

  const buildCanvasLoadAppliers = useCallback((includeLockedConnections = false) => ({
    setTiles,
    setGroups,
    restoreViewport,
    setNextZIndex,
    setPanelLayout,
    setActivePanelId,
    setExpandedTileId,
    setExpandedCanvasGroupId,
    savedLayoutRef,
    expandedCanvasGroupIdRef,
    expandedCanvasPriorViewportRef,
    ...(includeLockedConnections ? { setLockedConnections } : {}),
  }), [
    expandedCanvasGroupIdRef,
    expandedCanvasPriorViewportRef,
    restoreViewport,
    savedLayoutRef,
    setActivePanelId,
    setExpandedCanvasGroupId,
    setExpandedTileId,
    setGroups,
    setLockedConnections,
    setNextZIndex,
    setPanelLayout,
    setTiles,
  ])

  const showEmptyLayoutPage = useCallback((options?: { preserveOpenTabs?: boolean }) => {
    const preserveOpenTabs = options?.preserveOpenTabs ?? false
    const emptyPanel = createLeaf([])
    clearHistory()
    setShowWorkspacePickerTab(true)
    setWorkspacePickerReturnWorkspaceId(preserveOpenTabs ? currentWorkspaceIdRef.current : null)
    setWorkspace(null)
    if (!preserveOpenTabs) setOpenWorkspaceIds([])
    setTiles([])
    setGroups([])
    setLockedConnections([])
    resetViewportState()
    savedLayoutRef.current = emptyPanel
    setPanelLayout(emptyPanel)
    setActivePanelId(emptyPanel.id)
    setExpandedTileId(null)
  }, [
    clearHistory,
    currentWorkspaceIdRef,
    resetViewportState,
    savedLayoutRef,
    setActivePanelId,
    setExpandedTileId,
    setGroups,
    setLockedConnections,
    setOpenWorkspaceIds,
    setPanelLayout,
    setShowWorkspacePickerTab,
    setTiles,
    setWorkspace,
    setWorkspacePickerReturnWorkspaceId,
  ])

  const handleSwitchWorkspace = useCallback(async (id: string) => {
    let workspaceList = workspaces
    let targetWorkspaceId = getCanonicalWorkspaceId(workspaceList, id) ?? id
    let ws = workspaceList.find(candidate => candidate.id === targetWorkspaceId) ?? null
    if (!ws) {
      const refreshed = await window.electron.workspace.list().catch(() => [])
      if (refreshed.length > 0) {
        setWorkspaces(refreshed)
        workspaceList = refreshed
        targetWorkspaceId = getCanonicalWorkspaceId(refreshed, targetWorkspaceId) ?? targetWorkspaceId
        ws = refreshed.find(candidate => candidate.id === targetWorkspaceId) ?? null
      }
    }

    // Flush any pending debounced save for the OUTGOING workspace BEFORE
    // calling setWorkspace(). currentWorkspaceIdRef still holds the old id here
    // so the write goes to the correct canvas.json. This prevents the last
    // ≤500ms of edits from being dropped when the timer is cleared by the
    // incoming workspace's first schedulePersistWrite call.
    const outgoingId = currentWorkspaceIdRef.current
    if (outgoingId) flushPendingSave(outgoingId)

    await window.electron.workspace.setActive(targetWorkspaceId)
    setWorkspace(ws)
    setShowWorkspacePickerTab(false)
    setWorkspacePickerReturnWorkspaceId(null)
    if (!ws) return

    // Between setWorkspace(B) above and markCanvasLoaded(B) below, the
    // canvasLoadedForWorkspaceIdRef inside useCanvasEngine does NOT equal
    // workspace.id (still A or null), so the auto-save effect is gated off —
    // preventing A's tiles from being written into B's canvas.json.
    const saved = await window.electron.canvas.load(targetWorkspaceId)
    const savedTiles = saved?.tiles ?? []
    void window.electron.collab.pruneOrphanedTileDirs(ws.path, savedTiles.map(tile => tile.id))
    if (saved) {
      clearHistory()
      applySavedCanvasState(saved, buildCanvasLoadAppliers())
      markCanvasLoaded(targetWorkspaceId)
      return
    }

    clearHistory()
    applyEmptyCanvasWorkspaceState(buildCanvasLoadAppliers(), resetViewportState)
    markCanvasLoaded(targetWorkspaceId)
  }, [
    buildCanvasLoadAppliers,
    clearHistory,
    currentWorkspaceIdRef,
    flushPendingSave,
    markCanvasLoaded,
    resetViewportState,
    setShowWorkspacePickerTab,
    setWorkspace,
    setWorkspacePickerReturnWorkspaceId,
    setWorkspaces,
    workspaces,
  ])

  const handleDeleteWorkspace = useCallback(async (id: string) => {
    const wasActive = workspace?.id === id
    const nextOpenIds = openWorkspaceIds.filter(wsId => wsId !== id)

    await window.electron.workspace.delete(id)
    const updated = await window.electron.workspace.list()
    setWorkspaces(updated)
    setOpenWorkspaceIds(nextOpenIds)

    if (!wasActive) return

    const nextId = nextOpenIds.find(wsId => updated.some(ws => ws.id === wsId)) ?? updated[0]?.id ?? null
    if (nextId) {
      await handleSwitchWorkspace(nextId)
      return
    }

    showEmptyLayoutPage()
  }, [workspace?.id, openWorkspaceIds, handleSwitchWorkspace, showEmptyLayoutPage, setOpenWorkspaceIds, setWorkspaces])

  const handleCloseWorkspaceTab = useCallback(async (id: string) => {
    const tabIndex = openWorkspaceIds.indexOf(id)
    if (tabIndex === -1) return

    const nextOpenIds = openWorkspaceIds.filter(wsId => wsId !== id)
    setOpenWorkspaceIds(nextOpenIds)

    if (workspace?.id !== id) return

    const nextId = nextOpenIds[tabIndex] ?? nextOpenIds[tabIndex - 1] ?? null
    if (nextId) {
      await handleSwitchWorkspace(nextId)
      return
    }

    showEmptyLayoutPage()
  }, [openWorkspaceIds, workspace?.id, handleSwitchWorkspace, showEmptyLayoutPage, setOpenWorkspaceIds])

  const handleNewWorkspace = useCallback(async (name: string) => {
    if (!name.trim()) return
    const ws = await window.electron.workspace.create(name.trim())
    const updated = await window.electron.workspace.list()
    setWorkspaces(updated)
    await handleSwitchWorkspace(ws.id)
  }, [handleSwitchWorkspace, setWorkspaces])

  const handleOpenFolder = useCallback(async () => {
    const folderPath = await window.electron.workspace.openFolder()
    if (!folderPath) return
    const ws = await window.electron.workspace.createFromFolder(folderPath)
    const updated = await window.electron.workspace.list()
    setWorkspaces(updated)
    await handleSwitchWorkspace(ws.id)
  }, [handleSwitchWorkspace, setWorkspaces])

  useEffect(() => {
    return window.electron?.window?.onNewTab?.(() => {
      const next = workspaces.find(candidate => !openWorkspaceIds.includes(candidate.id))
      if (next) {
        setOpenWorkspaceIds(prev => [...prev, next.id])
        handleSwitchWorkspace(next.id)
      }
    })
  }, [workspaces, openWorkspaceIds, handleSwitchWorkspace, setOpenWorkspaceIds])

  const handleLaunchTemplate = useCallback(async (template: LayoutTemplate) => {
    const generated = generateLayoutFromTemplate(template)
    if (!generated) return

    const {
      tiles: generatedTiles,
      panelLayout: generatedPanelLayout,
      activePanelId: generatedActivePanelId,
      connections: generatedConnections,
      nextZIndex: zIdx,
    } = generated

    if (!workspace?.id) {
      const workspaceName = template.name.trim() || 'Workspace'
      const ws = await window.electron.workspace.create(workspaceName)
      const updatedList = await window.electron.workspace.list()
      setWorkspaces(updatedList)

      const nextState: CanvasState = {
        tiles: generatedTiles,
        groups: [],
        viewport: { tx: 0, ty: 0, zoom: 1 },
        nextZIndex: zIdx,
        panelLayout: generatedPanelLayout,
        activePanelId: generatedActivePanelId,
        tabViewActive: true,
        expandedTileId: null,
        lockedConnections: generatedConnections.length > 0 ? generatedConnections : undefined,
      }

      await window.electron.canvas.save(ws.id, nextState)
      await window.electron.workspace.setActive(ws.id)
      setWorkspace(ws)
      setTiles(generatedTiles)
      setGroups([])
      setLockedConnections(generatedConnections)
      setViewport({ tx: 0, ty: 0, zoom: 1 })
      setNextZIndex(zIdx)
      savedLayoutRef.current = generatedPanelLayout
      setPanelLayout(generatedPanelLayout)
      setActivePanelId(generatedActivePanelId)
      setExpandedTileId(null)
      setOpenWorkspaceIds(prev => prev.includes(ws.id) ? prev : [...prev, ws.id])
      return
    }

    const currentLayout = panelLayoutRef.current
    const currentPanelId = activePanelIdRef.current
    const activeLeaf = currentLayout && currentPanelId
      ? findLeafById(currentLayout, currentPanelId) as PanelLeaf | null
      : null
    const canInsertIntoActiveLeaf = Boolean(currentLayout && activeLeaf && activeLeaf.tabs.length === 0)
    const canReplaceWorkspaceState = !currentLayout
      && tilesRef.current.length === 0
      && groupsRef.current.length === 0
    if (!canInsertIntoActiveLeaf && !canReplaceWorkspaceState) return

    const nextTiles = canInsertIntoActiveLeaf
      ? [...tilesRef.current, ...generatedTiles]
      : generatedTiles
    const nextGroups = canInsertIntoActiveLeaf ? groupsRef.current : []
    const nextViewport = canInsertIntoActiveLeaf ? viewportRef.current : { tx: 0, ty: 0, zoom: 1 }
    const nextConnections = canInsertIntoActiveLeaf
      ? dedupeLockedConnections([...lockedConnectionsRef.current, ...generatedConnections])
      : generatedConnections
    const nextPanelLayout = canInsertIntoActiveLeaf && currentLayout && activeLeaf
      ? replaceLeafInPanelTree(currentLayout, activeLeaf.id, generatedPanelLayout)
      : generatedPanelLayout

    const nextState: CanvasState = {
      tiles: nextTiles,
      groups: nextGroups,
      viewport: nextViewport,
      nextZIndex: zIdx,
      panelLayout: nextPanelLayout,
      activePanelId: generatedActivePanelId,
      tabViewActive: true,
      expandedTileId: null,
      lockedConnections: nextConnections.length > 0 ? nextConnections : undefined,
    }

    setTiles(nextTiles)
    setGroups(nextGroups)
    setLockedConnections(nextConnections)
    setViewport(nextViewport)
    setNextZIndex(zIdx)
    savedLayoutRef.current = nextPanelLayout
    setPanelLayout(nextPanelLayout)
    setActivePanelId(generatedActivePanelId)
    setExpandedTileId(null)
    await window.electron.canvas.save(workspace.id, nextState).catch(() => {})
  }, [
    workspace,
    activePanelIdRef,
    groupsRef,
    lockedConnectionsRef,
    panelLayoutRef,
    savedLayoutRef,
    setActivePanelId,
    setExpandedTileId,
    setGroups,
    setLockedConnections,
    setNextZIndex,
    setOpenWorkspaceIds,
    setPanelLayout,
    setTiles,
    setViewport,
    setWorkspace,
    setWorkspaces,
    tilesRef,
    viewportRef,
  ])

  return {
    showEmptyLayoutPage,
    handleSwitchWorkspace,
    handleDeleteWorkspace,
    handleCloseWorkspaceTab,
    handleNewWorkspace,
    handleOpenFolder,
    handleLaunchTemplate,
    applySavedCanvasState: useCallback((saved: CanvasState) => {
      clearHistory()
      applySavedCanvasState(saved, buildCanvasLoadAppliers(true))
    }, [buildCanvasLoadAppliers, clearHistory]),
  }
}