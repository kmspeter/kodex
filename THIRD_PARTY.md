# Third-party software

## OpenAI Codex

- Upstream: https://github.com/openai/codex
- Pinned commit: `f1433fc71f2062ae3c007a03d7ff549bc582d386`
- Local source: `vendor/openai-codex/`
- License: Apache License 2.0

The upstream `LICENSE` and `NOTICE` files are preserved verbatim at
`vendor/openai-codex/LICENSE` and `vendor/openai-codex/NOTICE`. Kodex does not
rename or fork Codex internals; the product name “Kodex” applies only to this
local host and UI.

## Electron runtime

The Windows runtime bundle includes Electron and its bundled Chromium and
Node.js runtimes. Electron is distributed under the MIT License; Chromium and
Node.js include their own third-party notices and licenses in Electron's
distribution. The bundle is copied from the project-local npm dependency and
does not install a system-wide runtime.

## JavaScript dependencies

The JavaScript project runtime dependencies include the project-local `ws`,
`dotenv`, `pg`, and `argon2` packages as well as the built Kodex workspace
packages. The Windows desktop bundle includes `ws` and `dotenv`; the separate
product API image includes `dotenv`, `pg`, and `argon2`. Package metadata and
license files are retained in `node_modules`; exact resolved versions are
recorded in `package-lock.json`.

`argon2` 0.44.0 is pinned for password hashing and includes the reference
Argon2 implementation plus platform-specific native prebuilds. It is licensed
under the MIT License; its bundled Argon2 source license is retained under
`node_modules/argon2/argon2/LICENSE`.
