// ── Bulk Folder Move – Background Script ──
// Manages the processing queue and communicates progress to the UI tab.

// ─── State ────────────────────────────────────────────────────────────────────
let isProcessing = false;
let shouldCancel = false;
let currentProgress = null;

// Track which folder IDs have already been processed (to avoid duplicates)
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
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
      })),
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
    const walk = (folders, depth) => {
      for (const f of folders) {
        flatFolders.push({
          id: f.id,
          name: f.name,
          path: f.path,
          type: f.type,
          accountId,
          depth,
        });
        if (f.subFolders && f.subFolders.length) {
          walk(f.subFolders, depth + 1);
        }
      }
    };
    walk(account.folders || [], 0);
    return { ok: true, folders: flatFolders };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Queue-based Move Logic ───────────────────────────────────────────────────
async function handleStartMove(sourceFolders, destination) {
  if (isProcessing)
    return { ok: false, error: "A move operation is already in progress." };

  isProcessing = true;
  shouldCancel = false;
  processedFolderIds = new Set();
  currentProgress = {
    phase: "starting",
    folder: "",
    copied: 0,
    total: 0,
    overallDone: 0,
    overallTotal: sourceFolders.length,
    log: [],
  };

  // Run asynchronously so the UI gets status immediately
  processQueue(sourceFolders, destination);
  return { ok: true };
}

async function processQueue(sourceFolders, destination) {
  const log = (msg) => {
    currentProgress.log.push(msg);
    broadcast();
  };

  const broadcast = () => {
    messenger.runtime.sendMessage({
      type: "progress-update",
      progress: { ...currentProgress },
    }).catch(() => {}); // UI tab might be closed
  };

  try {
    for (let i = 0; i < sourceFolders.length; i++) {
      if (shouldCancel) {
        log("⚠️ Cancelled by user.");
        break;
      }

      const src = sourceFolders[i];

      // Skip if this folder was already processed as a sub-folder of a parent
      if (processedFolderIds.has(src.id)) {
        log(`⏭️ Skipping ${src.path} — already processed as a sub-folder.`);
        currentProgress.overallDone = i + 1;
        broadcast();
        continue;
      }

      // Check the folder still exists before processing
      try {
        await messenger.folders.get(src.id, false);
      } catch (_e) {
        log(`⏭️ Skipping ${src.path} — folder no longer exists (already moved).`);
        currentProgress.overallDone = i + 1;
        broadcast();
        continue;
      }

      currentProgress.overallDone = i;
      currentProgress.phase = "processing";
      currentProgress.folder = src.path;
      log(`📂 Processing folder: ${src.path}`);
      broadcast();

      // Cooldown between folders to let IMAP connections stabilise
      if (i > 0) {
        log(`   ⏳ Waiting 3s for server connections to stabilise…`);
        await sleep(3000);
      }

      try {
        await processSingleFolder(src, destination, log, broadcast);
        log(`✅ Finished: ${src.path}`);
      } catch (err) {
        log(`❌ Error processing ${src.path}: ${err.message}`);
      }
    }

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

async function processSingleFolder(src, destination, log, broadcast) {
  processedFolderIds.add(src.id);

  // 1. Create the folder in the destination
  let destFolder;
  const srcFolder = await messenger.folders.get(src.id, false);
  const folderName = srcFolder.name;

  try {
    destFolder = await messenger.folders.create(destination.id, folderName);
    log(`   📁 Created destination folder: ${folderName}`);
  } catch (err) {
    // Folder may already exist — try to find it
    const destParent = await messenger.folders.get(destination.id, true);
    const existing = (destParent.subFolders || []).find(
      (f) => f.name === folderName
    );
    if (existing) {
      destFolder = existing;
      log(`   📁 Destination folder already exists: ${folderName}`);
    } else {
      throw new Error(`Could not create folder "${folderName}": ${err.message}`);
    }
  }

  // 2. Collect all message IDs first
  const allMessageIds = [];
  let page = await messenger.messages.list(src.id);
  for (const m of page.messages) allMessageIds.push(m.id);
  while (page.id) {
    page = await messenger.messages.continueList(page.id);
    for (const m of page.messages) allMessageIds.push(m.id);
  }

  const totalMessages = allMessageIds.length;
  let copiedMessages = 0;
  let skippedMessages = 0;
  currentProgress.total = totalMessages;
  currentProgress.copied = 0;
  log(`   📧 Found ${totalMessages} message(s) to process`);
  broadcast();

  // 3. Copy and delete in small batches with retry + getRaw/import fallback
  const BATCH_SIZE = 10;
  const MAX_RETRIES = 3;

  for (let i = 0; i < allMessageIds.length; i += BATCH_SIZE) {
    if (shouldCancel) return;
    const batch = allMessageIds.slice(i, i + BATCH_SIZE);
    let batchCopied = false;

    // Attempt A: batch copy via messenger.messages.copy
    for (let attempt = 1; attempt <= MAX_RETRIES && !batchCopied; attempt++) {
      try {
        await messenger.messages.copy(batch, destFolder.id);
        batchCopied = true;
      } catch (err) {
        log(`   ⚠️ Batch copy attempt ${attempt}/${MAX_RETRIES} failed (${batch.length} msgs): ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await sleep(2000 * attempt);
        }
      }
    }

    if (batchCopied) {
      // Batch copy succeeded — now delete originals
      try {
        await messenger.messages.delete(batch, { deletePermanently: true });
      } catch (delErr) {
        log(`   ⚠️ Batch delete failed, trying individually: ${delErr.message}`);
        for (const msgId of batch) {
          try { await messenger.messages.delete([msgId], { deletePermanently: true }); } catch (_e) { /* best effort */ }
        }
      }
      copiedMessages += batch.length;
      currentProgress.copied = copiedMessages;
      log(`   📋 Copied ${copiedMessages}/${totalMessages} message(s)`);
      broadcast();
      continue;
    }

    // Attempt B: per-message using getRaw + import as ultimate fallback
    log(`   🔄 Falling back to per-message transfer…`);
    for (const msgId of batch) {
      if (shouldCancel) return;
      let msgCopied = false;

      // B1: Try single-message copy first
      try {
        await messenger.messages.copy([msgId], destFolder.id);
        msgCopied = true;
      } catch (_e) {
        // B2: Fall back to getRaw + import
        try {
          const rawFile = await messenger.messages.getRaw(msgId, { data_format: "File" });
          await messenger.messages.import(rawFile, destFolder.id);
          msgCopied = true;
          log(`   📨 Message ${msgId} imported via raw fallback`);
        } catch (importErr) {
          skippedMessages++;
          log(`   ❌ Skipped message ${msgId}: ${importErr.message}`);
          continue;
        }
      }

      if (msgCopied) {
        try {
          await messenger.messages.delete([msgId], { deletePermanently: true });
        } catch (delErr) {
          log(`   ⚠️ Could not delete source message ${msgId}: ${delErr.message}`);
        }
        copiedMessages++;
        currentProgress.copied = copiedMessages;
        broadcast();
      }

      // Small delay between individual messages to avoid hammering the server
      await sleep(200);
    }
  }

  if (skippedMessages > 0) {
    log(`   ⚠️ ${skippedMessages} message(s) could not be copied and were left in the source folder.`);
  }

  // 4. Recursively handle sub-folders
  const srcWithSubs = await messenger.folders.get(src.id, true);
  if (srcWithSubs.subFolders && srcWithSubs.subFolders.length > 0) {
    for (const sub of srcWithSubs.subFolders) {
      if (shouldCancel) return;
      log(`   ↳ Processing sub-folder: ${sub.name}`);
      await processSingleFolder(
        { id: sub.id, path: `${src.path}/${sub.name}`, accountId: src.accountId },
        { id: destFolder.id, accountId: destination.accountId },
        log,
        broadcast
      );
    }
  }

  // 5. Delete the now-empty source folder (only if no messages were skipped)
  if (skippedMessages === 0) {
    try {
      await messenger.folders.delete(src.id);
      log(`   🗑️ Removed source folder: ${folderName}`);
    } catch (err) {
      log(`   ⚠️ Could not remove source folder: ${err.message}`);
    }
  } else {
    log(`   ⚠️ Source folder "${folderName}" kept — it still has ${skippedMessages} message(s) that couldn't be moved.`);
  }
}
