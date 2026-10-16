/* Graft, explained: scenes of a canvas video (see ../engine/engine.js and the canvas-video skill).
 *
 * The world is the landing page's herbarium sheet (DESIGN.md): mounting-board ground, iron-gall ink, one cambium
 * green, IM Fell for display, Literata for argument, Courier Prime for anything a machine or a policy produced.
 * Risk is a stamp: a word plus a shape (single ring, dashed rectangle, double ring), hue only as a second channel.
 * Every organisation, person and pull request shown is fictional (the acme example of the README).
 *
 * Each scene is fn(t, d, cues), a pure function of t; animations hook onto at(cues, i).
 */
"use strict";

const FELL = '"IM Fell English", "Iowan Old Style", Georgia, serif';
const LIT = 'Literata, "Iowan Old Style", Georgia, serif';
const CP = '"Courier Prime", "Courier New", monospace';

const G = {
  board: "#e4e8df", sheet: "#f6f7f2", edge: "#cfd6c9", label: "#fbfaf2", ink: "#16212a", ink2: "#3c4950", ink3: "#536066",
  rule: "#bcc5b8", cambium: "#2f8a22", cambiumInk: "#22681a", soft: "#d5e8c8", tape: "#e3d8b0", tapeLine: "#b9ab78",
  sensitive: "#b42318", logic: "#8a5600", trivial: "#22681a", code: "#eceee6",
  cab: "#15201b", cab2: "#1d2a24", cabInk: "#e8ede4", cabInk2: "#b3bfb5", cabRule: "#34453c", cabGreen: "#8fd65c",
  dSensitive: "#f97066", dLogic: "#f0b84a", dTrivial: "#93d963",
};
const RISK = { trivial: G.trivial, logic: G.logic, sensitive: G.sensitive };
const RISK_DARK = { trivial: G.dTrivial, logic: G.dLogic, sensitive: G.dSensitive };

const STR = {
  en: {
    tagline1: "Intent review and policy checks",
    tagline2: "for pull requests written by coding agents.",
    status: "PHASE 0 · SHADOW MODE · REPORT ONLY",
    fictional: "every organisation, person and pull request shown is fictional",
  },
};

/* ------------------------------------------------------------------ herbarium helpers */

function rot(x, y, a, fn) { ctx.save(); ctx.translate(x, y); ctx.rotate(a * Math.PI / 180); fn(); ctx.restore(); }
function alpha(k, fn) { if (k <= 0) return; ctx.save(); ctx.globalAlpha *= clamp(k); fn(); ctx.restore(); }

/* Plate number and caption, the site's section opener. */
function plate(num, caption, k, o = {}) {
  const x = o.x ?? 80, y = o.y ?? 82;
  text(`Plate ${num}.`, x, y, { size: 21, weight: "italic 400", font: FELL, color: o.dark ? G.cabGreen : G.cambiumInk, alpha: k });
  const w = measure(`Plate ${num}.`, 21, "italic 400", FELL);
  text(caption.toUpperCase(), x + w + 14, y - 1, { size: 13, weight: 700, font: CP, color: o.dark ? G.cabInk2 : G.ink3, spacing: "1.5px", alpha: k });
}
/* Headline in IM Fell; an optional second line in italic cambium turns the statement. No digits in IM Fell. */
function head(l1, l2, k1, k2, o = {}) {
  const x = o.x ?? 80, y = o.y ?? 146, size = o.size ?? 46, gap = o.gap ?? size * 1.04;
  text(l1, x, y + (1 - outCubic(k1)) * 14, { size, font: FELL, color: o.dark ? G.cabInk : G.ink, alpha: k1, align: o.align });
  if (l2) text(l2, x, y + gap + (1 - outCubic(k2)) * 14, { size, weight: "italic 400", font: FELL, color: o.dark ? G.cabGreen : G.cambiumInk, alpha: k2, align: o.align });
}
/* Mounted paper: the only things that cast a shadow. */
function sheet(x, y, w, h, o = {}) {
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.shadowColor = o.pinned ? "rgba(0,0,0,0.16)" : "rgba(22,33,42,0.22)";
  ctx.shadowBlur = o.pinned ? 12 : 16; ctx.shadowOffsetY = o.pinned ? 5 : 7;
  rr(x, y, w, h, o.r ?? 4); ctx.fillStyle = o.fill ?? G.sheet; ctx.fill();
  ctx.shadowColor = "transparent";
  if (o.stroke !== false) { ctx.lineWidth = o.lw ?? 1; ctx.strokeStyle = o.stroke ?? G.edge; if (o.dash) ctx.setLineDash(o.dash); ctx.stroke(); }
  ctx.restore();
}
function flat(x, y, w, h, o = {}) { panel(x, y, w, h, { r: o.r ?? 4, fill: o.fill ?? G.sheet, stroke: o.stroke ?? G.edge, lw: o.lw, alpha: o.alpha }); }
function tape(x, y, w, h, a, k = 1) {
  alpha(k, () => rot(x, y, a, () => {
    ctx.fillStyle = G.tape; ctx.globalAlpha *= 0.92; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = G.tapeLine; ctx.lineWidth = 1; ctx.strokeRect(-w / 2, -h / 2, w, h);
  }));
}
function pin(x, y, k = 1) { dot(x + 1, y + 2, 6, "rgba(0,0,0,0.18)", k); dot(x, y, 6, G.cambiumInk, k); dot(x - 2, y - 2, 2, "#fff", 0.7 * k); }
function rule(x1, x2, y, w = 1, color = G.rule, k = 1) { if (k > 0) line([[x1, y], [lerp(x1, x2, clamp(k)), y]], color, w); }
function cropMarks(x, y, w, h, color = G.ink3, a = 0.7) {
  const s = 18;
  [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([cx, cy, dx, dy]) => {
    line([[cx, cy + dy * s], [cx, cy], [cx + dx * s, cy]], color, 1.2, a);
  });
}
function lbl(s, x, y, o = {}) { text(s, x, y, { size: o.size ?? 14, weight: o.weight ?? 400, font: CP, color: o.color ?? G.ink, align: o.align, alpha: o.alpha, spacing: o.spacing }); }
function body(s, x, y, o = {}) { text(s, x, y, { size: o.size ?? 18, weight: o.weight ?? 400, font: LIT, color: o.color ?? G.ink, align: o.align, alpha: o.alpha }); }

/* Risk stamp: the class word above a sub-line, its own silhouette per class. */
function stamp(cls, x, y, k, o = {}) {
  if (k <= 0) return;
  const col = (o.dark ? RISK_DARK : RISK)[cls], s = (o.size ?? 104) / 104;
  const press = 1 + 0.35 * (1 - outBack(clamp(k)));
  rot(x, y, o.rot ?? -12, () => {
    ctx.scale(s * press, s * press);
    ctx.globalAlpha *= clamp(k * 1.6) * 0.92;
    ctx.strokeStyle = col;
    if (cls === "logic") {
      ctx.lineWidth = 3; ctx.setLineDash([7, 5]); rr(-56, -36, 112, 72, 6); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1; rr(-48, -28, 96, 56, 4); ctx.stroke();
    } else if (cls === "sensitive") {
      ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, 52, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, 43, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 50, 0, Math.PI * 2); ctx.stroke();
    }
    text(cls.toUpperCase(), 0, o.sub ? 2 : 6, { size: cls === "sensitive" ? 14 : 16, weight: 700, font: CP, color: col, align: "center", spacing: "1px" });
    if (o.sub) text(o.sub.toUpperCase(), 0, 19, { size: 10, weight: 700, font: CP, color: col, align: "center", spacing: "1px" });
  });
}

/* A small risk tag for running text: the word plus the stamp's outline (single, dashed, double). Returns its width. */
function riskTag(cls, x, y) {
  const col = RISK[cls], w = measure(cls.toUpperCase(), 13, 700, CP) + 22, h = 26;
  ctx.save(); ctx.strokeStyle = col;
  if (cls === "logic") { ctx.lineWidth = 2; ctx.setLineDash([4, 3]); rr(x, y - h / 2, w, h, 4); ctx.stroke(); }
  else if (cls === "sensitive") { ctx.lineWidth = 2.4; rr(x, y - h / 2, w, h, 13); ctx.stroke(); ctx.lineWidth = 1; rr(x + 3.5, y - h / 2 + 3.5, w - 7, h - 7, 10); ctx.stroke(); }
  else { ctx.lineWidth = 1.6; rr(x, y - h / 2, w, h, 13); ctx.stroke(); }
  ctx.restore();
  lbl(cls.toUpperCase(), x + w / 2, y + 4.5, { size: 13, weight: 700, color: col, align: "center", spacing: "1px" });
  return w;
}

/* The Graft mark (docs/assets/brand/mark.svg), drawn as the graft takes: stem, scion, leaf, tape. */
function mark(cx, cy, s, k = 1) {
  const X = u => cx + (u - 32) * s, Y = v => cy + (v - 32) * s;
  const k1 = seg(k, 0, 0.3), k2 = seg(k, 0.3, 0.6), k3 = seg(k, 0.55, 0.8), k4 = seg(k, 0.75, 1);
  if (k1 > 0) line(partial([[X(32), Y(60)], [X(32), Y(30)]], outCubic(k1)), "#18222b", 7 * s);
  if (k2 > 0) line(partial([[X(32), Y(31)], [X(47), Y(8)]], outCubic(k2)), "#2a7d1e", 6 * s);
  alpha(k3, () => {
    ctx.translate(X(47), Y(8)); ctx.scale(outBack(k3), outBack(k3)); ctx.translate(-X(47), -Y(8));
    ctx.beginPath(); ctx.moveTo(X(47), Y(8));
    ctx.bezierCurveTo(X(41), Y(9), X(37), Y(13), X(37), Y(18));
    ctx.bezierCurveTo(X(43), Y(17), X(47), Y(13), X(47), Y(8));
    ctx.fillStyle = "#2a7d1e"; ctx.fill();
  });
  alpha(k4, () => {
    rr(X(25), Y(29) - (1 - outCubic(k4)) * 6 * s, 14 * s, 11 * s, 1.5 * s); ctx.fillStyle = "#e9e3c8"; ctx.fill();
    ctx.strokeStyle = "#18222b"; ctx.lineWidth = 2 * s; ctx.stroke();
    line([[X(26), Y(33)], [X(38), Y(33)]], "#18222b", 1.4 * s);
    line([[X(26), Y(36.5)], [X(38), Y(36.5)]], "#18222b", 1.4 * s);
  });
}

/* Personas, drawn in ink like a botanist's sketch. */
function human(x, y, s, k = 1, o = {}) {
  alpha(k, () => {
    ctx.lineWidth = 2.6; ctx.strokeStyle = G.ink; ctx.fillStyle = o.fill ?? G.label;
    ctx.beginPath(); ctx.ellipse(x, y + s * 0.62, s * 0.62, s * 0.5, 0, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y - s * 0.18, s * 0.32, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
}
function agent(x, y, s, k = 1, o = {}) {
  alpha(k, () => {
    ctx.lineWidth = 2.6; ctx.strokeStyle = G.ink; ctx.fillStyle = o.fill ?? G.label;
    ctx.beginPath(); ctx.moveTo(x - s * 0.55, y + s * 0.62); ctx.lineTo(x - s * 0.45, y + s * 0.2); ctx.lineTo(x + s * 0.45, y + s * 0.2); ctx.lineTo(x + s * 0.55, y + s * 0.62); ctx.closePath(); ctx.fill(); ctx.stroke();
    rr(x - s * 0.42, y - s * 0.5, s * 0.84, s * 0.6, s * 0.12); ctx.fill(); ctx.stroke();
    line([[x, y - s * 0.5], [x, y - s * 0.72]], G.ink, 2.6);
    dot(x, y - s * 0.76, s * 0.07, G.cambium);
    dot(x - s * 0.17, y - s * 0.22, s * 0.075, G.cambium); dot(x + s * 0.17, y - s * 0.22, s * 0.075, G.cambium);
    line([[x - s * 0.14, y - s * 0.04], [x + s * 0.14, y - s * 0.04]], G.ink, 2);
  });
}
function magnifier(x, y, s, k = 1) { alpha(k, () => { ring(x, y, s * 0.22, G.ink, 2.6); line([[x + s * 0.16, y + s * 0.16], [x + s * 0.36, y + s * 0.36]], G.ink, 3.4); }); }
function ruler(x, y, s, k = 1) {
  alpha(k, () => {
    ctx.fillStyle = G.tape; ctx.strokeStyle = G.ink; ctx.lineWidth = 2;
    rr(x - s * 0.2, y - s * 0.32, s * 0.4, s * 0.56, 2); ctx.fill(); ctx.stroke();
    for (let i = 0; i < 3; i++) line([[x - s * 0.11, y - s * 0.18 + i * s * 0.13], [x + s * 0.11, y - s * 0.18 + i * s * 0.13]], G.ink, 1.4);
  });
}

/* A dark cabinet terminal (Courier Prime, no coloured traffic lights: green is the only accent). */
function cabTerm(x, y, w, h, t, title, lines, o = {}) {
  sheet(x, y, w, h, { fill: G.cab, stroke: G.cabRule, alpha: o.alpha });
  alpha(o.alpha ?? 1, () => {
    ctx.save(); rr(x, y, w, 30, [4, 4, 0, 0]); ctx.fillStyle = G.cab2; ctx.fill(); ctx.restore();
    [0, 1, 2].forEach(i => ring(x + 18 + i * 15, y + 15, 4, G.cabInk2, 1.2, 0.8));
    lbl(title, x + w / 2, y + 20, { size: 12, color: G.cabInk2, align: "center" });
    const size = o.size ?? 15, lh = o.lh ?? 26;
    lines.forEach((l, i) => {
      if (t < l.a) return;
      const kk = l.b === undefined ? 1 : seg(t, l.a, l.b), ty = y + 58 + i * lh;
      const s = typed(l.s, kk);
      lbl(s, x + 20, ty, { size, color: l.c ?? G.cabInk, weight: l.w });
      if (kk > 0 && kk < 1) { ctx.fillStyle = G.cabGreen; ctx.fillRect(x + 21 + measure(s, size, l.w ?? 400, CP), ty - size + 3, size * 0.55, size); }
    });
  });
}

/* ------------------------------------------------------------------ background */

function board(t) {
  ctx.fillStyle = G.board; ctx.fillRect(0, 0, W, H);
  // a faint centimetre graticule, fading at top and bottom (static: nothing loops)
  ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = G.edge;
  for (let x = 40; x < W; x += 40) { ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 40; y < H; y += 40) { ctx.globalAlpha = 0.55 * Math.sin(Math.PI * y / H); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.restore();
  const g = ctx.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 780);
  g.addColorStop(0, "rgba(228,232,223,0.9)"); g.addColorStop(1, "rgba(228,232,223,0.15)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  cropMarks(28, 26, W - 56, H - 64, G.ink3, 0.55);
}

/* ------------------------------------------------------------------ 1 · title */

function sTitle(t, d, cues) {
  const a1 = at(cues, 1, 2.8);
  sheet(150, 150, 980, 400, { alpha: seg(t, 0, 0.6) });
  cropMarks(170, 170, 940, 360, G.edge, seg(t, 0.2, 0.8));
  mark(355, 350, 4.1, seg(t, 0.2, 2.2));
  text("Graft", 560, 345 + (1 - outCubic(seg(t, 1.2, 2))) * 16, { size: 132, font: FELL, color: G.ink, alpha: seg(t, 1.2, 2) });
  rule(566, 1060, 372, 2, G.cambium, seg(t, 1.6, 2.6));
  body(S.tagline1, 566, 418, { size: 25, alpha: seg(t, a1, a1 + 0.6) });
  body(S.tagline2, 566, 452, { size: 25, color: G.ink2, alpha: seg(t, a1 + 0.3, a1 + 0.9) });
  lbl(S.status, 566, 504, { size: 13, weight: 700, color: G.logic, spacing: "1.5px", alpha: seg(t, a1 + 1.2, a1 + 1.8) });
  lbl("mmornati/graft", 1110, 532, { size: 12, color: G.ink3, align: "right", alpha: seg(t, a1 + 1.2, a1 + 1.8) });
}

/* ------------------------------------------------------------------ 2 · problem */

const QUEUE = [
  ["#801", "feat: add CSV export to reports", "agent"], ["#802", "fix: retry loop on webhook timeout", "agent"],
  ["#803", "chore: bump lodash to 4.17.22", "agent"], ["#804", "feat: login rate limiter", "agent"],
  ["#805", "docs: fix typo in setup guide", "human"], ["#806", "refactor: split billing service", "agent"],
  ["#807", "test: cover zone boundaries", "agent"], ["#808", "ci: cache pnpm store", "agent"],
];
const DIFF = [
  ["+", "export function limit(account) {"], ["+", "  const key = `login:${account}`;"], ["+", "  const n = await store.incr(key);"],
  ["+", "  if (n === 1) await store.expire(key, 900);"], ["+", "  return n <= 5;"], ["+", "}"],
  [" ", ""], ["-", "if (!user) return res.status(401);"], ["+", "if (!user || !(await limit(id)))"], ["+", "  return res.status(429);"],
];

function sProblem(t, d, cues) {
  const a1 = at(cues, 1, 5.6), a2 = at(cues, 2, 8.4);
  plate("I", "The problem", seg(t, 0, 0.5));
  head("Agents open pull requests faster", "than people can read them.", seg(t, 0.1, 0.7), seg(t, 0.4, 1.0));

  // the review queue fills up
  lbl("REVIEW QUEUE · acme/api", 80, 262, { size: 12, weight: 700, color: G.ink3, spacing: "1px", alpha: seg(t, 0.4, 0.9) });
  rule(80, 560, 274, 2, G.ink, seg(t, 0.4, 1));
  QUEUE.forEach(([n, title, who], i) => {
    const k = seg(t, 0.8 + i * 0.55, 1.2 + i * 0.55), y = 302 + i * 36;
    alpha(k, () => {
      ctx.translate(0, (1 - outCubic(k)) * -10);
      lbl(n, 80, y, { size: 14, weight: 700, color: G.ink3 });
      lbl(title, 134, y, { size: 14 });
      if (who === "agent") agent(545, y - 6, 18); else human(545, y - 6, 18);
      rule(80, 560, y + 13, 1, G.rule);
    });
  });

  // the reviewer reads every line
  sheet(640, 236, 560, 196, { fill: G.code, alpha: seg(t, a1 - 0.3, a1 + 0.3) });
  alpha(seg(t, a1 - 0.3, a1 + 0.3), () => {
    lbl("src/auth/rate-limit.ts", 656, 258, { size: 12, weight: 700, color: G.ink3 });
    DIFF.forEach(([s, l], i) => lbl(`${s} ${l}`, 656, 282 + i * 15, { size: 12, color: s === "-" ? G.ink3 : G.ink }));
    const scan = 268 + ((Math.max(0, t - a1) * 34) % 150);
    ctx.fillStyle = "rgba(47,138,34,0.14)"; ctx.fillRect(644, scan, 552, 16);
    human(1150, 394, 30, 1); magnifier(1172, 390, 46, 1);
  });

  // the description comes from the agent being judged
  const kd = seg(t, a2 - 0.2, a2 + 0.4);
  sheet(640, 456, 520, 120, { fill: G.label, alpha: kd });
  alpha(kd, () => {
    lbl("## Summary", 660, 484, { size: 14, weight: 700 });
    body("This PR safely adds a rate limiter. All tests pass.", 660, 512, { size: 16, color: G.ink2 });
    body("No other behaviour changes.", 660, 538, { size: 16, color: G.ink2 });
    agent(1124, 500, 26);
  });
  const ks = seg(t, a2 + 1.2, a2 + 1.8);
  alpha(ks, () => rot(1040, 574, -3, () => {
    sheet(-170, -24, 340, 44, { fill: "#e5ecda", pinned: true });
    text("written by the agent being judged", 0, 5, { size: 19, weight: "italic 400", font: FELL, color: G.ink, align: "center" });
    pin(-158, -12);
  }));
}

/* ------------------------------------------------------------------ 3 · cast */

function sCast(t, d, cues) {
  const a = [1, 2, 3].map((i, j) => at(cues, i, 2.4 + j * 2)), a4 = at(cues, 4, 8.7);
  plate("II", "Who is involved", seg(t, 0, 0.5));
  head("Three roles, one repository.", null, seg(t, 0.1, 0.7));
  const CAST = [
    { x: 80, draw: (x, y, k) => agent(x, y, 64, k), role: "The agent", l1: "Writes the code and opens", l2: "the pull request.", tag: "+ Graft-* trailers" },
    { x: 480, draw: (x, y, k) => { human(x, y, 64, k); magnifier(x + 44, y + 6, 70, k); }, role: "The reviewer", l1: "Decides what merges,", l2: "reading the card first.", tag: "reads graft/intent" },
    { x: 880, draw: (x, y, k) => { human(x, y, 64, k); ruler(x + 48, y + 14, 70, k); }, role: "The platform owner", l1: "Sets the rules every pull", l2: "request is checked against.", tag: "writes graft.yaml" },
  ];
  CAST.forEach((c, i) => {
    const k = seg(t, a[i] - 0.3, a[i] + 0.4);
    alpha(k, () => {
      ctx.translate(0, (1 - outCubic(k)) * 18);
      sheet(c.x, 200, 320, 296, {});
      tape(c.x + 160, 202, 74, 18, i === 1 ? 2 : -3);
      c.draw(c.x + 160, 282, outCubic(k));
      text(c.role, c.x + 160, 376, { size: 31, font: FELL, align: "center" });
      body(c.l1, c.x + 160, 410, { size: 17, color: G.ink2, align: "center" });
      body(c.l2, c.x + 160, 434, { size: 17, color: G.ink2, align: "center" });
      lbl(c.tag, c.x + 160, 474, { size: 14, weight: 700, color: G.cambiumInk, align: "center" });
    });
  });
  // GitHub stays as it is
  const kb = seg(t, a4 - 0.2, a4 + 0.6);
  CAST.forEach(c => line(partial([[c.x + 160, 500], [c.x + 160, 534]], kb), G.ink3, 1.5, 0.9, [3, 4]));
  alpha(kb, () => {
    flat(80, 534, 1120, 52, { fill: G.sheet, stroke: G.ink, lw: 1.5 });
    lbl("GITHUB", 104, 566, { size: 15, weight: 700, spacing: "2px" });
    lbl("code · pull requests · CI · branch protection — unchanged", 210, 566, { size: 15, color: G.ink2 });
    mark(1160, 556, 0.62, 1);
    lbl("Graft sits on top", 1128, 566, { size: 13, weight: 700, color: G.cambiumInk, align: "right" });
  });
}

/* ------------------------------------------------------------------ 4 · flow */

function node(x, y, w, h, title, sub, k, o = {}) {
  alpha(k, () => {
    sheet(x, y, w, h, { fill: o.fill ?? G.sheet, stroke: o.stroke ?? G.edge, lw: o.lw });
    lbl(title, x + w / 2, y + 34, { size: 17, weight: 700, align: "center" });
    body(sub, x + w / 2, y + 60, { size: 14, color: G.ink2, align: "center" });
  });
}
function wire(x1, y1, x2, y2, k, t, live, label, o = {}) {
  arrow(x1, y1, x2, y2, outCubic(k), G.ink, 1);
  if (live && k >= 1) packets(x1, y1, x2, y2, t, { n: 2, period: 1.2, color: G.cambium, r: 4 });
  if (label) lbl(label, (x1 + x2) / 2, (o.ly ?? y1 - 12), { size: 12, color: G.ink3, align: "center", alpha: seg(k, 0.6, 1) });
}

function sFlow(t, d, cues) {
  const a1 = at(cues, 1, 4.2), a2 = at(cues, 2, 8.2), a3 = at(cues, 3, 14);
  plate("III", "How it works", seg(t, 0, 0.5));
  head("One webhook in, four answers out.", null, seg(t, 0.1, 0.7));
  const Y = 262, NH = 84;
  node(80, Y, 170, NH, "GitHub", "pull request opened", seg(t, 0.3, 0.8));
  wire(250, Y + 42, 330, Y + 42, seg(t, 1.0, 1.6), t, t < a2, "signed", { ly: Y + 30 });
  node(330, Y, 190, NH, "Server", "verify · dedupe · enqueue", seg(t, 1.3, 1.9));
  // the three server checks tick with the second sentence
  ["signature", "duplicate", "queued"].forEach((s, i) => {
    const k = seg(t, a1 + 0.4 + i * 0.9, a1 + 0.9 + i * 0.9);
    check(400, Y + NH + 26 + i * 24, 14, G.cambiumInk, k);
    lbl(s, 416, Y + NH + 31 + i * 24, { size: 13, color: G.ink2, alpha: k });
  });
  wire(520, Y + 42, 600, Y + 42, seg(t, a1 + 2.6, a1 + 3.1), t, t < a3, "job");
  node(600, Y, 190, NH, "Queue", "Postgres + pg-boss", seg(t, a1 + 2.8, a1 + 3.3));
  wire(790, Y + 42, 870, Y + 42, seg(t, a2 - 0.6, a2), t, t < a3, null);
  node(870, Y, 190, NH, "Worker", "one job per concern", seg(t, a2 - 0.4, a2 + 0.2), { fill: G.soft, stroke: G.cambium, lw: 1.5 });

  // the worker reads everything again from the GitHub API
  const kr = seg(t, a2 + 0.6, a2 + 2.2);
  const arc = []; for (let i = 0; i <= 40; i++) { const u = i / 40; arc.push([lerp(965, 165, u), Y - 6 - Math.sin(Math.PI * u) * 34]); }
  if (kr > 0) line(partial(arc, outCubic(kr)), G.cambiumInk, 2, 1, [6, 5]);
  lbl("re-reads PR, commits, diff and graft.yaml from the GitHub API", 565, Y - 50, { size: 13, weight: 700, color: G.cambiumInk, align: "center", alpha: seg(kr, 0.5, 1) });
  const kx = seg(t, a2 + 2.8, a2 + 3.4);
  cross(290, Y + 72, 7, G.ink, kx);
  lbl("payload not trusted", 250, Y + 100, { size: 12, color: G.ink3, align: "center", alpha: kx });

  // writer and verifier
  wire(1060, Y + 42, 1110, Y + 42, seg(t, a2 + 3.6, a2 + 4.0), t, t < a3 + 2, null);
  alpha(seg(t, a2 + 3.8, a2 + 4.4), () => {
    sheet(1110, Y - 6, 90, 96, { fill: G.label });
    lbl("model", 1155, Y + 20, { size: 12, color: G.ink3, align: "center" });
    lbl("writer", 1155, Y + 46, { size: 14, weight: 700, align: "center" });
    lbl("verifier", 1155, Y + 70, { size: 14, weight: 700, align: "center" });
  });

  // three neutral check runs and one managed comment, back on the pull request
  const ko = seg(t, a3 - 0.2, a3 + 0.6);
  if (ko > 0) line(partial([[965, Y + NH], [965, 444]], outCubic(ko)), G.ink, 1.5);
  if (ko > 0) line(partial([[965, 412], [560, 412], [560, 444]], outCubic(seg(ko, 0.3, 1))), G.ink, 1.5);
  alpha(seg(t, a3 + 0.2, a3 + 0.8), () => {
    sheet(330, 444, 430, 132, {});
    lbl("CHECKS", 350, 470, { size: 12, weight: 700, color: G.ink3, spacing: "1px" });
    ["graft/provenance", "graft/intent", "graft/policy"].forEach((c, i) => {
      const y = 498 + i * 28;
      ring(358, y - 5, 7, G.ink3, 1.6); line([[354, y - 5], [362, y - 5]], G.ink3, 1.6);
      lbl(c, 376, y, { size: 15, weight: 700 });
      lbl("neutral", 740, y, { size: 14, color: G.ink3, align: "right" });
    });
    sheet(800, 444, 400, 132, { fill: G.label });
    text("Graft", 822, 478, { size: 25, font: FELL });
    lbl("one managed comment", 1180, 476, { size: 12, color: G.ink3, align: "right" });
    rule(822, 1180, 490, 1.5, G.ink);
    ["Intent", "Provenance", "Policy"].forEach((s, i) => body(s, 822 + i * 124, 524, { size: 18, weight: 600 }));
    lbl("edits are overwritten", 822, 558, { size: 12, color: G.ink3 });
  });
  lbl("back on the pull request", 80, 496, { size: 13, color: G.ink3, alpha: seg(t, a3 + 0.6, a3 + 1.2) });
  arrow(80, 512, 316, 512, seg(t, a3 + 0.6, a3 + 1.2), G.ink3);
}

/* ------------------------------------------------------------------ 5 · provenance */

const PROV = [
  ["Authored by", "Agent (Graft trailers)"], ["Agent", "claude-code"], ["Model", "claude-sonnet-5-5"],
  ["Task", "#128"], ["Session", "agents.example.com"], ["Opened by", "acme-agent[bot]"],
];

function sProvenance(t, d, cues) {
  const a1 = at(cues, 1, 2.5), a2 = at(cues, 2, 7.6), a3 = at(cues, 3, 10.4);
  plate("IV", "First answer", seg(t, 0, 0.5));
  head("Who wrote it?", null, seg(t, 0.1, 0.7));
  const L = [
    { s: 'git commit -m "Add login rate limiter" \\', w: 700 },
    { s: '  --trailer "Graft-Agent: claude-code" \\' },
    { s: '  --trailer "Graft-Model: claude-sonnet-5-5" \\' },
    { s: '  --trailer "Graft-Task: #128" \\' },
    { s: '  --trailer "Graft-Session: https://agents.example.com/…"' },
  ].map((l, i) => ({ ...l, a: a1 + i * 0.75, b: a1 + i * 0.75 + 0.65, c: i ? G.cabGreen : G.cabInk }));
  cabTerm(80, 204, 640, 196, t, "agent session — zsh", L, { alpha: seg(t, a1 - 0.6, a1), size: 15, lh: 26 });
  agent(690, 176, 26, seg(t, a1 - 0.6, a1));

  alpha(seg(t, a1 + 3.6, a1 + 4.2), () => {
    lbl("or the prepare-commit-msg hook adds them", 80, 432, { size: 14, weight: 700, color: G.ink2 });
    lbl("from GRAFT_AGENT, GRAFT_MODEL, GRAFT_TASK, GRAFT_SESSION", 80, 454, { size: 14, color: G.ink2 });
  });
  lbl("ALSO COUNTED AS AGENT", 80, 500, { size: 12, weight: 700, color: G.ink3, spacing: "1px", alpha: seg(t, a2 - 0.2, a2 + 0.3) });
  ["GitHub bot account", "configured login", "agent co-author"].forEach((s, i) => {
    const k = seg(t, a2 + i * 0.5, a2 + 0.4 + i * 0.5), x = 80 + [0, 210, 400][i];
    alpha(k, () => {
      flat(x, 516, measure(s, 14, 700, CP) + 28, 34, { fill: G.sheet, stroke: G.ink, r: 3 });
      lbl(s, x + 14, 538, { size: 14, weight: 700 });
    });
  });

  // the accession label
  const kl = seg(t, 0.6, 1.4);
  alpha(kl, () => rot(980, 220, (1 - outBack(kl)) * 8 - 1.2, () => {
    sheet(-210, 0, 420, 336, { fill: G.label, pinned: true });
    tape(0, 2, 90, 20, 2);
    text("Provenance", -186, 52, { size: 30, font: FELL });
    rule(-186, 186, 66, 1.5, G.ink);
    PROV.forEach(([k, v], i) => {
      const y = 100 + i * 34, kv = seg(t, a3 - 0.4 + i * 0.35, a3 + i * 0.35);
      lbl(k, -186, y, { size: 14, color: G.ink3 });
      lbl(typed(v, kv), -50, y, { size: 15, weight: 700, color: i === 4 ? G.cambiumInk : G.ink });
      rule(-186, 186, y + 11, 1, G.edge);
    });
    lbl("Head 4c9e1f2 · 2 commits, 2 with Graft trailers", -186, 316, { size: 12, color: G.ink3, alpha: seg(t, a3 + 2, a3 + 2.5) });
  }));
  lbl("graft/provenance · fictional acme example", 980, 580, { size: 12, color: G.ink3, align: "center", alpha: kl });
}

/* ------------------------------------------------------------------ 6 · intent */

function sIntent(t, d, cues) {
  const a1 = at(cues, 1, 2.9), a2 = at(cues, 2, 5.5), a3 = at(cues, 3, 10.9);
  plate("V", "Second answer", seg(t, 0, 0.5));
  head("What does it claim to do?", null, seg(t, 0.1, 0.7));

  // inputs
  const INS = [["PR title + description", "written by the agent"], ["linked issue", "#128"], ["file list", "3 files"], ["diff", "+46 −3"]];
  INS.forEach(([a, b], i) => {
    const y = 212 + i * 88, k = seg(t, 0.5 + i * 0.25, 1.0 + i * 0.25);
    const fence = i === 0 ? seg(t, a3, a3 + 0.6) : 0;
    alpha(k, () => {
      sheet(80, y, 290, 70, { fill: i === 0 ? G.label : G.sheet, stroke: fence > 0 ? G.cambiumInk : G.edge, lw: fence > 0 ? 2 : 1, dash: fence > 0 ? [6, 4] : null });
      lbl(a, 98, y + 30, { size: 15, weight: 700 });
      lbl(b, 98, y + 54, { size: 13, color: G.ink3 });
      arrow(370, y + 35, 412, y + 35, seg(t, a1 - 0.4, a1), G.ink3);
    });
  });
  // the PR text is fenced as data
  alpha(seg(t, a3 + 0.4, a3 + 1.0), () => {
    lbl("<data nonce=7f3a>", 98, 204, { size: 12, weight: 700, color: G.cambiumInk });
    rot(330, 205, 4, () => {
      flat(-62, -14, 124, 26, { fill: G.cambiumInk, stroke: false, r: 3 });
      lbl("DATA ONLY", 0, 4, { size: 12, weight: 700, color: "#fff", align: "center", spacing: "1px" });
    });
  });

  // the writer drafts the card
  const kc = seg(t, a1 - 0.2, a1 + 0.4), kt = seg(t, a1 + 0.2, a2 + 1.5);
  alpha(kc, () => {
    sheet(430, 212, 430, 358, {});
    lbl("INTENT CARD · writer model", 452, 240, { size: 12, weight: 700, color: G.ink3, spacing: "1px" });
    rule(452, 838, 252, 1.5, G.ink);
    body("Goal", 452, 282, { size: 15, weight: 600, color: G.ink3 });
    para("Limit failed login attempts to 5 per account per 15 minutes, then lock the account for 15 minutes.", 452, 306, 386, { size: 16, lh: 23, font: LIT, color: G.ink, k: seg(kt, 0, 0.45) });
    body("Behavior changes", 452, 392, { size: 15, weight: 600, color: G.ink3, alpha: seg(kt, 0.45, 0.5) });
    para("• The sixth failed login returns 429 with a Retry-After header.", 452, 416, 386, { size: 15, lh: 22, font: LIT, k: seg(kt, 0.5, 0.75) });
    para("• A successful login resets the counter.", 452, 462, 386, { size: 15, lh: 22, font: LIT, k: seg(kt, 0.75, 0.9) });
    body("Out-of-scope edits", 452, 512, { size: 15, weight: 600, color: G.ink3, alpha: seg(kt, 0.9, 1) });
    lbl("none", 452, 538, { size: 15, weight: 700, alpha: seg(kt, 0.95, 1) });
  });
  // the verifier slip
  const kv = seg(t, a2 - 0.2, a2 + 0.5);
  alpha(kv, () => rot(1040, 380, -2.2, () => {
    sheet(-150, -160, 300, 330, { fill: "#e5ecda", pinned: true });
    pin(0, -146);
    text("Verifier", -128, -108, { size: 28, weight: "italic 400", font: FELL });
    lbl("a second model call", -128, -86, { size: 12, color: G.ink3 });
    lbl("SEES", -128, -54, { size: 12, weight: 700, color: G.cambiumInk, spacing: "1px" });
    lbl("diff · file list · card", -128, -34, { size: 14 });
    lbl("NEVER SEES", -128, -4, { size: 12, weight: 700, color: G.ink3, spacing: "1px" });
    lbl("title · description · issue", -128, 16, { size: 14, color: G.ink3 });
    line([[-128, 11], [lerp(-128, 96, seg(t, a2 + 1.5, a2 + 2.3)), 11]], G.ink3, 1.4);
    rule(-128, 128, 34, 1, G.edge);
    ["goal", "429 + Retry-After", "counter reset"].forEach((c, i) => {
      const k = seg(t, a2 + 2.6 + i * 0.6, a2 + 3.1 + i * 0.6);
      check(-118, 60 + i * 28, 14, G.cambiumInk, k);
      lbl(c, -100, 65 + i * 28, { size: 14, alpha: k });
    });
    lbl("3 of 3 claims supported", -128, 150, { size: 14, weight: 700, color: G.cambiumInk, alpha: seg(t, a2 + 4.6, a2 + 5.1) });
  }));
}

/* ------------------------------------------------------------------ 7 · risk floor (a cabinet in both themes) */

function sFloor(t, d, cues) {
  const a1 = at(cues, 1, 2.7), a2 = at(cues, 2, 8.4);
  ctx.save(); ctx.globalAlpha *= seg(t, 0, 0.35); ctx.fillStyle = G.cab; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = G.cabRule; ctx.lineWidth = 1; ctx.globalAlpha *= 0.5;
  for (let x = 40; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  ctx.restore();
  plate("VI", "Third answer", seg(t, 0, 0.5), { dark: true });
  head("Rules set the floor.", "A model can only raise it.", seg(t, 0.1, 0.7), seg(t, a2 - 0.2, a2 + 0.4), { dark: true });

  const X0 = 140, CW = 333, Y0 = 318, CH = 82, CLS = ["trivial", "logic", "sensitive"];
  CLS.forEach((c, i) => {
    const x = X0 + i * CW, k = seg(t, 0.4 + i * 0.2, 0.9 + i * 0.2);
    alpha(k, () => {
      flat(x, Y0, CW - 6, CH, { fill: G.cab2, stroke: G.cabRule, r: 3 });
      if (i === 1) { ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = RISK_DARK.logic; ctx.lineWidth = 2; rr(x + 7, Y0 + 7, CW - 20, CH - 14, 3); ctx.stroke(); ctx.restore(); }
      if (i === 2) { ctx.save(); ctx.strokeStyle = RISK_DARK.sensitive; ctx.lineWidth = 3; rr(x + 6, Y0 + 6, CW - 18, CH - 12, 3); ctx.stroke(); ctx.lineWidth = 1; rr(x + 13, Y0 + 13, CW - 32, CH - 26, 2); ctx.stroke(); ctx.restore(); }
      if (i === 0) { ctx.save(); ctx.strokeStyle = RISK_DARK.trivial; ctx.lineWidth = 1.5; rr(x + 7, Y0 + 7, CW - 20, CH - 14, 3); ctx.stroke(); ctx.restore(); }
      lbl(c.toUpperCase(), x + (CW - 6) / 2, Y0 + 49, { size: 20, weight: 700, color: RISK_DARK[c], align: "center", spacing: "2px" });
    });
  });

  // rules push the floor up as they match
  const RULES = [
    ["docs/guide.md", "nothing matched", 0], ["test lost 10+ lines", "logic", 1], ["src/auth/login.ts", "auth path", 2],
  ];
  let level = 0;
  RULES.forEach(([p, why, lv], i) => {
    const k = seg(t, a1 + 0.3 + i * 1.6, a1 + 0.8 + i * 1.6);
    if (k >= 1) level = Math.max(level, lv);
    alpha(k, () => {
      const x = X0 + i * CW;
      lbl(p, x, 452, { size: 16, weight: 700, color: G.cabInk });
      lbl(`→ ${why}`, x, 476, { size: 14, color: G.cabInk2 });
    });
  });
  const mk = X0 + level * CW + (CW - 6) / 2;
  // the model tries to lower it and bounces back
  const kd = seg(t, a2 + 0.4, a2 + 1.6), bounce = Math.sin(Math.PI * clamp(kd * 1.4)) * (kd < 1 ? 1 : 0);
  const mx = mk - bounce * 60;
  alpha(seg(t, 0.8, 1.2), () => {
    ctx.beginPath(); ctx.moveTo(mx, Y0 - 6); ctx.lineTo(mx - 11, Y0 - 24); ctx.lineTo(mx + 11, Y0 - 24); ctx.closePath();
    ctx.fillStyle = G.cabGreen; ctx.fill();
    lbl("FLOOR", mx, Y0 - 32, { size: 13, weight: 700, color: G.cabGreen, align: "center", spacing: "1px" });
  });
  alpha(seg(t, a2 + 0.2, a2 + 0.6), () => {
    const y = 548;
    lbl("model says: trivial", 140, y, { size: 16, weight: 700, color: G.cabInk });
    arrow(410, y - 5, 350, y - 5, 1, G.cabInk2);
    cross(440, y - 6, 8, G.cabInk, seg(t, a2 + 0.9, a2 + 1.3));
    lbl("cannot lower", 460, y, { size: 16, color: G.cabInk2, alpha: seg(t, a2 + 0.9, a2 + 1.3) });
    lbl("final = max(floor, writer, verifier)", 1140, y, { size: 16, weight: 700, color: G.cabGreen, align: "right", alpha: seg(t, a2 + 1.4, a2 + 1.9) });
  });
  stamp("sensitive", 1090, 170, seg(t, a2 + 1.8, a2 + 2.3), { dark: true, sub: "final", rot: -12 });
}

/* ------------------------------------------------------------------ 8 · policy */

const YAML = [
  ["rules:", 0],
  ["  - name: trivial", 1], ["    match: { risk: trivial }", 1], ["    approve: auto", 1],
  ["  - name: infra-and-auth", 2], ['    match: { paths: ["infra/**", "**/auth/**"] }', 2], ["    require: { humans: 1, team: security }", 2],
  ["  - name: agent-sensitive", 3], ["    match: { author: agent, risk: sensitive }", 3], ["    require: { humans: 2 }", 3],
  ["  - name: no-agent-secrets", 4], ['    match: { paths: ["secrets/**"], author: agent }', 4], ["    block: true", 4],
];

function yamlLine(s, x, y, o) {
  // keys in bold cambium-ink, strings in logic amber, the rest in ink (the code plate of DESIGN.md)
  const m = s.match(/^(\s*-?\s*)([a-z_]+:)(.*)$/);
  if (!m) { lbl(s, x, y, o); return; }
  lbl(m[1], x, y, o);
  const x1 = x + measure(m[1], o.size, 400, CP);
  lbl(m[2], x1, y, { ...o, weight: 700, color: G.cambiumInk });
  const x2 = x1 + measure(m[2], o.size, 700, CP);
  let cx = x2;
  m[3].split(/("[^"]*")/).forEach(part => {
    if (!part) return;
    const str = part.startsWith('"');
    lbl(part, cx, y, { ...o, color: str ? G.logic : G.ink });
    cx += measure(part, o.size, 400, CP);
  });
}

function sPolicy(t, d, cues) {
  const a1 = at(cues, 1, 3.0), a2 = at(cues, 2, 7.8);
  plate("VII", "Fourth answer", seg(t, 0, 0.5));
  head("What does the policy say?", null, seg(t, 0.1, 0.7));

  const kp = seg(t, 0.4, 1.0);
  alpha(kp, () => {
    ctx.save(); rr(80, 200, 250, 30, [4, 4, 0, 0]); ctx.fillStyle = G.ink; ctx.fill(); ctx.restore();
    lbl("graft.yaml · main @ 9d8c7b6", 96, 220, { size: 13, weight: 700, color: G.sheet });
    flat(80, 230, 600, 348, { fill: G.code });
    const hit = new Set(t > a2 + 1.0 ? [2, 3] : []);
    YAML.forEach(([s, r], i) => {
      const y = 262 + i * 24.5;
      if (hit.has(r)) { ctx.save(); ctx.fillStyle = "rgba(47,138,34,0.16)"; ctx.fillRect(84, y - 17, 592, 24.5); ctx.restore(); }
      yamlLine(s, 100, y, { size: 15, alpha: seg(t, 0.6 + i * 0.08, 0.9 + i * 0.08) });
    });
  });

  // read from the base branch only
  alpha(seg(t, a1 - 0.2, a1 + 0.4), () => {
    lbl("READ FROM", 730, 226, { size: 12, weight: 700, color: G.ink3, spacing: "1px" });
    flat(730, 238, 200, 40, { fill: G.soft, stroke: G.cambiumInk, lw: 1.5, r: 3 });
    lbl("base: main", 746, 264, { size: 15, weight: 700, color: G.cambiumInk });
    check(910, 258, 16, G.cambiumInk, seg(t, a1 + 0.6, a1 + 1.1));
    flat(950, 238, 250, 40, { fill: G.sheet, stroke: G.rule, r: 3 });
    lbl("PR's own copy", 966, 264, { size: 15, color: G.ink3 });
    cross(1176, 258, 8, G.ink3, seg(t, a1 + 1.0, a1 + 1.5));
    lbl("the pull request's own copy never counts", 730, 300, { size: 13, color: G.ink3, alpha: seg(t, a1 + 1.4, a1 + 2) });
  });

  // precedence
  const ORDER = [["block", "wins"], ["require", "then"], ["approve", "then"]];
  rule(730, 1200, 334, 2, G.ink, seg(t, a2 - 0.3, a2 + 0.3));
  ORDER.forEach(([w, c], i) => {
    const k = seg(t, a2 + i * 0.7, a2 + 0.4 + i * 0.7), y = 366 + i * 34;
    alpha(k, () => {
      text(["i.", "ii.", "iii."][i], 730, y, { size: 20, weight: "italic 400", font: FELL, color: G.cambiumInk });
      lbl(w, 780, y, { size: 17, weight: 700 });
      body(c, 880, y, { size: 16, color: G.ink2 });
      rule(730, 1200, y + 12, 1, G.rule);
    });
  });
  // the verdict for the fictional rate-limiter PR
  const kv = seg(t, a2 + 1.8, a2 + 2.4);
  alpha(kv, () => rot(965, 520, -1.5, () => {
    sheet(-235, -46, 470, 92, { fill: G.label, pinned: true });
    lbl("acme/api #804 · login rate limiter", -215, -18, { size: 12, color: G.ink3 });
    lbl("Would require 2 humans", -215, 10, { size: 18, weight: 700 });
    lbl("(1 from @acme/security) · report only", -215, 32, { size: 14, color: G.ink2 });
  }));
}

/* ------------------------------------------------------------------ 9 · a new way of working */

function sWorkflow(t, d, cues) {
  const a = [1, 2, 3, 4].map((i, j) => at(cues, i, 2.6 + j * 3));
  plate("VIII", "A new way of working", seg(t, 0, 0.5));
  head("Read the card", "before the diff.", seg(t, 0.1, 0.7), seg(t, 0.3, 0.9), { y: 140, size: 44 });
  const LX = 80, RX = 660, CW = 540;
  alpha(seg(t, 0.4, 0.9), () => {
    text("Before", LX, 236, { size: 28, font: FELL, color: G.ink2 });
    text("With Graft", RX, 236, { size: 28, font: FELL });
    mark(RX + 146, 228, 0.44, 1);
    rule(LX, LX + CW, 250, 2, G.ink);
    rule(RX, RX + CW, 250, 2, G.ink);
    human(1150, 218, 30, 1); magnifier(1172, 212, 46, 1);
  });
  const ROWS = [
    { k: a[0], l: "Read every diff, line by line", r: "Read the intent card first" },
    { k: a[0] + 0.9, l: "Start from the agent's own description", r: "Every claim checked against the diff" },
    { k: a[1], l: "Every pull request waits for the same people", r: "trivial", r2: "could be auto-approved", r3: "sensitive", r4: "to security" },
    { k: a[2], l: "Who wrote it? Guesswork", r: "Agent, model, task, session on every PR" },
    { k: a[3], l: "No measure of review quality", r: "“Card is accurate” votes, measured" },
  ];
  ROWS.forEach((row, i) => {
    const y = 290 + i * 60, kl = seg(t, row.k - 0.2, row.k + 0.3), kr = seg(t, row.k + 0.3, row.k + 0.8);
    alpha(kl, () => { body(row.l, LX, y, { size: 18, color: G.ink3 }); rule(LX, LX + CW, y + 22, 1, G.rule); });
    alpha(kr, () => {
      check(RX + 8, y - 6, 14, G.cambiumInk, kr);
      if (row.r2) {
        const w1 = riskTag("trivial", RX + 30, y - 6);
        body(row.r2, RX + 40 + w1, y, { size: 17 });
        const w2 = riskTag("sensitive", RX + 330, y - 6);
        body(row.r4, RX + 340 + w2, y, { size: 17 });
      } else body(row.r, RX + 30, y, { size: 18 });
      rule(RX, RX + CW, y + 22, 1, G.rule);
    });
  });
  lbl("agents: same workflow + four commit trailers", RX + 30, 594, { size: 13, weight: 700, color: G.cambiumInk, alpha: seg(t, a[2] + 1.2, a[2] + 1.8) });
}

/* ------------------------------------------------------------------ 10 · privacy and shadow mode */

function sTrust(t, d, cues) {
  const a1 = at(cues, 1, 4.7), a2 = at(cues, 2, 7.4), a3 = at(cues, 3, 11);
  plate("IX", "Privacy and shadow mode", seg(t, 0, 0.5));
  head("Graft keeps the label,", "not the specimen.", seg(t, 0.1, 0.7), seg(t, 0.4, 1.0), { y: 140, size: 44 });
  const COLS = [
    { x: 80, h: "Never stored", items: ["file contents", "diffs", "PR titles and bodies", "commit messages"], k: 0.5, c: G.ink },
    { x: 320, h: "Stored", items: ["paths", "commit SHAs", "numbers", "the model's own prose"], k: a1 - 0.2, c: G.ink },
    { x: 560, h: "Sent to Anthropic", items: ["the diff", "PR title and body", "the linked issue", "to write and check cards"], k: a1 + 1.4, c: G.ink2 },
  ];
  COLS.forEach((c, i) => {
    const k = seg(t, c.k, c.k + 0.5);
    alpha(k, () => {
      rule(c.x, c.x + 210, 250, 2, G.ink);
      text(c.h, c.x, 236, { size: 23, font: FELL });
      c.items.forEach((s, j) => {
        const y = 282 + j * 40, kk = seg(t, c.k + 0.2 + j * 0.15, c.k + 0.5 + j * 0.15);
        alpha(kk, () => {
          if (i === 0) cross(c.x + 6, y - 6, 5, G.ink3, 1); else if (i === 1) check(c.x + 6, y - 6, 12, G.cambiumInk, 1); else dot(c.x + 6, y - 6, 3, G.ink3);
          body(s, c.x + 22, y, { size: 16, color: c.c });
          rule(c.x, c.x + 210, y + 16, 1, G.rule);
        });
      });
    });
  });
  para("Graft keeps only review metadata. GitHub keeps the code, the pull requests and CI, so removing Graft leaves every repository intact.", 80, 484, 690, { size: 17, lh: 26, font: LIT, color: G.ink2, alpha: seg(t, a1 + 2.4, a1 + 3) });

  // the field note on shadow mode
  const kn = seg(t, a2 - 0.3, a2 + 0.4);
  alpha(kn, () => rot(1000, 400, 1.2, () => {
    sheet(-185, -186, 370, 362, { fill: G.label, pinned: true });
    ctx.save(); ctx.strokeStyle = "rgba(83,96,102,0.25)"; ctx.lineWidth = 1;
    for (let y = -122; y < 170; y += 32) { ctx.beginPath(); ctx.moveTo(-165, y); ctx.lineTo(165, y); ctx.stroke(); }
    ctx.restore();
    text("Field note", -160, -138, { size: 28, weight: "italic 400", font: FELL });
    const N = [["Phase 0 · report only", 0], ["every check: neutral", 0.5], ["“would approve” is not approval", 1.0], ["branch protection unchanged", 1.5]];
    N.forEach(([s, dl], j) => lbl(s, -160, -97 + j * 32, { size: 15, weight: j ? 400 : 700, alpha: seg(t, a2 + dl, a2 + dl + 0.4) }));
    // the gate
    const kg = seg(t, a3 - 0.2, a3 + 0.4);
    alpha(kg, () => {
      lbl("GATE · card accuracy", -160, 50, { size: 12, weight: 700, color: G.ink3, spacing: "1px" });
      ctx.strokeStyle = G.ink; ctx.lineWidth = 1.5; ctx.strokeRect(-160, 62, 320, 18);
      const gx = -160 + 320 * 0.9 * outCubic(seg(t, a3 + 0.3, a3 + 1.4));
      line([[gx, 56], [gx, 86]], G.cambiumInk, 3);
      lbl("90%", gx, 104, { size: 14, weight: 700, color: G.cambiumInk, align: "center" });
      lbl("then Phase 1: enforce (planned)", -160, 140, { size: 14, color: G.ink2, alpha: seg(t, a3 + 1.6, a3 + 2.2) });
    });
    // the amber shadow-mode stamp
    rot(118, -132, 6, () => alpha(seg(t, a2 + 0.2, a2 + 0.7), () => {
      ctx.strokeStyle = G.logic; ctx.lineWidth = 2; ctx.setLineDash([5, 3]); rr(-58, -20, 116, 40, 5); ctx.stroke(); ctx.setLineDash([]);
      lbl("SHADOW MODE", 0, 5, { size: 13, weight: 700, color: G.logic, align: "center", spacing: "1px" });
    }));
  }));
}

/* ------------------------------------------------------------------ 11 · close */

function sClose(t, d, cues) {
  const a1 = at(cues, 1, 2.8), a2 = at(cues, 2, 5.4);
  ctx.save(); ctx.globalAlpha *= seg(t, 0, 0.4) * 0.85; ctx.fillStyle = G.soft; ctx.fillRect(0, 0, W, H); ctx.restore();
  mark(W / 2, 150, 1.5, seg(t, 0, 1.2));
  head("Read the card", "before you read the diff.", seg(t, 0.2, 0.8), seg(t, 0.5, 1.1), { x: W / 2, y: 262, size: 60, align: "center" });
  alpha(seg(t, a1 - 0.2, a1 + 0.4), () => {
    const cmds = "pnpm install  ·  pnpm db:up  ·  pnpm dev:server";
    const w = measure(cmds, 17, 400, CP) + 48;
    flat(W / 2 - w / 2, 384, w, 46, { fill: G.code, stroke: G.edge });
    lbl(cmds, W / 2, 413, { size: 17, align: "center" });
    lbl("offline quickstart · no GitHub App or API key needed", W / 2, 456, { size: 13, color: G.ink3, align: "center" });
  });
  alpha(seg(t, a2 - 0.2, a2 + 0.4), () => {
    const s = "mmornati.github.io/graft/docs", w = measure(s, 18, 600, LIT) + 48;
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6;
    rr(W / 2 - w / 2, 486, w, 50, 3); ctx.fillStyle = G.cambiumInk; ctx.fill(); ctx.restore();
    body(s, W / 2, 518, { size: 18, weight: 600, color: "#fff", align: "center" });
    lbl(S.fictional, W / 2, 580, { size: 12, color: G.ink3, align: "center" });
  });
}

/* ------------------------------------------------------------------ video */

VIDEO.create({
  title: { en: "Graft, explained" },
  kicker: { en: "Graft · video documentation" },
  langs: ["en"],
  theme: {
    bg: G.board, bg2: G.board, panel: G.sheet, panel2: G.cab2, line: G.rule, ink: G.ink, soft: G.ink2, faint: G.ink3,
    accent: G.cambiumInk, accent2: G.cambium, good: G.trivial, warn: G.logic, bad: G.sensitive, deep: G.soft, term: G.cab, termInk: G.cabInk,
  },
  strings: STR,
  background: board,
  poster: "flow",
  fonts: ['400 20px "IM Fell English"', 'italic 400 20px "IM Fell English"', '400 20px Literata', '600 20px Literata',
    '400 20px "Courier Prime"', '700 20px "Courier Prime"'],
  scenes: {
    title: sTitle, problem: sProblem, cast: sCast, flow: sFlow, provenance: sProvenance, intent: sIntent,
    floor: sFloor, policy: sPolicy, workflow: sWorkflow, trust: sTrust, close: sClose,
  },
});
