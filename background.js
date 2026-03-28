// ── Bulk Folder Move – Background Script ──
// *** CRITICAL ARCHITECTURAL CONSTRAINT ***
// Do not attempt to clear the Error Console deprecation warnings by refactoring
// "MailFolder" objects into "MailFolderId" strings for APIs like folders.create() 
// or messages.list(). This script enforces strict backward compatibility for older
// Thunderbird clients running on Windows 7, which CANNOT parse the modern ID format.
// Always pass the raw, full MailFolder object to ensure cross-platform runtime safety.
// 
// Compatible with TB 115+ and TB 121+.
// Uses account tree walking to find real MailFolder objects on older TB versions.
// ─── State ────────────────────────────────────────────────────────────────────
let isProcessing = false;
let shouldCancel = false;
let currentProgress = null;
let processedFolderKeys = new Set();
let skipCurrentFolderRequested = false;
let skipCurrentMessageRequested = false;
let foldersCompletedCount = 0;
let currentSkipReject = null;

// ─── API Detection ────────────────────────────────────────────────────────────
const HAS_FOLDER_GET = typeof messenger.folders.get === "function";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Timeout wrapper — rejects if promise doesn't resolve within ms
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let timeoutId;
    
    // Register global skip handler for this promise
    const onSkip = (reason) => {
      clearTimeout(timeoutId);
      currentSkipReject = null;
      reject(new Error(reason || "Skipped by user"));
    };
    currentSkipReject = onSkip;

    timeoutId = setTimeout(() => {
      if (currentSkipReject === onSkip) currentSkipReject = null;
      reject(new Error(`Timed out after ${ms / 1000}s: ${label}`));
    }, ms);

    promise.then(
      (res) => {
        clearTimeout(timeoutId);
        if (currentSkipReject === onSkip) currentSkipReject = null;
        resolve(res);
      },
      (err) => {
        clearTimeout(timeoutId);
        if (currentSkipReject === onSkip) currentSkipReject = null;
        reject(err);
      }
    );
  });
}

// Timeout wrapper with progress logging — emits a heartbeat every intervalMs
function withTimeoutProgress(promise, ms, label, logFn, intervalMs = 120000) {
  return new Promise((resolve, reject) => {
    let elapsed = 0;
    const intervalId = setInterval(() => {
      elapsed += intervalMs;
      if (logFn) logFn(`   ⏳ Still processing: ${label}... (${elapsed / 1000}s elapsed, awaiting server)`);
    }, intervalMs);

    withTimeout(promise, ms, label).then(
      (result) => {
        clearInterval(intervalId);
        resolve(result);
      },
      (error) => {
        clearInterval(intervalId);
        reject(error);
      }
    );
  });
}

// TB 115: messages.delete(ids, skipTrash) — boolean
// TB 121+: messages.delete(ids, {deletePermanently}) — object
async function deleteMessages(ids) {
  try {
    await withTimeout(
      messenger.messages.delete(ids, { deletePermanently: true }),
      30000, "messages.delete"
    );
  } catch (_e) {
    await withTimeout(
      messenger.messages.delete(ids, true),
      30000, "messages.delete"
    );
  }
}

// Stable key for a folder — works on all TB versions
function folderKey(folder) {
  if (folder.id) return String(folder.id);
  return (folder.accountId || "") + ":" + (folder.path || "");
}

// ─── Folder Lookup (TB 115 compatible) ────────────────────────────────────────
// Walks the account tree via accounts.get() to find the real MailFolder object.
// This works on ALL TB versions, unlike folders.get() which needs TB 121+.

async function lookupFolder(accountId, path, includeSubFolders) {
  try {
    const account = await withTimeout(
      messenger.accounts.get(accountId, true),
      15000, "accounts.get"
    );
    if (!account || !account.folders) return null;

    const found = walkFind(account.folders, path);
    if (!found) return null;

    return found;
  } catch (_e) {
    return null;
  }
}

function walkFind(folders, targetPath) {
  for (const f of folders) {
    if (f.path === targetPath) return f;
    if (f.subFolders && f.subFolders.length) {
      const found = walkFind(f.subFolders, targetPath);
      if (found) return found;
    }
  }
  return null;
}

// Get a real MailFolder object — works on TB 115 and TB 121+
async function getFolder(accountId, path) {
  if (HAS_FOLDER_GET) {
    try {
      // TB 121+: try folders.get() with {accountId, path} or id
      return await messenger.folders.get({ accountId, path }, true);
    } catch (_e) {
      // Fall back to tree walk
    }
  }
  return await lookupFolder(accountId, path, true);
}

// Get a folder ref suitable for API calls (create, move, delete, messages.list)
// On TB 115: must pass real MailFolder object
// On TB 121+: can pass MailFolderId string or MailFolder object
async function getFolderRef(accountId, path) {
  return await lookupFolder(accountId, path, false);
}

// ─── Open UI Tab ──────────────────────────────────────────────────────────────
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
    case "skip-folder":
      skipCurrentFolderRequested = true;
      if (currentSkipReject) currentSkipReject("Folder skipped by user");
      return { ok: true };
    case "skip-message":
      skipCurrentMessageRequested = true;
      if (currentSkipReject) currentSkipReject("Message skipped by user");
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
          key,
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

// ─── Queue Orchestrator ───────────────────────────────────────────────────────
async function handleStartMove(sourceFolders, destination) {
  if (isProcessing)
    return { ok: false, error: "A move operation is already in progress." };

  isProcessing = true;
  shouldCancel = false;
  skipCurrentFolderRequested = false;
  skipCurrentMessageRequested = false;
  foldersCompletedCount = 0;
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
        continue;
      }

      // Verify folder exists by looking it up in the account tree
      const realFolder = await lookupFolder(src.accountId, src.path, false);
      if (!realFolder) {
        log(`⏭️ Skipping ${src.path} — folder no longer exists.`);
        foldersCompletedCount++;
        currentProgress.overallDone = foldersCompletedCount;
        broadcast();
        continue;
      }

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

    // ── Summary ─────────────────────────────────────────────────────────
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
      log(`   ├─ Skipped:              ${stats.foldersSkipped}`);
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

  // Get real MailFolder objects from the account tree
  const realSrc = await lookupFolder(src.accountId, src.path, true);
  if (!realSrc) throw new Error(`Source folder not found: ${src.path}`);

  // Pre-mark sub-folders
  if (realSrc.subFolders) {
    const markSubs = (folders) => {
      for (const f of folders) {
        processedFolderKeys.add(folderKey(f));
        if (f.subFolders && f.subFolders.length) markSubs(f.subFolders);
      }
    };
    markSubs(realSrc.subFolders);
  }

  // Resolve destination — get real MailFolder or account object
  const isAcctRoot = destination.key && destination.key.startsWith("account:");
  let realDest;
  if (isAcctRoot) {
    // For account root, pass the account itself as destination
    realDest = await withTimeout(messenger.accounts.get(destination.accountId, false), 15000, "accounts.get");
    if (!realDest) throw new Error("Destination account not found");
  } else {
    realDest = await lookupFolder(destination.accountId, destination.path, true);
    if (!realDest) throw new Error(`Destination folder not found: ${destination.path}`);
  }

  // ── Strategy 1: Native folders.move() (same account only) ────────────
  const sameAccount = src.accountId === destination.accountId;
  if (sameAccount) {
    log(`   🚀 Attempting native folder move…`);
    try {
      const movedFolder = await withTimeout(messenger.folders.move(realSrc, realDest), 120000, "folders.move");

      // Verify source is gone
      const srcCheck = await lookupFolder(src.accountId, src.path, false);
      if (!srcCheck) {
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
      if (moveErr.message === "Folder skipped by user") {
         log(`   ⏭️ Native move skipped by user. Skipping folder entirely…`);
         skipCurrentFolderRequested = false; // consume
         return;
      }
      const isTimeout = moveErr.message && moveErr.message.includes("Timed out");
      if (isTimeout) {
        log(`   ⚠️ Native move timed out. Waiting 10s for server to settle before merge-copy…`);
        await sleep(10000);
      } else {
        log(`   ⚠️ Native move failed: ${moveErr.message}`);
      }
    }
  }

  stats.foldersProcessed++;
  log(`   🔄 Using merge-copy mode…`);

  let folderName = realSrc.name;
  
  // Sanitize illegal characters for Exchange Online / IMAP
  // Exchange forbids: < > : " / \ | ? *
  folderName = folderName.replace(/[<>:"/\\|?*]/g, '-').trim();
  // Find or create destination sub-folder
  let destSubFolder = null;

  // Check if it already exists under the destination
  if (isAcctRoot) {
    const acct = await withTimeout(messenger.accounts.get(destination.accountId, true), 15000, "accounts.get");
    destSubFolder = (acct.folders || []).find((f) => f.name === folderName) || null;
  } else {
    // Re-fetch dest with subFolders
    const destRefresh = await lookupFolder(destination.accountId, destination.path, true);
    if (destRefresh && destRefresh.subFolders) {
      destSubFolder = destRefresh.subFolders.find((f) => f.name === folderName) || null;
    }
  }

  if (destSubFolder) {
    log(`   📁 Destination folder already exists: ${folderName} (merge mode)`);
  } else {
    try {
      destSubFolder = await withTimeout(messenger.folders.create(realDest, folderName), 15000, "folders.create");
      log(`   📁 Created destination folder: ${folderName}`);
      log(`   ⏳ Waiting 5s for IMAP sync…`);
      await sleep(5000);
    } catch (createErr) {
      // Maybe it was created between our check and now
      if (isAcctRoot) {
        const acct = await withTimeout(messenger.accounts.get(destination.accountId, true), 15000, "accounts.get");
        destSubFolder = (acct.folders || []).find((f) => f.name === folderName) || null;
      }
      if (!destSubFolder) {
        throw new Error(`Could not create folder "${folderName}": ${createErr.message}`);
      }
      log(`   📁 Destination folder already exists: ${folderName} (merge mode)`);
    }
  }

  // Collect source messages — pass real MailFolder to messages.list()
  let sourceMessages = await collectMessages(realSrc);

  const ghostMessages = sourceMessages.filter((m) => !m.size || m.size === 0);
  if (ghostMessages.length > 0) {
    log(`   👻 Found ${ghostMessages.length} corrupted 0-byte ghost message(s). Deleting from source safely…`);
    const ghostIds = ghostMessages.map((m) => m.id);
    for (let i = 0; i < ghostIds.length; i += 10) {
      const gBatch = ghostIds.slice(i, i + 10);
      try { await deleteMessages(gBatch); } catch (_g) {}
    }
    // Remove ghosts from our processing pipeline
    sourceMessages = sourceMessages.filter((m) => m.size > 0);
  }

  if (sourceMessages.length === 0) {
    log(`   📧 No messages to process`);
  } else {
    // Dedup against destination
    log(`   🔍 Checking destination for existing messages…`);
    const destMessageIds = await collectMessageIds(destSubFolder);
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
          await deleteMessages(batch);
        } catch (_e) {
          for (const id of batch) {
            try { await deleteMessages([id]); } catch (_e2) {}
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

    // Copy in batches with dynamic timeouts based on 1Mb/s downlink/uplink expectations
    // 1Mb/s ~= 7.5MB per minute. Base timeout = 5m (37.5MB), increased linearly max 15m.
    const BATCH_SIZE = 10;
    const RAMP_DELAYS = [10000, 20000, 30000, 60000, 90000, 90000];

    function calcBatchTimeout(msgs) {
      const totalBytes = msgs.reduce((sum, m) => sum + (m.size || 0), 0);
      const totalMB = totalBytes / (1024 * 1024);
      const extraMB = Math.max(0, totalMB - 37.5);
      // 300,000ms base (5 min) + 60,000ms per 7.5MB extra. Cap at 900,000 (15 min)
      return Math.min(300000 + Math.ceil(extraMB / 7.5) * 60000, 900000);
    }

    function calcMessageTimeout(msg) {
      const mb = (msg.size || 0) / (1024 * 1024);
      return Math.min(60000 + (mb * 10000), 900000);
    }

    for (let i = 0; i < newMessages.length; i += BATCH_SIZE) {
      if (shouldCancel) return;
      if (skipCurrentFolderRequested) break;
      const batch = newMessages.slice(i, i + BATCH_SIZE);
      const batchIds = batch.map((m) => m.id);
      let batchCopied = false;

      const batchTimeout = calcBatchTimeout(batch);
      const batchTimeoutSec = Math.round(batchTimeout / 1000);
      const batchSizeMb = (batch.reduce((sum, m) => sum + (m.size || 0), 0) / (1024 * 1024)).toFixed(2);

      log(`   📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} messages, ~${batchSizeMb} MB). Allocated timeout: ${batchTimeoutSec}s...`);
      broadcast();

      try {
        await withTimeoutProgress(messenger.messages.copy(batchIds, destSubFolder), batchTimeout, "messages.copy batch", log);
        batchCopied = true;
      } catch (err) {
        if (err.message === "Folder skipped by user") {
           skipCurrentFolderRequested = true;
        } else if (err.message === "Message skipped by user") {
           skipCurrentMessageRequested = false;
           skippedMessages += batch.length;
           stats.messagesFailed += batch.length;
           log(`   ⏭️ Skipped batch by user request`);
           continue;
        } else {
           log(`   ⚠️ Batch copy failed (${err.message}). Instant fallback to per-message…`);
        }
      }

      if (skipCurrentFolderRequested) break;

      if (batchCopied) {
        try {
          await deleteMessages(batchIds);
        } catch (delErr) {
          log(`   ⚠️ Batch delete failed, trying individually: ${delErr.message}`);
          for (const id of batchIds) {
            try { await deleteMessages([id]); } catch (_e) {}
          }
        }
        copiedMessages += batch.length;
        stats.messagesCopied += batch.length;
        currentProgress.copied = copiedMessages;
        log(`   📋 Copied ${copiedMessages}/${totalNew} message(s)`);
        broadcast();
        continue;
      }

      // ── Batch failed — fall back to per-message with dynamic timeouts ──

      // Fix 2: Re-scan destination to detect phantom copies
      log(`   🔍 Re-scanning destination for phantom copies…`);
      const arrivedIds = await collectMessageIds(destSubFolder);
      let phantomCount = 0;
      const remainingBatch = [];
      for (const msg of batch) {
        if (msg.headerMessageId && arrivedIds.has(msg.headerMessageId)) {
          // Phantom copy — message arrived despite timeout
          phantomCount++;
          try { await deleteMessages([msg.id]); } catch (_e) {}
          copiedMessages++;
          stats.messagesCopied++;
        } else {
          remainingBatch.push(msg);
        }
      }
      if (phantomCount > 0) {
        log(`   📋 ${phantomCount} message(s) arrived despite timeout — cleaned from source`);
        currentProgress.copied = copiedMessages;
        broadcast();
      }

      if (remainingBatch.length === 0) {
        log(`   📋 Copied ${copiedMessages}/${totalNew} message(s)`);
        broadcast();
        continue;
      }

      // Per-message fallback with individual dynamic timeouts
      log(`   🔄 Falling back to per-message transfer (${remainingBatch.length} remaining)…`);

      for (const msg of remainingBatch) {
        if (shouldCancel) return;
        if (skipCurrentFolderRequested) break;
        let msgCopied = false;
        const msgTimeout = calcMessageTimeout(msg);
        const msgTimeoutSec = Math.round(msgTimeout / 1000);
        const msgSizeMb = ((msg.size || 0) / (1024 * 1024)).toFixed(2);

        log(`   🐌 Attempting single message transfer (Msg ${remainingBatch.indexOf(msg) + 1}/${remainingBatch.length}, ~${msgSizeMb} MB). Allocated timeout: ${msgTimeoutSec}s...`);
        broadcast();

        try {
          await withTimeoutProgress(messenger.messages.copy([msg.id], destSubFolder), msgTimeout, "messages.copy single", log);
          msgCopied = true;
        } catch (copyErr) {
          if (copyErr.message === "Folder skipped by user") {
             skipCurrentFolderRequested = true;
             break;
          } else if (copyErr.message === "Message skipped by user" || skipCurrentMessageRequested) {
             skipCurrentMessageRequested = false;
             skippedMessages++;
             stats.messagesFailed++;
             log(`   ⏭️ Skipped message ${msg.id} by user request`);
             continue; // to next msg
          }
          if (copyErr.message && copyErr.message.includes("already contains")) {
            log(`   ✅ Message ${msg.id} already in destination — cleaning source`);
            msgCopied = true;
          } else {
            const isTimeout = copyErr.message && copyErr.message.includes("Timed out");
            
            if (isTimeout) {
              log(`   ⚠️ Single message timed out (${msgTimeoutSec}s). Likely phantom copying in background.`);
              const arrivedMsgs = await collectMessageIds(destSubFolder);
              if (msg.headerMessageId && arrivedMsgs.has(msg.headerMessageId)) {
                log(`   ✅ Message ${msg.id} phantom copied successfully.`);
                msgCopied = true;
              }
            } else {
              // EXPLICIT FAILURE - Ramped Retry for EWS / Connection recovery
              log(`   ⚠️ Explicit Failure on message ${msg.id}: ${copyErr.message}. Initiating Ramped Retry…`);
              
              for (let r = 0; r < RAMP_DELAYS.length && !msgCopied; r++) {
                if (shouldCancel) return;
                if (skipCurrentFolderRequested) break;
                if (skipCurrentMessageRequested) {
                   skipCurrentMessageRequested = false;
                   break;
                }
                const waitSec = RAMP_DELAYS[r] / 1000;
                log(`   ⏳ Throttling recovery: Waiting ${waitSec}s before retry (attempt ${r + 1}/${RAMP_DELAYS.length})…`);
                await sleep(RAMP_DELAYS[r]);

                try {
                  await withTimeoutProgress(messenger.messages.copy([msg.id], destSubFolder), msgTimeout, `messages.copy single retry`, log);
                  msgCopied = true;
                  log(`   ✅ Message ${msg.id} successfully copied after throttling recovery.`);
                } catch (retryErr) {
                  if (retryErr.message === "Folder skipped by user") {
                     skipCurrentFolderRequested = true; 
                     break;
                  }
                  if (retryErr.message === "Message skipped by user") {
                     skipCurrentMessageRequested = false;
                     break; 
                  }
                  if (retryErr.message && retryErr.message.includes("already contains")) {
                     msgCopied = true;
                  }
                }
              }
              
              if (skipCurrentFolderRequested) break;
              if (skipCurrentMessageRequested) {
                 skipCurrentMessageRequested = false;
                 skippedMessages++;
                 stats.messagesFailed++;
                 log(`   ⏭️ Skipped message ${msg.id} during retry`);
                 continue; // to next msg
              }
            }

            // Message permanently failed after ramped retry
            if (!msgCopied && !skipCurrentFolderRequested) {
              skippedMessages++;
              stats.messagesFailed++;
              const subjInfo = msg.subject ? ` (Subject: "${msg.subject}")` : "";
              log(`   ❌ Permanent failure on message ${msg.id}${subjInfo}: Failed after all retries.`);
            }
          }
        }

        if (msgCopied) {
          try {
            await deleteMessages([msg.id]);
          } catch (_e) {}
          copiedMessages++;
          stats.messagesCopied++;
          currentProgress.copied = copiedMessages;
          broadcast();
        }
        await sleep(200);
      }

      log(`   📋 Copied ${copiedMessages}/${totalNew} message(s)`);
      broadcast();
    }

    if (skipCurrentFolderRequested) {
       log(`   ⏭️ Skipping remaining messages in folder "${folderName}"`);
       skipCurrentFolderRequested = false; // consume it
    }

    if (skippedMessages > 0) {
      log(`   ⚠️ ${skippedMessages} message(s) could not be copied and remain in source.`);
    }
  }

  foldersCompletedCount++;
  // We cap at overallTotal, or update overallTotal if it was exceeded. Usually capped is fine.
  currentProgress.overallTotal = Math.max(currentProgress.overallTotal, foldersCompletedCount);
  currentProgress.overallDone = foldersCompletedCount;
  broadcast();

  // Recursively handle sub-folders
  // Re-fetch source to get current sub-folders
  const srcRefresh = await lookupFolder(src.accountId, src.path, true);
  if (srcRefresh && srcRefresh.subFolders && srcRefresh.subFolders.length > 0) {
    for (const sub of srcRefresh.subFolders) {
      if (shouldCancel) return;
      log(`   ↳ Processing sub-folder: ${sub.name}`);
      await processSingleFolder(
        {
          key: folderKey(sub),
          name: sub.name,
          path: sub.path,
          accountId: sub.accountId || src.accountId,
        },
        {
          key: folderKey(destSubFolder),
          name: destSubFolder.name,
          path: destSubFolder.path,
          accountId: destSubFolder.accountId || destination.accountId,
        },
        log, broadcast
      );
    }
  }

  // Delete source folder if empty AND has no remaining sub-folders
  // Re-check — the realSrc we got earlier might be stale
  const srcRecheck = await lookupFolder(src.accountId, src.path, true);
  if (!srcRecheck) {
    // Already gone
    stats.foldersDeleted++;
    return;
  }

  const freshCount = await countMessages(srcRecheck);
  const remainingSubFolders = srcRecheck.subFolders ? srcRecheck.subFolders.length : 0;

  if (freshCount > 0 || remainingSubFolders > 0) {
    const reasons = [];
    if (freshCount > 0) reasons.push(`${freshCount} message(s)`);
    if (remainingSubFolders > 0) reasons.push(`${remainingSubFolders} sub-folder(s)`);
    log(`   ⚠️ Source folder "${folderName}" kept — ${reasons.join(" and ")} remain.`);
    stats.foldersKept++;
    return;
  }

  let deleted = false;
  for (let attempt = 1; attempt <= 3 && !deleted; attempt++) {
    try {
      await sleep(2000);
      // Re-lookup the folder fresh for delete (stale refs can fail)
      const toDelete = await lookupFolder(src.accountId, src.path, false);
      if (!toDelete) { deleted = true; break; }
      await withTimeout(messenger.folders.delete(toDelete), 15000, "folders.delete");
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

// Collect all messages from a folder (pass real MailFolder object)
async function collectMessages(mailFolder) {
  const messages = [];
  let page = await withTimeout(messenger.messages.list(mailFolder), 60000, "messages.list");
  messages.push(...page.messages);
  while (page.id) {
    page = await withTimeout(messenger.messages.continueList(page.id), 60000, "messages.continueList");
    messages.push(...page.messages);
  }
  return messages;
}

// Collect Message-ID headers from a folder
async function collectMessageIds(mailFolder) {
  const ids = new Set();
  let page = await withTimeout(messenger.messages.list(mailFolder), 60000, "messages.list");
  for (const m of page.messages) {
    if (m.headerMessageId) ids.add(m.headerMessageId);
  }
  while (page.id) {
    page = await withTimeout(messenger.messages.continueList(page.id), 60000, "messages.continueList");
    for (const m of page.messages) {
      if (m.headerMessageId) ids.add(m.headerMessageId);
    }
  }
  return ids;
}

// Count messages in a folder
async function countMessages(mailFolder) {
  let count = 0;
  let page = await withTimeout(messenger.messages.list(mailFolder), 60000, "messages.list");
  count += page.messages.length;
  while (page.id) {
    page = await withTimeout(messenger.messages.continueList(page.id), 60000, "messages.continueList");
    count += page.messages.length;
  }
  return count;
}
