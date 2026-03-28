---
description: Critical Thunderbird API guidelines and backwards compatibility constraints. Read this before refactoring.
---

# Thunderbird API Architecture Rules

**CRITICAL CONSTRAINT: `MailFolder` vs `MailFolderId`**

When modifying or refactoring this extension, you will likely encounter Error Console warnings stating:
> *Error: Support deprecated since Thunderbird 121 and removed in Manifest V3: `folders.create()` requires to specify a MailFolderId instead of a full MailFolder object.*

You must **IGNORE** these deprecation warnings. 

Under no circumstances should you refactor the codebase to pass modern `MailFolderId` strings to WebExtension API methods (such as `messages.list()`, `messages.copy()`, `folders.create()`, or `folders.delete()`).

### Why?
The primary requirement of this tool is ultimate backward compatibility, explicitly supporting older Thunderbird versions running on **Windows 7**. These legacy architecture builds do not support the modern `MailFolderId` parameter convention. They strictly require the full, raw `MailFolder` object payload to execute correctly. 

Updating to the newer Manifest V3 standard of `MailFolderId` will instantly break the runtime on these client machines. Accept the console warnings as a necessary architectural requirement of the project.
