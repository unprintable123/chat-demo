# Runtime data

This directory is the persistent server store. The application writes the API key and chat
history here at runtime:

- `config.json` contains the DeepSeek API key.
- `chat/` contains conversations and original attachments.
- `chat-staging/` is used while importing a history archive.
- `document-cache/` contains reusable PDF page splits and their DeepSeek file IDs.

These files are intentionally ignored by Git so a key or private conversation cannot be
committed accidentally. Back up this directory if you need to retain the server data.
