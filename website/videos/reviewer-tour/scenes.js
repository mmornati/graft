/* What a reviewer sees: scenes of a canvas video (see ../engine/engine.js and the canvas-video skill).
 *
 * The frame is the herbarium sheet of the landing page (DESIGN.md): mounting-board ground, iron-gall ink, one cambium
 * green, IM Fell for display, Literata for argument, Courier Prime for labels. The pull request itself sits on a
 * GitHub-like surface, and every word on it comes from data.js: the comment and check text Graft's real renderers
 * produced in the offline e2e run e2e-20261021-ugrjhd (fake GitHub, canned model answers). Nothing here is live.
 *
 * Each scene is fn(t, d, cues), a pure function of t; animations hook onto at(cues, i).
 */
"use strict";

const FELL = '"IM Fell English", "Iowan Old Style", Georgia, serif';
const LIT = 'Literata, "Iowan Old Style", Georgia, serif';
const CP = '"Courier Prime", "Courier New", monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';
const GMONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const G = {
  board: "#e4e8df", sheet: "#f6f7f2", edge: "#cfd6c9", label: "#fbfaf2", ink: "#16212a", ink2: "#3c4950", ink3: "#536066",
  rule: "#bcc5b8", cambium: "#2f8a22", cambiumInk: "#22681a", soft: "#d5e8c8", tape: "#e3d8b0", tapeLine: "#b9ab78",
  sensitive: "#b42318", logic: "#8a5600", trivial: "#22681a", code: "#eceee6",
};
const RISK = { trivial: G.trivial, logic: G.logic, sensitive: G.sensitive };
/* the GitHub surface (light theme) */
const GH = {
  bg: "#ffffff", fg: "#1f2328", muted: "#59636e", border: "#d1d9e0", subtle: "#f6f8fa", link: "#0969da", open: "#1a7f37",
  neutral: "#59636e", code: "#eff1f3", tab: "#fd8c73", WARNING: "#9a6700", CAUTION: "#d1242f", IMPORTANT: "#8250df", NOTE: "#0969da",
  btn: "#1f883d",
};

const STR = {
  en: {
    simulated: "SIMULATED · OFFLINE E2E RUN E2E-20261021-UGRJHD",
    simulated2: "fake GitHub · canned model answers · Graft's real renderers",
    sandbox: "mmornati/graft-sandbox (simulated)",
    docs: "mmornati.github.io/graft/docs",
  },
};

/* ------------------------------------------------------------------ herbarium helpers */

function rot(x, y, a, fn) { ctx.save(); ctx.translate(x, y); ctx.rotate(a * Math.PI / 180); fn(); ctx.restore(); }
function alpha(k, fn) { if (k <= 0) return; ctx.save(); ctx.globalAlpha *= clamp(k); fn(); ctx.restore(); }

function plate(num, caption, k, o = {}) {
  const x = o.x ?? 80, y = o.y ?? 82;
  text(`Plate ${num}.`, x, y, { size: 21, weight: "italic 400", font: FELL, color: G.cambiumInk, alpha: k });
  const w = measure(`Plate ${num}.`, 21, "italic 400", FELL);
  text(caption.toUpperCase(), x + w + 12, y - 1, { size: 12, weight: 700, font: CP, color: G.ink3, spacing: "1.2px", alpha: k });
}
function head(l1, l2, k1, k2, o = {}) {
  const x = o.x ?? 80, y = o.y ?? 146, size = o.size ?? 46, gap = o.gap ?? size * 1.04;
  text(l1, x, y + (1 - outCubic(k1)) * 14, { size, font: FELL, color: G.ink, alpha: k1, align: o.align });
  if (l2) text(l2, x, y + gap + (1 - outCubic(k2)) * 14, { size, weight: "italic 400", font: FELL, color: G.cambiumInk, alpha: k2, align: o.align });
}
function sheet(x, y, w, h, o = {}) {
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.shadowColor = o.pinned ? "rgba(0,0,0,0.16)" : "rgba(22,33,42,0.22)";
  ctx.shadowBlur = o.pinned ? 12 : 16; ctx.shadowOffsetY = o.pinned ? 5 : 7;
  rr(x, y, w, h, o.r ?? 4); ctx.fillStyle = o.fill ?? G.sheet; ctx.fill();
  ctx.shadowColor = "transparent";
  if (o.stroke !== false) { ctx.lineWidth = o.lw ?? 1; ctx.strokeStyle = o.stroke ?? G.edge; ctx.stroke(); }
  ctx.restore();
}
function rule(x1, x2, y, w = 1, color = G.rule, k = 1) { if (k > 0) line([[x1, y], [lerp(x1, x2, clamp(k)), y]], color, w); }
function cropMarks(x, y, w, h, color = G.ink3, a = 0.7) {
  const s = 18;
  [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([cx, cy, dx, dy]) => {
    line([[cx, cy + dy * s], [cx, cy], [cx + dx * s, cy]], color, 1.2, a);
  });
}
function tape(x, y, w, h, a, k = 1) {
  alpha(k, () => rot(x, y, a, () => {
    ctx.fillStyle = G.tape; ctx.globalAlpha *= 0.92; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = G.tapeLine; ctx.lineWidth = 1; ctx.strokeRect(-w / 2, -h / 2, w, h);
  }));
}
function lbl(s, x, y, o = {}) { text(s, x, y, { size: o.size ?? 14, weight: o.weight ?? 400, font: CP, color: o.color ?? G.ink, align: o.align, alpha: o.alpha, spacing: o.spacing }); }
function body(s, x, y, o = {}) { text(s, x, y, { size: o.size ?? 18, weight: o.weight ?? 400, font: LIT, color: o.color ?? G.ink, align: o.align, alpha: o.alpha }); }

/* A small risk tag: the class word plus the stamp's outline (single, dashed, double). Returns its width. */
function riskTag(cls, x, y, k = 1) {
  const col = RISK[cls], w = measure(cls.toUpperCase(), 13, 700, CP) + 22, h = 26;
  alpha(k, () => {
    ctx.save(); ctx.strokeStyle = col;
    if (cls === "logic") { ctx.lineWidth = 2; ctx.setLineDash([4, 3]); rr(x, y - h / 2, w, h, 4); ctx.stroke(); }
    else if (cls === "sensitive") { ctx.lineWidth = 2.4; rr(x, y - h / 2, w, h, 13); ctx.stroke(); }
    else { ctx.lineWidth = 1.6; rr(x, y - h / 2, w, h, 13); ctx.stroke(); }
    ctx.restore();
    lbl(cls.toUpperCase(), x + w / 2, y + 4.5, { size: 13, weight: 700, color: col, align: "center", spacing: "1px" });
  });
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

function board() {
  ctx.fillStyle = G.board; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = G.edge;
  for (let x = 40; x < W; x += 40) { ctx.globalAlpha = 0.55; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 40; y < H; y += 40) { ctx.globalAlpha = 0.55 * Math.sin(Math.PI * y / H); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.restore();
  const g = ctx.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 780);
  g.addColorStop(0, "rgba(228,232,223,0.9)"); g.addColorStop(1, "rgba(228,232,223,0.15)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  cropMarks(28, 26, W - 56, H - 64, G.ink3, 0.55);
}

/* Field notes in the left column: a word in Courier, ticked off as the narration reaches it. */
function notes(items, t, x = 80, y = 290) {
  items.forEach(([s, k0, sub], i) => {
    const k = seg(t, k0 - 0.2, k0 + 0.3), yy = y + i * 52;
    alpha(0.35 + 0.65 * k, () => {
      ctx.save(); ctx.strokeStyle = k > 0.5 ? G.cambiumInk : G.ink3; ctx.lineWidth = 1.6; rr(x, yy - 15, 18, 18, 3); ctx.stroke(); ctx.restore();
      if (k > 0) check(x + 9, yy - 6, 12, G.cambiumInk, k);
      lbl(s, x + 30, yy, { size: 15, weight: 700, color: G.ink });
      if (sub) lbl(sub, x + 30, yy + 19, { size: 12, color: G.ink3 });
    });
  });
}
/* The accession slip under the notes: which pull request, which scenario, and that it is simulated. */
function slip(pr, k, x = 80, y = 520) {
  alpha(k, () => {
    sheet(x, y, 290, 66, { fill: G.label, pinned: true });
    tape(x + 145, y, 70, 16, -2);
    lbl(`PR #${pr.number} · ${pr.scenarioTitle.toLowerCase()}`.slice(0, 34), x + 14, y + 28, { size: 13, weight: 700 });
    lbl("simulated · offline e2e run", x + 14, y + 50, { size: 12, color: G.ink3 });
  });
}

/* ------------------------------------------------------------------ the GitHub surface */

/* Inline markdown: **bold**, `code` (also inside bold), [links](url) and @mentions. */
function spans(s) {
  const out = [];
  s.split("**").forEach((part, bi) => {
    part.split("`").forEach((p, ci) => {
      if (!p) return;
      if (ci % 2) { out.push({ s: p, b: bi % 2 === 1, c: true }); return; }
      p.split(/(\[[^\]]+\]\([^)]+\)|@[\w-]+)/).forEach((q, li) => {
        if (!q) return;
        if (li % 2 === 0) out.push({ s: q, b: bi % 2 === 1 });
        else if (q[0] === "@") out.push({ s: q, b: true });
        else out.push({ s: q.replace(/^\[([^\]]+)\].*$/, "$1"), a: true });
      });
    });
  });
  return out;
}
/* GitHub-flavoured markdown, the subset Graft writes: headings, lists, two-column tables, alerts, a collapsed
 * <details>, <sub>. HTML comments and raw tags are dropped, as GitHub does. */
function parseMd(src) {
  const blocks = [];
  let alert = null, inDetails = false;
  for (const raw of src.split("\n")) {
    const l = raw.replace(/<!--.*?-->/g, "");
    if (inDetails) { if (l.includes("</details>")) inDetails = false; continue; }
    if (alert && !l.startsWith(">")) alert = null;
    if (!l.trim()) { if (raw.trim() === "") blocks.push({ t: "gap" }); continue; }
    let m;
    if ((m = /^<details><summary>(.*)<\/summary>/.exec(l))) { blocks.push({ t: "details", s: m[1] }); inDetails = true; continue; }
    if ((m = /^<sub>(.*)<\/sub>/.exec(l))) { blocks.push({ t: "sub", s: m[1] }); continue; }
    if (/^<[^>]+>$/.test(l.trim())) continue;
    if ((m = /^> \[!(\w+)\]/.exec(l))) { alert = { t: "alert", kind: m[1], items: [] }; blocks.push(alert); continue; }
    if (alert) {
      const s = l.replace(/^>\s?/, "");
      if (s.startsWith("- ")) alert.items.push({ t: "li", r: spans(s.slice(2)) });
      else if (s.trim()) alert.items.push({ t: "p", r: spans(s) });
      continue;
    }
    if ((m = /^(#{2,3}) (.*)$/.exec(l))) { blocks.push({ t: m[1].length === 2 ? "h2" : "h3", s: m[2] }); continue; }
    if (/^\|\s*(---\s*\|\s*)+$/.test(l) || /^\|\s*\|\s*\|$/.test(l)) continue;
    if ((m = /^\| (.*) \| (.*) \|$/.exec(l))) {
      const last = blocks[blocks.length - 1];
      const row = [spans(m[1]), spans(m[2])];
      if (last && last.t === "table") last.rows.push(row); else blocks.push({ t: "table", rows: [row] });
      continue;
    }
    if (l.startsWith("- ")) { blocks.push({ t: "li", r: spans(l.slice(2)) }); continue; }
    const last = blocks[blocks.length - 1];
    if (last && last.t === "p" && !last.closed) last.lines.push(spans(l)); else blocks.push({ t: "p", lines: [spans(l)] });
  }
  return blocks;
}

const FS = 15, LH = 23;
function spanFont(sp, size) { return sp.c ? [size * 0.86, 400, GMONO] : [size, sp.b ? 600 : 400, SANS]; }
/* Word-wraps runs of spans into lines of positioned pieces. */
function flow(runs, maxW, size = FS) {
  const lines = [[]];
  let x = 0;
  for (const sp of runs) {
    const [fs, fw, ff] = spanFont(sp, size);
    const words = sp.c ? [sp.s] : sp.s.split(/(?<=\s)/);
    for (const wd of words) {
      const w = measure(wd, fs, fw, ff) + (sp.c ? 9 : 0);
      if (x + w > maxW && x > 0 && wd.trim()) { lines.push([]); x = 0; }
      if (x === 0 && !wd.trim()) continue;
      lines[lines.length - 1].push({ ...sp, s: wd, x, w });
      x += w + (sp.c ? 2 : 0);
    }
  }
  return lines;
}
function drawRuns(lines, x, y, o = {}) {
  const size = o.size ?? FS, lh = o.lh ?? LH;
  lines.forEach((ln, i) => ln.forEach(p => {
    const [fs, fw, ff] = spanFont(p, size), yy = y + i * lh;
    if (p.c) {
      ctx.save(); rr(x + p.x, yy - size + 1, p.w, size + 5, 5); ctx.fillStyle = GH.code; ctx.fill(); ctx.restore();
      text(p.s, x + p.x + 4.5, yy, { size: fs, weight: fw, font: ff, color: o.color ?? GH.fg });
    } else text(p.s, x + p.x, yy, { size: fs, weight: fw, font: ff, color: p.a ? GH.link : (o.color ?? GH.fg) });
  }));
}

/* Lays a parsed document out at width w: every block gets a y, a height and a draw function. Sections (h3) are
 * remembered so a scene can scroll to them and frame them. */
function layoutMd(blocks, w) {
  const out = [], sections = {};
  let y = 0, sec = null;
  for (const b of blocks) {
    let h = 0, draw = null;
    const y0 = y;
    if (b.t === "gap") { y += 6; continue; }
    if (b.t === "h2") { h = 44; draw = (x, yy) => { text(b.s, x, yy + 24, { size: 22, weight: 600, font: SANS, color: GH.fg }); line([[x, yy + 36], [x + w, yy + 36]], GH.border, 1); }; }
    else if (b.t === "h3") {
      h = 36; draw = (x, yy) => text(b.s, x, yy + 26, { size: 18, weight: 600, font: SANS, color: GH.fg });
      if (sec) sec.h = y0 - sec.y;
      sec = sections[b.s] = { y: y0, h: 0 };
    }
    else if (b.t === "p") {
      const lines = b.lines.flatMap(r => flow(r, w));
      h = lines.length * LH + 8; draw = (x, yy) => drawRuns(lines, x, yy + 17);
    }
    else if (b.t === "li") {
      const lines = flow(b.r, w - 26);
      h = lines.length * LH + 2; draw = (x, yy) => { dot(x + 10, yy + 12, 2.6, GH.fg); drawRuns(lines, x + 24, yy + 17); };
    }
    else if (b.t === "details") { h = LH + 8; draw = (x, yy) => { text("▸", x, yy + 17, { size: 13, font: SANS, color: GH.fg }); text(b.s, x + 16, yy + 17, { size: FS, font: SANS, color: GH.fg }); }; }
    else if (b.t === "sub") { h = 22; draw = (x, yy) => text(b.s, x, yy + 15, { size: 12, font: SANS, color: GH.muted }); }
    else if (b.t === "table") {
      const c1 = Math.max(...b.rows.map(r => flow(r[0], 999)[0].reduce((a, p) => a + p.w, 0))) + 26;
      const c2 = Math.max(...b.rows.map(r => flow(r[1], 999)[0].reduce((a, p) => a + p.w, 0))) + 26;
      const rh = 32; h = b.rows.length * rh + 12;
      draw = (x, yy) => {
        b.rows.forEach((r, i) => {
          const ry = yy + i * rh;
          if (i % 2) { ctx.fillStyle = GH.subtle; ctx.fillRect(x + c1, ry, c2, rh); }
          ctx.strokeStyle = GH.border; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, ry + 0.5, c1, rh); ctx.strokeRect(x + c1 + 0.5, ry + 0.5, c2, rh);
          drawRuns(flow(r[0], 999), x + 13, ry + 21); drawRuns(flow(r[1], 999), x + c1 + 13, ry + 21);
        });
      };
    }
    else if (b.t === "alert") {
      const icon = { WARNING: "⚠", CAUTION: "⊘", IMPORTANT: "!", NOTE: "ⓘ" }[b.kind] ?? "ⓘ";
      const items = b.items.map(it => ({ it, lines: flow(it.r, w - 18 - (it.t === "li" ? 26 : 0)) }));
      h = 34 + items.reduce((a, i) => a + i.lines.length * LH + (i.it.t === "p" ? 8 : 2), 0) + 6;
      draw = (x, yy) => {
        const col = GH[b.kind] ?? GH.NOTE;
        ctx.fillStyle = col; ctx.fillRect(x, yy, 4, h - 8);
        text(`${icon}  ${b.kind[0]}${b.kind.slice(1).toLowerCase()}`, x + 18, yy + 22, { size: FS, weight: 600, font: SANS, color: col });
        let iy = yy + 34;
        items.forEach(({ it, lines }) => {
          if (it.t === "li") { dot(x + 28, iy + 12, 2.6, GH.fg); drawRuns(lines, x + 42, iy + 17); }
          else drawRuns(lines, x + 18, iy + 17);
          iy += lines.length * LH + (it.t === "p" ? 8 : 2);
        });
      };
      sections[`alert:${b.kind}`] = { y: y0, h };
    }
    out.push({ y: y0, h, draw, b });
    y += h + (b.t === "li" ? 0 : 6);
  }
  if (sec) sec.h = y - sec.y;
  return { items: out, h: y, sections };
}
const MDCACHE = {};
function md(key, src, w) { const k = `${key}:${w}`; return MDCACHE[k] || (MDCACHE[k] = layoutMd(parseMd(src), w)); }

/* PR descriptions keep their line breaks; GitHub drops the comment, the <img> shows nothing useful. */
function bodySrc(s) { return s.split("\n").map(l => l.replace(/<!--.*?-->/g, "").replace(/<img[^>]*>/g, "").trim()).filter(Boolean).join("\n"); }

function avatar(x, y, who, bot) {
  if (bot) {
    ctx.save(); rr(x, y, 40, 40, 8); ctx.fillStyle = G.cambiumInk; ctx.fill(); ctx.restore();
    mark(x + 20, y + 21, 0.52, 1);
    ctx.save(); rr(x, y, 40, 40, 8); ctx.fillStyle = "rgba(255,255,255,0.88)"; ctx.fill(); ctx.restore();
    mark(x + 20, y + 21, 0.52, 1);
  } else {
    dot(x + 20, y + 20, 20, who === "outsider-e2e" ? "#8c959f" : "#6e7781");
    text(who[0].toUpperCase(), x + 20, y + 26, { size: 16, weight: 600, font: SANS, color: "#fff", align: "center" });
  }
}
function ghButton(s, x, y, o = {}) {
  const w = measure(s, 13, 500, SANS) + 26, h = 30;
  ctx.save(); rr(x, y, w, h, 6);
  ctx.fillStyle = o.primary ? GH.btn : (o.pressed ? "#e6eaef" : GH.subtle); ctx.fill();
  ctx.strokeStyle = o.primary ? "rgba(31,35,40,0.15)" : GH.border; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
  text(s, x + w / 2, y + 20, { size: 13, weight: 500, font: SANS, color: o.primary ? "#fff" : GH.fg, align: "center" });
  return w;
}
/* Cuts a string with an ellipsis so it fits maxW. */
function fit(s, maxW, size, weight, font) {
  if (measure(s, size, weight, font) <= maxW) return s;
  while (s.length > 1 && measure(s + "…", size, weight, font) > maxW) s = s.slice(0, -1);
  return s.trimEnd() + "…";
}
function neutralIcon(x, y) { ring(x, y, 7.5, GH.neutral, 2); line([[x - 3.2, y], [x + 3.2, y]], GH.neutral, 2); }
function checkName(n) { return { "graft/intent": 0, "graft/provenance": 1, "graft/policy": 2 }[n]; }

/* One timeline box: the avatar column plus a bordered box with a grey header. Returns nothing; h is the box height. */
function ghBox(x, y, w, h, hd) {
  ctx.save(); rr(x, y, w, h, 6); ctx.fillStyle = GH.bg; ctx.fill(); ctx.strokeStyle = GH.border; ctx.lineWidth = 1; ctx.stroke();
  if (hd) { ctx.clip(); ctx.fillStyle = GH.subtle; ctx.fillRect(x, y, w, 38); line([[x, y + 38], [x + w, y + 38]], GH.border, 1); }
  ctx.restore();
  if (hd) {
    let hx = x + 14;
    hd.forEach(([s, o]) => {
      if (o?.badge) {
        const bw = measure(s, 11, 500, SANS) + 14;
        ctx.save(); rr(hx, y + 11, bw, 18, 9); ctx.strokeStyle = GH.border; ctx.stroke(); ctx.restore();
        text(s, hx + 7, y + 24, { size: 11, weight: 500, font: SANS, color: GH.muted }); hx += bw + 6;
      } else { text(s, hx, y + 25, { size: 14, weight: o?.b ? 600 : 400, font: SANS, color: o?.b ? GH.fg : GH.muted }); hx += measure(s, 14, o?.b ? 600 : 400, SANS) + 6; }
    });
  }
}

/* The whole pull request page, top to bottom, as a list of blocks with heights. o.show picks what is on it:
 * desc, comment, review, checks, expand: {intent, policy}, pressed, merge. */
function prPage(pr, w, o = {}) {
  const items = [], CX = 56, BW = w - CX;
  const push = (id, h, draw, anchors = {}) => items.push({ id, h, draw, anchors });
  // header: title, state, branches, tabs
  push("header", 128, (x, y) => {
    text(pr.title, x, y + 30, { size: 25, font: SANS, color: GH.fg });
    text(`#${pr.number}`, x + measure(pr.title, 25, 400, SANS) + 10, y + 30, { size: 25, font: SANS, color: GH.muted });
    ctx.save(); rr(x, y + 46, 70, 30, 15); ctx.fillStyle = GH.open; ctx.fill(); ctx.restore();
    text("Open", x + 35, y + 66, { size: 14, weight: 500, font: SANS, color: "#fff", align: "center" });
    let mx = x + 82;
    const seg2 = [[pr.author, 600, GH.fg], [" wants to merge into ", 400, GH.muted], [pr.baseRef, 400, GH.link, true], [" from ", 400, GH.muted], [pr.headRef, 400, GH.link, true]];
    seg2.forEach(([s, fw, col, br]) => {
      const f = br ? GMONO : SANS, fs = br ? 12 : 14, sw = measure(s, fs, fw, f) + (br ? 10 : 0);
      if (br) { ctx.save(); rr(mx, y + 50, sw, 22, 6); ctx.fillStyle = "#ddf4ff"; ctx.fill(); ctx.restore(); }
      text(s, mx + (br ? 5 : 0), y + 66, { size: fs, weight: fw, font: f, color: col }); mx += sw;
    });
    const tabs = [["Conversation", null], ["Commits", null], ["Checks", "3"], ["Files changed", String(pr.files.length)]];
    let tx = x;
    tabs.forEach(([s, n], i) => {
      text(s, tx + 14, y + 112, { size: 14, weight: i ? 400 : 600, font: SANS, color: i ? GH.muted : GH.fg });
      let tw = measure(s, 14, i ? 400 : 600, SANS) + 28;
      if (n) { ctx.save(); rr(tx + tw - 8, y + 98, 22, 20, 10); ctx.fillStyle = GH.subtle; ctx.fill(); ctx.restore(); text(n, tx + tw + 3, y + 113, { size: 12, font: SANS, color: GH.fg, align: "center" }); tw += 22; }
      if (!i) { ctx.fillStyle = GH.tab; ctx.fillRect(tx, y + 125, tw, 2); }
      tx += tw + 4;
    });
    line([[x, y + 127], [x + w, y + 127]], GH.border, 1);
  });
  if (o.desc !== false) {
    const doc = md(`body${pr.number}`, bodySrc(pr.body), BW - 32);
    push("desc", doc.h + 38 + 22 + 20, (x, y) => {
      avatar(x, y, pr.author);
      ghBox(x + CX, y, BW, doc.h + 38 + 20, [[pr.author, { b: true }], ["opened this pull request"]]);
      doc.items.forEach(it => it.draw && it.draw(x + CX + 16, y + 48 + it.y));
    });
  }
  if (o.comment !== false) {
    const doc = md(`comment${pr.number}`, pr.comment.body, BW - 32);
    const reacts = o.reactions ? 40 : 0, top = 38 + 14;
    const anchors = {};
    Object.entries(doc.sections).forEach(([k, s]) => { anchors[k] = { y: top + s.y, h: s.h }; });
    anchors.reactions = { y: top + doc.h + 4, h: reacts };
    push("comment", top + doc.h + 10 + reacts + 22, (x, y) => {
      avatar(x, y, "graft", true);
      ghBox(x + CX, y, BW, top + doc.h + 10 + reacts, [["graft-dev", { b: true }], ["bot", { badge: true }], ["commented · edited"]]);
      doc.items.forEach(it => it.draw && it.draw(x + CX + 16, y + top + it.y));
      if (reacts) {
        const n = pr.comment.reactions.filter(r => r.content === "+1").length;
        const ry = y + top + doc.h + 6, rw = 52;
        ctx.save(); rr(x + CX + 16, ry, rw, 26, 13); ctx.fillStyle = o.reactK ? "#ddf4ff" : GH.subtle; ctx.fill(); ctx.strokeStyle = o.reactK ? GH.link : GH.border; ctx.stroke(); ctx.restore();
        text(`👍 ${n}`, x + CX + 16 + rw / 2, ry + 18, { size: 13, font: SANS, color: GH.fg, align: "center" });
      }
    }, anchors);
  }
  if (o.review) pr.reviews.forEach(r => push("review", 50, (x, y) => {
    dot(x + CX + 14, y + 16, 15, r.state === "APPROVED" ? GH.open : GH.subtle);
    check(x + CX + 14, y + 16, 12, "#fff", 1);
    text(r.user, x + CX + 40, y + 21, { size: 14, weight: 600, font: SANS, color: GH.fg });
    text(r.state === "APPROVED" ? "approved these changes" : "reviewed", x + CX + 46 + measure(r.user, 14, 600, SANS), y + 21, { size: 14, font: SANS, color: GH.muted });
  }));
  if (o.checks !== false) {
    const checks = [...pr.checks].sort((a, b) => checkName(a.name) - checkName(b.name));
    const ex = o.expand ?? {};
    const rows = checks.map(c => {
      let eh = 0;
      if (c.name === "graft/intent" && ex.intent) eh = 54 * ex.intent;
      if (c.name === "graft/policy" && ex.policy) eh = 48 * ex.policy;
      return { c, h: 44 + eh, eh };
    });
    const total = 50 + rows.reduce((a, r) => a + r.h, 0);
    const anchors = {}; let ay = 50;
    rows.forEach(r => { anchors[r.c.name] = { y: ay, h: r.h }; ay += r.h; });
    push("checks", total + 20, (x, y) => {
      ghBox(x + CX, y, BW, total);
      text("All checks have finished", x + CX + 16, y + 30, { size: 15, weight: 600, font: SANS, color: GH.fg });
      text("3 neutral checks", x + CX + 22 + measure("All checks have finished", 15, 600, SANS), y + 30, { size: 13, font: SANS, color: GH.muted });
      let ry = y + 50;
      rows.forEach(({ c, h, eh }) => {
        line([[x + CX, ry], [x + CX + BW, ry]], GH.border, 1);
        neutralIcon(x + CX + 24, ry + 22);
        text(c.name, x + CX + 44, ry + 27, { size: 14, weight: 600, font: SANS, color: GH.fg });
        const nw = measure(c.name, 14, 600, SANS);
        text(fit(`— ${c.title}`, BW - 44 - nw - 80, 14, 400, SANS), x + CX + 50 + nw, ry + 27, { size: 14, font: SANS, color: GH.muted });
        text("Details", x + CX + BW - 16, ry + 27, { size: 13, font: SANS, color: GH.link, align: "right" });
        if (eh > 1) alpha(clamp(eh / 30), () => {
          ctx.save(); rr(x + CX + 44, ry + 40, BW - 60, eh - 8, 6); ctx.clip();
          ctx.fillStyle = GH.subtle; ctx.fill();
          if (c.name === "graft/intent") {
            let bx = x + CX + 56;
            c.actions.forEach((a, i) => { bx += ghButton(a, bx, ry + 48, { pressed: i === 0 && o.pressed }) + 10; });
          } else text(c.text.split("\n")[0], x + CX + 58, ry + 70, { size: 14, font: SANS, color: GH.fg });
          ctx.restore();
          ctx.save(); rr(x + CX + 44, ry + 40, BW - 60, eh - 8, 6); ctx.strokeStyle = GH.border; ctx.stroke(); ctx.restore();
        });
        ry += h;
      });
    }, anchors);
  }
  if (o.merge) push("merge", 70, (x, y) => {
    ghButton("Merge pull request", x + CX, y + 4, { primary: true });
    text("nothing from Graft blocks this", x + CX + 170, y + 24, { size: 13, font: SANS, color: GH.muted });
  });
  let y = 0;
  items.forEach(it => { it.y = y; y += it.h; });
  return { items, h: y, find: (id, a) => { const it = items.find(i => i.id === id); if (!it) return { y: 0, h: 0 }; return a ? { y: it.y + (it.anchors[a]?.y ?? 0), h: it.anchors[a]?.h ?? it.h } : { y: it.y, h: it.h }; } };
}

/* A browser window holding the page, scrolled to `scroll`; `frame` outlines a region of the page in cambium. */
function ghWindow(pr, page, x, y, w, h, o = {}) {
  sheet(x, y, w, h, { fill: GH.bg, stroke: GH.border, r: 8, alpha: o.alpha });
  alpha(o.alpha ?? 1, () => {
    ctx.save(); rr(x, y, w, 34, [8, 8, 0, 0]); ctx.fillStyle = "#eef1ee"; ctx.fill(); ctx.restore();
    line([[x, y + 34], [x + w, y + 34]], GH.border, 1);
    ["#d0d7de", "#d0d7de", "#d0d7de"].forEach((c, i) => dot(x + 18 + i * 15, y + 17, 5, c));
    const url = `github.com/mmornati/graft-sandbox/pull/${pr.number}`;
    ctx.save(); rr(x + 70, y + 7, w - 140, 21, 10); ctx.fillStyle = "#fff"; ctx.fill(); ctx.restore();
    text(url, x + w / 2, y + 22, { size: 12, font: SANS, color: GH.muted, align: "center" });
    lbl("SIMULATED", x + w - 14, y + 22, { size: 11, weight: 700, color: G.logic, align: "right", spacing: "1px" });
    ctx.save(); ctx.beginPath(); ctx.rect(x + 1, y + 35, w - 2, h - 36); ctx.clip();
    const px = x + 26, pw = w - 52, top = y + 52 - (o.scroll ?? 0);
    page.items.forEach(it => {
      const k = o.appear?.[it.id] ?? 1;
      if (k <= 0) return;
      alpha(k, () => it.draw(px, top + it.y + (1 - outCubic(k)) * 14));
    });
    (o.frames ?? []).forEach(([r, k]) => {
      if (k <= 0) return;
      const fx = px + (r.dx ?? 56) - 8, fy = top + r.y - 6, fw = pw - (r.dx ?? 56) + 16, fh = r.h + 12;
      highlight(fx, fy, fw, fh, k, G.cambium);
    });
    // a soft fade at the bottom edge hints that the page continues
    const g = ctx.createLinearGradient(0, y + h - 30, 0, y + h); g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(1, "rgba(255,255,255,0.95)");
    ctx.fillStyle = g; ctx.fillRect(x, y + h - 30, w, 30);
    ctx.restore();
  });
}
/* Scroll position: holds then glides between key positions [[time, y], …]. */
function scrollAt(t, keys) {
  let y = keys[0][1];
  for (let i = 1; i < keys.length; i++) y = lerp(y, keys[i][1], inOut(seg(t, keys[i][0], keys[i][0] + 0.9)));
  return y;
}
/* Window geometry shared by the PR scenes. */
const WX = 400, WY = 52, WW = 800, WH = 552;
const VIEW = WH - 70;
function focus(r, pad = 40) { return Math.max(0, r.y - pad); }
function focusBottom(r, pad = 30) { return Math.max(0, r.y + r.h - VIEW + pad); }

/* ------------------------------------------------------------------ 1 · title */

const PICKS = ["s01", "s03", "s04", "s08"];
function riskOf(pr) { return (/Risk: (\w+)/.exec(pr.checks.find(c => c.name === "graft/intent").title) || [])[1]; }
function policyOf(pr) { return pr.checks.find(c => c.name === "graft/policy").title.replace(/\s*\(.*\)$/, ""); }

function sTitle(t, d, cues) {
  const a1 = at(cues, 1, 4.6);
  sheet(110, 92, 1060, 470, { alpha: seg(t, 0, 0.6) });
  cropMarks(130, 112, 1020, 430, G.edge, seg(t, 0.2, 0.8));
  mark(210, 210, 2.2, seg(t, 0.2, 1.8));
  lbl("GRAFT · VIDEO DOCUMENTATION", 290, 180, { size: 12, weight: 700, color: G.ink3, spacing: "1.2px", alpha: seg(t, 0.4, 1) });
  head("What a reviewer sees", "on a pull request with Graft.", seg(t, 0.6, 1.3), seg(t, 0.9, 1.6), { x: 290, y: 240, size: 50 });
  // the four specimens of the video
  PICKS.forEach((id, i) => {
    const pr = PRS[id], k = seg(t, a1 - 0.6 + i * 0.25, a1 - 0.1 + i * 0.25), x = 170 + i * 240, y = 380;
    alpha(k, () => {
      sheet(x, y + (1 - outCubic(k)) * 16, 220, 108, { fill: G.label, pinned: true });
      lbl(`#${pr.number} · ${id}`, x + 14, y + 28, { size: 13, weight: 700, color: G.ink3 });
      body(pr.title.length > 24 ? pr.title.slice(0, 23) + "…" : pr.title, x + 14, y + 56, { size: 16 });
      riskTag(riskOf(pr), x + 14, y + 84);
    });
  });
  alpha(seg(t, a1, a1 + 0.6), () => {
    lbl(S.simulated, 640, 524, { size: 13, weight: 700, color: G.logic, align: "center", spacing: "1.2px" });
    lbl(S.simulated2, 640, 546, { size: 12, color: G.ink3, align: "center" });
  });
}

/* ------------------------------------------------------------------ 2 · the managed comment (s01) */

function sComment(t, d, cues) {
  const pr = PRS.s01, c = [0, 1, 2, 3, 4].map((i, j) => at(cues, i, 0.5 + j * 4.5));
  plate("I", "The managed comment", seg(t, 0, 0.5));
  head("One comment,", "kept up to date.", seg(t, 0.1, 0.7), seg(t, 0.4, 1.0), { size: 40, y: 140 });
  notes([["Intent card", c[2], "goal · risk · behavior"], ["Provenance", c[3], "agent · model · task"], ["Policy", c[4], "what graft.yaml would do"]], t, 80, 300);
  slip(pr, seg(t, 0.6, 1.2), 80, 498);
  const page = prPage(pr, WW - 52, { checks: false });
  const intent = page.find("comment", "Intent"), prov = page.find("comment", "Provenance"), pol = page.find("comment", "Policy");
  const scroll = scrollAt(t, [[0, 0], [c[2] - 0.6, focus(intent, 10)], [c[3] - 0.5, focus(prov)], [c[4] - 0.5, focusBottom(pol)]]);
  ghWindow(pr, page, WX, WY, WW, WH, {
    alpha: seg(t, 0.2, 0.8), scroll,
    appear: { header: seg(t, 0.4, 1.0), desc: seg(t, 0.8, 1.4), comment: seg(t, c[1] - 0.2, c[1] + 0.5) },
    frames: [[intent, seg(t, c[2], c[2] + 0.5) - seg(t, c[3] - 0.4, c[3])], [prov, seg(t, c[3], c[3] + 0.5) - seg(t, c[4] - 0.4, c[4])], [pol, seg(t, c[4], c[4] + 0.5)]],
  });
}

/* ------------------------------------------------------------------ 3 · three neutral checks (s01) */

function sChecks(t, d, cues) {
  const pr = PRS.s01, c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 3.6));
  plate("II", "Three check runs", seg(t, 0, 0.5));
  head("Three checks,", "all neutral.", seg(t, 0.1, 0.7), seg(t, 0.4, 1.0), { size: 40, y: 140 });
  notes([["graft/intent", c[0] + 0.4, "Card is accurate · Card is wrong"], ["graft/provenance", c[0] + 1.1, "who wrote it"], ["graft/policy", c[0] + 1.8, "report mode never blocks"]], t, 80, 300);
  slip(pr, 1, 80, 498);
  const ex = { intent: outCubic(seg(t, c[2] - 0.2, c[2] + 0.5)), policy: outCubic(seg(t, c[3] - 0.2, c[3] + 0.5)) };
  const page = prPage(pr, WW - 52, { expand: ex, merge: true });
  const checks = page.find("checks"), ci = page.find("checks", "graft/intent"), cp = page.find("checks", "graft/policy");
  const scroll = scrollAt(t, [[0, focusBottom(page.find("comment"), -40)], [0.3, Math.max(0, checks.y - 60)]]);
  ghWindow(pr, page, WX, WY, WW, WH, {
    scroll,
    appear: { checks: seg(t, c[0] - 0.1, c[0] + 0.5), merge: seg(t, c[3] + 0.6, c[3] + 1.2) },
    frames: [[checks, seg(t, c[1], c[1] + 0.5) - seg(t, c[2] - 0.4, c[2])], [ci, seg(t, c[2] + 0.3, c[2] + 0.8) - seg(t, c[3] - 0.4, c[3])], [cp, seg(t, c[3] + 0.3, c[3] + 0.8)]],
  });
  // the neutral verdict, stamped in the herbarium's own hand
  alpha(seg(t, c[1], c[1] + 0.4), () => rot(1120, 560, -8, () => {
    ctx.strokeStyle = G.ink2; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); rr(-70, -22, 140, 44, 5); ctx.stroke(); ctx.setLineDash([]);
    lbl("NEUTRAL × 3", 0, 6, { size: 15, weight: 700, color: G.ink2, align: "center", spacing: "1px" });
  }));
}

/* ------------------------------------------------------------------ 4 · the verifier disagrees (s03) */

function sMisleading(t, d, cues) {
  const pr = PRS.s03, c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 4));
  plate("III", "PR #4 · misleading body", seg(t, 0, 0.5));
  head("The body says typo.", "The diff disagrees.", seg(t, 0.1, 0.7), seg(t, c[1], c[1] + 0.6), { size: 36, y: 140 });
  notes([["“No behavior change.”", c[0] + 0.5, "the PR description"], ["Verifier: 0 of 4", c[1] + 0.4, "claims supported"], ["Risk logic", c[3], "would require 1 human"]], t, 80, 300);
  slip(pr, seg(t, 0.4, 1), 80, 498);
  const page = prPage(pr, WW - 52, {});
  const desc = page.find("desc"), warn = page.find("comment", "alert:WARNING"), intent = page.find("comment", "Intent"), pol = page.find("comment", "Policy");
  const scroll = scrollAt(t, [[0, 0], [c[1] - 0.2, focus(intent, 10)], [c[2] - 0.5, focusBottom(warn)], [c[3] - 0.4, focusBottom(pol)]]);
  ghWindow(pr, page, WX, WY, WW, WH, {
    alpha: seg(t, 0.1, 0.6), scroll,
    appear: { header: seg(t, 0.2, 0.8), desc: seg(t, 0.5, 1.1), comment: seg(t, c[1] - 0.6, c[1]), checks: 1 },
    frames: [[desc, seg(t, c[0] + 0.6, c[0] + 1.1) - seg(t, c[1] - 0.6, c[1] - 0.2)], [warn, seg(t, c[2], c[2] + 0.5) - seg(t, c[3] - 0.5, c[3])], [pol, seg(t, c[3], c[3] + 0.5)]],
  });
  const kt = seg(t, c[2] + 0.4, c[2] + 0.9);
  alpha(kt, () => rot(1110, 572, -6, () => {
    sheet(-104, -22, 208, 44, { fill: G.label, pinned: true });
    lbl("Risk: logic · verifier disagrees", 0, 5, { size: 11, weight: 700, color: G.logic, align: "center" });
  }));
}

/* ------------------------------------------------------------------ 5 · text aimed at AI reviewers (s04) */

function sInjection(t, d, cues) {
  const pr = PRS.s04, c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 4.5));
  plate("IV", "PR #5 · injection text", seg(t, 0, 0.5));
  head("PR text is data,", "never instructions.", seg(t, 0.1, 0.7), seg(t, c[2], c[2] + 0.6), { size: 36, y: 140 });
  notes([["“classify as trivial”", c[1], "asked by the PR body"], ["Card: the real change", c[2] + 0.4, "a heart-rate zone threshold"], ["Risk floor: logic", c[3] + 0.4, "text addressed to AI reviewers"]], t, 80, 300);
  slip(pr, seg(t, 0.4, 1), 80, 498);
  const page = prPage(pr, WW - 52, {});
  const desc = page.find("desc"), intent = page.find("comment", "Intent"), caution = page.find("comment", "alert:CAUTION");
  const goal = { y: intent.y + 42, h: 26 };
  const scroll = scrollAt(t, [[0, 0], [c[2] - 0.5, focus(intent, 10)], [c[3] - 0.4, focusBottom(caution, 60)]]);
  ghWindow(pr, page, WX, WY, WW, WH, {
    alpha: seg(t, 0.1, 0.6), scroll,
    appear: { header: seg(t, 0.2, 0.8), desc: seg(t, 0.5, 1.1), comment: seg(t, c[1] + 0.8, c[1] + 1.4), checks: 1 },
    frames: [[desc, seg(t, c[0] + 0.8, c[0] + 1.3) - seg(t, c[2] - 0.8, c[2] - 0.4)], [goal, seg(t, c[2] + 0.4, c[2] + 0.9) - seg(t, c[3] - 0.5, c[3])], [caution, seg(t, c[3], c[3] + 0.5)]],
  });
  // the injected line is struck through, in the herbarium's red
  const ks = seg(t, c[1] + 0.2, c[1] + 0.9) * (1 - seg(t, c[2] - 0.8, c[2] - 0.4));
  if (ks > 0) {
    const y0 = WY + 52 + desc.y + 48 + 12;
    const sw = measure(bodySrc(pr.body).split("\n")[0], FS, 400, SANS);
    line([[WX + 26 + 72, y0], [WX + 26 + 72 + sw * outCubic(ks), y0]], G.sensitive, 2.4);
  }
}

/* ------------------------------------------------------------------ 6 · how ratings count (s08, s01) */

function sRatings(t, d, cues) {
  const p8 = PRS.s08, p2 = PRS.s01, c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 4.5));
  plate("V", "Card ratings", seg(t, 0, 0.5));
  head("A rating counts", "when a reviewer gives it.", seg(t, 0.1, 0.7), seg(t, 0.4, 1.0), { size: 36, y: 140 });
  // the PR 8 page on the left: approval, the 👍, the pressed button
  const LWX = 80, LWW = 560, LWH = 380, LWY = 222;
  const pressed = t > c[1] + 0.8;
  const page = prPage(p8, LWW - 52, { desc: false, review: true, reactions: true, reactK: t > c[1] + 1.8, expand: { intent: 1 }, pressed });
  const rev = page.find("review"), cmt = page.find("comment", "reactions"), ci = page.find("checks", "graft/intent");
  const view = LWH - 70;
  const scroll = scrollAt(t, [[0, Math.max(0, cmt.y + cmt.h - view + 40)], [c[1] + 0.6, Math.max(0, rev.y - 60)]]);
  const sc = Math.min(scroll, Math.max(0, page.h - view));
  ghWindow(p8, page, LWX, LWY, LWW, LWH, {
    alpha: seg(t, 0.3, 0.9), scroll: sc,
    frames: [[ci, seg(t, c[1] + 0.5, c[1] + 1.0) - seg(t, c[2], c[2] + 0.4)], [{ y: cmt.y, h: 30 }, seg(t, c[1] + 1.6, c[1] + 2.1) - seg(t, c[2], c[2] + 0.4)]],
  });
  // the ledger: how Graft counted each signal (stored by Graft, not shown on GitHub)
  const LX = 680, LW = 470;
  alpha(seg(t, c[0], c[0] + 0.5), () => {
    text("The rating ledger", LX, 248, { size: 26, font: FELL });
    lbl("stored by Graft, not shown on GitHub", LX, 270, { size: 12, color: G.ink3 });
    rule(LX, LX + LW, 282, 2, G.ink);
  });
  const rows = [
    { pr: p8, v: p8.votes[0], k: c[1] + 0.8 },
    { pr: p8, v: p8.votes[1], k: c[2] },
    { pr: p2, v: p2.votes[0], k: c[3] },
    { pr: p2, v: p2.votes[1], k: c[3] + 1.4 },
  ];
  rows.forEach(({ pr, v, k }, i) => {
    const y = 316 + i * 70 + (i > 1 ? 16 : 0), kk = seg(t, k - 0.1, k + 0.4);
    alpha(kk, () => {
      lbl(`#${pr.number}`, LX, y, { size: 13, weight: 700, color: G.ink3 });
      body(`${v.who} ${v.what.replace(" on the Graft comment", "").replace(" on graft/intent", "")}`, LX + 40, y, { size: 16 });
      lbl(v.why, LX + 40, y + 24, { size: 12, color: G.ink2 });
      const col = v.counted ? G.cambiumInk : G.sensitive, word = v.counted ? "COUNTED" : "DROPPED";
      const w = measure(word, 12, 700, CP) + 16;
      ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.6; if (!v.counted) ctx.setLineDash([4, 3]); rr(LX + LW - w, y - 15, w, 22, 3); ctx.stroke(); ctx.restore();
      lbl(word, LX + LW - w / 2, y + 1, { size: 12, weight: 700, color: col, align: "center", spacing: "1px" });
      rule(LX, LX + LW, y + 38, 1, G.rule);
    });
  });
  // the two PR 8 signals merge into one rating
  const km = seg(t, c[2] + 0.6, c[2] + 1.2);
  alpha(km, () => {
    line([[LX + LW + 12, 304], [LX + LW + 22, 304], [LX + LW + 22, 374], [LX + LW + 12, 374]], G.cambiumInk, 2);
    lbl("= 1", LX + LW + 30, 344, { size: 15, weight: 700, color: G.cambiumInk });
  });
}

/* ------------------------------------------------------------------ 7 · report mode */

function sReport(t, d, cues) {
  const pr = PRS.s03, c = [0, 1, 2, 3].map((i, j) => at(cues, i, 0.5 + j * 3.4));
  plate("VI", "Report mode", seg(t, 0, 0.5));
  head("Graft reports.", "It never blocks a merge.", seg(t, 0.1, 0.7), seg(t, c[2], c[2] + 0.6), { size: 44, y: 140 });
  // the checks of PR 4 and an enabled merge button
  const page = prPage(pr, 640 - 52, { desc: false, comment: false, merge: true, expand: { policy: outCubic(seg(t, c[1], c[1] + 0.5)) } });
  const chk = page.find("checks"), mg = page.find("merge");
  ghWindow(pr, page, 80, 236, 640, 360, {
    alpha: seg(t, 0.3, 0.9), scroll: scrollAt(t, [[0, chk.y - 10], [c[2] + 0.2, mg.y + mg.h - (360 - 70) + 10]]),
    appear: { merge: seg(t, c[2] + 0.4, c[2] + 1) },
    frames: [[page.find("checks", "graft/policy"), seg(t, c[1] + 0.3, c[1] + 0.8) - seg(t, c[2] + 0.2, c[2] + 0.6)], [{ ...page.find("merge"), dx: 56, h: 40 }, seg(t, c[2] + 0.8, c[2] + 1.3)]],
  });
  // the field note on modes (docs/features/modes.md)
  alpha(seg(t, c[0], c[0] + 0.5), () => rot(990, 400, 1.2, () => {
    sheet(-190, -170, 380, 330, { fill: G.label, pinned: true });
    ctx.save(); ctx.strokeStyle = "rgba(83,96,102,0.25)"; ctx.lineWidth = 1;
    for (let y = -106; y < 150; y += 34) { ctx.beginPath(); ctx.moveTo(-170, y); ctx.lineTo(170, y); ctx.stroke(); }
    ctx.restore();
    text("Field note", -166, -124, { size: 28, weight: "italic 400", font: FELL });
    const N = [["policy_mode: report", c[0] + 0.3, 700], ["(the default)", c[0] + 0.6], ["“would approve” is a report", c[1] + 0.3], ["every check: neutral", c[2] + 0.2], ["nothing blocks a merge", c[2] + 0.8], ["modes: set by the operator", c[3] + 0.2], ["never by graft.yaml or a PR", c[3] + 0.8]];
    N.forEach(([s, k, w], j) => lbl(s, -166, -82 + j * 34, { size: 15, weight: w ?? 400, alpha: seg(t, k, k + 0.4) }));
  }));
}

/* ------------------------------------------------------------------ 8 · close */

function sClose(t, d, cues) {
  const a1 = at(cues, 1, 2.8), a2 = at(cues, 2, 6.4);
  ctx.save(); ctx.globalAlpha *= seg(t, 0, 0.4) * 0.85; ctx.fillStyle = G.soft; ctx.fillRect(0, 0, W, H); ctx.restore();
  mark(W / 2, 150, 1.5, seg(t, 0, 1.2));
  head("Read the card", "before you read the diff.", seg(t, 0.2, 0.8), seg(t, 0.5, 1.1), { x: W / 2, y: 262, size: 60, align: "center" });
  alpha(seg(t, a1 - 0.2, a1 + 0.4), () => {
    const s = "pnpm graft e2e run --interactive", w = measure(s, 17, 400, CP) + 48;
    ctx.save(); rr(W / 2 - w / 2, 384, w, 46, 4); ctx.fillStyle = G.code; ctx.fill(); ctx.strokeStyle = G.edge; ctx.stroke(); ctx.restore();
    lbl(s, W / 2, 413, { size: 17, align: "center" });
    lbl("simulated here: fake GitHub, canned model answers, Graft's real renderers", W / 2, 456, { size: 13, color: G.ink3, align: "center" });
  });
  alpha(seg(t, a2 - 0.2, a2 + 0.4), () => {
    const s = S.docs, w = measure(s, 18, 600, LIT) + 48;
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,0.25)"; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6;
    rr(W / 2 - w / 2, 486, w, 50, 3); ctx.fillStyle = G.cambiumInk; ctx.fill(); ctx.restore();
    body(s, W / 2, 518, { size: 18, weight: 600, color: "#fff", align: "center" });
  });
}

/* ------------------------------------------------------------------ video */

VIDEO.create({
  title: { en: "What a reviewer sees" },
  kicker: { en: "Graft · video documentation" },
  langs: ["en"],
  theme: {
    bg: G.board, bg2: G.board, panel: G.sheet, panel2: "#1d2a24", line: G.rule, ink: G.ink, soft: G.ink2, faint: G.ink3,
    accent: G.cambiumInk, accent2: G.cambium, good: G.trivial, warn: G.logic, bad: G.sensitive, deep: G.soft, term: "#15201b", termInk: "#e8ede4",
  },
  strings: STR,
  background: board,
  poster: "misleading",
  fonts: ['400 20px "IM Fell English"', 'italic 400 20px "IM Fell English"', '400 20px Literata', '600 20px Literata',
    '400 20px "Courier Prime"', '700 20px "Courier Prime"'],
  scenes: {
    title: sTitle, comment: sComment, checks: sChecks, misleading: sMisleading, injection: sInjection,
    ratings: sRatings, report: sReport, close: sClose,
  },
});
