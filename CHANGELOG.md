# Changelog

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.23] - 2026-09-13

### Security

- Update Tiptap to 3.31.3 to fix prototype manipulation in merged DOM attributes
  and excessive processing in Markdown attribute parsing.
- Update Vitest to 4.1.11 to fix file access outside allowed paths in its mock
  development-server plugin.

## [0.1.22] - 2026-08-23

### Changed

- Internal groundwork adds a hidden deterministic English and Spanish
  writing-coach engine, offline quality evaluator, and generated-text style
  audit. No editor controls or model features are enabled.

## [0.1.21] - 2026-08-22

### Changed

- Internal editor proof work adds deterministic English and Spanish spelling
  extraction, student-approved corrections, scoped ignore lists, and an
  accessible correction menu. Ordinary release builds still contain no
  spelling controls or native spelling calls pending the final physical gate.

## [0.1.20] - 2026-08-22

### Changed

- Internal groundwork adds a hidden, local spelling boundary for English and
  Spanish on macOS and Windows. The editor does not use it yet, so visible
  behavior is unchanged.

## [0.1.19] - 2026-08-21

### Changed

- Internal consistency work with no visible changes: document building blocks
  now share one source of truth for their names across the editor's schema,
  live pagination, previews, portable archives, and Word export.

## [0.1.18] - 2026-08-21

### Changed

- Internal reliability work with no visible changes: saving now runs through a
  dedicated autosave engine with the same save states as before, and document
  building blocks share one source of truth for their names across the editor,
  previews, and Word export.

## [0.1.17] - 2026-08-18

### Added

- Export or import your complete library as one portable `.tesina` file,
  including every paper, reference, collection, and figure.
- Optional daily backups can write to a folder you choose when your library has
  changed. Tesina keeps the seven newest backups it can prove belong to this
  installation and leaves other files alone.
- Restore a backup by merging it with your current library. Newer local work is
  preserved, and differing older content is kept as a separate imported copy.
- Portable library and backup files contain the complete library and are not
  password-protected or encrypted. Anyone with the file can read its contents;
  Tesina explains this before writing either kind of file.

### Changed

- Backup setup now uses neutral first-time wording whenever no configured
  backup folder can be confirmed.
- Backup folder access is now anchored entirely in native, renderer-denied
  storage. People who configured backups in v0.1.16 must select the folder
  again and complete one real test backup; existing backup files remain
  untouched. Later v0.1.17 restarts keep the renewed authorization, while a
  missing native trust anchor fails closed and asks for authorization again.
- Tesina's packaged web content and build dependencies now use tighter
  security boundaries without changing native DOI, ISBN, or update access.
- Linux packaging remains in the source, but Linux is no longer built or
  supported by the active release workflows.

### Fixed

- One damaged paper file no longer hides every other paper. Tesina preserves
  unreadable files, names them in recovery guidance, and keeps reference
  deletion blocked while the library scan is incomplete.
- The editor's Add menu now closes when you click outside it or press Escape,
  and keyboard focus returns to the Add button.
- Opening Tesina again on a Mac now shows and focuses the existing window even
  when it was hidden with the close button.

## [0.1.16] - 2026-08-18

### Changed

- The small labels, filters and buttons around your paper now follow one
  set of rules instead of five. A label that only says what something is,
  such as a reference type or a language tag, is now plain grey at one
  size and one shape everywhere. Colour is kept for the things that want
  you to do something: "uncited" and "Duplicate" stay warm. The filter
  buttons in the essay list and in the library now look and behave alike,
  and the Cite and Delete actions in a reference row light up when you
  point at them.
- Short questions such as "Delete reference" and "Quit Tesina?" now open
  in a narrower window that fits the question, instead of the wider one
  every form uses.
- Every small pop-up panel now looks the same — the update message, the
  APA check, the citation picker and every toolbar menu. The ones that
  report on something open with a coloured strip and a dot that tells
  you at a glance whether it is good news: green when you are up to
  date, blue when an update is waiting, amber when your paper has
  something to look at.
- Blue text is slightly darker throughout, so labels on a blue
  background are easier to read.

## [0.1.15] - 2026-08-17

### Added

- The editor now checks your APA format while you write. A small light in
  the toolbar stays green while the structure looks right, and turns red
  with a count when something drifts: a blank line from pressing Enter
  twice, a heading level that skips a step, or a table or figure without a
  title. Drifting blocks get a soft tint on the page. Click the light to see
  the list, jump to each spot, and remove blank lines in one click. The
  advice window before an export shows the same list. These are
  suggestions, not blockers: saving and exporting always work.

## [0.1.14] - 2026-08-16

### Added

- Tesina on Windows now updates itself. The update icon works there the same
  way it does on a Mac: it checks for new versions while the app is open,
  shows what changed, and installs on click. Tesina saves your work before
  the installer runs, and the app restarts on its own.

### Changed

- The update notice is now a small icon beside the version number, at the
  bottom of the sidebar and in the editor status bar, instead of a banner
  across the top of the window. Hover the icon to read what is new; click it
  to update and restart. Tesina saves your work before restarting. When you
  are already up to date, the same icon checks for new updates on click.

## [0.1.12] - 2026-08-16

### Fixed

- The close button works on Windows again. Closing now asks whether you want
  to quit, saves your paper, and ends the app. If saving cannot finish, Tesina
  says so and lets you leave anyway instead of refusing to close, which used
  to force people into the Task Manager.

### Changed

- Closing the window on a Mac now leaves Tesina in the Dock, the way Mac apps
  behave. Click the Dock icon to bring your work back.
- Settings has a **Quit Tesina** entry. It asks for confirmation first, and
  works the same way on both systems.

## [0.1.11] - 2026-08-16

### Added

- Tesina now has a Windows installer, and PDF export works there too. It is
  marked experimental, because the Windows build has not been tested as
  carefully as the macOS one yet. Windows shows a warning before the installer
  runs, since it is not signed yet, and the Windows version does not update
  itself. The README explains both.

## [0.1.10] - 2026-08-16

### Changed

- Installing Tesina on a Mac is now a single step. The app is signed with an
  Apple Developer ID certificate and notarized by Apple, so the first launch
  only asks whether you want to open an app downloaded from the internet.
  Nobody has to visit System Settings to allow a blocked app anymore.

## [0.1.9] - 2026-08-16

### Added

- Export now offers PDF as well as Word. The PDF is built from the same pages
  the Print preview shows you, so what you hand in is what you proofread, and
  it saves straight to the folder you pick without going through the macOS
  print panel.

### Fixed

- Exporting to PDF no longer prints on the wrong paper. The page size now
  travels with the document, so a US Letter essay cannot come out on A4
  because of a Mac's regional settings.
- A PDF export that fails partway can no longer leave a broken file where your
  paper should be. The old file stays untouched until the new one is complete.

## [0.1.8] - 2026-08-15

### Changed

- Export no longer refuses to run when the title page is incomplete. Tesina
  now lists what APA asks for and lets you export anyway, so an unfinished
  cover page can never hold your document hostage.
- The course field accepts whatever you type. The number-colon-name form APA
  expects is still shown as advice instead of being enforced.
- The cover-page form shows every APA suggestion at once, in a yellow panel
  that empties as you fill the fields. Saving is never disabled.

## [0.1.7] - 2026-08-14

### Changed

- Every dialog in Tesina now shares one look: a larger, clearer title, field
  edges you can actually see before you type, a selected option that stands
  out at a glance, and a footer that reads as part of the window frame.
- Colors, text sizes, and spacing across the interface now come from one
  shared set of values. Light surfaces carry a faint paper warmth instead of
  a flat gray.
- Dropdowns now open a Tesina list instead of the grey system menu, and they
  follow your theme. In the font picker each family previews itself, with its
  APA point size beside it. Arrow keys, Home, End, Escape, and type-to-jump
  all still work.
- On the cover-page form, the course and the instructor each get a full line.
  Side by side, the course placeholder was cut off mid-word.
- Buttons are now one shared set across the whole app instead of five
  near-copies. Sizes settle onto two steps, and a destructive action reads as
  quiet until you reach the step that actually does it, which is filled red.
- Backup settings has been rebuilt around one status panel that answers
  whether your work is safe before anything else, a single obvious action,
  and separate Folder and Advanced sections. The backup path is no longer
  the loudest thing on the screen, and the window now has a Close button.

### Fixed

- The Insert citation button no longer turns its label near-black while you
  point at it in light mode. The label stayed readable in dark mode, so this
  only affected light.
- Font, Heading, List, Table, and Focus buttons in the toolbar keep their
  highlight while you point at them, so an open menu still looks open.
- The recovery notice no longer paints a cream strip that ignored your theme.
- Dropdowns and date fields no longer sit a few pixels shorter than the text
  boxes stacked next to them.
- The Back, Cancel, and Retry buttons in the backup setup wizard were drawn
  with no background or border at all. They look like buttons now.
- Keyboard focus outlines follow each control's own shape instead of being
  forced into the same rounded corner.

## [0.1.6] - 2026-08-10

### Fixed

- Tesina now checks the correct published release feed when looking for updates
  at startup.

## [0.1.5] - 2026-08-09

### Fixed

- Backups can now be set up when a paper contains website links. Tesina still
  blocks links that could run code when it checks a backup file.

## [0.1.4] - 2026-08-09

### Added

- Export your complete library — every essay, reference, collection, and
  figure — as one portable `.tesina` file you can copy, move, or keep
  anywhere. Tesina verifies the saved file by reopening it before reporting
  success.
- Import a `.tesina` file with a clear preview first: new content is added,
  identical content is skipped, and anything that differs is kept as a
  separate imported copy. Importing never replaces or deletes your current
  work, and an interrupted import is finished or undone safely the next time
  Tesina starts.
- Optional daily backups to one folder you choose — including folders synced
  by Google Drive, iCloud Drive, OneDrive, or Dropbox — set up through a
  five-step guided wizard in your language. Tesina keeps the seven newest
  backups from this computer, never touches anyone else's files, and shows
  you the last successful backup at a glance.
- Restore from a backup by merging it into your current library, so newer
  work is never rolled back or replaced.
- Backup files are complete and not password-protected; the wizard explains
  this clearly before anything is written.

## [0.1.3] - 2026-08-09

### Changed

- Essays now flow automatically from one US Letter page to the next while you
  write, with the title page, body, references, and appendices staying in order.
- Release notes now show formatted headings and lists while unsafe links and
  embedded content remain blocked.
- The installed version is always available on the home screen and in the
  editor status bar, where it can reopen that version's release notes at any
  time.

## [0.1.2] - 2026-08-08

### Changed

- The editor now shows the paper as separate pages — title page, essay, and
  references — in the same order as the printed document, instead of one
  continuous sheet with dividers.
- New papers start with all of their pages visible, including a references
  page that shows a short note until the first source is added.

### Fixed

- When exporting to Word with an incomplete title page, the title page window
  now highlights what is missing in red, updates the message while you type,
  and finishes the export on its own after you save the corrected title page.

## [0.1.1] - 2026-08-07

### Fixed

- Opening a paper preview no longer changes the fonts in menus, panels, or other
  parts of the app.
- Improved the checks for app update downloads so broken update files are
  caught before a release reaches users.

## [0.1.0] - 2026-08-07

### Added

- Writing and formatting for APA 7 student papers on macOS 11 or newer, with
  independent English or Spanish choices for the interface and document.
- APA 7 student title pages, structured body sections, abstracts, appendices,
  five heading levels, lists, tables, figures, equations, and page numbering.
- In-text citations and a generated reference list, backed by a reusable
  reference library with collections, DOI, ISBN, and URL autofill, plus BibTeX
  import with a review step.
- Paged preview and Word export, with student title-page validation.
- Local atomic autosave and a timestamped backup before a paper is deleted. No
  account or cloud service is required.
- Optional in-app updates from published GitHub Releases. Installed release
  notes appear once in plain text after the app restarts.

### Fixed

- Kept student title pages and body-page titles consistent across the editor,
  preview, and Word export, including multiple authors and affiliations.
- Preserved citations and formatting inside tables, headings, and block quotes
  in previews and Word exports.
- Kept primary editor actions available at the app's supported window widths.
- Improved the reliability of installing updates and showing release notes
  after restart.

[Unreleased]: https://github.com/adominicci/tesina/compare/v0.1.23...HEAD
[0.1.23]: https://github.com/adominicci/tesina/compare/v0.1.22...v0.1.23
[0.1.22]: https://github.com/adominicci/tesina/compare/v0.1.21...v0.1.22
[0.1.21]: https://github.com/adominicci/tesina/compare/v0.1.20...v0.1.21
[0.1.20]: https://github.com/adominicci/tesina/compare/v0.1.19...v0.1.20
[0.1.19]: https://github.com/adominicci/tesina/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/adominicci/tesina/compare/v0.1.17...v0.1.18
[0.1.17]: https://github.com/adominicci/tesina/compare/v0.1.16...v0.1.17
[0.1.16]: https://github.com/adominicci/tesina/compare/v0.1.15...v0.1.16
[0.1.15]: https://github.com/adominicci/tesina/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/adominicci/tesina/compare/v0.1.12...v0.1.14
[0.1.13]: https://github.com/adominicci/tesina/commit/80443091b75b1a887b01fdca12c09e565807a10a
[0.1.12]: https://github.com/adominicci/tesina/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/adominicci/tesina/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/adominicci/tesina/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/adominicci/tesina/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/adominicci/tesina/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/adominicci/tesina/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/adominicci/tesina/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/adominicci/tesina/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/adominicci/tesina/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/adominicci/tesina/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/adominicci/tesina/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/adominicci/tesina/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/adominicci/tesina/releases/tag/v0.1.0
