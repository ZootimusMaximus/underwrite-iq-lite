"use strict";

/**
 * generate-mock-pdfs.js
 *
 * Generates 3 mock dispute letter PDFs using the render-pdf.js system.
 * Letters match Chris's template format: structured DISPUTED ITEM sections
 * with numbered Metro 2 field sub-points, one letter per bureau.
 *
 * Output: /Users/darwin1/Documents/projects/fundhub/mar 2026/apr-26/
 *
 * Usage: node scripts/generate-mock-pdfs.js
 */

require("dotenv").config({ path: ".env.local" });

const fs = require("fs");
const path = require("path");
const { renderLetterPDF } = require("../api/lite/crs/render-pdf");

// ── Consumer info ─────────────────────────────────────────────────────────────

const personal = {
  name: "James Richardson",
  address: "4521 Oak Park Drive, Phoenix, AZ 85016"
};

// ── Output directory ──────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, "..", "..", "mar 2026", "apr-26");

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log("Created output directory:", OUTPUT_DIR);
}

// ── Letter bodies ─────────────────────────────────────────────────────────────
//
// NOTE: renderLetterPDF auto-renders the header block (date, consumer address,
// bureau address, Re: subject line). The text below starts at the salutation
// and contains the full letter body.

const letterExperian = `Dear Experian,

I am writing to formally dispute the following items on my credit report. Under the Fair Credit Reporting Act, Section 611 [15 U.S.C. § 1681i], I am requesting a thorough investigation of the information listed below that I believe to be inaccurate, incomplete, or unverifiable.

DISPUTED ITEM 1 — Midland Funding LLC
Account Type: Collection
Balance Reported: $2,100
Original Charge-Off Amount: $1,850
Account Opened: March 2019

The following Metro 2 fields contain reporting errors that must be investigated and corrected:

1. Field 25 (Date of First Delinquency) — This field is missing entirely. The DOFD is required for all derogatory accounts and controls the 7-year reporting window under FCRA § 605 [15 U.S.C. § 1681c(a)]. Without an accurate DOFD, there is no way to determine whether this account has exceeded its reporting period.

2. Field 29 / K1 Segment (Original Creditor Name) — This collection account does not report the original creditor. Metro 2 format requires the K1 Segment to be populated with the original creditor name for all purchased or transferred debt. The absence of this information prevents me from verifying the legitimacy of this debt.

3. Field 21 (Current Balance) — The account reports a $2,100 balance despite being a closed collection account. If this debt has been sold or transferred, the balance should reflect $0 per Metro 2 Base Segment requirements.

DISPUTED ITEM 2 — Cavalry SPV I LLC
Account Type: Collection
Balance Reported: $890
Account Opened: November 2020

The following Metro 2 fields contain reporting errors that must be investigated and corrected:

1. Field 5 (Account Status) — The reported status does not accurately reflect the current disposition of this account. I am requesting verification of the status code against the furnisher's records.

2. Field 17A (Payment Rating) — The payment rating does not correspond to my actual payment history. This field must be verified against the original creditor's records.

3. Field 33 (Date of Account Information) — This field must be within 30 days of the date reported. If stale, the tradeline is non-compliant with Metro 2 reporting standards.

4. Field 25 (Date of First Delinquency) — I am requesting verification of the DOFD per FCRA § 623(a)(5). This date must be sourced from the original creditor's records.

REQUESTED ACTIONS

1. Conduct a reasonable investigation of the above items as required by FCRA § 611(a)(1)(A).
2. Verify each Metro 2 field identified above at the field level, not merely confirm the account exists.
3. Provide written results of the investigation within 30 days as required by § 611(a)(6)(B)(ii).
4. If any item cannot be verified, delete it immediately per § 611(a)(5)(A).
5. Provide a free copy of my updated credit report per § 611(d).

Sincerely,

James Richardson
Date: April 27, 2026

Enclosures:
- Copy of government-issued photo ID
- Copy of utility bill confirming current address`;

const letterEquifax = `Dear Equifax,

I am writing to formally dispute the following items on my credit report. Under the Fair Credit Reporting Act, Section 611 [15 U.S.C. § 1681i], I am requesting a thorough investigation of the information listed below that I believe to be inaccurate, incomplete, or unverifiable.

DISPUTED ITEM 1 — Capital One
Account Type: Charge-Off
Balance Reported: $4,500
Account Opened: June 2018
Account Closed: January 2022

The following Metro 2 fields contain reporting errors that must be investigated and corrected:

1. Field 12 (Monthly Payment) — This charged-off account continues to report a scheduled monthly payment of $150. Charged-off accounts should not carry a scheduled payment amount. This field must be corrected to $0 or removed entirely.

2. Field 21 (Current Balance) — The account reports a $4,500 balance despite being closed and charged off. If this account has been charged off and closed, the current balance should reflect $0 or the charge-off amount only — not an ongoing balance.

3. Field 24 (Date of Account Information) — This account was last reported more than 90 days ago, which violates FCRA § 623(a)(2) requiring furnishers to report accurate information and update within a reasonable time. I am requesting verification that this field reflects a date within 30 days of current reporting.

DISPUTED ITEM 2 — Synchrony Bank
Account Type: Charge-Off
Balance Reported: $3,400
Account Opened: June 2019

The following Metro 2 fields contain reporting errors that must be investigated and corrected:

1. Field 5 (Account Status) — The status code must be verified. If this debt was sold to a third-party collector after charge-off, the status should be updated to code 05 with a $0 balance. Reporting an active charge-off balance on a sold debt constitutes double-reporting.

2. Field 14 (Current Balance) — If this debt was sold or assigned to a third-party collector, Synchrony Bank is required to report a $0 balance on this tradeline. Continued reporting of a $3,400 balance when the debt no longer belongs to Synchrony is inaccurate.

3. Field 25 (Date of First Delinquency) — The DOFD controls the 7-year reporting clock under FCRA § 605(a)(4). I am requesting that this date be sourced directly from Synchrony's records and verified against the original delinquency date, not the charge-off or sale date.

REQUESTED ACTIONS

1. Conduct a reasonable investigation of the above items as required by FCRA § 611(a)(1)(A).
2. Verify each Metro 2 field identified above at the field level, not merely confirm the account exists.
3. Provide written results of the investigation within 30 days as required by § 611(a)(6)(B)(ii).
4. If any item cannot be verified, delete it immediately per § 611(a)(5)(A).
5. Provide a free copy of my updated credit report per § 611(d).

Sincerely,

James Richardson
Date: April 27, 2026

Enclosures:
- Copy of government-issued photo ID
- Copy of utility bill confirming current address`;

const letterTransUnion = `Dear TransUnion,

I am writing to formally dispute the following items on my credit report. Under the Fair Credit Reporting Act, Section 611 [15 U.S.C. § 1681i], I am requesting a thorough investigation of the information listed below that I believe to be inaccurate, incomplete, or unverifiable.

DISPUTED ITEM 1 — Discover Financial
Account Type: Revolving (Open)
Balance Reported: $3,200
Credit Limit: $5,000
Account Opened: January 2020

The following Metro 2 fields contain reporting errors that must be investigated and corrected:

1. Field 17A (Account Status) — This account reports a current/as-agreed status, yet Field 22 simultaneously shows $450 past due. These two fields are contradictory. If the account is current, the past-due amount must be $0. If a past-due amount exists, the status cannot be as-agreed. I am requesting that Discover verify and reconcile these fields.

2. Field 18 (Payment History Profile) — The payment history profile contains late payment indicators (codes "2" and "3") that are inconsistent with the current account rating of As Agreed. The payment history and account status must reflect the same underlying payment record. Contradictory codes in these fields are non-compliant with Metro 2 reporting standards.

DISPUTED ITEM 2 — Capital One
Account Type: Revolving
30-Day Late: September 2025

The following Metro 2 fields contain reporting errors that must be investigated and corrected:

1. Field 17B (Payment History Profile) — The September 2025 late payment indicator is inaccurate. Payment was made in full within the billing cycle and before the reported delinquency date. I am requesting that Capital One verify this payment against their internal payment records.

2. Field 17A (Payment Rating) — If the late payment indicator in Field 17B is corrected or removed as inaccurate, Field 17A must also be updated to reflect a payment rating of 0 (Current/As Agreed). Retaining a derogatory payment rating when the underlying late indicator has been removed constitutes an inconsistent and inaccurate tradeline.

REQUESTED ACTIONS

1. Conduct a reasonable investigation of the above items as required by FCRA § 611(a)(1)(A).
2. Verify each Metro 2 field identified above at the field level, not merely confirm the account exists.
3. Provide written results of the investigation within 30 days as required by § 611(a)(6)(B)(ii).
4. If any item cannot be verified, delete it immediately per § 611(a)(5)(A).
5. Provide a free copy of my updated credit report per § 611(d).

Sincerely,

James Richardson
Date: April 27, 2026

Enclosures:
- Copy of government-issued photo ID
- Copy of utility bill confirming current address`;

// ── PDF generation ────────────────────────────────────────────────────────────

const letters = [
  {
    text: letterExperian,
    bureau: "experian",
    filename: "Round1-Experian-Dispute.pdf",
    furnisher: "Midland Funding LLC / Cavalry SPV I LLC"
  },
  {
    text: letterEquifax,
    bureau: "equifax",
    filename: "Round1-Equifax-Dispute.pdf",
    furnisher: "Capital One / Synchrony Bank"
  },
  {
    text: letterTransUnion,
    bureau: "transunion",
    filename: "Round1-TransUnion-Dispute.pdf",
    furnisher: "Discover Financial / Capital One"
  }
];

async function run() {
  console.log("Generating mock dispute letter PDFs...\n");

  for (const letter of letters) {
    const outPath = path.join(OUTPUT_DIR, letter.filename);
    console.log(`  Rendering ${letter.bureau.toUpperCase()} letter...`);

    const buffer = await renderLetterPDF(letter.text, "dispute", letter.bureau, 1, personal, {
      furnisher: letter.furnisher
    });

    fs.writeFileSync(outPath, buffer);
    console.log(`  Written: ${outPath} (${(buffer.length / 1024).toFixed(1)} KB)\n`);
  }

  console.log(`Done. 3 PDFs written to:\n  ${OUTPUT_DIR}`);
}

run().catch(err => {
  console.error("Error generating PDFs:", err.message);
  process.exit(1);
});
