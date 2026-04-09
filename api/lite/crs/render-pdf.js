"use strict";

/**
 * render-pdf.js — Branded PDF Renderer
 *
 * Takes Claude markdown output + structured engine data and renders branded PDFs.
 * Strategy: Option B — parse Claude markdown output, render to PDF with pdf-lib.
 *
 * Handles two doc classes:
 *   - Documents: credit analysis, roadmap, funding snapshot, lender list (rich layout)
 *   - Letters: dispute rounds, inquiry removal, personal info (letter format)
 */

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fs = require("fs");
const path = require("path");
const { logInfo, logWarn } = require("../logger");

// Logo image — loaded once, cached
let _logoPngBytes = null;
function getLogoBytes() {
  if (_logoPngBytes) return _logoPngBytes;
  try {
    const logoPath = path.join(__dirname, "..", "..", "..", "public", "fundhub-logo.png");
    _logoPngBytes = fs.readFileSync(logoPath);
  } catch (_err) {
    _logoPngBytes = null;
  }
  return _logoPngBytes;
}

// ============================================================================
// BRAND CONSTANTS
// ============================================================================

const BRAND = {
  navy: rgb(0.102, 0.153, 0.267), // #1a2744
  navyLight: rgb(0.129, 0.196, 0.345), // #213259
  white: rgb(1, 1, 1),
  black: rgb(0.05, 0.05, 0.05),
  gray: rgb(0.5, 0.5, 0.5),
  grayLight: rgb(0.93, 0.93, 0.93),
  grayBorder: rgb(0.8, 0.8, 0.8),
  green: rgb(0.118, 0.565, 0.298), // #1e9060
  greenBg: rgb(0.898, 0.976, 0.925), // #e5f9ec
  red: rgb(0.78, 0.169, 0.169), // #c72b2b
  redBg: rgb(0.996, 0.91, 0.91), // #ffe8e8
  blue: rgb(0.086, 0.388, 0.769), // #1663c4
  blueBg: rgb(0.902, 0.933, 0.988), // #e6eefc
  amber: rgb(0.8, 0.502, 0.0), // #cc8000
  amberBg: rgb(0.996, 0.957, 0.878), // #fef4e0
  metricBg: rgb(0.945, 0.953, 0.973) // #f1f3f8
};

// ============================================================================
// PAGE LAYOUT
// ============================================================================

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2; // 512
const LINE_H = 14;
const PARA_SPACE = 6;

// ============================================================================
// MARKDOWN PARSER
// ============================================================================

/**
 * Parse Claude markdown into flat render-node array.
 *
 * Supported node types:
 *   { type: 'h1'|'h2'|'h3', text }
 *   { type: 'paragraph', runs }
 *   { type: 'bullet', depth, runs }
 *   { type: 'table', headers, rows }
 *   { type: 'callout', style, text }
 *   { type: 'metric', value, label }
 *   { type: 'hr' }
 *   { type: 'blank' }
 *
 * @param {string} markdown
 * @returns {Array<Object>}
 */
function parseMarkdown(markdown) {
  if (!markdown || typeof markdown !== "string") return [];

  const nodes = [];
  const lines = markdown.split("\n");
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Blank line
    if (line.trim() === "") {
      nodes.push({ type: "blank" });
      i++;
      continue;
    }

    // HR
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      nodes.push({ type: "hr" });
      i++;
      continue;
    }

    // Headings
    const h3m = line.match(/^### (.+)/);
    if (h3m) {
      nodes.push({ type: "h3", text: stripInline(h3m[1]) });
      i++;
      continue;
    }
    const h2m = line.match(/^## (.+)/);
    if (h2m) {
      nodes.push({ type: "h2", text: stripInline(h2m[1]) });
      i++;
      continue;
    }
    const h1m = line.match(/^# (.+)/);
    if (h1m) {
      nodes.push({ type: "h1", text: stripInline(h1m[1]) });
      i++;
      continue;
    }

    // Callout blocks (:::green ... ::: syntax)
    const calloutOpen = line.match(/^:::(green|red|blue|amber|neutral)/i);
    if (calloutOpen) {
      const style = calloutOpen[1].toLowerCase();
      const bodyLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(":::")) {
        bodyLines.push(lines[i]);
        i++;
      }
      i++; // skip closing :::
      nodes.push({ type: "callout", style, text: bodyLines.join("\n").trim() });
      continue;
    }

    // Blockquote as callout
    if (line.startsWith("> ")) {
      const text = stripInline(line.replace(/^>\s*/, "").trim());
      nodes.push({ type: "callout", style: "blue", text });
      i++;
      continue;
    }

    // Table detection
    if (line.includes("|")) {
      const tableLines = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i].trim());
        i++;
      }
      const tNode = parseTable(tableLines);
      if (tNode) nodes.push(tNode);
      continue;
    }

    // Bullet / unordered list
    const bm = line.match(/^(\s*)[-*+] (.+)/);
    if (bm) {
      const depth = Math.floor(bm[1].length / 2);
      nodes.push({ type: "bullet", depth, runs: parseInlineRuns(bm[2]) });
      i++;
      continue;
    }

    // Numbered list
    const nm = line.match(/^(\s*)\d+\. (.+)/);
    if (nm) {
      const depth = Math.floor(nm[1].length / 2);
      nodes.push({ type: "bullet", depth, runs: parseInlineRuns(nm[2]) });
      i++;
      continue;
    }

    // Metric shorthand: **$123,456** label
    const mm = line.match(/^\*\*\$?([\d,]+)\*\*\s*(.*)$/);
    if (mm) {
      nodes.push({ type: "metric", value: "$" + mm[1], label: mm[2].trim() });
      i++;
      continue;
    }

    // Plain paragraph
    nodes.push({ type: "paragraph", runs: parseInlineRuns(line.trim()) });
    i++;
  }

  return nodes;
}

/** Parse inline bold/italic into run objects */
function parseInlineRuns(text) {
  const runs = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|([^*]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) runs.push({ text: m[2], italic: true });
    else if (m[3] !== undefined) runs.push({ text: m[3] });
  }
  return runs.length > 0 ? runs : [{ text }];
}

/** Strip markdown syntax for plain-text contexts */
function stripInline(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .trim();
}

/** Parse a block of pipe-delimited lines into a table node */
function parseTable(tableLines) {
  const dataLines = tableLines.filter(l => !/^\|?[-:| ]+\|?$/.test(l));
  if (dataLines.length < 1) return null;

  const parseRow = s =>
    s
      .split("|")
      .map(c => stripInline(c.trim()))
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);

  const [headerLine, ...bodyLines] = dataLines;
  const headers = parseRow(headerLine);
  const rows = bodyLines.map(parseRow);
  if (headers.length === 0) return null;
  return { type: "table", headers, rows };
}

// ============================================================================
// PDF CONTEXT HELPERS
// ============================================================================

function makeCtx(doc, page, font, bold) {
  return { doc, pages: [page], currentPage: page, font, bold, y: PAGE_H - MARGIN };
}

function activePage(ctx) {
  return ctx.currentPage;
}

function ensureSpace(ctx, needed) {
  if (ctx.y - needed < MARGIN + 10) {
    const np = ctx.doc.addPage([PAGE_W, PAGE_H]);
    ctx.pages.push(np);
    ctx.currentPage = np;
    ctx.y = PAGE_H - MARGIN;
  }
}

function textWidth(font, text, size) {
  try {
    return font.widthOfTextAtSize(text, size);
  } catch (_) {
    return text.length * size * 0.5;
  }
}

function wrapText(font, text, size, maxWidth) {
  if (!text) return [""];
  const words = String(text).split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const test = current ? current + " " + word : word;
    if (textWidth(font, test, size) <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function drawTextLine(ctx, text, opts) {
  const f = opts && opts.font ? opts.font : ctx.font;
  const c = opts && opts.color ? opts.color : BRAND.black;
  const size = opts && opts.size ? opts.size : 10;
  const x = opts && opts.x ? opts.x : MARGIN;
  const mw = opts && opts.maxWidth ? opts.maxWidth : CONTENT_W;

  const wrapped = wrapText(f, String(text || ""), size, mw);
  for (const wl of wrapped) {
    ensureSpace(ctx, size + 4);
    activePage(ctx).drawText(wl, { x, y: ctx.y, size, font: f, color: c });
    ctx.y -= size + 4;
  }
}

function drawRuns(ctx, runs, opts) {
  const size = opts && opts.size ? opts.size : 10;
  const x = opts && opts.x ? opts.x : MARGIN;
  const c = opts && opts.color ? opts.color : BRAND.black;

  const fullText = runs.map(r => r.text).join("");
  const wrapped = wrapText(ctx.font, fullText, size, CONTENT_W - (x - MARGIN));

  if (wrapped.length === 1) {
    ensureSpace(ctx, size + 4);
    let curX = x;
    for (const run of runs) {
      const f = run.bold ? ctx.bold : ctx.font;
      activePage(ctx).drawText(run.text, { x: curX, y: ctx.y, size, font: f, color: c });
      curX += textWidth(f, run.text, size);
    }
    ctx.y -= size + 4;
  } else {
    const hasBold = runs.some(r => r.bold);
    const f = hasBold ? ctx.bold : ctx.font;
    for (const wl of wrapped) {
      ensureSpace(ctx, size + 4);
      activePage(ctx).drawText(wl, { x, y: ctx.y, size, font: f, color: c });
      ctx.y -= size + 4;
    }
  }
}

// ============================================================================
// BRANDED COMPONENT RENDERERS
// ============================================================================

function drawPageHeader(ctx, title, subtitle) {
  const headerH = subtitle ? 64 : 50;

  activePage(ctx).drawRectangle({
    x: 0,
    y: PAGE_H - headerH,
    width: PAGE_W,
    height: headerH,
    color: BRAND.navy
  });

  // Embed logo image or fall back to text
  if (ctx._logoImage) {
    const logoH = 18;
    const logoW = logoH * (ctx._logoImage.width / ctx._logoImage.height);
    activePage(ctx).drawImage(ctx._logoImage, {
      x: MARGIN,
      y: PAGE_H - 6 - logoH,
      width: logoW,
      height: logoH
    });
  } else {
    activePage(ctx).drawText("fundhub.", {
      x: MARGIN,
      y: PAGE_H - 24,
      size: 14,
      font: ctx.bold,
      color: rgb(0.4, 0.65, 1.0)
    });
  }
  activePage(ctx).drawText(title.toUpperCase(), {
    x: MARGIN,
    y: PAGE_H - 40,
    size: 16,
    font: ctx.bold,
    color: BRAND.white
  });
  if (subtitle) {
    activePage(ctx).drawText(subtitle, {
      x: MARGIN,
      y: PAGE_H - 55,
      size: 9,
      font: ctx.font,
      color: rgb(0.7, 0.75, 0.85)
    });
  }

  ctx.y = PAGE_H - headerH - 20;
}

function drawFooters(ctx, docTitle) {
  const total = ctx.pages.length;
  ctx.pages.forEach((page, idx) => {
    page.drawLine({
      start: { x: MARGIN, y: 28 },
      end: { x: PAGE_W - MARGIN, y: 28 },
      thickness: 0.5,
      color: BRAND.grayBorder
    });
    page.drawText("FundHub Credit Solutions \u2014 Confidential", {
      x: MARGIN,
      y: 16,
      size: 7,
      font: ctx.font,
      color: BRAND.gray
    });
    const ps = docTitle + "  |  Page " + (idx + 1) + " of " + total;
    const pw = textWidth(ctx.font, ps, 7);
    page.drawText(ps, {
      x: PAGE_W - MARGIN - pw,
      y: 16,
      size: 7,
      font: ctx.font,
      color: BRAND.gray
    });
  });
}

function renderH1(ctx, text) {
  ctx.y -= 8;
  ensureSpace(ctx, 26);
  activePage(ctx).drawText(text, {
    x: MARGIN,
    y: ctx.y,
    size: 18,
    font: ctx.bold,
    color: BRAND.navy
  });
  ctx.y -= 24;
  activePage(ctx).drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 1.5,
    color: BRAND.navy
  });
  ctx.y -= 10;
}

function renderH2(ctx, text) {
  ctx.y -= 10;
  ensureSpace(ctx, 22);
  activePage(ctx).drawRectangle({
    x: MARGIN,
    y: ctx.y - 4,
    width: 3,
    height: 18,
    color: BRAND.navy
  });
  activePage(ctx).drawText(text, {
    x: MARGIN + 10,
    y: ctx.y,
    size: 13,
    font: ctx.bold,
    color: BRAND.navy
  });
  ctx.y -= 20;
}

function renderH3(ctx, text) {
  ctx.y -= 6;
  ensureSpace(ctx, 16);
  activePage(ctx).drawText(text, {
    x: MARGIN,
    y: ctx.y,
    size: 11,
    font: ctx.bold,
    color: BRAND.navyLight
  });
  ctx.y -= 16;
}

function renderParagraph(ctx, runs) {
  ensureSpace(ctx, LINE_H + 4);
  drawRuns(ctx, runs, { size: 10 });
  ctx.y -= PARA_SPACE;
}

function renderBullet(ctx, runs, depth) {
  const indent = MARGIN + (depth || 0) * 16;
  ensureSpace(ctx, LINE_H + 2);
  activePage(ctx).drawText("\u2022", {
    x: indent,
    y: ctx.y,
    size: 10,
    font: ctx.bold,
    color: BRAND.navy
  });
  drawRuns(ctx, runs, { x: indent + 12, size: 10 });
}

function renderCallout(ctx, text, style) {
  const styleMap = {
    green: { border: BRAND.green, bg: BRAND.greenBg },
    red: { border: BRAND.red, bg: BRAND.redBg },
    blue: { border: BRAND.blue, bg: BRAND.blueBg },
    amber: { border: BRAND.amber, bg: BRAND.amberBg },
    neutral: { border: BRAND.grayBorder, bg: BRAND.grayLight }
  };
  const s = styleMap[style] || styleMap.neutral;
  const wrapped = wrapText(ctx.font, text, 10, CONTENT_W - 20);
  const boxH = wrapped.length * LINE_H + 14;

  ctx.y -= 4;
  ensureSpace(ctx, boxH + 8);

  activePage(ctx).drawRectangle({
    x: MARGIN,
    y: ctx.y - boxH + LINE_H,
    width: CONTENT_W,
    height: boxH,
    color: s.bg
  });
  activePage(ctx).drawRectangle({
    x: MARGIN,
    y: ctx.y - boxH + LINE_H,
    width: 3,
    height: boxH,
    color: s.border
  });

  const startY = ctx.y - 4;
  ctx.y = startY;
  for (const wl of wrapped) {
    activePage(ctx).drawText(wl, {
      x: MARGIN + 12,
      y: ctx.y,
      size: 10,
      font: ctx.font,
      color: BRAND.black
    });
    ctx.y -= LINE_H;
  }
  ctx.y -= 8;
}

function renderMetric(ctx, value, label) {
  const cardW = 200;
  const cardH = 52;
  ctx.y -= 6;
  ensureSpace(ctx, cardH + 8);

  activePage(ctx).drawRectangle({
    x: MARGIN,
    y: ctx.y - cardH + 14,
    width: cardW,
    height: cardH,
    color: BRAND.metricBg
  });
  activePage(ctx).drawRectangle({
    x: MARGIN,
    y: ctx.y - cardH + 14,
    width: 4,
    height: cardH,
    color: BRAND.navy
  });
  activePage(ctx).drawText(String(value || ""), {
    x: MARGIN + 14,
    y: ctx.y - 2,
    size: 22,
    font: ctx.bold,
    color: BRAND.navy
  });
  if (label) {
    activePage(ctx).drawText(String(label), {
      x: MARGIN + 14,
      y: ctx.y - 22,
      size: 9,
      font: ctx.font,
      color: BRAND.gray
    });
  }
  ctx.y -= cardH + 6;
}

function renderTable(ctx, headers, rows) {
  if (!headers || headers.length === 0) return;

  const colCount = headers.length;
  const colW = Math.floor(CONTENT_W / colCount);
  const cellPad = 5;
  const rowH = 18;

  ctx.y -= 8;
  ensureSpace(ctx, rowH + 6);

  const tableTop = ctx.y;

  // Header row
  activePage(ctx).drawRectangle({
    x: MARGIN,
    y: tableTop - rowH + 4,
    width: CONTENT_W,
    height: rowH,
    color: BRAND.navy
  });
  headers.forEach((h, ci) => {
    activePage(ctx).drawText(String(h || ""), {
      x: MARGIN + ci * colW + cellPad,
      y: tableTop - rowH + 8,
      size: 8,
      font: ctx.bold,
      color: BRAND.white
    });
  });
  ctx.y = tableTop - rowH;

  // Body rows
  rows.forEach((row, ri) => {
    const bg = ri % 2 === 0 ? BRAND.white : BRAND.grayLight;
    ensureSpace(ctx, rowH + 4);

    activePage(ctx).drawRectangle({
      x: MARGIN,
      y: ctx.y - rowH + 4,
      width: CONTENT_W,
      height: rowH,
      color: bg
    });
    activePage(ctx).drawLine({
      start: { x: MARGIN, y: ctx.y - rowH + 4 },
      end: { x: MARGIN + CONTENT_W, y: ctx.y - rowH + 4 },
      thickness: 0.3,
      color: BRAND.grayBorder
    });

    row.forEach((cell, ci) => {
      const cellStr = String(cell || "");
      const maxChars = Math.floor((colW - cellPad * 2) / 5);
      const truncated =
        textWidth(ctx.font, cellStr, 9) > colW - cellPad * 2
          ? cellStr.substring(0, maxChars) + "..."
          : cellStr;
      activePage(ctx).drawText(truncated, {
        x: MARGIN + ci * colW + cellPad,
        y: ctx.y - rowH + 8,
        size: 9,
        font: ctx.font,
        color: BRAND.black
      });
    });

    ctx.y -= rowH;
  });

  ctx.y -= 8;
}

function renderHR(ctx) {
  ctx.y -= 6;
  ensureSpace(ctx, 4);
  activePage(ctx).drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 0.5,
    color: BRAND.grayBorder
  });
  ctx.y -= 10;
}

// ============================================================================
// CTA PAGE (Booking URL + QR Placeholder)
// ============================================================================

function drawCTAPage(ctx, title, cta) {
  addNewPage(ctx);
  drawPageHeader(ctx, "NEXT STEPS", "");
  ctx.y -= 30;

  // Centered heading
  const headingText = title || "Let Us Build Your Game Plan Together";
  const headingWidth = ctx.bold.widthOfTextAtSize(headingText, 18);
  activePage(ctx).drawText(headingText, {
    x: (PAGE_W - headingWidth) / 2,
    y: ctx.y,
    size: 18,
    font: ctx.bold,
    color: BRAND.navy
  });
  ctx.y -= 30;

  // CTA body text
  if (cta) {
    const ctaWidth = CONTENT_W - 60;
    const ctaX = MARGIN + 30;
    const ctaText =
      typeof cta === "string"
        ? cta
        : "Review the suggestions above and contact our team to discuss next steps.";
    drawTextLine(ctx, ctaText, { size: 11, x: ctaX });
    ctx.y -= 20;
  }

  // QR Code placeholder box
  const qrSize = 100;
  const qrX = (PAGE_W - qrSize) / 2;
  activePage(ctx).drawRectangle({
    x: qrX,
    y: ctx.y - qrSize,
    width: qrSize,
    height: qrSize,
    borderColor: BRAND.grayBorder,
    borderWidth: 1,
    color: BRAND.grayLight
  });
  const qrLabel = "[ QR CODE ]";
  const qrLabelWidth = ctx.font.widthOfTextAtSize(qrLabel, 10);
  activePage(ctx).drawText(qrLabel, {
    x: (PAGE_W - qrLabelWidth) / 2,
    y: ctx.y - qrSize / 2 - 4,
    size: 10,
    font: ctx.font,
    color: BRAND.gray
  });
  ctx.y -= qrSize + 10;

  // Caption
  const caption = "Scan to book your call instantly";
  const capWidth = ctx.font.widthOfTextAtSize(caption, 9);
  activePage(ctx).drawText(caption, {
    x: (PAGE_W - capWidth) / 2,
    y: ctx.y,
    size: 9,
    font: ctx.font,
    color: BRAND.gray
  });
  ctx.y -= 20;

  // Booking URL
  const bookingUrl = process.env.BOOKING_URL || "www.fundhubbookingurl.template";
  const urlWidth = ctx.bold.widthOfTextAtSize(bookingUrl, 12);
  activePage(ctx).drawText(bookingUrl, {
    x: (PAGE_W - urlWidth) / 2,
    y: ctx.y,
    size: 12,
    font: ctx.bold,
    color: BRAND.navy
  });
  ctx.y -= 14;

  const subCaption = "Or copy this link into your browser";
  const subCapWidth = ctx.font.widthOfTextAtSize(subCaption, 9);
  activePage(ctx).drawText(subCaption, {
    x: (PAGE_W - subCapWidth) / 2,
    y: ctx.y,
    size: 9,
    font: ctx.font,
    color: BRAND.gray
  });
}

// ============================================================================
// NODE DISPATCHER
// ============================================================================

function renderNode(ctx, node) {
  switch (node.type) {
    case "h1":
      renderH1(ctx, node.text);
      break;
    case "h2":
      renderH2(ctx, node.text);
      break;
    case "h3":
      renderH3(ctx, node.text);
      break;
    case "paragraph":
      if (node.runs && node.runs.length) renderParagraph(ctx, node.runs);
      break;
    case "bullet":
      renderBullet(ctx, node.runs, node.depth || 0);
      break;
    case "table":
      renderTable(ctx, node.headers, node.rows);
      break;
    case "callout":
      renderCallout(ctx, node.text, node.style || "neutral");
      break;
    case "metric":
      renderMetric(ctx, node.value, node.label);
      break;
    case "hr":
      renderHR(ctx);
      break;
    case "blank":
      ctx.y -= 6;
      break;
    default:
      break;
  }
}

// ============================================================================
// METADATA STRIP
// ============================================================================

function drawMetadataStrip(ctx, personal, engineData) {
  ctx.y -= 4;
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const parts = [
    "Applicant: " + (personal && personal.name ? personal.name : "[Applicant Name]"),
    "Date: " + today
  ];
  if (engineData && engineData.outcome) parts.push("Outcome: " + engineData.outcome);
  const median =
    engineData && engineData.consumerSignals && engineData.consumerSignals.scores
      ? engineData.consumerSignals.scores.median
      : null;
  if (median) parts.push("Score: " + median);

  ensureSpace(ctx, LINE_H + 10);
  activePage(ctx).drawText(parts.join("   |   "), {
    x: MARGIN,
    y: ctx.y,
    size: 8,
    font: ctx.font,
    color: BRAND.gray
  });
  ctx.y -= LINE_H + 6;
  activePage(ctx).drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 0.5,
    color: BRAND.grayBorder
  });
  ctx.y -= 12;
}

// ============================================================================
// LETTER HEADER
// ============================================================================

function drawLetterHeader(ctx, params) {
  const personal = params.personal;
  const bureau = params.bureau;
  const subject = params.subject;
  const round = params.round;

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  drawTextLine(ctx, today, { size: 11 });
  ctx.y -= 10;

  const name = personal && personal.name ? personal.name : "[CONSUMER NAME]";
  const address = personal && personal.address ? personal.address : "[CONSUMER ADDRESS]";
  drawTextLine(ctx, name, { size: 11 });
  String(address)
    .split("\n")
    .forEach(al => drawTextLine(ctx, al, { size: 11 }));
  ctx.y -= 14;

  if (bureau) {
    drawTextLine(ctx, bureau.name, { size: 11, font: ctx.bold });
    if (bureau.address) {
      bureau.address.split("\n").forEach(bl => drawTextLine(ctx, bl, { size: 11 }));
    }
  }
  ctx.y -= 14;

  if (subject) {
    const subjectLine = round ? "Re: " + subject + " \u2014 Round " + round : "Re: " + subject;
    drawTextLine(ctx, subjectLine, { size: 12, font: ctx.bold });
    ctx.y -= 8;
  }

  activePage(ctx).drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 0.5,
    color: BRAND.grayBorder
  });
  ctx.y -= 14;
}

// ============================================================================
// INIT HELPER
// ============================================================================

async function initPdfDoc() {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  // Embed logo if available
  let logoImage = null;
  const logoBytes = getLogoBytes();
  if (logoBytes) {
    try {
      logoImage = await pdfDoc.embedPng(logoBytes);
    } catch (_e) {
      logoImage = null;
    }
  }
  return { pdfDoc, font, bold, logoImage };
}

// ============================================================================
// CORE PDF BUILDERS
// ============================================================================

/**
 * Render a rich document PDF from Claude markdown output.
 *
 * @param {string} markdownContent - Claude's markdown for this document
 * @param {string} type            - Document type key (e.g. 'credit_analysis')
 * @param {Object} [personal]      - { name, address }
 * @param {Object} [engineData]    - Full CRS engine result
 * @returns {Promise<Buffer>}
 */
async function renderDocumentPDF(markdownContent, type, personal, engineData) {
  const { pdfDoc, font, bold, logoImage } = await initPdfDoc();
  const firstPage = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const ctx = makeCtx(pdfDoc, firstPage, font, bold);
  ctx._logoImage = logoImage;

  const titles = {
    credit_analysis: "Credit Analysis Report",
    roadmap: "Credit Optimization Roadmap",
    funding_snapshot: "Funding Snapshot",
    lender_match: "Lender Match List",
    repair_plan_summary: "Repair Plan Summary",
    funding_summary: "Funding Pre-Approval Summary",
    business_prep_summary: "Business Credit Preparation",
    issue_priority_sheet: "Credit Issue Priority Sheet",
    hold_notice: "Application Hold Notice",
    operator_checklist: "Operator Checklist"
  };

  const title = titles[type] || type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
  const subtitle =
    personal && personal.name ? personal.name + "  \u00b7  Prepared " + today : "Prepared " + today;

  drawPageHeader(ctx, title, subtitle);
  drawMetadataStrip(ctx, personal, engineData);

  const nodes = parseMarkdown(markdownContent || "");
  for (const node of nodes) {
    renderNode(ctx, node);
  }

  // Add CTA page at the end of each document
  const { getCTA } = require("./build-suggestions");
  const outcome = engineData?.outcome || engineData?.outcomeResult?.outcome;
  const ctaText = outcome ? getCTA(outcome) : null;
  drawCTAPage(ctx, null, ctaText);

  drawFooters(ctx, title);

  const bytes = await pdfDoc.save();
  logInfo("render-pdf: document rendered", { type, pages: ctx.pages.length });
  return Buffer.from(bytes);
}

const BUREAU_ADDRESSES = {
  experian: { name: "Experian", address: "P.O. Box 4500\nAllen, TX 75013" },
  transunion: { name: "TransUnion", address: "P.O. Box 2000\nChester, PA 19016" },
  equifax: { name: "Equifax", address: "P.O. Box 740256\nAtlanta, GA 30374" }
};

const LETTER_SUBJECTS = {
  dispute: "Dispute of Inaccurate Information",
  inquiry_removal: "Inquiry Removal Request",
  personal_info: "Personal Information Correction Request"
};

/**
 * Render a letter PDF (dispute, inquiry removal, personal info).
 *
 * @param {string}      text     - Claude's text output / letter body
 * @param {string}      type     - 'dispute' | 'inquiry_removal' | 'personal_info'
 * @param {string}      bureau   - 'experian' | 'transunion' | 'equifax'
 * @param {number|null} round    - Round number (1-3) for dispute letters
 * @param {Object}      [personal] - { name, address }
 * @returns {Promise<Buffer>}
 */
async function renderLetterPDF(text, type, bureau, round, personal) {
  const { pdfDoc, font, bold, logoImage } = await initPdfDoc();
  const firstPage = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const ctx = makeCtx(pdfDoc, firstPage, font, bold);

  ctx.y = PAGE_H - MARGIN;

  const bureauInfo = BUREAU_ADDRESSES[bureau] || { name: bureau || "Credit Bureau", address: "" };
  const subject = LETTER_SUBJECTS[type] || "Credit Report Dispute";

  drawLetterHeader(ctx, { personal, bureau: bureauInfo, subject, round });

  // Render letter body as flowing paragraphs (no markdown parsing for letters)
  const paragraphs = String(text || "").split(/\n\n+/);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      ctx.y -= 8;
      continue;
    }
    const bodyLines = trimmed.split("\n");
    for (const bl of bodyLines) {
      if (!bl.trim()) {
        ctx.y -= 6;
      } else {
        drawTextLine(ctx, bl.trim(), { size: 11 });
      }
    }
    ctx.y -= 8;
  }

  const titleStr = bureauInfo.name + " " + subject + (round ? " R" + round : "");
  drawFooters(ctx, titleStr);

  const bytes = await pdfDoc.save();
  logInfo("render-pdf: letter rendered", { type, bureau, round, pages: ctx.pages.length });
  return Buffer.from(bytes);
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Render all PDFs from a document package.
 *
 * @param {Object}   params
 * @param {Array}    params.documents  - [{type, content}] rich documents
 * @param {Array}    params.letters    - [{type, bureau, round, content}] letters
 * @param {Object}   params.personal   - { name, address }
 * @param {Object}   params.engineData - Full CRS engine result
 * @returns {Promise<Array<{filename, buffer, docType}>>}
 */
async function renderAllPDFs(params) {
  const documents = params && params.documents ? params.documents : [];
  const letters = params && params.letters ? params.letters : [];
  const personal = params && params.personal ? params.personal : null;
  const engineData = params && params.engineData ? params.engineData : null;

  const results = [];
  const errors = [];

  for (const doc of documents) {
    try {
      const buffer = await renderDocumentPDF(doc.content, doc.type, personal, engineData);
      results.push({ filename: doc.type + ".pdf", buffer, docType: doc.type });
    } catch (err) {
      logWarn("render-pdf: document render failed", { type: doc.type, error: err.message });
      errors.push({ type: doc.type, error: err.message });
    }
  }

  for (const letter of letters) {
    try {
      const buffer = await renderLetterPDF(
        letter.content,
        letter.type,
        letter.bureau,
        letter.round,
        personal
      );
      const prefix = (letter.bureau || "").substring(0, 2);
      const suffix = letter.round ? "_r" + letter.round : "";
      const filename = letter.type + "_" + prefix + suffix + ".pdf";
      results.push({ filename, buffer, docType: letter.type });
    } catch (err) {
      logWarn("render-pdf: letter render failed", {
        type: letter.type,
        bureau: letter.bureau,
        round: letter.round,
        error: err.message
      });
      errors.push({ type: letter.type, bureau: letter.bureau, error: err.message });
    }
  }

  logInfo("render-pdf: renderAllPDFs complete", {
    rendered: results.length,
    failed: errors.length
  });
  return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  renderAllPDFs,
  renderDocumentPDF,
  renderLetterPDF,
  parseMarkdown,
  parseInlineRuns,
  wrapText,
  BRAND,
  BUREAU_ADDRESSES,
  LETTER_SUBJECTS
};
