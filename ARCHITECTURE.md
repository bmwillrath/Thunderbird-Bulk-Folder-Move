# Bulk Folder Move Architecture

This document contains critical operational context for maintainers. Do not expand this file with generic web extension documentation.

## 1. API Constraints & Backwards Compatibility
**Thunderbird 115 (Windows 7 target) does not support string-based `MailFolderId` pointers.** 
All interactions with APIs like `folders.create()`, `folders.move()`, or `messages.list()` MUST use the raw, complete `MailFolder` object. Passing a string ID may work locally on modern Thunderbird (v121+) but will silently fail or crash in the legacy target environment.

**Folder Resolution Strategy:** 
Because `messenger.folders.get()` is unreliable in older versions, `lookupFolder()` manually walks the folder tree via `messenger.accounts.get()` to locate the correct `MailFolder` reference. Do not replace this with a modern `folders.get()` call.

## 2. Transfer Pipeline
The extension employs two transfer strategies depending on the source and destination constraints:

### A. Native Move (Intra-Account)
When moving folders within the *same* account, the extension uses `messenger.folders.move()`. This delegates the heavy lifting directly to Thunderbird's internal processing, achieving fast directory tree transfers. 
- **Handling Failures:** If `folders.move()` times out, we wait 10 seconds for the server to settle before automatically falling back to Strategy B.

### B. Merge-Copy (Cross-Account)
When moving folders between *different* accounts (e.g., POP3 to IMAP/Exchange), the extension utilizes a "Safe Copy-Then-Delete" loop.
1. The destination folder structure is mapped and created. Illegal characters (`< > : " / \ | ? *`) are forcefully sanitized.
2. Messages are pulled from the source. **Ghost messages (0-byte size)** are instantly detected and purged to prevent API hangs.
3. Messages are copied in dynamically calculated batches.
4. If a batch succeeds, the source counterparts are deleted.

## 3. The "Phantom Copy" Problem
`messenger.messages.copy()` provides heavily delayed or erratic Promise resolutions, especially on slow network connections against Exchange servers. 

- **Dynamic Timeouts:** Timeout ceilings are dynamically mapped based on message payloads, assuming a bottom-end 1Mb/s throughput floor (roughly `5m` base, up to `15m`).
- **Phantom Reads:** Large batches may timeout within the client, even if they were successfully transmitted to the remote server. 
- **Reconciliation:** To prevent duplicated messages, the destination is aggressively re-scanned against `headerMessageId` before retrying a batch. If a message arrived (phantom copy), it is deleted from the source instead of re-copied.
- **Ramped Retry:** If single-message copies fail to reach the server, the connection recovery engine implements a ramped delay (`10s`, `20s`, `30s`, `60s`, `90s`, `90s`) totalling 5 minutes to bypass API throttling.
