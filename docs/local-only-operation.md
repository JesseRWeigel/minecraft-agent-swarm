# Local-only operation safety controls

For local-only sessions, set `TTS_ENABLED=false` to disable Microsoft Edge speech before any connection and `TWITCH_CHANNEL=` to disable Twitch. Set `LLM_PROVIDER=ollama`, `OLLAMA_HOST=http://127.0.0.1:11434`, and explicit installed local model names. Never select a cloud model for a no-charge local run.

Set `SWARM_BIND_HOST=127.0.0.1` for dashboard, overlay, unified-viewer, and fallback-viewer listeners. Launch Paper with its application `--host 127.0.0.1` override. These runtime options do not change system network settings or rewrite existing server configuration.

Do not enable Claude plugins or external messaging during local-only oversight. Preserve world backups and append actual launch/configuration evidence to the operations ledger.

These controls are opt-in; unset variables preserve existing behavior. The exact value `false` disables speech. They do not stop an already-open speech connection, disable arbitrary plugins, or make cloud LLM selections local. Set them before starting the process.

Validation: 1,082 automated tests, TypeScript and production build; real HTTP/API checks for all four listener types with OS socket inspection confirming loopback bindings. The fallback check used an inert bot object, not a live world. Static viewer-page loading in the hidden audit worktree was blocked by Express dotfile protection, so this run does not claim rendered-browser or in-game validation.
