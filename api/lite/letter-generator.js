// ============================================================================
// Dispute Letter Generator
// Generates PDF dispute letters based on repair vs fundable path
// ============================================================================

const { PDFDocument, StandardFonts } = require("pdf-lib");
const { logInfo } = require("./logger");

const BUREAUS = {
  experian: {
    name: "Experian",
    prefix: "ex",
    address: "P.O. Box 4500\nAllen, TX 75013"
  },
  transunion: {
    name: "TransUnion",
    prefix: "tu",
    address: "P.O. Box 2000\nChester, PA 19016"
  },
  equifax: {
    name: "Equifax",
    prefix: "eq",
    address: "P.O. Box 740256\nAtlanta, GA 30374"
  }
};

/**
 * Generate all dispute letters based on path
 * @param {Object} params
 * @param {string} params.path - "repair" or "fundable"
 * @param {Object} params.bureaus - Parsed bureau data
 * @param {Object} params.personal - Personal info (name, addresses, etc.)
 * @param {Object} params.underwrite - Underwriting results
 * @returns {Promise<Array<{filename: string, buffer: Buffer}>>}
 */
async function generateLetters({ path, bureaus, personal, underwrite }) {
  const letters = [];

  if (path === "repair") {
    // Repair path: 9 dispute letters + 2 personal info letters
    const disputeLetters = await generateDisputeLetters({ bureaus, personal, underwrite });
    letters.push(...disputeLetters);
  } else {
    // Fundable path: 2 personal info + 2 inquiry letters
    const inquiryLetters = await generateInquiryLetters({ bureaus, personal });
    letters.push(...inquiryLetters);
  }

  // Both paths get personal info letters
  const personalInfoLetters = await generatePersonalInfoLetters({ bureaus, personal });
  letters.push(...personalInfoLetters);

  logInfo("Letters generated", {
    path,
    count: letters.length,
    files: letters.map(l => l.filename)
  });

  return letters;
}

/**
 * Generate 9 dispute letters (3 rounds × 3 bureaus) for repair path
 */
async function generateDisputeLetters({ bureaus, personal, underwrite: _underwrite }) {
  const letters = [];
  const rounds = [1, 2, 3];

  for (const [bureauKey, bureauInfo] of Object.entries(BUREAUS)) {
    const bureauData = bureaus[bureauKey] || {};

    for (const round of rounds) {
      const filename = `${bureauInfo.prefix}_round${round}.pdf`;

      // Get accounts to dispute for this round
      const accounts = getAccountsForRound(bureauData, round);

      const buffer = await createDisputeLetter({
        bureau: bureauInfo,
        personal,
        round,
        accounts,
        bureauData
      });

      letters.push({ filename, buffer });
    }
  }

  return letters;
}

/**
 * Generate 2 inquiry removal letters for fundable path
 */
async function generateInquiryLetters({ bureaus, personal }) {
  const letters = [];
  const rounds = [1, 2];

  for (const round of rounds) {
    const filename = `inquiries_round${round}.pdf`;

    // Collect inquiries from all bureaus
    const inquiries = collectInquiries(bureaus, round);

    const buffer = await createInquiryLetter({
      personal,
      round,
      inquiries
    });

    letters.push({ filename, buffer });
  }

  return letters;
}

/**
 * Generate 2 personal information dispute letters (both paths)
 */
async function generatePersonalInfoLetters({ bureaus, personal }) {
  const letters = [];
  const rounds = [1, 2];

  for (const round of rounds) {
    const filename = `personal_info_round${round}.pdf`;

    // Collect personal info variations from all bureaus
    const variations = collectPersonalInfoVariations(bureaus, round);

    const buffer = await createPersonalInfoLetter({
      personal,
      round,
      variations
    });

    letters.push({ filename, buffer });
  }

  return letters;
}

/**
 * Get accounts to dispute for a specific round
 * Distributes accounts across 3 rounds
 */
function getAccountsForRound(bureauData, round) {
  const tradelines = bureauData.tradelines || [];

  // Filter to negative/derogatory accounts
  const negativeAccounts = tradelines.filter(t => {
    const status = (t.status || "").toLowerCase();
    return (
      status.includes("collection") ||
      status.includes("charge") ||
      status.includes("late") ||
      status.includes("derogatory") ||
      status.includes("closed") ||
      t.is_negative
    );
  });

  // Distribute across rounds (round 1 gets indices 0,3,6..., round 2 gets 1,4,7..., etc.)
  return negativeAccounts.filter((_, idx) => idx % 3 === round - 1);
}

/**
 * Collect inquiries from all bureaus for a round
 */
function collectInquiries(bureaus, round) {
  const allInquiries = [];

  for (const [bureauKey, bureauData] of Object.entries(bureaus)) {
    const count = bureauData.inquiries || 0;
    if (count > 0) {
      allInquiries.push({
        bureau: BUREAUS[bureauKey]?.name || bureauKey,
        count
      });
    }
  }

  // Split inquiries between 2 rounds
  if (round === 1) {
    return allInquiries.slice(0, Math.ceil(allInquiries.length / 2));
  }
  return allInquiries.slice(Math.ceil(allInquiries.length / 2));
}

/**
 * Collect personal info variations from all bureaus
 */
function collectPersonalInfoVariations(bureaus, _round) {
  const variations = {
    names: new Set(),
    addresses: new Set(),
    employers: new Set()
  };

  for (const bureauData of Object.values(bureaus)) {
    (bureauData.names || []).forEach(n => variations.names.add(n));
    (bureauData.addresses || []).forEach(a => variations.addresses.add(a));
    (bureauData.employers || []).forEach(e => variations.employers.add(e));
  }

  return {
    names: Array.from(variations.names),
    addresses: Array.from(variations.addresses),
    employers: Array.from(variations.employers)
  };
}

// ============================================================================
// PDF CREATION FUNCTIONS
// ============================================================================

/**
 * Create a dispute letter PDF
 */
async function createDisputeLetter({ bureau, personal, round, accounts, bureauData: _bureauData }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]); // Letter size
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const leftMargin = 50;
  const lineHeight = 14;

  // Date
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  page.drawText(today, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;

  // Consumer info (from personal data or placeholder)
  const name = personal?.name || "[CONSUMER NAME]";
  const address = personal?.address || "[CONSUMER ADDRESS]";

  page.drawText(name, { x: leftMargin, y, size: 11, font });
  y -= lineHeight;
  page.drawText(address, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;

  // Bureau address
  page.drawText(bureau.name, { x: leftMargin, y, size: 11, boldFont });
  y -= lineHeight;
  const bureauAddressLines = bureau.address.split("\n");
  bureauAddressLines.forEach(line => {
    page.drawText(line, { x: leftMargin, y, size: 11, font });
    y -= lineHeight;
  });
  y -= lineHeight;

  // Subject line
  page.drawText(`Re: Dispute of Inaccurate Information - Round ${round}`, {
    x: leftMargin,
    y,
    size: 12,
    font: boldFont
  });
  y -= lineHeight * 2;

  // Body - Placeholder content (will be replaced with real templates)
  const bodyText = `To Whom It May Concern:

I am writing to dispute inaccurate information appearing on my credit report. Under the Fair Credit Reporting Act (FCRA), I have the right to dispute incomplete or inaccurate information.

The following account(s) contain inaccurate information and I am requesting investigation and correction:

${accounts.length > 0 ? formatAccountsList(accounts) : "[ACCOUNTS TO BE DISPUTED]"}

Please investigate these items and remove or correct any information that cannot be verified as accurate and complete within 30 days as required by the FCRA.

Please send me written notification of the results of your investigation.

Sincerely,

${name}`;

  // Draw body text with wrapping
  const bodyLines = bodyText.split("\n");
  bodyLines.forEach(line => {
    if (line.trim() === "") {
      y -= lineHeight;
    } else {
      const wrapped = wrapText(line, font, 11, 512);
      wrapped.split("\n").forEach(wLine => {
        if (y < 50) {
          // Add new page if needed
          pdfDoc.addPage([612, 792]);
          y = 740;
        }
        page.drawText(wLine, { x: leftMargin, y, size: 11, font });
        y -= lineHeight;
      });
    }
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Create an inquiry removal letter PDF
 */
async function createInquiryLetter({ personal, round, inquiries }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const leftMargin = 50;
  const lineHeight = 14;

  // Date
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  page.drawText(today, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;

  // Consumer info
  const name = personal?.name || "[CONSUMER NAME]";
  page.drawText(name, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;

  // Subject
  page.drawText(`Re: Inquiry Removal Request - Round ${round}`, {
    x: leftMargin,
    y,
    size: 12,
    font: boldFont
  });
  y -= lineHeight * 2;

  // Body - Placeholder
  const bodyText = `To Whom It May Concern:

I am writing to request the removal of unauthorized inquiries from my credit report. Under the FCRA, inquiries made without my consent or permissible purpose should be removed.

The following inquiries were made without my authorization:

${inquiries.map(i => `- ${i.bureau}: ${i.count} inquiry(ies)`).join("\n") || "[INQUIRIES TO BE REMOVED]"}

Please investigate and remove these unauthorized inquiries within 30 days.

Sincerely,

${name}`;

  const bodyLines = bodyText.split("\n");
  bodyLines.forEach(line => {
    if (line.trim() === "") {
      y -= lineHeight;
    } else {
      page.drawText(line, { x: leftMargin, y, size: 11, font });
      y -= lineHeight;
    }
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Create a personal information dispute letter PDF
 */
async function createPersonalInfoLetter({ personal, round, variations }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const leftMargin = 50;
  const lineHeight = 14;

  // Date
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  page.drawText(today, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;

  // Consumer info
  const name = personal?.name || "[CONSUMER NAME]";
  page.drawText(name, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;

  // Subject
  page.drawText(`Re: Personal Information Correction Request - Round ${round}`, {
    x: leftMargin,
    y,
    size: 12,
    font: boldFont
  });
  y -= lineHeight * 2;

  // Body - Placeholder
  const bodyText = `To Whom It May Concern:

I am writing to request correction of inaccurate personal information on my credit file.

The following information is incorrect and should be updated or removed:

Name Variations: ${variations.names.length > 0 ? variations.names.join(", ") : "None identified"}
Address Variations: ${variations.addresses.length > 0 ? variations.addresses.slice(0, 3).join("; ") : "None identified"}
Employer Information: ${variations.employers.length > 0 ? variations.employers.join(", ") : "None identified"}

Please update my file with only the correct information.

Sincerely,

${name}`;

  const bodyLines = bodyText.split("\n");
  bodyLines.forEach(line => {
    if (line.trim() === "") {
      y -= lineHeight;
    } else {
      const wrapped = wrapText(line, font, 11, 512);
      wrapped.split("\n").forEach(wLine => {
        page.drawText(wLine, { x: leftMargin, y, size: 11, font });
        y -= lineHeight;
      });
    }
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function formatAccountsList(accounts) {
  if (!accounts || accounts.length === 0) return "";

  return accounts
    .map(a => {
      const creditor = a.creditor || "Unknown Creditor";
      const status = a.status || "Unknown Status";
      return `- ${creditor}: ${status}`;
    })
    .join("\n");
}

function wrapText(text, font, size, maxWidth) {
  const words = text.split(" ");
  let line = "";
  let lines = "";

  words.forEach(word => {
    const testLine = line + word + " ";
    const width = font.widthOfTextAtSize(testLine, size);

    if (width < maxWidth) {
      line = testLine;
    } else {
      lines += line.trim() + "\n";
      line = word + " ";
    }
  });

  lines += line.trim();
  return lines;
}

module.exports = {
  generateLetters,
  generateDisputeLetters,
  generateInquiryLetters,
  generatePersonalInfoLetters,
  BUREAUS
};
