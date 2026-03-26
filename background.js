// ── Bulk Folder Move – Background Script ──
// IMAP→IMAP same-server optimised. Resumable: re-running a migration merges
// into existing folders and skips already-copied messages (Message-ID dedup).

// ─── State ────────────────────────────────────────────────────────────────────
let isProcessing = false;
let shouldCancel = false;
let currentProgress = null;
let processedFolderIds = new Set();

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Open UI Tab on Toolbar Click ─────────────────────────────────────────────
messenger.browserAction.onClicked.addListener(async () => {
  await messenger.tabs.create({ url: "content/index.html" });
});

// ─── Message Router ───────────────────────────────────────────────────────────
messenger.runtime.onMessage.addListener(async (message, _sender) => {
  switch (message.type) {
    case "get-accounts":
      return handleGetAccounts();
    case "get-folders":
      return handleGetFolders(message.accountId);
    case "start-move":
      return handleStartMove(message.sourceFolders, message.destination);
    case "cancel":
      shouldCancel = true;
      return { ok: true };
    case "get-progress":
      return { ok: true, progress: currentProgress, processing: isProcessing };
    default:
      return { ok: false, error: "Unknown message type" };
  }
});

// ─── Account / Folder Discovery ───────────────────────────────────────────────
async function handleGetAccounts() {
  try {
    const accounts = await messenger.accounts.list(false);
    return {
      ok: true,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleGetFolders(accountId) {
  try {
    const account = await messenger.accounts.get(accountId, true);
    if (!account) return { ok: false, error: "Account not found" };

    const flatFolders = [];
    const walk = (folders, depth, parentId) => {
      for (const f of folders) {
        flatFolders.push({
          id: f.id, name: f.name, path: f.path,
          type: f.type, accountId, depth, parentId,
        });
        if (f.subFolders && f.subFolders.length) walk(f.subFolders, depth + 1, f.id);
      }
    };
    walk(account.folders || [], 0, null);
    return { ok: true, folders: flatFolders };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Resolve destination ID ───────────────────────────────────────────────────
function isAccountRoot(id) {
  return typeof id === "string" && id.startsWith("account:");
}
function resolveDestId(destId) {
  return isAccountRoot(destId) ? destId.replace("account:", "") : destId;
}

// ─── Queue Orchestrator ───────────────────────────────────────────────────────
async function handleStartMove(sourceFolders, destination) {
  if (isProcessing)
    return { ok: false, error: "A move operation is already in progress." };

  isProcessing = true;
  shouldCancel = false;
  processedFolderIds = new Set();
  currentProgress = {
    phase: "starting", folder: "",
    copied: 0, total: 0,
    overallDone: 0, overallTotal: sourceFolders.length,
    log: [],
  };

  processQueue(sourceFolders, destination);
  return { ok: true };
}

async function processQueue(sourceFolders, destination) {
  const log = (msg) => { currentProgress.log.push(msg); broadcast(); };
  const broadcast = () => {
    messenger.runtime.sendMessage({
      type: "progress-update",
      progress: { ...currentProgress },
    }).catch(() => {});
  };

  // Migration-wide stats
  const stats = {
    foldersProcessed: 0,
    foldersSkipped: 0,
    foldersFailed: 0,
    foldersDeleted: 0,
    foldersKept: 0,
    messagesCopied: 0,
    messagesDuplicatesRemoved: 0,
    messagesFailed: 0,
    nativeMoves: 0,
  };

  // Store stats on currentProgress so processSingleFolder can update them
  currentProgress.stats = stats;

  try {
    for (let i = 0; i < sourceFolders.length; i++) {
      if (shouldCancel) { log("⚠️ Cancelled by user."); break; }

      const src = sourceFolders[i];

      if (processedFolderIds.has(src.id)) {
        log(`⏭️ Skipping ${src.path} — already processed as a sub-folder.`);
        stats.foldersSkipped++;
        currentProgress.overallDone = i + 1;
        broadcast();
        continue;
      }

      try { await messenger.folders.get(src.id, false); } catch (_e) {
        log(`⏭️ Skipping ${src.path} — folder no longer exists.`);
        stats.foldersSkipped++;
        currentProgress.overallDone = i + 1;
        broadcast();
        continue;
      }

      currentProgress.overallDone = i;
      currentProgress.phase = "processing";
      currentProgress.folder = src.path;
      log(`📂 Processing folder: ${src.path}`);
      broadcast();

      if (i > 0) { log(`   ⏳ Waiting 3s…`); await sleep(3000); }

      try {
        await processSingleFolder(src, destination, log, broadcast);
        log(`✅ Finished: ${src.path}`);
      } catch (err) {
        stats.foldersFailed++;
        log(`❌ Error processing ${src.path}: ${err.message}`);
      }
    }

    // ── Completion Summary ────────────────────────────────────────────────
    log(``);
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    if (shouldCancel) {
      log(`⚠️  MIGRATION CANCELLED`);
    } else if (stats.messagesFailed > 0 || stats.foldersFailed > 0) {
      log(`⚠️  MIGRATION COMPLETED WITH ISSUES`);
    } else {
      log(`✅  MIGRATION COMPLETED SUCCESSFULLY`);
    }
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    log(`   Folders processed:       ${stats.foldersProcessed}`);
    if (stats.nativeMoves > 0)
      log(`   ├─ Native moves:         ${stats.nativeMoves}`);
    log(`   ├─ Deleted from source:  ${stats.foldersDeleted}`);
    if (stats.foldersKept > 0)
      log(`   ├─ Kept (have errors):   ${stats.foldersKept}`);
    if (stats.foldersSkipped > 0)
      log(`   ├─ Skipped (duplicates): ${stats.foldersSkipped}`);
    if (stats.foldersFailed > 0)
      log(`   └─ Failed:               ${stats.foldersFailed}`);
    log(``);
    log(`   Messages copied:         ${stats.messagesCopied}`);
    if (stats.messagesDuplicatesRemoved > 0)
      log(`   ├─ Duplicates cleaned:   ${stats.messagesDuplicatesRemoved}`);
    if (stats.messagesFailed > 0)
      log(`   └─ Failed to copy:       ${stats.messagesFailed}`);
    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    currentProgress.overallDone = sourceFolders.length;
    currentProgress.phase = shouldCancel ? "cancelled" : "done";
    broadcast();
  } catch (err) {
    currentProgress.phase = "error";
    log(`❌ Fatal error: ${err.message}`);
    broadcast();
  } finally {
    isProcessing = false;
  }
}

// ─── Process a Single Folder ──────────────────────────────────────────────────
async function processSingleFolder(src, destination, log, broadcast) {
  processedFolderIds.add(src.id);
  const stats = currentProgress.stats;

  // Pre-mark sub-folders so they don't get double-processed
  try {
    const srcWithSubs = await messenger.folders.get(src.id, true);
    const markSubs = (folders) => {
      for (const f of folders) {
        processedFolderIds.add(f.id);
        if (f.subFolders && f.subFolders.length) markSubs(f.subFolders);
      }
    };
    if (srcWithSubs.subFolders) markSubs(srcWithSubs.subFolders);
  } catch (_e) {}

  const destRef = resolveDestId(destination.id);

  // ── Strategy 1: Native folders.move() ────────────────────────────────────
  // Only works within the same account (IMAP RENAME). Cross-account moves
  // require copy-then-delete, so we skip straight to merge-copy.
  const sameAccount = src.accountId === destination.accountId;

  if (sameAccount) {
    log(`   🚀 Attempting native folder move…`);
    try {
      const movedFolder = await messenger.folders.move(src.id, destRef);

      // Verify move succeeded — folders.move() can return null on some setups
      let sourceStillExists = false;
      try { await messenger.folders.get(src.id, false); sourceStillExists = true; } catch (_e) {}

      if (!sourceStillExists) {
        const displayPath = movedFolder ? movedFolder.path : "(moved)";
        log(`   ✅ Native move succeeded → ${displayPath}`);
        stats.nativeMoves++;
        stats.foldersProcessed++;
        stats.foldersDeleted++;
        return;
      } else if (movedFolder) {
        log(`   ✅ Native move succeeded → ${movedFolder.path}`);
        stats.nativeMoves++;
        stats.foldersProcessed++;
        stats.foldersDeleted++;
        return;
      } else {
        log(`   ⚠️ Native move didn't complete, using merge-copy…`);
      }
    } catch (moveErr) {
      log(`   ⚠️ Native move failed: ${moveErr.message}`);
    }
  }

  stats.foldersProcessed++;
  log(`   🔄 Using merge-copy mode (cross-account)…`);

  // ── Strategy 2: Merge-copy (resumable) ───────────────────────────────────
  // Creates destination if needed, copies only NEW messages (dedup by
  // Message-ID), then cleans up the source.

  const srcFolder = await messenger.folders.get(src.id, false);
  const folderName = srcFolder.name;

  // 2a. Find or create destination folder
  let destFolder = await findExistingFolder(destRef, folderName, destination.id);
  if (destFolder) {
    log(`   📁 Destination folder already exists: ${folderName} (merge mode)`);
  } else {
    try {
      destFolder = await messenger.folders.create(destRef, folderName);
      log(`   📁 Created destination folder: ${folderName}`);
      // Wait for IMAP to register the new folder
      log(`   ⏳ Waiting 5s for IMAP sync…`);
      await sleep(5000);
    } catch (createErr) {
      throw new Error(`Could not create folder "${folderName}": ${createErr.message}`);
    }
  }

  // 2b. Collect source messages
  const sourceMessages = await collectMessages(src.id);
  if (sourceMessages.length === 0) {
    log(`   📧 No messages to process`);
  } else {
    // 2c. Collect existing Message-IDs in destination for dedup
    log(`   🔍 Checking destination for existing messages…`);
    const destMessageIds = await collectMessageIds(destFolder.id);
    log(`   📊 Destination has ${destMessageIds.size} existing message(s)`);

    // 2d. Filter to only new messages
    const newMessages = sourceMessages.filter(
      (m) => !destMessageIds.has(m.headerMessageId)
    );
    const dupeMessages = sourceMessages.filter(
      (m) => destMessageIds.has(m.headerMessageId)
    );

    // Delete duplicates from source — they're confirmed in the destination
    if (dupeMessages.length > 0) {
      log(`   🧹 Deleting ${dupeMessages.length} duplicate(s) from source (already in destination)…`);
      const dupeIds = dupeMessages.map((m) => m.id);
      for (let i = 0; i < dupeIds.length; i += 10) {
        const batch = dupeIds.slice(i, i + 10);
        try {
          await messenger.messages.delete(batch, { deletePermanently: true });
        } catch (_e) {
          for (const id of batch) {
            try { await messenger.messages.delete([id], { deletePermanently: true }); } catch (_e2) {}
          }
        }
      }
      stats.messagesDuplicatesRemoved += dupeMessages.length;
      log(`   ✅ Removed ${dupeMessages.length} duplicate(s) from source`);
    }

    const totalNew = newMessages.length;
    let copiedMessages = 0;
    let skippedMessages = 0;
    currentProgress.total = totalNew;
    currentProgress.copied = 0;
    log(`   📧 ${totalNew} new message(s) to copy`);
    broadcast();

    // 2e. Copy new messages in batches
    const BATCH_SIZE = 10;
    const MAX_RETRIES = 3;

    for (let i = 0; i < newMessages.length; i += BATCH_SIZE) {
      if (shouldCancel) return;
      const batch = newMessages.slice(i, i + BATCH_SIZE);
      const batchIds = batch.map((m) => m.id);
      let batchCopied = false;

      // Try batch copy with retries
      for (let attempt = 1; attempt <= MAX_RETRIES && !batchCopied; attempt++) {
        try {
          await messenger.messages.copy(batchIds, destFolder.id);
          batchCopied = true;
        } catch (err) {
          log(`   ⚠️ Batch copy attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
          if (attempt < MAX_RETRIES) await sleep(2000 * attempt);
        }
      }

      if (batchCopied) {
        // Delete originals
        try {
          await messenger.messages.delete(batchIds, { deletePermanently: true });
        } catch (delErr) {
          log(`   ⚠️ Batch delete failed, trying individually: ${delErr.message}`);
          for (const id of batchIds) {
            try { await messenger.messages.delete([id], { deletePermanently: true }); } catch (_e) {}
          }
        }
        copiedMessages += batch.length;
        stats.messagesCopied += batch.length;
        currentProgress.copied = copiedMessages;
        log(`   📋 Copied ${copiedMessages}/${totalNew} message(s)`);
        broadcast();
        continue;
      }

      // Per-message fallback with getRaw+import
      log(`   🔄 Falling back to per-message transfer…`);
      for (const msg of batch) {
        if (shouldCancel) return;
        let msgCopied = false;

        try {
          await messenger.messages.copy([msg.id], destFolder.id);
          msgCopied = true;
        } catch (_e) {
          try {
            const rawFile = await messenger.messages.getRaw(msg.id, { data_format: "File" });
            await messenger.messages.import(rawFile, destFolder.id);
            msgCopied = true;
            log(`   📨 Message ${msg.id} imported via raw fallback`);
          } catch (importErr) {
            skippedMessages++;
            stats.messagesFailed++;
            log(`   ❌ Skipped message ${msg.id}: ${importErr.message}`);
            continue;
          }
        }

        if (msgCopied) {
          try {
            await messenger.messages.delete([msg.id], { deletePermanently: true });
          } catch (_e) {}
          copiedMessages++;
          stats.messagesCopied++;
          currentProgress.copied = copiedMessages;
          broadcast();
        }
        await sleep(200);
      }
    }

    if (skippedMessages > 0) {
      log(`   ⚠️ ${skippedMessages} message(s) could not be copied and remain in source.`);
    }
  }

  // 2f. Recursively handle sub-folders (merge-capable)
  const srcWithSubs = await messenger.folders.get(src.id, true);
  if (srcWithSubs.subFolders && srcWithSubs.subFolders.length > 0) {
    for (const sub of srcWithSubs.subFolders) {
      if (shouldCancel) return;
      log(`   ↳ Processing sub-folder: ${sub.name}`);
      await processSingleFolder(
        { id: sub.id, path: `${src.path}/${sub.name}`, accountId: src.accountId },
        { id: destFolder.id, accountId: destination.accountId },
        log, broadcast
      );
    }
  }

  // 2g. Delete source folder only if fully emptied
  const remainingCount = await countMessages(src.id);
  if (remainingCount > 0) {
    log(`   ⚠️ Source folder "${folderName}" kept — ${remainingCount} message(s) remain.`);
    stats.foldersKept++;
    return;
  }

  let deleted = false;
  for (let attempt = 1; attempt <= 3 && !deleted; attempt++) {
    try {
      await sleep(2000);
      await messenger.folders.delete(src.id);
      log(`   🗑️ Removed source folder: ${folderName}`);
      stats.foldersDeleted++;
      deleted = true;
    } catch (err) {
      if (attempt < 3) {
        log(`   ⏳ Folder delete attempt ${attempt}/3 failed, retrying…`);
      } else {
        log(`   ⚠️ Could not remove source folder: ${err.message}`);
        log(`   ℹ️ The folder is empty — you can delete it manually.`);
        stats.foldersKept++;
      }
    }
  }
}

// ─── Utility Functions ────────────────────────────────────────────────────────

// Find an existing folder by name under a parent (folder or account root)
async function findExistingFolder(destRef, folderName, rawDestId) {
  try {
    let subs;
    if (isAccountRoot(rawDestId)) {
      const acct = await messenger.accounts.get(destRef, true);
      subs = acct ? acct.folders : [];
    } else {
      const parent = await messenger.folders.get(destRef, true);
      subs = parent.subFolders || [];
    }
    return subs.find((f) => f.name === folderName) || null;
  } catch (_e) {
    return null;
  }
}

// Collect all messages (with headers) from a folder
async function collectMessages(folderId) {
  const messages = [];
  try {
    let page = await messenger.messages.list(folderId);
    messages.push(...page.messages);
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      messages.push(...page.messages);
    }
  } catch (_e) {}
  return messages;
}

// Collect all Message-ID headers from a folder into a Set
async function collectMessageIds(folderId) {
  const ids = new Set();
  try {
    let page = await messenger.messages.list(folderId);
    for (const m of page.messages) {
      if (m.headerMessageId) ids.add(m.headerMessageId);
    }
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      for (const m of page.messages) {
        if (m.headerMessageId) ids.add(m.headerMessageId);
      }
    }
  } catch (_e) {}
  return ids;
}

// Count messages in a folder
async function countMessages(folderId) {
  let count = 0;
  try {
    let page = await messenger.messages.list(folderId);
    count += page.messages.length;
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      count += page.messages.length;
    }
  } catch (_e) {}
  return count;
}
