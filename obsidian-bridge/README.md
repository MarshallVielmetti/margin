# Margin Research Bridge

Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/margin-bridge/`, then enable or reload the plugin.
After updating the files, turn **Margin Research Bridge** off and back on in Community plugins to reload its running code. The **Reload plugins** button refreshes the plugin list and manifest, but does not replace an already running bridge.

Start Margin and keep Zotero running with Better BibTeX enabled.
Set the local Margin URL in this plugin’s settings (this installation uses `http://127.0.0.1:4318`).
Open a literature note and run **Margin Research Bridge: Open literature note in Margin** from Obsidian’s command palette.
The command saves the active editor and opens a vault-relative note URL.
Margin resolves its citation key, opens the existing Zotero PDF, and resumes an existing reading session when available.
If multiple PDFs exist, choose the intended attachment.
The existing return-to-session and jump-to-note/heading commands remain available.

## Chat with Margin

Open a literature note and run **Margin Research Bridge: Chat with Margin**.
A terminal-style Obsidian pane opens beside the note, with the Margin research agent, Markdown/math answers, cited sources, live activity, and a multiline prompt. Enter sends; Shift+Enter inserts a line break.

The bridge saves the note's open editor buffers before connecting and before each question. The server reads the current literature note into registered evidence on every turn, alongside the selected PDF page. The initial note excerpt is bounded to 12,000 characters; the agent can read further passages and search the PDF through its existing tools. Context budgets still apply; this does not load the entire PDF into every prompt. Existing exclusions apply to the linked note too. Imported note content retains its vault provenance without assuming every sentence was written by the researcher.

The paper is resolved through the same Zotero/Better BibTeX integration as the reading desk. Choose an attachment if several are available. When the PDF cannot be resolved, reconnect after fixing Zotero, or explicitly choose **Chat with literature note only (no PDF)**. The header always shows which context is attached. Set **PDF page** to discuss a different page. Choose the local or cloud model in the pane before sending; choosing a cloud model sends that turn's context to that provider.

The pane resumes the latest session for the resolved source, or its saved session when still available. A new source starts in the first workspace returned by Margin (the most recently updated workspace). The status identifies the workspace. **Open in Margin** opens the same session in the browser. Conversation and run history remain in Margin's database; closing a pane leaves an active run running. Reopen the command or use **Reconnect** to recover history and resume activity. **Stop** cancels the current run. A renamed/deleted note requires opening the command from its current location.

Margin must be running with this version of the server, and must be connected to the same vault as Obsidian. Restart Margin after updating the server; reload the bridge after copying the files. The pane checks vault identity and uses the server's mutation token in request headers. Tokens and questions are not stored in note URLs. Chat answers stay in session history; applying suggested edits still uses Margin's existing review flow.

## Coordinated literature-note writes

The desktop plugin polls the configured loopback Margin server for versioned writes to this vault. Requests use Margin's mutation token in a header; no token is stored in a note or URL.
For an open Markdown note, the bridge checks the editor's actual text against the expected file version. Unsaved or changed buffers decline the request without replacement. Save the note in Obsidian, then retry sync in Synthesis so Margin can merge the latest file.
Clean buffers receive the change as an editor transaction and save through Obsidian. Unopened notes use `Vault.process` with a version check. Renamed files are not silently recreated.
When the plugin or server is unavailable, Margin retains local revisions and reports Offline. Without coordination, use Margin's explicit closed-note sync option and keep the target note closed in Obsidian.
