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

The runtime dependencies include the project-local `ws`, `dotenv`, and `pg` packages as well as
the built Kodex workspace packages. Their package metadata and license files
are retained in `node_modules`; exact resolved versions are recorded in
`package-lock.json`.
