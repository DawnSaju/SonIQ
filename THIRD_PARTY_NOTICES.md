# Third-Party Notices

SonIQ is free software distributed under the **GNU General Public License,
version 2 only (GPL-2.0-only)**. The complete license text is included in
[`LICENSE`](LICENSE). A published SonIQ release tag and its corresponding
source archive are the source for that release.

This document is a practical release notice, not a claim of exhaustive legal
analysis. `package-lock.json` and `src-tauri/Cargo.lock` are the authoritative
version records for the JavaScript and Rust dependency graphs. Release builds
also write runtime build metadata beside the packaged tools.

## Recognition adapter

- **@yao-pkg/pkg 6.21.0** — MIT. This release-build tool packages SonIQ's
  recognition adapter as a standalone macOS sidecar so people who download a
  DMG do not need to install Node.js. Source:
  <https://github.com/yao-pkg/pkg>.
- **Node.js runtime** — MIT. The packaged sidecar contains a Node.js runtime
  supplied by the packaging tool. Source and license information:
  <https://github.com/nodejs/node>.

## Bundled media runtime

SonIQ releases include `ffmpeg` and `ffprobe` built from:

- **FFmpeg 8.0.1** — LGPL-2.1-or-later.
- Source archive:
  <https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz>
- SHA-256:
  `05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41`
- Reproducible build instructions/configuration:
  [`scripts/build-media-tools.mjs`](scripts/build-media-tools.mjs).

The script downloads that pinned source archive, verifies its SHA-256, and
builds only the local macOS architecture. It deliberately avoids Homebrew and
disables GPL/nonfree components by relying on FFmpeg's default LGPL licensing
mode while enabling only SonIQ's required local media support. The resulting
runtime's version, source SHA, target triple, and build configuration are
recorded in `build-metadata.json` inside the release app bundle.

## JavaScript application dependencies

The released frontend uses the following direct packages. Their exact resolved
versions, transitive dependencies, and license files are available through
`package-lock.json` and the corresponding npm packages.

| Package | Declared license |
| --- | --- |
| @radix-ui/react-slot | MIT |
| @tauri-apps/api and Tauri plugins | Apache-2.0 OR MIT |
| clsx | MIT |
| lucide-react | ISC |
| react and react-dom | MIT |
| tailwind-merge | MIT |

## Rust and Tauri dependencies

SonIQ is built with Tauri and Rust crates. Their complete, resolved version
graph is recorded in [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock). Consult
each crate's source package for its license text and notices.

## Release source and notices

For each distributed SonIQ binary, obtain the matching source from its Git tag
or the repository's source archive. The source includes this notice, `LICENSE`,
the lock files, and the release scripts needed to inspect how bundled runtime
components are assembled. This notice does not replace the terms of any
third-party license.
