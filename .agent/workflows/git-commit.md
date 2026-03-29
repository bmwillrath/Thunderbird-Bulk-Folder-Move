---
description: Custom workflow specifically for packaging and committing the extension.
---

When the user asks me to "git commit" or run a "git commit workflow", I must follow these exact steps to ensure the extension is correctly versioned and zipped cleanly out of the repository.

1. **Verify Version:** Check `manifest.json` and ensure the `version` bumped or matches the intended new git tag/version. If it needs updating, edit `manifest.json` first.
2. **Git Commit:** Stage changes and write a descriptive, multi-line commit message summarizing features/fixes.
3. **Zip to Parent Directory:** Use the `zip` command to bundle the extension into an `.xpi` file, making absolutely sure the output path is set to the PARENT directory (`../`). 
   - **Important:** Ensure the archive name includes the version number (e.g. `../bulk-folder-move-v0.2.0.xpi`).
   - Exclude the `.git` directory, any existing `.xpi` files, logs, screenshots, and documentation (`README.md`, `ARCHITECTURE.md`, `.agent/*`).
   
Example commands: 
```bash
# Use multiple -m flags to create a title and a detailed multi-line description
git commit -am "v0.X.X: Short title of the update" -m "- Detailed description line 1
- Detailed description line 2
- Detailed description line 3"

zip -r "../bulk-folder-move-v0.X.X.xpi" * -x "*.git*" "*.xpi" "*.moz_log" "*.log" "screenshots/*" "README.md" "ARCHITECTURE.md" ".agent/*" ".gitignore"
```
