# Tesina

[Download Tesina for macOS](https://github.com/adominicci/tesina/releases/latest/download/Tesina-macos-universal.dmg)
· [Download Tesina for Windows (experimental)](https://github.com/adominicci/tesina/releases/latest/download/Tesina-windows-x64.exe)

Tesina is a free, local academic writing app that helps students format papers
in APA 7 style. It runs without an account, and your papers remain on your
computer. The interface and each document can use English or Spanish
independently.

Version 0.1.25 supports student papers on macOS 12 or newer, and ships an
experimental Windows 10 or newer build. Both are distributed through GitHub
Releases, not through an app store. Linux is not currently a supported or
CI-built release target, although its implementation remains in the source.

The source includes an internal bilingual spelling-editor proof. Ordinary
release builds do not include its controls or native spelling calls until the
final physical macOS Intel and Windows accessibility gate is complete.

## Install on macOS

1. Download and open the DMG.
2. Drag Tesina to the Applications folder.
3. Open Tesina from Applications. The first launch asks whether you are sure you
   want to open an app downloaded from the internet. Choose **Open**.

Tesina is signed with an Apple Developer ID certificate and notarized by Apple,
so no **Privacy & Security** exception is needed.

## Install on Windows (experimental)

The Windows build is not tested as carefully as the macOS build yet. Keep a copy
of anything important before you rely on it.

1. Download `Tesina-windows-x64.exe` and run it.
2. Windows shows a blue **Windows protected your PC** message, because the
   installer is not signed with a Windows code signing certificate.
3. Choose **More info**, then choose **Run anyway**.
4. Follow the installer and open Tesina from the Start menu.

Tesina on Windows updates itself the same way it does on macOS: the app
offers the new version, installs it, and restarts. An `.msi` package is also
attached to each release for administrators who prefer it.

## What it does

- Builds APA 7 student title pages and lists the APA details that are missing
  before an export, without ever blocking it.
- Keeps the editor, paged preview, and Word export aligned for headings,
  appendices, lists, tables, figures, equations, citations, and references.
- Flows the paper automatically across US Letter pages as you write.
- Formats in-text citations and reference entries in English or Spanish.
- Offers deterministic English and Spanish writing feedback in a dedicated
  Study workspace. It asks questions about the current passage. It never
  rewrites the paper automatically and does not replace instructor or APA
  guidance.
- Manages a reusable reference library with collections, DOI, ISBN, and URL
  autofill, plus BibTeX import with a review step.
- Provides a paged preview and exports `.docx` files for Microsoft Word and
  compatible editors.
- Exports PDF from the same pages the preview shows, saved straight to the
  folder you choose without going through the system print panel.
- Saves locally with atomic autosave and creates a timestamped backup before a
  paper is deleted. Tesina has no account system or cloud service.
- Exports and safely merges complete portable `.tesina` library archives, with
  optional daily backups to a folder you choose.

Tesina follows the public [APA Style paper-format guidance](https://apastyle.apa.org/style-grammar-guidelines/paper-format/), but students should still follow any instructions provided by their instructor or institution.

## Updates

Tesina checks the latest published GitHub Release when the app opens, and
again every few minutes while it stays open. If an update is available, the
update icon beside the version number offers it; hovering shows the release
notes and clicking installs. After installation, Tesina restarts and shows
formatted release notes. You can reopen the installed version's notes from the
version shown on the home screen or in the editor status bar. An app update
does not replace your locally saved papers.

The updater verifies release artifacts with Tesina's updater key on both
macOS and Windows. This key is separate from the Apple Developer ID
certificate that signs the macOS app.

## Run from source

Requirements:

- Deno 2
- Rust 1.88 or newer
- The [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system

Install dependencies and start the desktop app:

```bash
deno install
deno task dev
```

Run the repository checks from the project root:

```bash
deno task check
deno task test
deno fmt --check
deno lint
```

`deno task build` creates local bundles after a Tauri updater signing key is
available in `TAURI_SIGNING_PRIVATE_KEY`. Local bundles use an ad-hoc signature,
so no Apple certificate is needed to build from source. Keep private keys
outside the repository. The published macOS DMG is created by the release
workflow, which signs it with the Developer ID certificate and notarizes it with
Apple.

## License and name

Tesina is available under the [MIT License](LICENSE).

Tesina bundles the Inter interface font under the
[SIL Open Font License 1.1](apps/desktop/src-tauri/resources/Inter-OFL-1.1.txt).

Tesina is an independent project. It is not affiliated with, endorsed by, or
sponsored by the American Psychological Association. “APA” identifies the
formatting style the app is designed to help apply.
