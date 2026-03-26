// ── Bulk Folder Move – UI Script ──────────────────────────────────────────────

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
const $progressPanel  = document.getElementById("progress-panel");
const $progressBadge  = document.getElementById("progress-badge");
const $progressOverall     = document.getElementById("progress-overall");
const $progressOverallText = document.getElementById("progress-overall-text");
const $progressFolder      = document.getElementById("progress-folder");
const $progressFolderText  = document.getElementById("progress-folder-text");
const $log            = document.getElementById("log");

// ─── State ────────────────────────────────────────────────────────────────────
let accounts = [];
let sourceFolders = [];   // currently displayed source folders
let selectedSourceIds = new Set();
let destFolders = [];     // currently displayed dest folders
let selectedDestId = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const res = await messenger.runtime.sendMessage({ type: "get-accounts" });
  if (!res.ok) { alert("Failed to load accounts: " + res.error); return; }
  accounts = res.accounts;
  populateAccountDropdowns();
  syncMoveButton();

  // Poll for ongoing progress in case the tab was reopened mid-operation
  pollProgress();
})();

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
  selectedSourceIds.clear();
  if (!id) { $sourceTree.innerHTML = '<div class="empty-state">Select an account above to list its folders.</div>'; syncMoveButton(); return; }
  await loadFolderTree(id, "source");
});

$destAccount.addEventListener("change", async () => {
  const id = $destAccount.value;
  selectedDestId = null;
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
    // Prepend a virtual "Account Root" entry so the user can move folders
    // to the top level of the account (the parent of Inbox, Sent, etc.)
    const acct = accounts.find((a) => a.id === accountId);
    const rootEntry = {
      id: `account:${accountId}`,
      name: `📫 ${acct ? acct.name : "Account"} (Root)`,
      path: "/",
      type: "root",
      accountId,
      depth: 0,
    };
    destFolders = [rootEntry, ...res.folders];
  }

  renderTree(side === "source" ? sourceFolders : destFolders, container, side);
}

function folderIcon(type) {
  const map = {
    inbox:   "📥",
    sent:    "📤",
    drafts:  "📝",
    trash:   "🗑️",
    junk:    "⚠️",
    archives:"📦",
    outbox:  "📬",
  };
  return map[type] || "📁";
}

function renderTree(folders, container, side) {
  container.innerHTML = "";
  if (!folders.length) {
    container.innerHTML = '<div class="empty-state">No folders found.</div>';
    return;
  }
  for (const f of folders) {
    const row = document.createElement("label");
    row.className = "folder-item";
    row.style.paddingLeft = `${16 + f.depth * 20}px`;

    if (side === "source") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = f.id;
      cb.dataset.path = f.path;
      cb.dataset.accountId = f.accountId;
      cb.checked = selectedSourceIds.has(f.id);
      cb.addEventListener("change", () => {
        const isChecked = cb.checked;
        // Toggle this folder
        if (isChecked) selectedSourceIds.add(f.id);
        else selectedSourceIds.delete(f.id);
        // Cascade to all children (any folder whose path starts with this one + "/")
        const parentPath = f.path.endsWith("/") ? f.path : f.path + "/";
        for (const child of sourceFolders) {
          if (child.path.startsWith(parentPath)) {
            if (isChecked) selectedSourceIds.add(child.id);
            else selectedSourceIds.delete(child.id);
          }
        }
        reRenderSourceChecks();
        syncMoveButton();
      });
      row.appendChild(cb);
    } else {
      const rb = document.createElement("input");
      rb.type = "radio";
      rb.name = "dest-folder";
      rb.value = f.id;
      rb.dataset.accountId = f.accountId;
      rb.checked = selectedDestId === f.id;
      rb.addEventListener("change", () => {
        selectedDestId = f.id;
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

    container.appendChild(row);
  }
}

// ─── Select All / None ───────────────────────────────────────────────────────
$btnSelectAll.addEventListener("click", () => {
  sourceFolders.forEach((f) => selectedSourceIds.add(f.id));
  reRenderSourceChecks();
  syncMoveButton();
});
$btnSelectNone.addEventListener("click", () => {
  selectedSourceIds.clear();
  reRenderSourceChecks();
  syncMoveButton();
});

function reRenderSourceChecks() {
  $sourceTree.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = selectedSourceIds.has(cb.value);
  });
  $sourceCount.textContent = `${selectedSourceIds.size} selected`;
}

// ─── Move Button State ───────────────────────────────────────────────────────
function syncMoveButton() {
  $btnMove.disabled = selectedSourceIds.size === 0 || !selectedDestId;
}

// ─── Execute Move ─────────────────────────────────────────────────────────────
$btnMove.addEventListener("click", async () => {
  if (selectedSourceIds.size === 0 || !selectedDestId) return;

  // Build source list from current selection
  const sources = [];
  for (const id of selectedSourceIds) {
    const folder = sourceFolders.find((f) => f.id === id);
    if (folder) sources.push({ id: folder.id, path: folder.path, accountId: folder.accountId });
  }

  // Find dest accountId
  const destFolder = destFolders.find((f) => f.id === selectedDestId);
  const destination = { id: selectedDestId, accountId: destFolder ? destFolder.accountId : "" };

  // Confirm
  const confirmMsg = `Move ${sources.length} folder(s) to "${destFolder ? destFolder.name : "selected destination"}"?\n\nThis will copy all messages, then delete the originals.`;
  if (!confirm(confirmMsg)) return;

  // Disable UI and show progress
  $btnMove.style.display = "none";
  $btnCancel.style.display = "inline-flex";
  $progressPanel.style.display = "";
  $log.textContent = "";
  $sourceAccount.disabled = true;
  $destAccount.disabled = true;

  const res = await messenger.runtime.sendMessage({
    type: "start-move",
    sourceFolders: sources,
    destination,
  });
  if (!res.ok) {
    alert("Failed to start: " + res.error);
    resetUI();
  }
});

// ─── Cancel ───────────────────────────────────────────────────────────────────
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

  // Badge
  const phaseLabels = {
    starting: "Starting…",
    processing: "Processing…",
    done: "✅ Complete",
    cancelled: "⚠️ Cancelled",
    error: "❌ Error",
  };
  $progressBadge.textContent = phaseLabels[p.phase] || p.phase;

  // Overall bar
  const overallPct = p.overallTotal > 0 ? (p.overallDone / p.overallTotal) * 100 : 0;
  $progressOverall.style.width = `${overallPct}%`;
  $progressOverallText.textContent = `${p.overallDone} / ${p.overallTotal}`;

  // Folder bar
  const folderPct = p.total > 0 ? (p.copied / p.total) * 100 : 0;
  $progressFolder.style.width = `${folderPct}%`;
  $progressFolderText.textContent = `${p.copied} / ${p.total}`;

  // Log
  $log.textContent = (p.log || []).join("\n");
  $log.parentElement.scrollTop = $log.parentElement.scrollHeight;

  // Reset UI when finished
  if (p.phase === "done" || p.phase === "cancelled" || p.phase === "error") {
    resetUI();
    // Refresh folder lists
    if ($sourceAccount.value) loadFolderTree($sourceAccount.value, "source");
    if ($destAccount.value) loadFolderTree($destAccount.value, "dest");
  }
}

function resetUI() {
  $btnMove.style.display = "inline-flex";
  $btnCancel.style.display = "none";
  $sourceAccount.disabled = false;
  $destAccount.disabled = false;
  selectedSourceIds.clear();
  $sourceCount.textContent = "0 selected";
  syncMoveButton();
}

// ─── Poll for Progress (tab reopen scenario) ─────────────────────────────────
async function pollProgress() {
  const res = await messenger.runtime.sendMessage({ type: "get-progress" });
  if (res.ok && res.processing) {
    $btnMove.style.display = "none";
    $btnCancel.style.display = "inline-flex";
    $sourceAccount.disabled = true;
    $destAccount.disabled = true;
    updateProgress(res.progress);
  }
}
