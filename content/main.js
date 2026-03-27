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
const $progressPanel  = document.getElementById("progress-panel");
const $progressBadge  = document.getElementById("progress-badge");
const $progressOverall     = document.getElementById("progress-overall");
const $progressOverallText = document.getElementById("progress-overall-text");
const $progressFolder      = document.getElementById("progress-folder");
const $progressFolderText  = document.getElementById("progress-folder-text");
const $log            = document.getElementById("log");

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

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  const manifest = messenger.runtime.getManifest();
  document.getElementById("app-version").textContent = "v" + manifest.version;

  const res = await messenger.runtime.sendMessage({ type: "get-accounts" });
  if (!res.ok) { alert("Failed to load accounts: " + res.error); return; }
  accounts = res.accounts;
  populateAccountDropdowns();
  syncMoveButton();
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
  const confirmMsg = `Move ${sources.length} folder(s) to "${destFolder ? destFolder.name : "selected destination"}"?\n\nThis will copy all messages, then delete the originals.`;
  if (!confirm(confirmMsg)) return;

  // Disable UI
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
    resetUI();
    if ($sourceAccount.value) loadFolderTree($sourceAccount.value, "source");
    if ($destAccount.value) loadFolderTree($destAccount.value, "dest");
  }
}

function resetUI() {
  $btnMove.style.display = "inline-flex";
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
    $btnCancel.style.display = "inline-flex";
    $sourceAccount.disabled = true;
    $destAccount.disabled = true;
    updateProgress(res.progress);
  }
}
