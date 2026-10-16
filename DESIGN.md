---
name: Graft
description: Herbarium sheet meets code review. Every pull request is mounted as a specimen with its accession label, a determination slip and a risk stamp.
colors:
  board: "#e4e8df"
  sheet: "#f6f7f2"
  sheet-edge: "#cfd6c9"
  label: "#fbfaf2"
  ink: "#16212a"
  ink-2: "#3c4950"
  ink-3: "#536066"
  rule: "#bcc5b8"
  cambium: "#2f8a22"
  cambium-ink: "#22681a"
  cambium-soft: "#d5e8c8"
  btn-ink: "#ffffff"
  tape: "#e3d8b0"
  tape-line: "#b9ab78"
  sensitive: "#b42318"
  logic: "#8a5600"
  trivial: "#22681a"
  code-bg: "#eceee6"
  cabinet: "#15201b"
  cabinet-2: "#1d2a24"
  cabinet-ink: "#e8ede4"
  cabinet-ink-2: "#b3bfb5"
  cabinet-rule: "#34453c"
  cabinet-green: "#8fd65c"
typography:
  display:
    fontFamily: "IM Fell English, Iowan Old Style, Georgia, serif"
    fontSize: "clamp(2.7rem, 5.6vw, 5.1rem)"
    fontWeight: 400
    lineHeight: 0.98
    letterSpacing: "-0.012em"
  headline:
    fontFamily: "IM Fell English, Iowan Old Style, Georgia, serif"
    fontSize: "clamp(2.1rem, 3.9vw, 3.3rem)"
    fontWeight: 400
    lineHeight: 1.04
  title:
    fontFamily: "IM Fell English, Iowan Old Style, Georgia, serif"
    fontSize: "clamp(1.6rem, 2.6vw, 2.2rem)"
    fontWeight: 400
    lineHeight: 1.05
  body:
    fontFamily: "Literata, Iowan Old Style, Georgia, serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.65
  action:
    fontFamily: "Literata, Iowan Old Style, Georgia, serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1
  label:
    fontFamily: "Courier Prime, Courier New, ui-monospace, monospace"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.35
  stamp:
    fontFamily: "Courier Prime, Courier New, ui-monospace, monospace"
    fontSize: "0.8rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.06em"
  docs-heading:
    fontFamily: "Literata, Iowan Old Style, Georgia, serif"
    fontSize: "2.4em"
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: "-0.01em"
rounded:
  hairline: "2px"
  sm: "3px"
  md: "4px"
  lg: "6px"
  round: "50%"
spacing:
  gutter: "clamp(16px, 4vw, 48px)"
  section: "clamp(72px, 10vw, 136px)"
  container: "1220px"
  action-gap: "12px"
  ledger-row: "28px 0 26px"
components:
  button-primary:
    backgroundColor: "{colors.cambium-ink}"
    textColor: "{colors.btn-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.sm}"
    padding: "0 22px"
    height: "48px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.action}"
    rounded: "{rounded.sm}"
    padding: "0 22px"
    height: "48px"
  button-ghost-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.board}"
  text-link:
    textColor: "{colors.cambium-ink}"
    typography: "{typography.action}"
  nav-link:
    textColor: "{colors.ink-2}"
  nav-link-hover:
    textColor: "{colors.ink}"
  herbarium-sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    padding: "3% 3% 0"
  accession-label:
    backgroundColor: "{colors.label}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "12px 14px 10px"
  stamp-sensitive:
    textColor: "{colors.sensitive}"
    typography: "{typography.stamp}"
    rounded: "{rounded.round}"
    size: "116px"
  stamp-logic:
    textColor: "{colors.logic}"
    typography: "{typography.stamp}"
    rounded: "{rounded.lg}"
    width: "116px"
    height: "76px"
  stamp-trivial:
    textColor: "{colors.trivial}"
    typography: "{typography.stamp}"
    rounded: "{rounded.round}"
    size: "116px"
  cabinet-band:
    backgroundColor: "{colors.cabinet}"
    textColor: "{colors.cabinet-ink}"
    padding: "{spacing.section} 0"
  select-field:
    backgroundColor: "{colors.cabinet-2}"
    textColor: "{colors.cabinet-ink}"
    typography: "{typography.stamp}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    height: "46px"
  code-plate:
    backgroundColor: "{colors.code-bg}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "18px 20px"
---

# Design System: Graft

## Overview

**Creative North Star: "The Herbarium Sheet"**

Every pull request is a specimen grafted onto a rootstock and mounted on a herbarium sheet: an accession label typed in a typewriter face, a determination slip pinned on by a second botanist, gummed linen tape at the graft union, corner crop marks, a faint centimetre graticule, and a risk stamp pressed across the sheet. Sections are numbered Plates with italic captions. The ground is a cool grey-green mounting board, the ink is iron-gall blue-black, and one living cambium green marks the graft union and the primary action.

Density is that of a scientific plate: generous section rhythm, ruled ledgers instead of boxed cards, and evidence (the managed comment, the policy file, the floor gauge) rendered faithfully rather than abstracted into marketing tiles. Dark mode is the closed herbarium cabinet: the board goes near-black green, the paper dims, and the cambium green brightens because it is the only living thing in the drawer. One band (the risk floor) is a cabinet in both themes.

The world rejects the gradient SaaS hero with floating UI cards and the cream-serif-terracotta editorial default: the ground is grey-green, not cream, and the only accent is green.

**Key Characteristics:**
- Cool mounting-board ground, iron-gall ink, one cambium green.
- Risk is a stamp: a word plus a shape, with hue as a second channel.
- Three faces with fixed jobs: IM Fell for display, Literata for reading and actions, Courier Prime for labels, code and data.
- Ruled ledgers and numbered Plates with captions instead of cards.
- Paper depth: soft mounted-sheet shadows, tape, pins and slight rotation on pinned paper.
- Dark mode is a closed cabinet, not an inverted page.

## Colors

A cool, low-chroma botanical palette: grey-green paper on grey-green board, blue-black ink, a single saturated green, and three stamp inks reserved for risk. Light values are in the frontmatter; dark (cabinet) values are recorded in the sidecar.

### Primary
- **Cambium Green** (cambium): the living layer exposed by the graft cut. Scion stroke, graft-union line, leaf fills (mixed 22% into the sheet), list markers, the active flow step, text selection. Stroke and fill only; it is under 4.5:1 on the sheet, so it never carries body text.
- **Cambium Ink** (cambium-ink): the text-weight green. Links, the primary button fill, keyword highlighting in code, italic counter numerals, the `trivial` stamp.
- **Cambium Soft** (cambium-soft): the closing band background and the tint mixed into the determination slip.

### Secondary
- **Quarantine Red** (sensitive): the `sensitive` stamp only.
- **Amber Logic** (logic): the `logic` stamp, string literals in code, the shadow-mode status ring and field-note stamp, the "Stays out" ledger heading.

### Neutral
- **Mounting Board** (board): page ground and sticky header (92% mix with blur).
- **Herbarium Sheet** (sheet): bands, the specimen sheet, the check-run panel.
- **Sheet Edge** (sheet-edge): 1px borders of mounted paper; the graticule lines.
- **Label Stock** (label): accession labels and the field note.
- **Iron-Gall Ink** (ink), **Ink 2** (ink-2), **Ink 3** (ink-3): text in three steps; ink-3 holds 5.2:1 on the board and is the floor for captions.
- **Rule** (rule): 1px dividers between ledger rows and under the header.
- **Linen Tape** (tape) and **Tape Line** (tape-line): gummed tape strips and the docs announcement banner.
- **Code Paper** (code-bg): inline code and code plates.
- **Cabinet** (cabinet, cabinet-2, cabinet-ink, cabinet-ink-2, cabinet-rule, cabinet-green): the dark cabinet band. Inside it the ink, rule, code and link tokens are re-pointed to their cabinet equivalents and the stamp inks switch to their dark values.

### Named Rules
**The One Living Green Rule.** Green is the only accent. It marks the graft union, the primary action and links; nothing else on the page is coloured except a risk stamp.

**The Stamp Ink Rule.** Red, amber and the risk use of green belong to the risk classes `sensitive`, `logic` and `trivial`. They are never decoration, and they always arrive with a word and a shape.

**The Closed Cabinet Rule.** Dark mode re-points every token rather than inverting the page: board #0e1613, sheet #15201b, ink #e6ebe2, cambium brightened to #7cc94a and cambium-ink to #93d963, and the primary button turns light green with board-coloured text.

## Typography

**Display Font:** IM Fell English (with Iowan Old Style, Georgia, serif)
**Body Font:** Literata (with Iowan Old Style, Georgia, serif), optical sizing on
**Label/Mono Font:** Courier Prime (with Courier New, ui-monospace, monospace)

**Character:** IM Fell is the printed plate title, with its italic for Latin-style names and plate numbers; Literata is the botanist's reading text; Courier Prime is the typed accession label. Fonts load from Google Fonts (Courier Prime 400/700, IM Fell English roman and italic, Literata 400/600 and italic 400).

### Hierarchy
- **Display** (400, clamp(2.7rem, 5.6vw, 5.1rem), 0.98): the hero headline only; the branch name inside it is set in Courier Prime 700 at 0.78em in cambium-ink.
- **Headline** (400, clamp(2.1rem, 3.9vw, 3.3rem), 1.04): section headings; the problem statement and close run larger (up to 3.6rem and 4rem). A second line in italic cambium-ink is the system's way to turn a statement.
- **Title** (400, clamp(1.6rem, 2.6vw, 2.2rem), 1.05): custody ledger questions, prefixed by an italic upper-roman counter; ledger column heads at 1.5rem.
- **Body** (400, 1.0625rem, 1.65): reading copy; leads at clamp(1.06rem, 1.3vw, 1.2rem) capped at 36em; section leads at 40em.
- **Action** (600 Literata, 1rem, 1): buttons and text links; text links append a right arrow.
- **Label** (Courier Prime 400/700, 0.76 to 0.95rem): accession labels, legends, file lists, tabs, code plates, check-run states.
- **Stamp** (Courier Prime 700, 0.8rem word / 0.7rem sub-line, 0.06em tracking, uppercase): risk stamps only.
- **Caption** (Literata, 0.86rem, ink-3, max 60em) led by an italic IM Fell plate number ("Plate IV.").

### Named Rules
**The Typed Label Rule.** Anything a machine or a policy produced (models, paths, risk words, check names, gauge steps) is set in Courier Prime. Anything a person reads as argument is Literata.

**The Old-Style Figure Rule.** IM Fell has only old-style figures, so "Step 1" reads as "Step I". Where headings carry numerals (all docs headings), use Literata at display size (h1 2.4em/1.08, h2 1.75em with a 2px ink rule above, h3 1.32em italic) instead of IM Fell.

## Layout

A single 1220px container with a fluid gutter of clamp(16px, 4vw, 48px), and section padding of clamp(72px, 10vw, 136px). The hero is a 5/12 copy column against a 7/12 plate; split sections use 4fr/7fr (5fr/7fr for policy) with a sticky side heading at top 96px. Content alternates between the board, sheet-coloured bands bordered top and bottom by sheet-edge, the cabinet band, and a cambium-soft closing band.

Ledgers carry the structure: a 2px ink rule opens a ledger, 1px rules divide rows. The custody ledger is a 4/8 grid of question and answer; the privacy ledger is four ruled columns; the flow is five steps on a 2px ink line with ring nodes.

Breakpoints: 1080px hides the header section nav; 960px stacks hero, splits, floor and footer, turns the privacy ledger to two columns and the flow to a vertical line; 640px goes single column, unpins the label and slip from the sheet into the flow, hides the scale bar and tags, and makes buttons full width.

## Elevation & Depth

Hybrid: most of the page is flat and ruled, and depth is reserved for physical paper objects. Mounted things (the specimen sheet, the GitHub comment, the terminal, the field note) take one soft mounted-sheet shadow; pinned paper (label, slip) takes a lighter one. The primary button has a pressed-paper shadow that deepens on hover. Ledgers, bands and the code plate stay flat.

### Shadow Vocabulary
- **Mounted sheet** (`box-shadow: 0 1px 2px rgb(22 33 42 / .1), 0 8px 16px -8px rgb(22 33 42 / .3)`; dark `0 1px 2px rgb(0 0 0 / .4), 0 8px 16px -8px rgb(0 0 0 / .6)`): sheets and mounted evidence panels.
- **Pinned paper** (`box-shadow: 0 1px 1px rgb(0 0 0 / .06), 0 6px 14px -8px rgb(0 0 0 / .3)`): accession label and determination slip.
- **Primary button** (`box-shadow: 0 1px 0 rgb(0 0 0 / .2), 0 6px 14px -8px rgb(0 0 0 / .35)`; hover `0 1px 0 rgb(0 0 0 / .2), 0 10px 18px -8px rgb(0 0 0 / .4)` with a 1px lift).

### Named Rules
**The Paper Object Rule.** Only things that are physically paper on the sheet cast a shadow. Text blocks, ledgers and bands never do.

## Shapes

Nearly square. Paper and controls use small radii (2 to 6px); circles appear only for stamps, the theme toggle, buds, flow nodes and pins. Paper that is pinned rather than mounted sits slightly off-axis (slip -2.2deg, stamps -12deg on the sheet and -8deg in the verdict, field-note stamp 6deg). Registration furniture: 18px corner crop marks in ink-3, a 40px graticule masked to fade at top and bottom, a dashed leader line (3 4) from tags to the specimen.

**The Stamp Shape Rule.** Each risk class has its own silhouette so it reads without colour: `trivial` is a single 2px ring circle; `logic` is a dashed 3px rounded rectangle (6px radius, 76px tall) with an inner 1px outline; `sensitive` is a double ring (3px border plus a 1px outline inset 9px) circle. The floor gauge repeats the cue: the final `logic` cell carries a 2px dashed inner outline, the final `sensitive` cell a 3px double one.

## Components

### Buttons
- **Shape:** near-square (3px), 48px tall, 0 22px padding, Literata 600 at 1rem.
- **Primary:** cambium-ink fill with white text (6.9:1); in dark mode light green #93d963 with board text.
- **Hover / Focus:** primary lifts 1px with a deeper shadow over .25s cubic-bezier(.2,.7,.2,1); focus is a 2px cambium-ink outline offset 3px (global).
- **Ghost:** 1.5px ink border, ink text; hover fills with ink and turns text to board.
- **Text link:** Literata 600 in cambium-ink, underlined 1px at .22em offset, 2px on hover, followed by a right arrow.

### Cards / Containers
There are no generic cards. Containers are mounted paper: the specimen sheet (sheet fill, sheet-edge border, mounted shadow, graticule, crop marks), the evidence panel (6px radius, sheet-edge border, a board-tinted title bar), and the field note (label stock ruled every 32px, text set on the ruling, a rotated amber stamp in the corner).

### Inputs / Fields
Inputs live inside the cabinet band. Checkboxes are 20px squares (2px radius, 1.5px ink-2 border) that fill cabinet-green with a cabinet-coloured tick. Selects are Courier Prime 700 on cabinet-2, 1px rule border, 3px radius, 46px tall. File rows are ruled label rows that tint cabinet-2 on hover.

### Navigation
Sticky header on a 92% board mix with an 8px blur and a 1px rule underline. IM Fell wordmark (1.6rem) with the 30px mark; section links in ink-2 at .9rem that turn ink and underline on hover; Docs and GitHub links in Literata 600; a 36px round theme toggle with a 1px rule border. The docs header keeps the board colour (no coloured bar), sets tabs in Courier Prime 700, and carries a linen-tape announcement banner.

### Risk Stamp (signature)
An inline-grid mark, 116px, rotated, uppercase Courier Prime 700 with the class word above a smaller sub-line ("rules floor", "final"). Shape per The Stamp Shape Rule; colour via one custom property set per class. On the light sheet it multiplies into the paper; in dark mode it is drawn normally. The JS swaps the class and word together, never the colour alone.

### Accession Label and Determination Slip
The label is label stock, typed in Courier Prime at .82rem with an IM Fell head over a 1.5px ink rule and a definition grid (ink-3 terms, 700 values). The slip is the same paper tinted 55% cambium-soft, rotated -2.2deg, with an IM Fell italic head and a pin.

### Ledgers
Rows on a 2px ink top rule with 1px rule dividers. Docs tables use the same form: no box, no radius, no shadow, Courier Prime 700 headers on a 1px ink rule, rows tinted with transparent accent on hover.

### Code Plate
An ink tab (4px top radius) in Courier Prime naming the file, over a code-bg block with a sheet-edge border. Comments italic ink-3, keywords bold cambium-ink, strings logic amber.

### Motion
**The Graft Takes Once Rule.** Everything is visible at rest. On load the graft takes once: the cambium line and sap line draw (.7s and 1.6s on cubic-bezier(.16,1,.3,1)), the leaves unfurl, the label swings to rest, the slip is pinned, the stamp presses in. Nothing loops. The floor marker moves over .5s on the same curve. Under reduced motion all of it, plus smooth scrolling and transitions, is off.

## Do's and Don'ts

### Do:
- **Do** keep green the only accent: cambium for strokes and fills, cambium-ink for any green text.
- **Do** give every risk class its word and its stamp shape (single ring, dashed rounded rectangle, double ring) wherever it appears.
- **Do** set models, paths, risk words and check names in Courier Prime; set argument in Literata; keep IM Fell for display headings without numerals.
- **Do** use Literata for docs headings and any heading that carries a digit.
- **Do** caption figures as numbered Plates with an italic IM Fell plate number.
- **Do** structure lists of facts as ruled ledgers (2px ink rule to open, 1px rules between).
- **Do** re-point tokens for dark mode and inside the cabinet band instead of hard-coding new values.

### Don't:
- **Don't** use a cream ground, a terracotta accent, or a gradient hero with floating UI cards.
- **Don't** signal risk or state by hue alone.
- **Don't** use cambium (#2f8a22) for text; it falls below 4.5:1 on the sheet.
- **Don't** put shadows on anything that is not a paper object.
- **Don't** set step numbers or other digits in IM Fell.
- **Don't** loop motion or hide content until it animates.
