// Generated from src/main/chat/peer-context-policy.ts with esbuild.
// Keep behavior synchronized through the shared peer-context policy fixtures.

// src/main/chat/peer-context-serialization.ts
var textEncoder = new TextEncoder();
var unsafeControl = new RegExp("\\p{Cc}", "gu");
var unsafeBidi = new RegExp("\\p{Bidi_Control}", "gu");
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function toWellFormedText(value) {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += character.length === 1 && code >= 55296 && code <= 57343 ? "\uFFFD" : character;
  }
  return result;
}
function utf8Bytes(value) {
  return textEncoder.encode(value).byteLength;
}
function utf8Prefix(value, maxBytes) {
  let result = "";
  let used = 0;
  for (const character of toWellFormedText(value)) {
    const bytes = utf8Bytes(character);
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}
function singleLine(value) {
  return toWellFormedText(value).replace(unsafeControl, " ").replace(unsafeBidi, "").replace(/\s+/gu, " ").trim();
}
function readDataProperty(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return { ok: false };
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}
function safeKeys(value) {
  try {
    return Object.keys(value).sort(compareText);
  } catch {
    return null;
  }
}
function serialize(value, state, depth, limits) {
  if (state.remainingNodes <= 0) return JSON.stringify("[Node limit reached]");
  state.remainingNodes -= 1;
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(toWellFormedText(value));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (typeof value === "undefined") return JSON.stringify("[Undefined]");
  if (typeof value === "symbol") return JSON.stringify(`[Symbol: ${singleLine(value.description ?? "")}]`);
  if (typeof value === "function") return JSON.stringify("[Function]");
  if (typeof value !== "object") return JSON.stringify("[Unsupported value]");
  if (state.ancestors.has(value)) return JSON.stringify("[Circular]");
  if (depth >= limits.depth) return JSON.stringify("[Depth limit reached]");
  state.ancestors.add(value);
  try {
    if (value instanceof Date) {
      try {
        return JSON.stringify(Number.isFinite(value.getTime()) ? value.toISOString() : "[Invalid Date]");
      } catch {
        return JSON.stringify("[Unserializable Date]");
      }
    }
    if (Array.isArray(value)) {
      const length = Math.min(value.length, limits.containerEntries);
      const items = [];
      for (let index = 0; index < length; index += 1) {
        const item = readDataProperty(value, String(index));
        items.push(item.ok ? serialize(item.value, state, depth + 1, limits) : JSON.stringify("[Inaccessible item]"));
      }
      if (value.length > length) items.push(JSON.stringify(`[${value.length - length} items omitted]`));
      return `[${items.join(",")}]`;
    }
    const keys = safeKeys(value);
    if (!keys) return JSON.stringify("[Unserializable object]");
    const selectedKeys = keys.slice(0, limits.containerEntries);
    const fields = selectedKeys.map((key) => {
      const property = readDataProperty(value, key);
      const display = property.ok ? serialize(property.value, state, depth + 1, limits) : JSON.stringify("[Inaccessible property]");
      return `${JSON.stringify(toWellFormedText(key))}:${display}`;
    });
    if (keys.length > selectedKeys.length) {
      fields.push(`${JSON.stringify("...")}:${JSON.stringify(`[${keys.length - selectedKeys.length} entries omitted]`)}`);
    }
    return `{${fields.join(",")}}`;
  } catch {
    return JSON.stringify("[Unserializable object]");
  } finally {
    state.ancestors.delete(value);
  }
}
function safeSerializeContextValue(value, limits) {
  try {
    return serialize(value, {
      remainingNodes: limits.nodes,
      ancestors: /* @__PURE__ */ new WeakSet()
    }, 0, limits);
  } catch {
    return JSON.stringify("[Unserializable value]");
  }
}

// src/main/chat/contextual-fragments.ts
function createContextualPromptFragment(owner, text, maxUtf8Bytes) {
  const boundedText = utf8Bytes(text) <= maxUtf8Bytes ? text : utf8Prefix(text, maxUtf8Bytes);
  return Object.freeze({
    owner,
    volatility: "per-turn",
    maxUtf8Bytes,
    text: boundedText
  });
}

// src/main/chat/peer-context-policy.ts
var PEER_CONTEXT_LIMITS = Object.freeze({
  peers: 16,
  peerIdBytes: 128,
  peerTypeBytes: 64,
  toolsPerPeer: 48,
  toolNameBytes: 128,
  actionsPerPeer: 24,
  actionNameBytes: 128,
  actionDescriptionBytes: 512,
  contextEntriesPerPeer: 32,
  contextKeyBytes: 128,
  contextValueBytes: 1024,
  contextNodesPerValue: 128,
  contextDepth: 6,
  containerEntries: 32,
  collectionInspectionEntries: 256,
  peerRenderedBytes: 256,
  // A byte-pair tokenizer cannot emit more tokens than input UTF-8 bytes.
  // Keeping each owned fragment to 1,000 bytes therefore proves that it stays
  // below the central 1K-token contextual-fragment ceiling.
  promptRenderedBytes: 1e3
});
function isArray(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}
function safeArrayLength(value) {
  if (!isArray(value)) return null;
  const length = readDataProperty(value, "length");
  return length.ok && Number.isSafeInteger(length.value) && Number(length.value) >= 0 ? Number(length.value) : null;
}
function boundUtf8(value, maxBytes, reason, metadata) {
  const normalized = toWellFormedText(value);
  const originalBytes = utf8Bytes(normalized);
  if (originalBytes <= maxBytes) return normalized;
  metadata.truncatedFieldCount += 1;
  const marker = `[Truncated: ${reason}; ${originalBytes} original UTF-8 bytes; ${maxBytes} byte limit]`;
  const separator = " ";
  const reservedBytes = utf8Bytes(separator + marker);
  if (reservedBytes >= maxBytes) return utf8Prefix(marker, maxBytes);
  return `${utf8Prefix(normalized, maxBytes - reservedBytes).trimEnd()}${separator}${marker}`;
}
function readArrayItem(value, index) {
  return isArray(value) ? readDataProperty(value, String(index)) : { ok: false };
}
function boundedContextDisplay(value, metadata) {
  const serialized = safeSerializeContextValue(value, {
    nodes: PEER_CONTEXT_LIMITS.contextNodesPerValue,
    depth: PEER_CONTEXT_LIMITS.contextDepth,
    containerEntries: PEER_CONTEXT_LIMITS.containerEntries
  });
  return boundUtf8(
    serialized,
    PEER_CONTEXT_LIMITS.contextValueBytes,
    "maximum peer context value bytes",
    metadata
  ).replace(/[\r\n]+/gu, " ");
}
function validIdentifier(value, maxBytes) {
  if (typeof value !== "string" || value.length === 0) return false;
  const normalized = toWellFormedText(value);
  return normalized === value && singleLine(value) === value && utf8Bytes(value) <= maxBytes;
}
function normalizeStringList(value, countLimit, byteLimit, metadata) {
  const length = safeArrayLength(value);
  if (length === null) return null;
  if (length > PEER_CONTEXT_LIMITS.collectionInspectionEntries) {
    metadata.omittedFieldCount += length;
    return { values: [], omitted: length };
  }
  const values = /* @__PURE__ */ new Set();
  let omitted = 0;
  for (let index = 0; index < length; index += 1) {
    const item = readArrayItem(value, index);
    if (!item.ok || !validIdentifier(item.value, byteLimit)) {
      omitted += 1;
      continue;
    }
    if (values.has(item.value)) {
      omitted += 1;
      continue;
    }
    values.add(item.value);
  }
  metadata.omittedFieldCount += omitted;
  const sorted = [...values].sort(compareText);
  const retained = sorted.slice(0, countLimit);
  const overLimit = sorted.length - retained.length;
  metadata.omittedFieldCount += overLimit;
  return {
    values: retained,
    omitted: omitted + overLimit
  };
}
function normalizeActions(value, metadata) {
  if (value === void 0) return { actions: [], omitted: 0 };
  const length = safeArrayLength(value);
  if (length === null) return null;
  if (length > PEER_CONTEXT_LIMITS.collectionInspectionEntries) {
    metadata.omittedFieldCount += length;
    return { actions: [], omitted: length };
  }
  const actions = [];
  let omitted = 0;
  for (let index = 0; index < length; index += 1) {
    const entry = readArrayItem(value, index);
    if (!entry.ok || !entry.value || typeof entry.value !== "object" || isArray(entry.value)) {
      omitted += 1;
      continue;
    }
    const name = readDataProperty(entry.value, "name");
    const description = readDataProperty(entry.value, "description");
    if (!name.ok || !validIdentifier(name.value, PEER_CONTEXT_LIMITS.actionNameBytes) || !description.ok || typeof description.value !== "string") {
      omitted += 1;
      continue;
    }
    const boundedDescription = boundUtf8(
      singleLine(description.value),
      PEER_CONTEXT_LIMITS.actionDescriptionBytes,
      "maximum peer action description bytes",
      metadata
    );
    actions.push({ name: name.value, description: boundedDescription });
  }
  metadata.omittedFieldCount += omitted;
  actions.sort((left, right) => compareText(left.name, right.name) || compareText(left.description, right.description));
  const retained = actions.slice(0, PEER_CONTEXT_LIMITS.actionsPerPeer);
  const overLimit = actions.length - retained.length;
  metadata.omittedFieldCount += overLimit;
  return { actions: retained, omitted: omitted + overLimit };
}
function normalizeContext(value, metadata) {
  if (value === void 0) return { entries: [], omitted: 0 };
  if (!value || typeof value !== "object" || isArray(value)) return null;
  const keys = safeKeys(value);
  if (!keys) return null;
  if (keys.length > PEER_CONTEXT_LIMITS.collectionInspectionEntries) {
    metadata.omittedFieldCount += keys.length;
    return { entries: [], omitted: keys.length };
  }
  const selectedKeys = keys.slice(0, PEER_CONTEXT_LIMITS.contextEntriesPerPeer);
  const entries = [];
  let omitted = Math.max(0, keys.length - selectedKeys.length);
  for (const key of selectedKeys) {
    const normalizedKey = singleLine(key);
    const property = readDataProperty(value, key);
    if (!normalizedKey || utf8Bytes(normalizedKey) > PEER_CONTEXT_LIMITS.contextKeyBytes || !property.ok) {
      omitted += 1;
      continue;
    }
    entries.push({
      key: normalizedKey,
      value: boundedContextDisplay(property.value, metadata)
    });
  }
  metadata.omittedFieldCount += omitted;
  return { entries, omitted };
}
function normalizePeer(value, metadata) {
  if (!value || typeof value !== "object" || isArray(value)) return null;
  const peerId = readDataProperty(value, "peerId");
  const peerType = readDataProperty(value, "peerType");
  const tools = readDataProperty(value, "tools");
  if (!peerId.ok || !validIdentifier(peerId.value, PEER_CONTEXT_LIMITS.peerIdBytes) || !peerType.ok || typeof peerType.value !== "string" || !singleLine(peerType.value) || !tools.ok) {
    return null;
  }
  const normalizedTools = normalizeStringList(
    tools.value,
    PEER_CONTEXT_LIMITS.toolsPerPeer,
    PEER_CONTEXT_LIMITS.toolNameBytes,
    metadata
  );
  if (!normalizedTools) return null;
  const actionsProperty = readDataProperty(value, "actions");
  const contextProperty = readDataProperty(value, "context");
  const normalizedActions = normalizeActions(actionsProperty.ok ? actionsProperty.value : void 0, metadata);
  const normalizedContext = normalizeContext(contextProperty.ok ? contextProperty.value : void 0, metadata);
  const notices = [];
  if (!normalizedActions) {
    metadata.omittedFieldCount += 1;
    notices.push("actions rejected: expected an array");
  } else if (normalizedActions.omitted > 0) {
    notices.push(`${normalizedActions.omitted} action entr${normalizedActions.omitted === 1 ? "y" : "ies"} omitted`);
  }
  if (!normalizedContext) {
    metadata.omittedFieldCount += 1;
    notices.push("context rejected: expected an object");
  } else if (normalizedContext.omitted > 0) {
    notices.push(`${normalizedContext.omitted} context entr${normalizedContext.omitted === 1 ? "y" : "ies"} omitted`);
  }
  if (normalizedTools.omitted > 0) {
    notices.push(`${normalizedTools.omitted} tool entr${normalizedTools.omitted === 1 ? "y" : "ies"} omitted`);
  }
  return {
    peerId: peerId.value,
    peerType: boundUtf8(
      singleLine(peerType.value),
      PEER_CONTEXT_LIMITS.peerTypeBytes,
      "maximum peer type bytes",
      metadata
    ),
    tools: normalizedTools.values,
    actions: normalizedActions?.actions ?? [],
    contextEntries: normalizedContext?.entries ?? [],
    notices
  };
}
function renderPeer(peer, metadata) {
  const lines = [];
  if (peer.tools.length > 0) lines.push(`  Tools: ${peer.tools.join(", ")}`);
  if (peer.actions.length > 0) {
    lines.push("  Actions (call via ext_invoke_action):");
    for (const action of peer.actions) lines.push(`    - ${action.name}: ${action.description}`);
  }
  if (peer.contextEntries.length > 0) {
    lines.push("  Current context:");
    for (const entry of peer.contextEntries) lines.push(`    ${entry.key}: ${entry.value}`);
  }
  for (const notice of peer.notices) lines.push(`  [Peer metadata limited: ${notice}]`);
  if (lines.length === 0) lines.push("  (no specific tools)");
  return boundUtf8(
    `- Block ${JSON.stringify(peer.peerId)} (${peer.peerType}):
${lines.join("\n")}`,
    PEER_CONTEXT_LIMITS.peerRenderedBytes,
    "maximum rendered bytes for one peer",
    metadata
  );
}
function normalizePeers(value, metadata) {
  if (value === void 0 || value === null) return [];
  const length = safeArrayLength(value);
  if (length === null) {
    metadata.malformedPeerCount = 1;
    metadata.omittedPeerCount = 1;
    return [];
  }
  metadata.originalPeerCount = length;
  if (length > PEER_CONTEXT_LIMITS.collectionInspectionEntries) {
    metadata.omittedPeerCount = length;
    return [];
  }
  const peers = [];
  for (let index = 0; index < length; index += 1) {
    const entry = readArrayItem(value, index);
    const peer = entry.ok ? normalizePeer(entry.value, metadata) : null;
    if (peer) peers.push(peer);
    else {
      metadata.malformedPeerCount += 1;
      metadata.omittedPeerCount += 1;
    }
  }
  peers.sort((left, right) => compareText(left.peerId, right.peerId) || compareText(left.peerType, right.peerType));
  const retained = peers.slice(0, PEER_CONTEXT_LIMITS.peers);
  metadata.omittedPeerCount += peers.length - retained.length;
  metadata.includedPeerCount = retained.length;
  return retained;
}
function promptParts(peers) {
  const hasExtensionActions = peers.some((peer) => peer.actions.length > 0);
  const hasBrowserTools = peers.some((peer) => peer.tools.some((tool) => tool.startsWith("browser_")));
  const browserGuide = hasBrowserTools ? [
    "",
    "## Browser Control",
    "Use browser_* with the block tile_id; consult ctx:browser:* before acting."
  ] : [];
  const extensionGuide = hasExtensionActions ? [
    "",
    "## Extension Actions",
    "Use ext_invoke_action(tile_id, action, params); read via tile_context_get. Prefer generate over setHtml; do not author HTML."
  ] : [];
  return {
    header: [
      "## Agent room",
      "The host-bounded blocks below are authoritative for this turn. Their block ID is tile_id.",
      "Room tools: room_status, room_post, room_consume, peer_set_state, peer_get_state, peer_send_message.",
      "Use an exposed direct tool immediately; only discover the canvas if no listed peer covers the task.",
      ...browserGuide,
      ...extensionGuide,
      "",
      "## Connected peer blocks"
    ].join("\n"),
    suffix: ""
  };
}
function buildPeerContextPrompt(value) {
  const metadata = {
    originalPeerCount: 0,
    includedPeerCount: 0,
    omittedPeerCount: 0,
    malformedPeerCount: 0,
    truncatedFieldCount: 0,
    omittedFieldCount: 0,
    renderedPeerCount: 0,
    renderedBytes: 0,
    promptTruncated: false
  };
  const peers = normalizePeers(value, metadata);
  if (peers.length === 0) return { peers, fragment: void 0, metadata };
  const renderedPeers = peers.map((peer) => renderPeer(peer, metadata));
  const { header, suffix } = promptParts(peers);
  const normalizationNotice = metadata.omittedPeerCount > 0 ? `[Peer list limited: ${metadata.omittedPeerCount} peer record${metadata.omittedPeerCount === 1 ? "" : "s"} omitted by the peer context policy.]` : "";
  const includedBlocks = [];
  for (const block of renderedPeers) {
    const candidateBlocks = [...includedBlocks, block];
    const candidateOmitted = renderedPeers.length - candidateBlocks.length;
    const candidateNotice = candidateOmitted > 0 ? `[Peer prompt truncated: ${candidateOmitted} normalized peer block${candidateOmitted === 1 ? "" : "s"} omitted to enforce the ${PEER_CONTEXT_LIMITS.promptRenderedBytes} byte aggregate limit.]` : "";
    const candidate = [
      header,
      normalizationNotice,
      candidateBlocks.join("\n"),
      candidateNotice,
      suffix
    ].filter(Boolean).join("\n\n");
    if (utf8Bytes(candidate) > PEER_CONTEXT_LIMITS.promptRenderedBytes) break;
    includedBlocks.push(block);
  }
  metadata.renderedPeerCount = includedBlocks.length;
  const promptOmittedPeers = renderedPeers.length - includedBlocks.length;
  const aggregateNotice = promptOmittedPeers > 0 ? `[Peer prompt truncated: ${promptOmittedPeers} normalized peer block${promptOmittedPeers === 1 ? "" : "s"} omitted to enforce the ${PEER_CONTEXT_LIMITS.promptRenderedBytes} byte aggregate limit.]` : "";
  metadata.promptTruncated = promptOmittedPeers > 0;
  const prompt = [
    header,
    normalizationNotice,
    includedBlocks.join("\n"),
    aggregateNotice,
    suffix
  ].filter(Boolean).join("\n\n");
  metadata.renderedBytes = utf8Bytes(prompt);
  if (metadata.renderedBytes > PEER_CONTEXT_LIMITS.promptRenderedBytes) {
    const bounded = boundUtf8(
      prompt,
      PEER_CONTEXT_LIMITS.promptRenderedBytes,
      "maximum aggregate peer prompt bytes",
      metadata
    );
    metadata.renderedBytes = utf8Bytes(bounded);
    metadata.promptTruncated = true;
    return {
      peers,
      fragment: createContextualPromptFragment("peer-context-policy", bounded, PEER_CONTEXT_LIMITS.promptRenderedBytes),
      metadata
    };
  }
  return {
    peers,
    fragment: createContextualPromptFragment("peer-context-policy", prompt, PEER_CONTEXT_LIMITS.promptRenderedBytes),
    metadata
  };
}
export {
  PEER_CONTEXT_LIMITS,
  buildPeerContextPrompt
};
