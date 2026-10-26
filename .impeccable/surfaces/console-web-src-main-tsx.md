---
version: 1
slug: "console-web-src-main-tsx"
primary_target: "console/web/src/main.tsx"
related_targets: ["console/web/src/journal.tsx","console/web/src/styles.css"]
---

# Surface brief: operator console (console/web)

Scope: a read-only operator console for Graft, deployed as its own container next to server and worker, reading
Postgres through a read-only role. Built from the approved Field Journal mockup (PR 52, first version).
Visitor mode: Operate.

Audience: the operator running Graft (today the owner), daily. Job: a morning check of what Graft handled since
yesterday, and digging in when something looks wrong. Task: see what needs a human, read the day, open one PR's record,
copy the `graft …` CLI command that acts on it (v1 takes no action itself). Content: whatever Graft stored; the mockup used production aggregates from
2026-10-25 (read-only queries): deliveries, cards, verifier verdicts, policy outcomes, guard events, spend, feedback.
Constraints: only what the tables store (no PR titles, bodies, diffs); goals are model prose and may be shown;
WCAG 2.2 AA in light and dark; usable at 360px.

Decision: surface round, seed afe593d5, dealt 7/6/3; the user locked The Field Journal (assigned).

## Direction contract

THESIS: The console is the operator's field journal: each day is one ruled page of what Graft handled, in time order,
with anything that needs a human pinned in the margin. Refuses the KPI-tile admin dashboard (a grid of same-size cards
with big numbers and sparklines).

OWN-WORLD: The herbarium world unchanged: mounting-board ground, a label-stock journal page ruled every 32px, iron-gall
ink, cambium green as the only accent, risk stamps (ring, dashed rectangle, double ring) inline on entries, rotated
pinned slips for attention items, journal day tabs on the fore edge, Courier Prime for anything a machine produced,
Literata for the day's prose, IM Fell for the day title. The queue and webhook facts sit in a cabinet band.

STORY: The operator reads one sentence about the day, sees three pinned slips (guard needs a human on main, author-only
votes, the budget), scans the entries, unfolds one PR into its specimen record, copies the CLI command.

FIRST VIEWPORT: Left: a 76px rail of day tabs, today extended. Centre 8/12: IM Fell day title, a Literata summary
sentence, a ruled tally row, then entries begin. Right 4/12 margin: pinned slips under "Needs you", then the Phase 0
gate and the token budget.

FORM: The Field Journal, position 7 of my ordered list, seed key afe593d5. Signature interaction: an entry unfolds in
place into its specimen record (accession label, determination slip, verdict, CLI command). Motion: the slips pin once on
load; nothing loops.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
