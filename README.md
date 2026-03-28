# Thunderbird Bulk Folder Move

A robust, no-nonsense Thunderbird extension to securely move entire folder trees and their emails between accounts. Designed to handle large data migrations using a safe copy-then-delete queue, ensuring zero data loss during transfer.

![UI Overview Placeholder](screenshot-ui-placeholder.png)

## Compatibility

- **Thunderbird:** v115.0 and above.
- Fully compatible with Thunderbird v128+ (Supernova).

## Features

- **Safe Copy-Then-Delete**: Messages are fully copied and verified in the destination before the original is removed.
- **Hierarchical Folder Support**: Select entire folder trees; the exact structure is replicated in your target account.
- **Granular Control**: "Skip Message", "Skip Folder", or "Cancel" operations gracefully if an error occurs mid-transfer.
- **Real-Time Progress**: Detailed logs and progress bars keep you informed during large batch transfers.

## Screenshots

*(Placeholder for Source & Destination Selection)*
![Folder Selection](screenshot-selection-placeholder.png)

*(Placeholder for Active Progress Tracker)*
![Progress Tracker](screenshot-progress-placeholder.png)

## Installation

1. Download the latest `.xpi` release from the [Releases](#) page (or package the repository yourself).
2. Open Thunderbird and navigate to **Add-ons and Themes** (`Ctrl+Shift+A` or `Cmd+Shift+A`).
3. Click the gear icon (**⚙️**) in the top-right corner and select **Install Add-on From File...**
4. Select the downloaded `.xpi` file and confirm the installation.
5. The Bulk Folder Move icon will now appear in your Thunderbird toolbar.

## Usage

1. Click the **Bulk Folder Move** icon in your Thunderbird toolbar to open the tool.
2. **Left Panel (Source):** Select the account you want to move folders *from*. Check the boxes next to the folders you wish to move.
3. **Right Panel (Destination):** Select the account you want to move folders *to*, and select the target parent folder.
4. Click **Move Selected Folders**.
5. Keep the migration window open. You can monitor the transfer progress or intervene manually using the control buttons if necessary.

## Required Permissions

To perform folder structural moves safely, this extension requests:
- **`accountsRead` / `accountsFolders`**: To list your accounts and build the folder trees.
- **`messagesRead`**: To read the contents of emails prior to copying.
- **`messagesMove` / `messagesImport`**: To recreate messages in the destination.
- **`messagesDelete`**: To remove the source messages *only after* a successful copy to the destination.

## Development 

This project is built using native WebExtensions APIs. 

**Building from source:**
Zip the contents of this repository and rename the extension to `.xpi`.

```bash
zip -r /tmp/bulk-folder-move.xpi * -x "*.git*" ".DS_Store"
```

---
*Created by BTE*
