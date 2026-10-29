# Margin Research Bridge

Copy `main.js` and `manifest.json` into `.obsidian/plugins/margin-bridge/`, then enable or reload the plugin.
The installed copy in your vault has already been updated.

Start Margin and keep Zotero running with Better BibTeX enabled.
Set the local Margin URL in this plugin’s settings (this installation uses `http://127.0.0.1:4318`).
Open a literature note and run **Margin Research Bridge: Open literature note in Margin** from Obsidian’s command palette.
The command saves the active editor and opens a vault-relative note URL.
Margin resolves its citation key, opens the existing Zotero PDF, and resumes an existing reading session when available.
If multiple PDFs exist, choose the intended attachment.
The existing return-to-session and jump-to-note/heading commands remain available.
