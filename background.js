// ── Bulk Folder Move – Background Script ──
// Manages the processing queue and communicates progress to the UI tab.

// ─── State ────────────────────────────────────────────────────────────────────
let isProcessing = false;
let shouldCancel = false;
let currentProgress = null; // { phase, folder, copied, total, overallDone, overallTotal, log }

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
      // message.sourceFolders = [ { id, path, accountId } , … ]
      // message.destination   = { id, accountId }  (MailFolderId or root account)
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

    // Flatten the folder tree
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
    });
  };

  try {
    for (let i = 0; i < sourceFolders.length; i++) {
      if (shouldCancel) {
        log("⚠️ Cancelled by user.");
        break;
      }

      const src = sourceFolders[i];
      currentProgress.overallDone = i;
      currentProgress.phase = "processing";
      currentProgress.folder = src.path;
      log(`📂 Processing folder: ${src.path}`);
      broadcast();

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
  log(`   📧 Found ${totalMessages} message(s) to copy`);
  broadcast();

  // 3. Copy and delete in small batches with retry + per-message fallback
  const BATCH_SIZE = 10;
  const MAX_RETRIES = 3;

  for (let i = 0; i < allMessageIds.length; i += BATCH_SIZE) {
    if (shouldCancel) return;
    const batch = allMessageIds.slice(i, i + BATCH_SIZE);
    let copied = false;

    // Try the batch as a whole, with retries
    for (let attempt = 1; attempt <= MAX_RETRIES && !copied; attempt++) {
      try {
        await messenger.messages.copy(batch, destFolder.id);
        copied = true;
      } catch (err) {
        log(`   ⚠️ Batch copy attempt ${attempt}/${MAX_RETRIES} failed (${batch.length} msgs): ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await sleep(1000 * attempt); // backoff
        }
      }
    }

    if (!copied) {
      // Fallback: copy one message at a time so one bad message doesn't block everything
      log(`   🔄 Falling back to per-message copy for this batch…`);
      for (const msgId of batch) {
        if (shouldCancel) return;
        try {
          await messenger.messages.copy([msgId], destFolder.id);
        } catch (err) {
          skippedMessages++;
          log(`   ❌ Skipped message ${msgId}: ${err.message}`);
          continue; // skip delete for this message too
        }
        // Delete only the successfully copied message
        try {
          await messenger.messages.delete([msgId], true);
        } catch (delErr) {
          log(`   ⚠️ Could not delete source message ${msgId}: ${delErr.message}`);
        }
        copiedMessages++;
        currentProgress.copied = copiedMessages;
        broadcast();
      }
      continue; // skip the bulk delete below
    }

    // Bulk delete the batch after successful copy
    try {
      await messenger.messages.delete(batch, true);
    } catch (delErr) {
      log(`   ⚠️ Batch delete failed, trying individually: ${delErr.message}`);
      for (const msgId of batch) {
        try { await messenger.messages.delete([msgId], true); } catch (_e) { /* best effort */ }
      }
    }

    copiedMessages += batch.length;
    currentProgress.copied = copiedMessages;
    log(`   📋 Copied ${copiedMessages}/${totalMessages} message(s)`);
    broadcast();
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

  // 5. Delete the now-empty source folder
  try {
    await messenger.folders.delete(src.id);
    log(`   🗑️ Removed source folder: ${folderName}`);
  } catch (err) {
    log(`   ⚠️ Could not remove source folder: ${err.message}`);
  }
}
