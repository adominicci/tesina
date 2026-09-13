# LT-04 Writing Coach experience manual evidence

## Accepted source and attestation

The manually tested implementation source is
`dc04ac0ffe03c7b7911b12db610ce6e578de93f1`. The running local development
session hot-reloaded that exact head before the final retest. This record is
added by a later evidence-only commit and does not relabel that later commit as
the manually tested source. No packaged installer or release is claimed.

On 2026-08-23 AST, the product owner explicitly attested in the task transcript
that the complete LT-04 manual checklist passed, not only the corrected hover
state. The attestation covers the VoiceOver and keyboard journey, live
announcements, exact Edit-this-passage behavior, Reduced Motion, and both
320-CSS-pixel UI/document-language combinations.

## Environment

- Platform: macOS 26.6.1, build 25G76, arm64
- Assistive technology: VoiceOver app metadata version 10
- Tesina source: `dc04ac0ffe03c7b7911b12db610ce6e578de93f1`
- Test mode: local development session with hot reload
- Narrow-layout proof: `document.documentElement.clientWidth` confirmed as
  exactly `320`

## Manual results

| Check | Result | Attested observation |
| --- | --- | --- |
| Keyboard and VoiceOver flow | Pass | Write and Study modes, Study observations, navigation, and actions were operable by keyboard and announced in a useful order. |
| Focus and live region | Pass | Focus remained visible and predictable; the single polite status announced analysis and position changes without duplicate live output or background focus movement. |
| Edit this passage | Pass | Current content returned to Write with the exact mapped issue substring selected and focused, without automatic text changes. |
| Reduced Motion | Pass | Study entry, observation navigation, and return to Write remained operable with Reduced Motion enabled and without nonessential motion or smooth scrolling. |
| English UI with Spanish document at 320 CSS px | Pass | The full Study surface remained readable and operable with no horizontal page overflow, clipped source/question text, or unreachable action. |
| Spanish UI with English document at 320 CSS px | Pass | The full Study surface remained readable and operable with no horizontal page overflow, clipped source/question text, or unreachable action. |
| Non-color presentation | Pass | Source emphasis, selected state, focus, and actions remained perceivable without relying on color alone. |
| Remaining defects | Pass | No remaining manual defect was reported after the final retest. |

## Defect and retest history

Manual inspection at source
`7a40eac7eba0004c4eae1d414868695c9d61c8a5` found that hovering the primary
**Edit this passage** button applied the generic pale hover background while
retaining light text, producing poor contrast. A pre-fix screenshot was
provided in the task transcript; no final screenshot is retained or claimed by
this repository evidence.

Commit `dc04ac0ffe03c7b7911b12db610ce6e578de93f1` added an explicit primary
hover using the theme-specific `--accent-hover` background and `--accent-on`
text tokens. The product owner successfully retested that hover state at the
exact accepted source and then confirmed the full checklist passed.

## Evidence boundary

### Navigation-group retest reported on 2026-09-13

The product owner replied `pass` to the requested VoiceOver check for the build
launched from `dbc35f2d9bf8496da96c34898abbbb15dd937013`: Previous/Next was
announced as one labeled "Issue X of Y" group, and Next announced the new
position once while keyboard focus remained on Next. This is a user-reported
result for that requested build, not an independently inspected runtime SHA.

The later controller and boundary-audit correction at
`4de4e264007f39717b45deb3908779e572c21a92` did not change the navigation-group
markup or live-region markup. The defensive stale-navigation announcement has
automated coverage but still lacks a separate real-VoiceOver retest. It is not
included in this new attestation.

This record satisfies the LT-04 manual assistive-technology and narrow-layout
gate for the exact local source above. It does not claim a packaged build,
Windows behavior, signing, notarization, publication, release delivery, model
behavior, generated writing, quiz behavior, or APA authority.
