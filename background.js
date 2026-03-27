// ── Bulk Folder Move – Background Script ──
// IMAP→IMAP cross-account optimised. Resumable with Message-ID dedup.
// Compatible with TB 115+ (no MailFolder.id) and TB 128+ (has MailFolder.id).

// ─── State ────────────────────────────────────────────────────────────────────
let isProcessing = false;
let shouldCancel = false;
let currentProgress = null;
let processedFolderKeys = new Set();

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Generate a stable key for a folder — works on TB 115 (no .id) and TB 128+ (.id)
function folderKey(folder) {
  if (folder.id) return String(folder.id);
  return folder.accountId + ":" + folder.path;
}

// Build a folder reference that works with TB 115+ APIs
// TB 115: APIs accept {accountId, path} objects
// TB 128+: APIs accept MailFolderId strings
function folderRef(folder) {
  if (folder.id) return folder.id;
  return { accountId: folder.accountId, path: folder.path };
}

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
    const walk = (folders, depth, parentKey) => {
      for (const f of folders) {
        const key = folderKey(f);
        flatFolders.push({
          key: key,
          id: f.id || null,
          name: f.name,
          path: f.path,
          type: f.type,
          accountId: f.accountId || accountId,
          depth,
          parentKey,
        });
        if (f.subFolders && f.subFolders.length) {
          walk(f.subFolders, depth + 1, key);
        }
      }
    };
    walk(account.folders || [], 0, null);
    return { ok: true, folders: flatFolders };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Resolve destination ──────────────────────────────────────────────────────
function isAccountRoot(id) {
  return typeof id === "string" && id.startsWith("account:");
}
function resolveDestRef(dest) {
  // dest has: key, accountId, path (and maybe id)
  if (isAccountRoot(dest.key)) {
    return dest.accountId;
  }
  if (dest.id) return dest.id;
  return { accountId: dest.accountId, path: dest.path };
}

// ─── Safely get a folder ──────────────────────────────────────────────────────
async function safeGetFolder(folder, includeSubFolders) {
  try {
    const ref = folder.id ? folder.id : { accountId: folder.accountId, path: folder.path };
    return await messenger.folders.get(ref, includeSubFolders || false);
  } catch (_e) {
    return null;
  }
}

// ─── Queue Orchestrator ───────────────────────────────────────────────────────
async function handleStartMove(sourceFolders, destination) {
  if (isProcessing)
    return { ok: false, error: "A move operation is already in progress." };

  isProcessing = true;
  shouldCancel = false;
  processedFolderKeys = new Set();
  currentProgress = {
    phase: "starting", folder: "",
    copied: 0, total: 0,
    overallDone: 0, overallTotal: sourceFolders.length,
    log: [],
    stats: {
      foldersProcessed: 0, foldersSkipped: 0, foldersFailed: 0,
      foldersDeleted: 0, foldersKept: 0,
      messagesCopied: 0, messagesDuplicatesRemoved: 0, messagesFailed: 0,
      nativeMoves: 0,
    },
  };

  processQueue(sourceFolders, destination);
  return { ok: true };
}

async function processQueue(sourceFolders, destination) {
  const log = (msg) => { currentProgress.log.push(msg); broadcast(); };
  const broadcast = () => {
    messenger.runtime.sendMessage({
      type: "progress-update", progress: { ...currentProgress },
    }).catch(() => {});
  };
  const stats = currentProgress.stats;

  try {
    for (let i = 0; i < sourceFolders.length; i++) {
      if (shouldCancel) { log("⚠️ Cancelled by user."); break; }

      const src = sourceFolders[i];

      if (processedFolderKeys.has(src.key)) {
        log(`⏭️ Skipping ${src.path} — already processed as a sub-folder.`);
        stats.foldersSkipped++;
        currentProgress.overallDone = i + 1;
        broadcast();
        continue;
      }

      // Check folder still exists
      const exists = await safeGetFolder(src, false);
      if (!exists) {
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

    // ── Completion Summary ──────────────────────────────────────────────
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
  const stats = currentProgress.stats;
  processedFolderKeys.add(src.key);

  // Pre-mark sub-folders
  const srcWithSubs = await safeGetFolder(src, true);
  if (srcWithSubs && srcWithSubs.subFolders) {
    const markSubs = (folders) => {
      for (const f of folders) {
        processedFolderKeys.add(folderKey(f));
        if (f.subFolders && f.subFolders.length) markSubs(f.subFolders);
      }
    };
    markSubs(srcWithSubs.subFolders);
  }

  const destRef = resolveDestRef(destination);

  // ── Strategy 1: Native folders.move() ────────────────────────────────────
  const sameAccount = src.accountId === destination.accountId;
  if (sameAccount) {
    log(`   🚀 Attempting native folder move…`);
    try {
      const srcRef = folderRef(src);
      const movedFolder = await messenger.folders.move(srcRef, destRef);
      const sourceGone = !(await safeGetFolder(src, false));

      if (sourceGone) {
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
  log(`   🔄 Using merge-copy mode…`);

  const srcFolder = await safeGetFolder(src, false);
  if (!srcFolder) throw new Error("Source folder disappeared");
  const folderName = srcFolder.name;

  // Find or create destination folder
  let destFolder = await findExistingSubFolder(destRef, folderName, destination);
  if (destFolder) {
    log(`   📁 Destination folder already exists: ${folderName} (merge mode)`);
  } else {
    try {
      destFolder = await messenger.folders.create(destRef, folderName);
      log(`   📁 Created destination folder: ${folderName}`);
      log(`   ⏳ Waiting 5s for IMAP sync…`);
      await sleep(5000);
    } catch (createErr) {
      throw new Error(`Could not create folder "${folderName}": ${createErr.message}`);
    }
  }

  // Collect source messages
  const srcListRef = folderRef(src);
  const sourceMessages = await collectMessages(srcListRef);

  if (sourceMessages.length === 0) {
    log(`   📧 No messages to process`);
  } else {
    // Dedup against destination
    log(`   🔍 Checking destination for existing messages…`);
    const destListRef = folderRef(destFolder);
    const destMessageIds = await collectMessageIds(destListRef);
    log(`   📊 Destination has ${destMessageIds.size} existing message(s)`);

    const newMessages = sourceMessages.filter(
      (m) => !destMessageIds.has(m.headerMessageId)
    );
    const dupeMessages = sourceMessages.filter(
      (m) => destMessageIds.has(m.headerMessageId)
    );

    // Delete duplicates from source
    if (dupeMessages.length > 0) {
      log(`   🧹 Deleting ${dupeMessages.length} duplicate(s) from source…`);
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

    // Copy in batches
    const BATCH_SIZE = 10;
    const MAX_RETRIES = 3;
    const destCopyRef = folderRef(destFolder);

    for (let i = 0; i < newMessages.length; i += BATCH_SIZE) {
      if (shouldCancel) return;
      const batch = newMessages.slice(i, i + BATCH_SIZE);
      const batchIds = batch.map((m) => m.id);
      let batchCopied = false;

      for (let attempt = 1; attempt <= MAX_RETRIES && !batchCopied; attempt++) {
        try {
          await messenger.messages.copy(batchIds, destCopyRef);
          batchCopied = true;
        } catch (err) {
          log(`   ⚠️ Batch copy attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
          if (attempt < MAX_RETRIES) await sleep(2000 * attempt);
        }
      }

      if (batchCopied) {
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

      // Per-message fallback
      log(`   🔄 Falling back to per-message transfer…`);
      for (const msg of batch) {
        if (shouldCancel) return;
        let msgCopied = false;

        try {
          await messenger.messages.copy([msg.id], destCopyRef);
          msgCopied = true;
        } catch (_e) {
          try {
            const rawFile = await messenger.messages.getRaw(msg.id, { data_format: "File" });
            await messenger.messages.import(rawFile, destCopyRef);
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

  // Recursively handle sub-folders
  const srcRefresh = await safeGetFolder(src, true);
  if (srcRefresh && srcRefresh.subFolders && srcRefresh.subFolders.length > 0) {
    for (const sub of srcRefresh.subFolders) {
      if (shouldCancel) return;
      log(`   ↳ Processing sub-folder: ${sub.name}`);
      await processSingleFolder(
        {
          key: folderKey(sub), id: sub.id || null,
          name: sub.name, path: sub.path,
          accountId: sub.accountId || src.accountId,
        },
        {
          key: folderKey(destFolder), id: destFolder.id || null,
          name: destFolder.name, path: destFolder.path,
          accountId: destFolder.accountId || destination.accountId,
        },
        log, broadcast
      );
    }
  }

  // Delete source folder if empty
  const remainingCount = await countMessages(folderRef(src));
  if (remainingCount > 0) {
    log(`   ⚠️ Source folder "${folderName}" kept — ${remainingCount} message(s) remain.`);
    stats.foldersKept++;
    return;
  }

  let deleted = false;
  const srcDelRef = folderRef(src);
  for (let attempt = 1; attempt <= 3 && !deleted; attempt++) {
    try {
      await sleep(2000);
      await messenger.folders.delete(srcDelRef);
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

async function findExistingSubFolder(destRef, folderName, destination) {
  try {
    let subs;
    if (isAccountRoot(destination.key)) {
      const acct = await messenger.accounts.get(destination.accountId, true);
      subs = acct ? acct.folders : [];
    } else {
      const ref = destination.id ? destination.id : { accountId: destination.accountId, path: destination.path };
      const parent = await messenger.folders.get(ref, true);
      subs = parent.subFolders || [];
    }
    return subs.find((f) => f.name === folderName) || null;
  } catch (_e) {
    return null;
  }
}

async function collectMessages(ref) {
  const messages = [];
  try {
    let page = await messenger.messages.list(ref);
    messages.push(...page.messages);
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      messages.push(...page.messages);
    }
  } catch (_e) {}
  return messages;
}

async function collectMessageIds(ref) {
  const ids = new Set();
  try {
    let page = await messenger.messages.list(ref);
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

async function countMessages(ref) {
  let count = 0;
  try {
    let page = await messenger.messages.list(ref);
    count += page.messages.length;
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      count += page.messages.length;
    }
  } catch (_e) {}
  return count;
}
