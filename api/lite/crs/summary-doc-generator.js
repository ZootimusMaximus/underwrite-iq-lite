"use strict";

/**
 * summary-doc-generator.js — PDF generation for CRS summary documents
 *
 * Generates the 6 summary document types specified by build-documents.js:
 * - funding_summary — Customer-facing pre-approval summary
 * - repair_plan_summary — Customer repair roadmap
 * - issue_priority_sheet — Prioritized credit issue list
 * - hold_notice — Application hold notification
 * - operator_checklist — Internal review checklist
 * - business_prep_summary — Business credit preparation guide
 */

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

// ---------------------------------------------------------------------------
// Shared PDF helpers
// ---------------------------------------------------------------------------

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 50;
const LINE_H = 14;

function today() {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

async function initDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  return { doc, font, bold, page, y: PAGE_H - MARGIN };
}

function drawTitle(page, bold, y, text) {
  page.drawText(text, { x: MARGIN, y, size: 16, font: bold, color: rgb(0.1, 0.1, 0.3) });
  return y - LINE_H * 2;
}

function drawSubtitle(page, bold, y, text) {
  page.drawText(text, { x: MARGIN, y, size: 12, font: bold });
  return y - LINE_H * 1.5;
}

function drawLine(page, font, y, text, size) {
  size = size || 10;
  page.drawText(text, { x: MARGIN, y, size, font });
  return y - LINE_H;
}

function drawBullet(page, font, y, text) {
  page.drawText(`  \u2022 ${text}`, { x: MARGIN, y, size: 10, font });
  return y - LINE_H;
}

function drawSeparator(page, y) {
  page.drawLine({
    start: { x: MARGIN, y: y + 4 },
    end: { x: PAGE_W - MARGIN, y: y + 4 },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7)
  });
  return y - LINE_H;
}

// ---------------------------------------------------------------------------
// 1. Funding Summary
// ---------------------------------------------------------------------------

async function generateFundingSummary(crsResult, personal) {
  const { doc, font, bold, page } = await initDoc();
  let y = PAGE_H - MARGIN;

  y = drawLine(page, font, y, today());
  y -= LINE_H;
  y = drawTitle(page, bold, y, "Funding Pre-Approval Summary");
  y = drawSeparator(page, y);

  y = drawLine(page, font, y, `Applicant: ${personal?.name || "[Applicant Name]"}`);
  y = drawLine(page, font, y, `Decision: ${crsResult.decision_label || crsResult.outcome}`);
  y -= LINE_H;

  y = drawSubtitle(page, bold, y, "Pre-Approval Estimates");
  const pa = crsResult.preapprovals || {};
  y = drawBullet(page, font, y, `Personal Funding: $${(pa.totalPersonal || 0).toLocaleString()}`);
  y = drawBullet(page, font, y, `Business Funding: $${(pa.totalBusiness || 0).toLocaleString()}`);
  y = drawBullet(page, font, y, `Total Combined: $${(pa.totalCombined || 0).toLocaleString()}`);
  if (pa.confidenceBand) {
    y = drawBullet(page, font, y, `Confidence: ${pa.confidenceBand}`);
  }
  y -= LINE_H;

  y = drawSubtitle(page, bold, y, "Credit Snapshot");
  const cs = crsResult.consumerSignals || {};
  if (cs.scores?.median) y = drawBullet(page, font, y, `Median Score: ${cs.scores.median}`);
  if (cs.utilization?.overall != null)
    y = drawBullet(page, font, y, `Utilization: ${cs.utilization.overall}%`);
  y -= LINE_H;

  if (crsResult.consumer_summary) {
    y = drawSubtitle(page, bold, y, "Summary");
    y = drawLine(page, font, y, crsResult.consumer_summary.substring(0, 200));
  }

  y -= LINE_H * 2;
  y = drawLine(
    page,
    font,
    y,
    "This is a pre-qualification estimate, not a guarantee of funding.",
    8
  );
  drawLine(page, font, y, `Generated: ${today()}`, 8);

  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------------------
// 2. Repair Plan Summary
// ---------------------------------------------------------------------------

async function generateRepairPlanSummary(crsResult, personal) {
  const { doc, font, bold, page } = await initDoc();
  let y = PAGE_H - MARGIN;

  y = drawLine(page, font, y, today());
  y -= LINE_H;
  y = drawTitle(page, bold, y, "Credit Repair Plan");
  y = drawSeparator(page, y);

  y = drawLine(page, font, y, `Applicant: ${personal?.name || "[Applicant Name]"}`);
  y -= LINE_H;

  y = drawSubtitle(page, bold, y, "Current Credit Status");
  const cs = crsResult.consumerSignals || {};
  if (cs.scores?.median) y = drawBullet(page, font, y, `Median Score: ${cs.scores.median}`);
  if (cs.utilization?.overall != null)
    y = drawBullet(page, font, y, `Utilization: ${cs.utilization.overall}%`);
  if (cs.derogatories?.active != null)
    y = drawBullet(page, font, y, `Active Derogatories: ${cs.derogatories.active}`);
  y -= LINE_H;

  const findings = crsResult.optimization_findings || [];
  if (findings.length > 0) {
    y = drawSubtitle(page, bold, y, "Priority Actions");
    for (const f of findings.slice(0, 8)) {
      y = drawBullet(page, font, y, `${f.code || f.category}: ${f.title || f.description || ""}`);
      if (y < MARGIN + 40) break;
    }
    y -= LINE_H;
  }

  const suggestions = crsResult.suggestions;
  const topMoves = suggestions?.topMoves || suggestions?.flatList || [];
  if (topMoves.length > 0) {
    y = drawSubtitle(page, bold, y, "Top Recommendations");
    for (const s of topMoves.slice(0, 5)) {
      y = drawBullet(page, font, y, s.title || s.problem || s.code || "");
      if (y < MARGIN + 40) break;
    }
  }

  y -= LINE_H * 2;
  y = drawLine(page, font, y, `Generated: ${today()}`, 8);

  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------------------
// 3. Issue Priority Sheet
// ---------------------------------------------------------------------------

async function generateIssuePrioritySheet(crsResult) {
  const { doc, font, bold, page } = await initDoc();
  let y = PAGE_H - MARGIN;

  y = drawLine(page, font, y, today());
  y -= LINE_H;
  y = drawTitle(page, bold, y, "Credit Issue Priority Sheet");
  y = drawSeparator(page, y);

  const findings = crsResult.optimization_findings || [];
  if (findings.length === 0) {
    y = drawLine(page, font, y, "No credit issues identified.");
  } else {
    // Group by severity
    const high = findings.filter(f => f.severity === "high" || f.severity === "critical");
    const medium = findings.filter(f => f.severity === "medium");
    const low = findings.filter(f => f.severity === "low" || f.severity === "info");

    if (high.length > 0) {
      y = drawSubtitle(page, bold, y, "HIGH PRIORITY");
      for (const f of high) {
        y = drawBullet(page, font, y, `${f.code || f.category}: ${f.title || f.description || ""}`);
        if (y < MARGIN + 40) break;
      }
      y -= LINE_H;
    }

    if (medium.length > 0) {
      y = drawSubtitle(page, bold, y, "MEDIUM PRIORITY");
      for (const f of medium) {
        y = drawBullet(page, font, y, `${f.code || f.category}: ${f.title || f.description || ""}`);
        if (y < MARGIN + 40) break;
      }
      y -= LINE_H;
    }

    if (low.length > 0) {
      y = drawSubtitle(page, bold, y, "LOW PRIORITY");
      for (const f of low) {
        y = drawBullet(page, font, y, `${f.code || f.category}: ${f.title || f.description || ""}`);
        if (y < MARGIN + 40) break;
      }
    }
  }

  y -= LINE_H * 2;
  y = drawLine(page, font, y, "INTERNAL DOCUMENT — Do not distribute to client.", 8);
  y = drawLine(page, font, y, `Generated: ${today()}`, 8);

  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------------------
// 4. Hold Notice
// ---------------------------------------------------------------------------

async function generateHoldNotice(crsResult, personal) {
  const { doc, font, bold, page } = await initDoc();
  let y = PAGE_H - MARGIN;

  y = drawLine(page, font, y, today());
  y -= LINE_H;
  y = drawTitle(page, bold, y, "Application Hold Notice");
  y = drawSeparator(page, y);

  y = drawLine(page, font, y, `Applicant: ${personal?.name || "[Applicant Name]"}`);
  y = drawLine(page, font, y, `Status: ${crsResult.decision_label || "On Hold"}`);
  y -= LINE_H;

  y = drawSubtitle(page, bold, y, "Reason");
  y = drawLine(
    page,
    font,
    y,
    crsResult.decision_explanation || "Your application requires additional review."
  );
  y -= LINE_H;

  const codes = crsResult.reason_codes || [];
  if (codes.length > 0) {
    y = drawSubtitle(page, bold, y, "Reason Codes");
    for (const code of codes) {
      y = drawBullet(page, font, y, code);
    }
  }

  y -= LINE_H * 2;
  y = drawLine(page, font, y, "INTERNAL DOCUMENT — Do not distribute to client.", 8);
  y = drawLine(page, font, y, `Generated: ${today()}`, 8);

  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------------------
// 5. Operator Checklist
// ---------------------------------------------------------------------------

async function generateOperatorChecklist(crsResult) {
  const { doc, font, bold, page } = await initDoc();
  let y = PAGE_H - MARGIN;

  y = drawLine(page, font, y, today());
  y -= LINE_H;
  y = drawTitle(page, bold, y, "Operator Checklist");
  y = drawSeparator(page, y);

  const outcome = crsResult.outcome || "UNKNOWN";
  y = drawLine(page, font, y, `Outcome: ${outcome}`);
  y = drawLine(page, font, y, `Decision: ${crsResult.decision_label || ""}`);
  y -= LINE_H;

  // Outcome-specific checklist items
  const checklistItems = getChecklistItems(outcome, crsResult);

  y = drawSubtitle(page, bold, y, "Action Items");
  for (const item of checklistItems) {
    y = drawBullet(page, font, y, `[ ] ${item}`);
    if (y < MARGIN + 40) break;
  }

  y -= LINE_H;
  y = drawSubtitle(page, bold, y, "Key Metrics");
  const cs = crsResult.consumerSignals || {};
  const pa = crsResult.preapprovals || {};
  if (cs.scores?.median) y = drawBullet(page, font, y, `Score: ${cs.scores.median}`);
  if (pa.totalCombined)
    y = drawBullet(page, font, y, `Total Pre-Approval: $${pa.totalCombined.toLocaleString()}`);
  if (crsResult.confidence) y = drawBullet(page, font, y, `Confidence: ${crsResult.confidence}`);

  y -= LINE_H * 2;
  y = drawLine(page, font, y, "INTERNAL DOCUMENT — Do not distribute to client.", 8);
  y = drawLine(page, font, y, `Generated: ${today()}`, 8);

  return Buffer.from(await doc.save());
}

function getChecklistItems(outcome, crsResult) {
  switch (outcome) {
    case "FRAUD_HOLD":
      return [
        "Verify applicant identity manually",
        "Review fraud indicators in audit trail",
        "Contact applicant if identity mismatch is resolvable",
        "Escalate to compliance if fraud confirmed"
      ];
    case "MANUAL_REVIEW":
      return [
        "Review audit trail for low-confidence indicators",
        "Verify bureau data completeness",
        "Check if additional documentation is needed",
        "Determine if applicant can be re-pulled with corrections"
      ];
    case "REPAIR":
      return [
        "Confirm dispute letters generated for all bureaus",
        "Schedule follow-up for dispute results (30-45 days)",
        "Review repair plan with client",
        "Set credit monitoring alerts",
        "Schedule re-analysis after disputes complete"
      ];
    case "CONDITIONAL_APPROVAL":
      return [
        "Review conditional items with client",
        "Verify pre-approval amounts are realistic",
        "Begin lender application process",
        "Address optimization findings before submission",
        `Total estimated: $${(crsResult.preapprovals?.totalCombined || 0).toLocaleString()}`
      ];
    case "FULL_STACK_APPROVAL":
    case "PREMIUM_STACK":
      return [
        "Begin full lender application stack",
        "Verify business entity if applicable",
        "Submit applications in recommended order",
        "Monitor inquiry impact",
        `Total estimated: $${(crsResult.preapprovals?.totalCombined || 0).toLocaleString()}`
      ];
    default:
      return ["Review engine output", "Determine next action"];
  }
}

// ---------------------------------------------------------------------------
// 6. Business Prep Summary
// ---------------------------------------------------------------------------

async function generateBusinessPrepSummary(crsResult) {
  const { doc, font, bold, page } = await initDoc();
  let y = PAGE_H - MARGIN;

  y = drawLine(page, font, y, today());
  y -= LINE_H;
  y = drawTitle(page, bold, y, "Business Credit Preparation Guide");
  y = drawSeparator(page, y);

  const bs = crsResult.businessSignals || {};

  if (bs.available) {
    y = drawSubtitle(page, bold, y, "Current Business Credit Status");
    if (bs.scores?.intelliscore)
      y = drawBullet(page, font, y, `Intelliscore: ${bs.scores.intelliscore}`);
    if (bs.scores?.fsr)
      y = drawBullet(page, font, y, `FSR (Financial Stability): ${bs.scores.fsr}`);
    if (bs.dbt?.value != null) y = drawBullet(page, font, y, `Days Beyond Terms: ${bs.dbt.value}`);
    y -= LINE_H;
  } else {
    y = drawLine(page, font, y, "No business credit report available.");
    y -= LINE_H;
  }

  y = drawSubtitle(page, bold, y, "Preparation Steps");
  const steps = [
    "Establish or verify LLC/Corporation with Secretary of State",
    "Obtain EIN from IRS if not already done",
    "Open business bank account in entity name",
    "Register with Dun & Bradstreet for DUNS number",
    "Establish net-30 trade accounts (Uline, Grainger, etc.)",
    "Monitor business credit reports quarterly",
    "Keep personal utilization below 30%",
    "Address any personal derogatories before business applications"
  ];

  for (const step of steps) {
    y = drawBullet(page, font, y, step);
    if (y < MARGIN + 40) break;
  }

  y -= LINE_H * 2;
  y = drawLine(page, font, y, `Generated: ${today()}`, 8);

  return Buffer.from(await doc.save());
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Generate a summary document PDF by type.
 *
 * @param {string} docType - One of: funding_summary, repair_plan_summary, issue_priority_sheet, hold_notice, operator_checklist, business_prep_summary
 * @param {Object} crsResult - Full CRS engine result
 * @param {Object} [personal] - { name, address }
 * @returns {Promise<Buffer>} PDF buffer
 */
async function generateSummaryDocument(docType, crsResult, personal) {
  switch (docType) {
    case "funding_summary":
      return generateFundingSummary(crsResult, personal);
    case "repair_plan_summary":
      return generateRepairPlanSummary(crsResult, personal);
    case "issue_priority_sheet":
      return generateIssuePrioritySheet(crsResult);
    case "hold_notice":
      return generateHoldNotice(crsResult, personal);
    case "operator_checklist":
      return generateOperatorChecklist(crsResult);
    case "business_prep_summary":
      return generateBusinessPrepSummary(crsResult);
    default:
      throw new Error(`Unknown summary document type: ${docType}`);
  }
}

/**
 * Generate all summary documents from CRS document specs.
 *
 * @param {Array<{type, description}>} summaryDocSpecs - From buildDocuments().summaryDocuments
 * @param {Object} crsResult - Full CRS engine result
 * @param {Object} [personal] - { name, address }
 * @returns {Promise<Array<{filename, buffer, type}>>}
 */
async function generateAllSummaryDocuments(summaryDocSpecs, crsResult, personal) {
  const results = [];

  for (const spec of summaryDocSpecs) {
    try {
      const buffer = await generateSummaryDocument(spec.type, crsResult, personal);
      results.push({
        filename: `${spec.type}.pdf`,
        buffer,
        type: spec.type
      });
    } catch {
      // Skip unknown types silently
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateSummaryDocument,
  generateAllSummaryDocuments,
  generateFundingSummary,
  generateRepairPlanSummary,
  generateIssuePrioritySheet,
  generateHoldNotice,
  generateOperatorChecklist,
  generateBusinessPrepSummary
};
