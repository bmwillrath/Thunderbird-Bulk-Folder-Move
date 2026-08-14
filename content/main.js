// ── Bulk Folder Move – UI Script ──────────────────────────────────────────────
// Uses folder.key (composite accountId:path) for identification,
// compatible with TB 115+ (no MailFolder.id) and TB 128+ (has MailFolder.id).

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $sourceAccount  = document.getElementById("source-account");
const $destAccount    = document.getElementById("dest-account");
const $sourceTree     = document.getElementById("source-tree");
const $destTree       = document.getElementById("dest-tree");
const $sourceCount    = document.getElementById("source-count");
const $btnSelectAll   = document.getElementById("btn-select-all");
const $btnSelectNone  = document.getElementById("btn-select-none");
const $btnMove        = document.getElementById("btn-move");
const $btnCancel      = document.getElementById("btn-cancel");
const $btnSkipMsg     = document.getElementById("btn-skip-msg");
const $btnSkipFolder  = document.getElementById("btn-skip-folder");
const $progressPanel  = document.getElementById("progress-panel");
const $progressBadge  = document.getElementById("progress-badge");
const $progressOverall     = document.getElementById("progress-overall");
const $progressOverallText = document.getElementById("progress-overall-text");
const $progressFolder      = document.getElementById("progress-folder");
const $progressFolderText  = document.getElementById("progress-folder-text");
const $log            = document.getElementById("log");

// ─── Settings DOM refs ────────────────────────────────────────────────────────
const $settingMaxSize   = document.getElementById("setting-max-size");
const $settingTransferMode = document.getElementById("setting-transfer-mode");
const $settingsSearch   = document.getElementById("settings-search");
const $settingItems     = document.querySelectorAll(".setting-item");
const $settingFuzzyMatch = document.getElementById("setting-fuzzy-match");
const $settingKeepMasterLog = document.getElementById("setting-keep-master-log");
const $btnDownloadMasterLog = document.getElementById("btn-download-master-log");
const $btnClearMasterLog = document.getElementById("btn-clear-master-log");
const $masterLogSize    = document.getElementById("master-log-size");
const $btnSaveLog       = document.getElementById("btn-save-log");

// ─── Toolbar Buttons ──────────────────────────────────────────────────────────
const $btnSourceExpand   = document.getElementById("btn-source-expand");
const $btnSourceCollapse = document.getElementById("btn-source-collapse");
const $btnDestExpand     = document.getElementById("btn-dest-expand");
const $btnDestCollapse   = document.getElementById("btn-dest-collapse");

// ─── State ────────────────────────────────────────────────────────────────────
let accounts = [];
let sourceFolders = [];   // flat list with .key, .parentKey, .depth etc.
let selectedSourceKeys = new Set();
let destFolders = [];
let selectedDestKey = null;
let currentCountSession = { source: 0, dest: 0 };

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const manifest = messenger.runtime.getManifest();
  document.getElementById("app-version").textContent = "v" + manifest.version;

  // Load preferences
  const prefs = await messenger.storage.local.get({
    maxSizeMb: 25,
    enableFuzzyMatching: true,
    keepMasterLog: true,
    transferMode: "move"
  });
  $settingMaxSize.value = prefs.maxSizeMb;
  if ($settingFuzzyMatch) $settingFuzzyMatch.checked = prefs.enableFuzzyMatching;
  if ($settingKeepMasterLog) $settingKeepMasterLog.checked = prefs.keepMasterLog;
  if ($settingTransferMode) {
    $settingTransferMode.value = prefs.transferMode;
    updateTransferModeUI(prefs.transferMode);
  }
  updateMasterLogSize();

  const res = await messenger.runtime.sendMessage({ type: "get-accounts" });
  if (!res.ok) { alert("Failed to load accounts: " + res.error); return; }
  accounts = res.accounts;
  populateAccountDropdowns();
  syncMoveButton();
  pollProgress();
})();

// ─── Settings Handlers ───────────────────────────────────────────────────────
$settingMaxSize.addEventListener("change", async () => {
  let val = parseInt($settingMaxSize.value, 10);
  if (isNaN(val) || val < 1) val = 1;
  $settingMaxSize.value = val;
  await messenger.storage.local.set({ maxSizeMb: val });
});

if ($settingFuzzyMatch) {
  $settingFuzzyMatch.addEventListener("change", async () => {
    await messenger.storage.local.set({ enableFuzzyMatching: $settingFuzzyMatch.checked });
  });
}

if ($settingKeepMasterLog) {
  $settingKeepMasterLog.addEventListener("change", async () => {
    await messenger.storage.local.set({ keepMasterLog: $settingKeepMasterLog.checked });
  });
}

if ($settingTransferMode) {
  $settingTransferMode.addEventListener("change", async () => {
    const val = $settingTransferMode.value;
    await messenger.storage.local.set({ transferMode: val });
    updateTransferModeUI(val);
  });
}

function updateTransferModeUI(mode) {
  const isCopy = mode === "copy";
  const actionText = isCopy ? "Copy Selected Folders" : "Move Selected Folders";
  $btnMove.innerHTML = `<span class="btn-icon">▶</span> ${actionText}`;
}

function updateMasterLogSize() {
  messenger.storage.local.get({ masterLog: "" }).then(res => {
    const bytes = new Blob([res.masterLog]).size;
    let sizeStr = bytes + " B";
    if (bytes > 1024 * 1024) sizeStr = (bytes / (1024 * 1024)).toFixed(2) + " MB";
    else if (bytes > 1024) sizeStr = (bytes / 1024).toFixed(2) + " KB";
    if ($masterLogSize) $masterLogSize.textContent = sizeStr;
  });
}

if ($btnClearMasterLog) {
  $btnClearMasterLog.addEventListener("click", async () => {
    if (confirm("Are you sure you want to clear the master log history?")) {
      await messenger.storage.local.set({ masterLog: "" });
      updateMasterLogSize();
    }
  });
}

if ($btnDownloadMasterLog) {
  $btnDownloadMasterLog.addEventListener("click", async () => {
    const res = await messenger.storage.local.get({ masterLog: "No master log history found." });
    downloadTextFile("master-migration-log.txt", res.masterLog);
  });
}

if ($btnSaveLog) {
  $btnSaveLog.addEventListener("click", () => {
    const logText = $log.textContent;
    downloadTextFile(`migration-log-${new Date().toISOString().slice(0, 10)}.txt`, logText);
  });
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  
  if (messenger.downloads && messenger.downloads.download) {
    messenger.downloads.download({
      url: url,
      filename: filename,
      saveAs: true
    }).finally(() => {
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  } else {
    // Fallback if downloads API is restricted
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

$settingsSearch.addEventListener("input", () => {
  const term = $settingsSearch.value.toLowerCase().trim();
  $settingItems.forEach(item => {
    const searchTokens = (item.dataset.search || "").toLowerCase();
    const text = item.textContent.toLowerCase();
    
    if (term === "" || searchTokens.includes(term) || text.includes(term)) {
      item.classList.remove("hidden");
    } else {
      item.classList.add("hidden");
    }
  });
});

// ─── Account Dropdowns ───────────────────────────────────────────────────────
function populateAccountDropdowns() {
  for (const acct of accounts) {
    const label = `${acct.name} (${acct.type})`;
    $sourceAccount.appendChild(new Option(label, acct.id));
    $destAccount.appendChild(new Option(label, acct.id));
  }
}

$sourceAccount.addEventListener("change", async () => {
  const id = $sourceAccount.value;
  selectedSourceKeys.clear();
  if (!id) { $sourceTree.innerHTML = '<div class="empty-state">Select an account above to list its folders.</div>'; syncMoveButton(); return; }
  await loadFolderTree(id, "source");
});

$destAccount.addEventListener("change", async () => {
  const id = $destAccount.value;
  selectedDestKey = null;
  if (!id) { $destTree.innerHTML = '<div class="empty-state">Select an account above to choose a destination folder.</div>'; syncMoveButton(); return; }
  await loadFolderTree(id, "dest");
});

// ─── Folder Tree Rendering ───────────────────────────────────────────────────
async function loadFolderTree(accountId, side) {
  const container = side === "source" ? $sourceTree : $destTree;
  container.innerHTML = '<div class="empty-state">Loading…</div>';

  const res = await messenger.runtime.sendMessage({ type: "get-folders", accountId });
  if (!res.ok) { container.innerHTML = `<div class="empty-state">Error: ${res.error}</div>`; return; }

  if (side === "source") {
    sourceFolders = res.folders;
  } else {
    const acct = accounts.find((a) => a.id === accountId);
    const rootEntry = {
      key: "account:" + accountId,
      id: null,
      name: `📫 ${acct ? acct.name : "Account"} (Root)`,
      path: "/",
      type: "root",
      accountId,
      depth: 0,
      parentKey: null,
    };
    destFolders = [rootEntry, ...res.folders];
  }

  renderTree(side === "source" ? sourceFolders : destFolders, container, side);
  startBackgroundCountQueue(side === "source" ? sourceFolders : destFolders, side);
}

function folderIcon(type) {
  const map = {
    inbox: "📥", sent: "📤", drafts: "📝", trash: "🗑️",
    junk: "⚠️", archives: "📦", outbox: "📬",
  };
  return map[type] || "📁";
}

// Get all descendant keys using parentKey tree structure
function getDescendantKeys(parentKey) {
  const descendants = [];
  const findChildren = (pk) => {
    for (const f of sourceFolders) {
      if (f.parentKey === pk) {
        descendants.push(f.key);
        findChildren(f.key);
      }
    }
  };
  findChildren(parentKey);
  return descendants;
}

function renderTree(folders, container, side) {
  container.innerHTML = "";
  if (!folders.length) {
    container.innerHTML = '<div class="empty-state">No folders found.</div>';
    return;
  }

  function buildDOM(parentKey, targetContainer) {
    const children = folders.filter((f) => f.parentKey === parentKey);
    let totalDescendantsOfParent = 0;

    for (const f of children) {
      const folderWrapper = document.createElement("div");
      folderWrapper.className = "folder-wrapper";

      const row = document.createElement("div");
      row.className = "folder-item";

      const childFolders = folders.filter((child) => child.parentKey === f.key);
      const hasChildren = childFolders.length > 0;

      const toggle = document.createElement("span");
      toggle.className = "folder-toggle";
      if (hasChildren) {
        toggle.innerHTML = "▼";
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          folderWrapper.classList.toggle("collapsed");
          toggle.innerHTML = folderWrapper.classList.contains("collapsed") ? "▶" : "▼";
        });
      } else {
        toggle.classList.add("empty-toggle");
      }
      row.appendChild(toggle);

      if (side === "source") {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = f.key;
        cb.checked = selectedSourceKeys.has(f.key);

        cb.addEventListener("click", (e) => {
          e.stopPropagation();
          const checked = cb.checked;
          if (checked) selectedSourceKeys.add(f.key);
          else selectedSourceKeys.delete(f.key);
          // Cascade to descendants
          for (const descKey of getDescendantKeys(f.key)) {
            if (checked) selectedSourceKeys.add(descKey);
            else selectedSourceKeys.delete(descKey);
          }
          reRenderSourceChecks();
          syncMoveButton();
        });
        row.appendChild(cb);
      } else {
        const rb = document.createElement("input");
        rb.type = "radio";
        rb.name = "dest-folder";
        rb.value = f.key;
        rb.checked = selectedDestKey === f.key;

        rb.addEventListener("click", (e) => {
          e.stopPropagation();
          selectedDestKey = f.key;
          syncMoveButton();
        });
        row.appendChild(rb);
      }

      const icon = document.createElement("span");
      icon.className = "folder-icon";
      icon.textContent = folderIcon(f.type);
      row.appendChild(icon);

      const name = document.createElement("span");
      name.className = "folder-name";
      name.textContent = f.name;
      name.title = f.path;
      row.appendChild(name);

      if (f.type !== "root") {
        const badge = document.createElement("span");
        badge.className = "msg-count-badge";
        badge.dataset.key = f.key;
        row.appendChild(badge);
      }

      folderWrapper.appendChild(row);
      targetContainer.appendChild(folderWrapper);

      let descendantsCount = 0;
      if (hasChildren) {
        const childrenContainer = document.createElement("div");
        childrenContainer.className = "folder-children";
        descendantsCount = buildDOM(f.key, childrenContainer);
        folderWrapper.appendChild(childrenContainer);

        const countSpan = document.createElement("span");
        countSpan.className = "child-count";
        countSpan.textContent = `(${descendantsCount})`;
        row.appendChild(countSpan);
      }

      totalDescendantsOfParent += 1 + descendantsCount;

      // Make whole row clickable
      row.addEventListener("click", (e) => {
        if (e.target.tagName === "INPUT" || e.target.classList.contains("folder-toggle")) return;
        if (side === "source") {
          const cb = row.querySelector('input[type="checkbox"]');
          cb.click();
        } else {
          const rb = row.querySelector('input[type="radio"]');
          rb.click();
        }
      });
    }

    return totalDescendantsOfParent;
  }

  buildDOM(null, container);
}

async function startBackgroundCountQueue(folders, side) {
  const sessionId = ++currentCountSession[side];
  const container = side === "source" ? $sourceTree : $destTree;

  for (const f of folders) {
    if (currentCountSession[side] !== sessionId) break;
    if (f.type === "root") continue;

    const badgeEl = container.querySelector(`.msg-count-badge[data-key="${CSS.escape(f.key)}"]`);
    if (!badgeEl) continue;

    try {
      const res = await messenger.runtime.sendMessage({
        type: "get-folder-count",
        accountId: f.accountId,
        path: f.path,
      });

      if (currentCountSession[side] !== sessionId) break;

      if (res && res.ok && typeof res.count === "number") {
        badgeEl.textContent = `[${res.count}]`;
        badgeEl.title = `${res.count} email(s)`;
      } else {
        badgeEl.textContent = `[?]`;
        badgeEl.title = "Could not read message count";
      }
    } catch (_err) {
      if (currentCountSession[side] !== sessionId) break;
      badgeEl.textContent = `[?]`;
    }

    // 150ms throttle delay between folders to ensure zero UI lag & zero server flooding
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

// ─── Select All / None ───────────────────────────────────────────────────────
$btnSelectAll.addEventListener("click", () => {
  sourceFolders.forEach((f) => selectedSourceKeys.add(f.key));
  reRenderSourceChecks();
  syncMoveButton();
});
$btnSelectNone.addEventListener("click", () => {
  selectedSourceKeys.clear();
  reRenderSourceChecks();
  syncMoveButton();
});

// ─── Expand / Collapse All ───────────────────────────────────────────────────
function toggleAllTree(container, collapse) {
  container.querySelectorAll(".folder-wrapper").forEach((wrapper) => {
    if (wrapper.querySelector(".folder-children")) {
      if (collapse) {
        wrapper.classList.add("collapsed");
        wrapper.querySelector(".folder-toggle").innerHTML = "▶";
      } else {
        wrapper.classList.remove("collapsed");
        wrapper.querySelector(".folder-toggle").innerHTML = "▼";
      }
    }
  });
}

if ($btnSourceExpand) $btnSourceExpand.addEventListener("click", () => toggleAllTree($sourceTree, false));
if ($btnSourceCollapse) $btnSourceCollapse.addEventListener("click", () => toggleAllTree($sourceTree, true));
if ($btnDestExpand) $btnDestExpand.addEventListener("click", () => toggleAllTree($destTree, false));
if ($btnDestCollapse) $btnDestCollapse.addEventListener("click", () => toggleAllTree($destTree, true));

function reRenderSourceChecks() {
  $sourceTree.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = selectedSourceKeys.has(cb.value);
  });
  $sourceCount.textContent = `${selectedSourceKeys.size} selected`;
}

// ─── Move Button State ───────────────────────────────────────────────────────
function syncMoveButton() {
  $btnMove.disabled = selectedSourceKeys.size === 0 || !selectedDestKey;
}

// ─── Execute Move ─────────────────────────────────────────────────────────────
$btnMove.addEventListener("click", async () => {
  if (selectedSourceKeys.size === 0 || !selectedDestKey) return;

  // Build source list
  const sources = [];
  for (const key of selectedSourceKeys) {
    const folder = sourceFolders.find((f) => f.key === key);
    if (folder) {
      sources.push({
        key: folder.key,
        id: folder.id,
        name: folder.name,
        path: folder.path,
        accountId: folder.accountId,
      });
    }
  }

  // Find dest folder
  const destFolder = destFolders.find((f) => f.key === selectedDestKey);
  const destination = {
    key: selectedDestKey,
    id: destFolder ? destFolder.id : null,
    name: destFolder ? destFolder.name : "",
    path: destFolder ? destFolder.path : "/",
    accountId: destFolder ? destFolder.accountId : "",
  };

  // Confirm
  const isCopy = $settingTransferMode && $settingTransferMode.value === "copy";
  const actionVerb = isCopy ? "Copy" : "Move";
  const actionDetails = isCopy
    ? "This will copy all messages and keep the original emails and folders intact."
    : "This will copy all messages, then delete the originals.";
  const confirmMsg = `${actionVerb} ${sources.length} folder(s) to "${destFolder ? destFolder.name : "selected destination"}"?\n\n${actionDetails}`;
  if (!confirm(confirmMsg)) return;

  // Disable UI
  $btnMove.style.display = "none";
  $btnSkipMsg.style.display = "inline-flex";
  $btnSkipFolder.style.display = "inline-flex";
  $btnCancel.style.display = "inline-flex";
  $progressPanel.style.display = "";
  $log.textContent = "";
  $sourceAccount.disabled = true;
  $destAccount.disabled = true;

  const settingsPayload = {
    maxSizeMb: parseInt($settingMaxSize.value, 10) || 25,
    enableFuzzyMatching: $settingFuzzyMatch ? $settingFuzzyMatch.checked : true,
    keepMasterLog: $settingKeepMasterLog ? $settingKeepMasterLog.checked : true,
    transferMode: $settingTransferMode ? $settingTransferMode.value : "move"
  };

  const res = await messenger.runtime.sendMessage({
    type: "start-move",
    sourceFolders: sources,
    destination,
    settings: settingsPayload
  });
  if (!res.ok) {
    alert("Failed to start: " + res.error);
    resetUI();
  }
});

// ─── Control Actions (Skip & Cancel) ──────────────────────────────────────────
$btnSkipMsg.addEventListener("click", async () => {
  await messenger.runtime.sendMessage({ type: "skip-message" });
});

$btnSkipFolder.addEventListener("click", async () => {
  await messenger.runtime.sendMessage({ type: "skip-folder" });
});

$btnCancel.addEventListener("click", async () => {
  await messenger.runtime.sendMessage({ type: "cancel" });
});

// ─── Progress Updates ─────────────────────────────────────────────────────────
messenger.runtime.onMessage.addListener((message) => {
  if (message.type === "progress-update") {
    updateProgress(message.progress);
  }
});

function updateProgress(p) {
  if (!p) return;
  $progressPanel.style.display = "";

  const phaseLabels = {
    starting: "Starting…",
    processing: "Processing…",
    done: "✅ Complete",
    cancelled: "⚠️ Cancelled",
    error: "❌ Error",
  };
  $progressBadge.textContent = phaseLabels[p.phase] || p.phase;

  const overallPct = p.overallTotal > 0 ? (p.overallDone / p.overallTotal) * 100 : 0;
  $progressOverall.style.width = `${overallPct}%`;
  $progressOverallText.textContent = `${p.overallDone} / ${p.overallTotal}`;

  const folderPct = p.total > 0 ? (p.copied / p.total) * 100 : 0;
  $progressFolder.style.width = `${folderPct}%`;
  $progressFolderText.textContent = `${p.copied} / ${p.total}`;

  $log.textContent = (p.log || []).join("\n");
  $log.parentElement.scrollTop = $log.parentElement.scrollHeight;

  if (p.phase === "done" || p.phase === "cancelled" || p.phase === "error") {
    $btnSaveLog.style.display = "inline-flex";
    resetUI();
    if ($sourceAccount.value) loadFolderTree($sourceAccount.value, "source");
    if ($destAccount.value) loadFolderTree($destAccount.value, "dest");
    updateMasterLogSize();
  } else {
    $btnSaveLog.style.display = "none";
  }
}

function resetUI() {
  $btnMove.style.display = "inline-flex";
  $btnSkipMsg.style.display = "none";
  $btnSkipFolder.style.display = "none";
  $btnCancel.style.display = "none";
  $sourceAccount.disabled = false;
  $destAccount.disabled = false;
  selectedSourceKeys.clear();
  $sourceCount.textContent = "0 selected";
  syncMoveButton();
}

// ─── Poll for Progress (tab reopen) ──────────────────────────────────────────
async function pollProgress() {
  const res = await messenger.runtime.sendMessage({ type: "get-progress" });
  if (res.ok && res.processing) {
    $btnMove.style.display = "none";
    $btnSkipMsg.style.display = "inline-flex";
    $btnSkipFolder.style.display = "inline-flex";
    $btnCancel.style.display = "inline-flex";
    $sourceAccount.disabled = true;
    $destAccount.disabled = true;
    updateProgress(res.progress);
  }
}
