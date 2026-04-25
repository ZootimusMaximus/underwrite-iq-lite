# METRO 2 \+ FCRA DISPUTE LETTER KNOWLEDGE BASE

## Master Reference for Underwrite IQ / FundHub Credit Solutions

**Version:** 1.0 | **Built for:** AI-powered dispute letter generation **Sources:** 2020 CDIA Credit Reporting Resource Guide (CRRG), 15 U.S.C. § 1681 et seq., 12 CFR Part 1022, federal case law

---

## TABLE OF CONTENTS

1. [QUICK REFERENCE](#quick-reference)  
2. [SECTION 1 — METRO 2 COMPLETE SPECIFICATION](#section-1--metro-2-complete-specification)  
3. [SECTION 2 — CASE LAW LIBRARY](#section-2--case-law-library)  
4. [SECTION 3 — STATUTES (FULL TEXT)](#section-3--statutes-full-text)  
5. [SECTION 4 — DISPUTE LETTER STRATEGY FRAMEWORK](#section-4--dispute-letter-strategy-framework)  
6. [SECTION 5 — TRADELINE VIOLATION CHECKLIST](#section-5--tradeline-violation-checklist)  
7. [AI PROMPT INTEGRATION GUIDE](#ai-prompt-integration-guide)

---

## QUICK REFERENCE

### The 4 Legal Pillars of Credit Disputes

| Authority | What It Governs | Key Sections |
| :---- | :---- | :---- |
| **FCRA** (15 USC § 1681\) | Credit reporting, disputes, accuracy | §§ 1681e, 1681i, 1681s-2, 1681c, 1681n, 1681o |
| **Regulation V** (12 CFR 1022\) | Furnisher duties, direct disputes | §§ 1022.42, 1022.43 |
| **FDCPA** (15 USC § 1692\) | Debt collection conduct | §§ 1692g (validation), 1692e (misrep) |
| **Metro 2® Format** (CDIA) | Data format for furnishing to CRAs | CRRG, all exhibits |

### The Accuracy Standard — What Makes Info "Inaccurate"

A credit report entry is actionably inaccurate when it is either:

1. **Patently incorrect** (factually wrong), OR  
2. **Materially misleading** — misleading in such a way and to such an extent that it can be expected to have an adverse effect on credit decisions.

The information must be **objectively and readily verifiable** (Sessa v. Trans Union, 74 F.4th 38 (2d Cir. 2023); Mader v. Experian).

### Metro 2 Compliance Is Not Itself Law — But It IS Evidence of Accuracy

- Metro 2® is the CDIA-maintained standard format for credit reporting.  
- Deviation from Metro 2 alone is not per se an FCRA violation (*Davenport v. Capio Partners*).  
- BUT — Metro 2 deviations are strong evidence that the information reported is inaccurate or materially misleading, which IS actionable under FCRA.  
- **Strategic frame for letters:** cite the Metro 2 field violation \+ explain why that creates a materially misleading impression \+ cite the FCRA section being violated.

### Statutory Damages at a Glance

| Violation Type | Statute | Damages |
| :---- | :---- | :---- |
| Willful noncompliance | 15 USC § 1681n | Actual OR $100–$1,000 per violation, punitive damages, attorneys' fees |
| Negligent noncompliance | 15 USC § 1681o | Actual damages \+ attorneys' fees |
| FDCPA violation | 15 USC § 1692k | Actual \+ up to $1,000 statutory \+ fees |
| Credit Repair Organizations Act | 15 USC § 1679g | Actual, punitive, fees |

---

# SECTION 1 — METRO 2 COMPLETE SPECIFICATION

## 1.1 What Metro 2® Is

Metro 2® is the industry-standard electronic file format maintained by the Consumer Data Industry Association (CDIA) for furnishers to report consumer credit data to Equifax, Experian, Innovis, and TransUnion. The format defines fixed-length fields, valid codes, and the sequence in which account data is transmitted. The definitive reference is the CDIA Credit Reporting Resource Guide (CRRG).

Metro 2 is **not itself a law**. However, the FCRA, FCBA, and ECOA impose the legal duties of accuracy and completeness that Metro 2 was designed to help furnishers satisfy. When a furnisher departs from Metro 2 standards, that departure is evidence the reporting is inaccurate or incomplete.

## 1.2 Record Structure Overview

A Metro 2 file consists of:

- **Header Record** — identifies the reporter, software, and reporting period  
- **Base Segment** — one per account; 426 characters (character format) or 366 (packed format); contains primary account data  
- **Optional Appended Segments** — J1, J2, K1, K2, K3, K4, L1, N1 — add associated consumers, original creditor, purchased/sold info, mortgage specifics, etc.  
- **Trailer Record** — totals and validation counts

## 1.3 Base Segment Fields — Complete Reference

The Base Segment contains the primary tradeline data. Key fields critical for dispute analysis:

| Field \# | Field Name | What It Is | Why It Matters for Disputes |
| :---- | :---- | :---- | :---- |
| 2 | Processing Indicator | File processing flag | Rarely disputed |
| 7 | Consumer Account Number | The account number | Must match actual account; mismatches \= inaccuracy |
| 8 | Portfolio Type | C/I/M/O/R (Credit Line, Installment, Mortgage, Open, Revolving) | Wrong portfolio type misrepresents account nature |
| 9 | Account Type | Two-digit industry code (Exhibit 1\) | Wrong type can misrepresent the product |
| 10 | Date Opened | MMDDYYYY account open date | Must match original opening; not reset on sale |
| 11 | Credit Limit | Assigned credit limit | Critical for utilization calc; missing \= violation |
| 12 | Highest Credit/Original Loan Amount | Peak balance or original loan | For revolving, must reflect highest usage |
| 13 | Terms Duration | Payment term (months or LOC) | Must match contract |
| 14 | Terms Frequency | M/W/B/S/P/Y/etc. | Must match contract |
| 15 | Scheduled Monthly Payment Amount | Required minimum payment | Zero when account closed/paid |
| 16 | Actual Payment Amount | Last actual payment received | Must reflect reality |
| **17A** | **Account Status** | Current condition (Exhibit 4\) | **MOST-DISPUTED FIELD** — see § 1.4 |
| **17B** | **Payment Rating** | 0–9, L — required with certain statuses | Must be internally consistent with 17A |
| **18** | **Payment History Profile** | 24-month string of payment codes | Must be consistent with status; gaps/contradictions \= violation |
| **19** | **Special Comment Code** | Narrative code (Exhibit 7\) | Misused comments can be materially misleading |
| **20** | **Compliance Condition Code** | Dispute/closure flags (Exhibit 8\) | Must reflect dispute status under FCRA/FCBA/FDCPA |
| 21 | Current Balance | Current amount owed | Must be $0 for paid/closed/DF accounts |
| 22 | Amount Past Due | Delinquent amount | Must be $0 for current/paid accounts |
| 23 | Original Charge-off Amount | Amount at charge-off | Only populated on 97/64 statuses |
| **24** | **Date of Account Information** | "As-of" date of report | **Must be within current reporting cycle; stale \= violation** |
| **25** | **FCRA Compliance / Date of First Delinquency (DOFD)** | Anchor for 7-year clock | **CRITICAL — see § 1.6** |
| 26 | Date Closed | Date account closed to use | Required with certain statuses |
| 27 | Date of Last Payment | Most recent payment date | Must match actual |
| 33 | Surname/First/Middle | Consumer name | Must match consumer identity |
| 37 | ECOA Code | Relationship to account (Exhibit 10\) | Must reflect actual liability |
| 38 | Consumer Information Indicator | Bankruptcy/other flags (Exhibit 11\) | Required for BK-included accounts |

## 1.4 Account Status Codes (Field 17A) — EXHIBIT 4

The Account Status Code reflects the account's current condition as of the Date of Account Information. This is the single most important field for dispute analysis.

| Code | Meaning | Required Balance | Notes |
| :---- | :---- | :---- | :---- |
| 05 | Account transferred to another office | $0 | **OBSOLETE as of April 2022** — use Special Comment Codes O, AH, AT, or BA instead |
| 11 | Current account (0–29 days past due) | Non-zero (installment/mortgage) | For closed lines with balance, also report Code M or CCC XA |
| 13 | Paid or closed / zero balance | $0 | Final status, no further updates needed |
| 61 | Paid in full, was voluntary surrender | $0 | Final |
| 62 | Paid in full, was collection | $0 | Final |
| 63 | Paid in full, was repossession | $0 | Final |
| 64 | Paid in full, was charge-off | $0 | Final |
| 65 | Paid in full, foreclosure was started | $0 | Final |
| 71 | 30–59 days past due | Past due \> 0 | Requires Payment Rating (17B) |
| 78 | 60–89 days past due | Past due \> 0 | Requires Payment Rating (17B) |
| 80 | 90–119 days past due | Past due \> 0 | Requires Payment Rating (17B) |
| 82 | 120–149 days past due | Past due \> 0 | Requires Payment Rating (17B) |
| 83 | 150–179 days past due | Past due \> 0 | Requires Payment Rating (17B) |
| 84 | 180+ days past due | Past due \> 0 | Requires Payment Rating (17B) |
| 88 | Claim filed with government (defaulted loan) | Balance may exist | Final |
| 89 | Deed in lieu of foreclosure (defaulted mortgage) | Balance may exist | Final; do NOT report 97 after 89 |
| 93 | Account assigned to internal or external collections | Balance exists | Third-party collection agencies may ONLY use 62, 93, DA, or DF |
| 94 | Foreclosure completed | Balance may exist | Final; do NOT report 97 after 94 |
| 95 | Voluntary surrender | Balance may exist | Final; do NOT use for lease early termination |
| 96 | Merchandise repossessed | Balance may exist |  |
| 97 | Unpaid balance reported as loss (charge-off) | Balance may exist | Final |
| DA | Delete entire account (non-fraud) | N/A | Paid derogatory accounts should be reported as paid, NOT deleted |
| DF | Delete entire account — confirmed fraud | N/A | After completed fraud investigation |

**⚠ Common violations at this field:**

- Status 11 (current) combined with Payment History Profile showing late months \= contradictory \= materially misleading  
- Status 97 (charge-off) with non-zero Current Balance after the account was sold \= inaccurate (balance should be $0 after sale, with K2 Sold To populated)  
- Status 13 (paid/zero) with Amount Past Due \> 0 \= contradictory  
- Reporting status 97 after 89 or 94 \= prohibited by CRRG  
- Third-party collection agency reporting anything other than 62, 93, DA, or DF \= violation

## 1.5 Payment Rating (Field 17B) and Payment History Profile (Field 18\)

**Payment Rating (17B):** Required when Account Status Code is 05, 13, 61–65, or 88–97. Indicates the state of the account AT the time the final status was reported.

| Code | Meaning |
| :---- | :---- |
| 0 | Current |
| 1 | 30–59 days past due |
| 2 | 60–89 days past due |
| 3 | 90–119 days past due |
| 4 | 120–149 days past due |
| 5 | 150–179 days past due |
| 6 | 180+ days past due |
| G | Collection |
| L | Charge-off |

**Payment History Profile (18):** 24 characters representing 24 months of history, left-to-right newest-to-oldest. Codes include 0 (current), 1–6 (delinquency tiers), B (no data), D (no data/paid), E (zero balance/current), G (collection), H (foreclosure), J (voluntary surrender), K (repossession), L (charge-off).

**⚠ Violations:**

- A Payment History Profile showing "L" (charge-off) in months BEFORE the Date of First Delinquency is internally inconsistent.  
- Late-payment codes (1–6) appearing in the PHP while Account Status is 11 (current) and Amount Past Due is $0 \= contradictory.

## 1.6 Date of First Delinquency (DOFD) — Field 25

**This is the single most important field for the 7-year reporting clock under FCRA § 605\.**

The DOFD is the date of the commencement of the delinquency that immediately preceded the reporting of the account as delinquent, charged-off, placed for collection, or similar adverse action. Once established, **the DOFD does NOT change** — it anchors the 7-year window (7 years \+ 180 days per § 605(c) for collections/charge-offs).

**⚠ Violations related to DOFD:**

- **Re-aging** — moving the DOFD forward when the account is sold, transferred, or restructured. This extends the reporting window unlawfully and is a direct FCRA violation.  
- **Missing DOFD** — for collections and charge-offs, absence of DOFD makes the 7-year clock unverifiable and the reporting inaccurate.  
- **DOFD inconsistent with Payment History Profile** — if PHP shows no delinquency preceding the reported DOFD, the DOFD is suspect.  
- **DOFD past the 7-year \+ 180-day window** — account must be deleted under § 605\.

**The Rule of Thumb:** When an account is sold, the buyer MUST report the same DOFD as the original creditor (15 USC § 1681s-2(a)(5)).

## 1.7 Date of Account Information — Field 24

The "as-of" date for the reporting cycle. Best practice and compliance standard: must be within 30 days of the report date. A stale DOAI indicates the furnisher is not monthly-updating as required.

## 1.8 Special Comment Codes (Field 19\) — EXHIBIT 7 (Selected)

Reported each month as long as the condition applies. Key codes:

| Code | Meaning | Required Conditions |
| :---- | :---- | :---- |
| B | Payments managed by financial counseling |  |
| C | Paid by co-maker/guarantor | Status 13 or 61–65, balance \= 0 |
| H | Loan assumed by another party | ECOA Code T |
| M | Account closed at credit grantor's request | Requires Date Closed |
| O | Account transferred to another company/servicer |  |
| AB | Debt being paid through insurance | Status NOT 13 or 61–65 |
| AC | Paying under partial payment agreement | Status NOT 13 or 61–65 |
| AH | Purchased by another company |  |
| AS | Account closed due to refinance |  |
| AT | Account closed due to transfer (internal) |  |
| AU | Account paid in full for less than full balance | Status 13 or 61–65, balance \= 0 |
| AV | First payment never received |  |
| AW | Affected by natural or declared disaster |  |
| BO | Foreclosure proceedings started |  |
| BP | Paid through insurance | Status 13 or 61–65, balance \= 0 |
| CI | Account closed due to inactivity |  |
| CN | Loan modified under federal government plan |  |
| CO | Loan modified (non-federal) |  |
| CP | Account in forbearance | Status NOT 13 or 61–65, balance NOT 0 |
| DE | Debt extinguished under state law | Status NOT 13 or 61–65, balance \= 0, past due \= 0 |

**⚠ Violations:**

- Special Comment Code that contradicts Account Status (e.g., Code AU requiring status 13 but account shows status 97\)  
- Stacking inconsistent comment codes  
- Missing required comment when condition applies (e.g., no AH on purchased account)

## 1.9 Compliance Condition Codes (Field 20\) — EXHIBIT 8 — **HIGH-VALUE DISPUTE TARGET**

Compliance Condition Codes (CCC) flag legal-compliance conditions: dispute status under FCRA, FCBA, FDCPA, and consumer-closed accounts.

| Code | Meaning | Key Trigger |
| :---- | :---- | :---- |
| XA | Account closed at consumer's request | Date Closed must match |
| **XB** | Account info disputed by consumer directly to furnisher under FCRA; investigation in progress | Must be REMOVED after investigation completes |
| XC | FCRA direct dispute investigation completed — consumer disagrees | Used after investigation; consumer still disagrees |
| XD | Combination: XA \+ XB (closed at consumer request \+ disputed) |  |
| XE | Combination: XA \+ XC (closed at consumer request \+ investigation done, consumer disagrees) |  |
| XF | Account in dispute under FCBA; investigation in progress | Must be REMOVED after investigation |
| XG | FCBA dispute investigation completed — consumer disagrees |  |
| **XH** | Account previously in dispute; furnisher has completed investigation | USE for FCRA direct, FDCPA, or FCBA disputes after completion |
| XJ | Combination: XA \+ XF |  |
| XR | Removes the most recently reported Compliance Condition Code | Do NOT use as default |

**⚠ The XB/XH/XC dispute wave — MAJOR litigation pattern:**

- Furnisher uses **XH** after closing an investigation, but consumer never agreed with the outcome.  
- Correct code is **XC** (FCRA direct, consumer disagrees) — XH does not capture consumer disagreement.  
- This mischaracterization can be materially misleading and has been the subject of recent federal litigation (Fulton, Wood, Matson cases).

**⚠ Other violations:**

- XB never being removed after investigation (stale dispute flag)  
- No CCC reported despite an active direct dispute to furnisher  
- CCC inconsistent with Account Status

## 1.10 ECOA Code (Field 37\) — EXHIBIT 10

Defines relationship of consumer to account under the Equal Credit Opportunity Act.

| Code | Meaning |
| :---- | :---- |
| 1 | Individual (primary contractual responsibility) |
| 2 | Joint contractual liability |
| 3 | Authorized user (no contractual responsibility) |
| 5 | Co-maker or guarantor |
| 7 | Maker (but co-maker/guarantor liable if default) |
| T | Terminated association |
| W | Business/commercial |
| X | Deceased (requires legally-sufficient death notice) |
| Z | Delete consumer from account |

**⚠ Violations:**

- Reporting ECOA 1 (individual) on an account where consumer is only an authorized user  
- Reporting ECOA 3 (authorized user) on an account included in the authorized user's bankruptcy — CRRG requires deletion with Code Z  
- ECOA X reported without death certificate  
- Obsolete codes 0, 4, 6 still being reported (obsolete since September 2003\)

## 1.11 Consumer Information Indicators (Field 38\) — EXHIBIT 11

Flags bankruptcy, reaffirmation, and other consumer conditions on a per-consumer basis.

| Code | Meaning |
| :---- | :---- |
| A | Petition for Chapter 7 Bankruptcy |
| B | Petition for Chapter 11 Bankruptcy |
| C | Petition for Chapter 12 Bankruptcy |
| D | Petition for Chapter 13 Bankruptcy |
| E | Discharged through Chapter 7 |
| F | Discharged through Chapter 11 |
| G | Discharged through Chapter 12 |
| H | Discharged/completed through Chapter 13 |
| Q | Removes previously-reported bankruptcy indicator; also used for BK closed/terminated without discharge |
| R | Chapter 7 Reaffirmation of Debt |
| V | Chapter 7 Reaffirmation of Debt Rescinded |
| 1A | Personal Receivership |
| 2A | Lease Assumption |
| T | Credit grantor cannot locate consumer |
| U | Consumer now located (removes T) |

**⚠ Violations critical for bankruptcy disputes:**

- Account shows balance/past-due after Chapter 7 discharge (Code E) without dismissal  
- Account with Code H (Chapter 13 completed) still reporting delinquent status  
- Missing CII on an account that was included in bankruptcy  
- Reporting a balance due on a discharged (Code E/F/G/H) debt — direct FCRA violation and potential § 524 bankruptcy discharge injunction violation

## 1.12 Critical Appended Segments

### K1 Segment — Original Creditor Name

**REQUIRED for debt buyers, collection agencies, and sold accounts.** Names the original creditor so consumers can identify the debt origin.

**⚠ Violation:** Debt buyer or collection agency reporting WITHOUT K1 \= prevents consumer from knowing what the debt is \= materially misleading.

### K2 Segment — Purchased From / Sold To

Populated when an account is purchased or sold. Indicates transfer and identifies the other party.

**⚠ Violation:** Charge-off sold to a debt buyer, but original creditor still reports a Current Balance without populating K2 Sold To and zeroing out the balance \= double-reporting / inaccurate balance.

### K3 Segment — Mortgage Information

MIN (Mortgage Identification Number) for mortgages.

### K4 Segment — Specialized Payment Information

Deferred payment start dates, balloon payment due dates/amounts.

**⚠ Violation (Sessa-style):** Reporting a balloon payment obligation that the contract does not require.

## 1.13 Industry-Specific Rules — Key Points

### Collections / Debt Buyers

- May only use Account Status Codes 62, 93, DA, or DF  
- MUST report K1 (Original Creditor Name)  
- Should NOT report accounts included in discharged/completed bankruptcies acquired after discharge  
- Must NOT report non-contractual debts (fines, tickets, library fines)  
- **Medical debt:** wait ≥ 365 days from DOFD; exclude \< $500

### Mortgages

- Specific delinquency buckets required  
- K3 Segment required  
- Foreclosure reporting sequence: 82/84 (delinquent) → BO comment (foreclosure started) → 65 or 94 (completed) — 97 prohibited after 89/94

### Student Loans

- Federal vs. private have separate reporting guidelines  
- Deferment/forbearance requires specific special comment coding (CP, AL — now obsolete)  
- Post-default federal loans have special rules

### Child Support

- Only code CS as Special Comment  
- DOFD freezes when youngest child reaches majority

## 1.14 e-OSCAR Dispute System

e-OSCAR is the CDIA-operated electronic dispute resolution system mandated by FCRA § 611(a)(5)(D). When a consumer disputes an item with a CRA:

1. CRA receives dispute via consumer direct contact  
2. CRA transmits Automated Consumer Dispute Verification (ACDV) to furnisher via e-OSCAR within 5 business days  
3. Furnisher has until the end of the 30-day CRA investigation window to respond  
4. Furnisher investigates, responds via ACDV (confirm, update, or delete)  
5. CRA updates file and notifies consumer within 5 days

**⚠ Furnisher violations in this process (from case law):**

- Not conducting "reasonable investigation" (per § 1681s-2(b))  
- Rubber-stamping ACDV responses without actual review (Seamans, Johnson v. MBNA)  
- Not reviewing "all relevant information" provided by CRA  
- Not reporting disputed status (Saunders, Gorman)

---

# SECTION 2 — CASE LAW LIBRARY

## 2.1 The Accuracy Standard Cases

### Sessa v. Trans Union, LLC, 74 F.4th 38 (2d Cir. 2023\)

**Holding:** FCRA liability under § 1681e(b) does not require a threshold inquiry into whether an alleged inaccuracy is "legal" or "factual." Information is actionable if it is **objectively and readily verifiable**.

**Facts:** TransUnion reported that Sessa owed a "balloon payment" at the end of her vehicle lease — but the lease terms did not require any such payment.

**Key language:** "Allegedly inaccurate information reported on a consumer's credit report must be objectively and readily verifiable to be actionable under section 1681e(b)... there is no threshold inquiry under the FCRA as to whether any purportedly inaccurate information is legal or factual in nature."

**How to use it in letters:** When a furnisher or CRA argues they can't investigate "legal" questions (e.g., whether a debt was discharged in bankruptcy, whether a balloon payment applies, whether a contractual provision was triggered), cite Sessa — the analysis is whether the facts are objectively and readily verifiable, not whether they involve legal application.

### Mader v. Experian Information Solutions, 56 F.4th 264 (2d Cir. 2022\)

**Holding:** Accuracy under the FCRA "requires a focus on objectively and readily verifiable information." CRAs may be required to accurately report information derived from the readily verifiable and straightforward application of law to facts.

**How to use it:** Companion case to Sessa. Cite when furnisher claims the dispute is "too complex" to investigate.

### Seamans v. Temple University, 744 F.3d 853 (3d Cir. 2014\)

**Holding:** Even technically correct information can be "inaccurate" under the FCRA if it creates a materially misleading impression through omission. Blanket policies limiting investigators to a short time per dispute and never flagging accounts as disputed can support punitive damages for willful noncompliance.

**How to use it:** When a furnisher reports a technically-true data point that omits material context (e.g., reporting late payments without noting the loan was in forbearance), cite Seamans for the "materially misleading" theory. Also cite when challenging a furnisher's investigation procedures.

### Saunders v. Branch Banking & Trust Co., 526 F.3d 142 (4th Cir. 2008\)

**Holding:** Furnisher violated FCRA by failing to report account as disputed after receiving a meritorious dispute. A furnisher cannot satisfy its duties under § 1681s-2(b) by merely verifying that the account information is technically correct if the furnisher has received evidence of a meritorious dispute.

**How to use it:** Core case for Round 2 letters — cite when furnisher responds to a dispute by simply "verifying" the information and refusing to note the account is disputed under Compliance Condition Code XB.

### Gorman v. Wolpoff & Abramson, LLP, 584 F.3d 1147 (9th Cir. 2009\)

**Holding:** A furnisher that receives notice of a consumer dispute must report the disputed status of the debt to CRAs, and that failure to do so can be a violation of § 1681s-2(b). Affirmed the "materially misleading" standard.

**How to use it:** Same as Saunders, but for 9th Circuit jurisdictions.

### Boggio v. USAA Federal Savings Bank, 696 F.3d 611 (6th Cir. 2012\)

**Holding:** The "materially misleading" standard — information is inaccurate if it is either patently incorrect OR misleading in such a way that it can be expected to have an adverse effect on credit decisions.

**How to use it:** Another jurisdiction-specific citation for the materially-misleading standard.

### Frazier v. Dovenmuehle Mortgage, Inc., 72 F.4th 813 (7th Cir. 2023\)

**Holding:** To bring a § 1681s-2(b) claim, plaintiff must show the furnished information was either patently incorrect OR materially misleading in a way that can be expected to adversely affect credit decisions.

**How to use it:** 7th Circuit version of the materially-misleading standard. Frames what a plaintiff must plead to survive a motion to dismiss.

## 2.2 Furnisher Investigation Duty Cases

### Johnson v. MBNA America Bank, 357 F.3d 426 (4th Cir. 2004\)

**Holding:** Furnisher's "investigation" under § 1681s-2(b) must be reasonable. Merely confirming information already in the furnisher's records without investigating the consumer's specific dispute is insufficient.

**How to use it:** Cite in Round 2 and direct furnisher disputes — establishes that furnishers cannot rubber-stamp verifications.

### Hinkle v. Midland Credit Management, Inc., 827 F.3d 1295 (11th Cir. 2016\)

**Holding:** When a consumer provides specific information challenging the accuracy of reported debt, the furnisher's investigation must include review of relevant account documentation — not just their own records.

**How to use it:** When disputing a collection account and the consumer has submitted specific facts (e.g., "I never held this account" \+ proof), cite Hinkle to demand the furnisher actually review the original documentation, not just their own file.

## 2.3 Metro 2 and Compliance Condition Code Cases

### Davenport v. Capio Partners, LLC (M.D. Pa. 2021\)

**Holding:** Metro 2 non-compliance, standing alone, is not actionable under the FCRA. The FCRA does not require strict Metro 2 compliance — it requires accuracy.

**How to use it (cautiously):** Understand that citing Metro 2 alone is not sufficient — letters must explain WHY the Metro 2 deviation creates inaccurate or materially misleading information under FCRA § 1681e and § 1681s-2.

### The XB/XH/XC Cases (Fulton, Wood, Matson)

Federal district court decisions analyzing furnishers' use of Compliance Condition Codes after closing investigations. Core holding pattern: whether the code choice (XB, XH, XC) complies with FCRA depends on matching the underlying facts to the Metro 2 Manual definitions.

**How to use it:** When a furnisher reports XH (investigation completed) but the consumer never accepted the outcome and still disagrees, argue the correct code is XC (consumer disagrees) — using XH is materially misleading because it suggests resolution when none exists.

## 2.4 The Reasonable Investigation Standard

### Bibbs v. Trans Union LLC, 43 F.4th 331 (3d Cir. 2022\)

**Holding:** A furnisher's investigation is reasonable only if it would have uncovered the inaccuracy. Merely matching data points against the furnisher's own records is often insufficient.

### Pittman v. Experian Information Solutions, 901 F.3d 619 (6th Cir. 2018\)

**Holding:** A consumer's notice to the CRA triggers the furnisher's investigation obligation, and the furnisher must conduct a reasonable investigation appropriate to the specific facts disputed.

## 2.5 Furnisher Liability and the "Legal Dispute" Issue (Post-2023)

### 4th Circuit — Roberts/Milgram Line (2024–2025)

Recent Fourth Circuit authority has reinforced that furnishers must investigate disputes based on objectively and readily verifiable information, regardless of whether the dispute is characterized as "legal" or "factual." The consumer's burden is to show the investigation was unreasonable, which requires showing both (1) a cognizable inaccuracy and (2) that a reasonable investigation would have uncovered it.

**How to use it:** Frames Round 2/3 escalations where the furnisher tries to duck a dispute by claiming it raises a "legal question."

## 2.6 CFPB Enforcement Patterns

CFPB consent orders against furnishers and CRAs over the past 5 years show consistent enforcement themes:

- Failure to investigate consumer disputes reasonably  
- Failure to update or delete inaccurate information after confirmed disputes  
- Failure to report disputed status (no CCC reported)  
- Inadequate policies and procedures under Regulation V  
- Reporting discharged bankruptcy debts as active  
- Re-aging accounts

Reference the CFPB enforcement actions database at `consumerfinance.gov/enforcement/actions/` for current citations; in letters, a general reference to "CFPB enforcement patterns concerning \[specific violation type\]" suffices to signal regulatory attention.

---

# SECTION 3 — STATUTES (FULL TEXT)

## 3.1 FCRA — Fair Credit Reporting Act (15 U.S.C. § 1681\)

### § 1681 — Congressional Findings and Purpose

The stated purpose of the FCRA is to require consumer reporting agencies to adopt **reasonable procedures** for meeting the needs of commerce with regard to the **confidentiality, accuracy, relevancy, and proper utilization** of consumer information — **fairly and equitably to the consumer.**

### § 1681a — Definitions

Key definitions for disputes:

- **"Consumer"** — an individual  
- **"Consumer report"** — any written, oral, or other communication of information by a CRA bearing on a consumer's creditworthiness used for credit, insurance, employment, or similar purposes  
- **"Consumer reporting agency" (CRA)** — any person that regularly engages in assembling or evaluating consumer information for furnishing consumer reports to third parties  
- **"File"** — all of the information on a consumer recorded and retained by a CRA, regardless of how the information is stored  
- **"Furnisher"** — a person who furnishes information to a CRA (defined more fully in Regulation V)

### § 1681b — Permissible Purposes of Consumer Reports

A CRA may furnish a consumer report only for specified permissible purposes, including:

1. In response to a court order or federal grand jury subpoena  
2. With the written instructions of the consumer  
3. To a person that intends to use the information in connection with:  
   - A credit transaction involving the consumer  
   - Employment purposes (with additional requirements)  
   - Underwriting insurance involving the consumer  
   - A legitimate business need in connection with a business transaction initiated by the consumer  
   - Review or collection of an account of the consumer  
   - Assessment of credit or prepayment risks

**Dispute strategy:** Unauthorized hard inquiries without a permissible purpose violate § 1681b and can be disputed and removed.

### § 1681c — Time Limits on Reporting Adverse Information

**The 7-Year Rule (§ 1681c(a))** — CRAs may NOT report:

- Bankruptcies that antedate the report by more than 10 years  
- Civil suits, judgments, paid tax liens, accounts placed for collection, charge-offs, or any other adverse item of information — older than 7 years

**§ 1681c(c) — Running of the 7-year period for collection accounts and charge-offs:** The 7-year reporting period for collection accounts and charge-offs runs from the **Date of First Delinquency** (the date of the delinquency that immediately preceded the collection activity, charge-off, or similar action), plus 180 days.

**Dispute strategy:** Any collection, charge-off, or delinquency reporting more than 7 years \+ 180 days after the DOFD MUST be deleted. Re-aging (moving the DOFD forward) is a direct § 1681c and § 1681s-2(a)(5) violation.

### § 1681c-2 — Block of Information Resulting from Identity Theft

If a consumer submits an identity theft report (typically an FTC Identity Theft Report under 16 CFR Part 603\) along with proof of identity to a CRA, the CRA MUST block reporting of the identified information within **4 business days** of receiving the report.

**Dispute strategy:** For identity theft-related items, this is the most powerful statutory tool — it mandates deletion without the furnisher investigation process.

### § 1681e — Compliance Procedures (CRA Accuracy Duty)

**§ 1681e(b) — The Accuracy Mandate:** When preparing a consumer report, a CRA shall **"follow reasonable procedures to assure maximum possible accuracy"** of the information concerning the consumer about whom the report relates.

**Dispute strategy:** § 1681e(b) is the primary statutory hook for claims against CRAs (Equifax, Experian, TransUnion). When you dispute with the CRA, you're invoking their obligation to follow reasonable procedures to assure maximum possible accuracy.

### § 1681i — Procedure in Case of Disputed Accuracy

**§ 1681i(a)(1) — The 30-Day Investigation:** If the completeness or accuracy of any item in a consumer's file is disputed by the consumer and the consumer notifies the CRA directly, the agency shall, **free of charge, conduct a reasonable reinvestigation** and record the current status of the disputed information, or **delete the item** — before the end of the 30-day period beginning when the CRA receives the notice.

The 30-day period may be extended by up to 15 additional days if the CRA receives additional relevant information from the consumer during that window.

**§ 1681i(a)(2) — Notice to Furnisher:** Within 5 business days of receiving the dispute, the CRA must notify the furnisher of the dispute and provide all relevant information received from the consumer.

**§ 1681i(a)(3) — Frivolous or Irrelevant:** A CRA may terminate a reinvestigation if it reasonably determines the dispute is frivolous or irrelevant — but must notify the consumer of this determination within 5 business days.

**§ 1681i(a)(5)(A) — Deletion of Unverifiable Information:** If, after any reinvestigation, an item of information is found to be inaccurate, incomplete, or cannot be verified, the CRA shall **promptly delete that item** or modify it as appropriate.

**§ 1681i(a)(5)(B) — Refusal to Reinvestigate Frivolous Disputes:** Notification to consumer required within 5 business days.

**§ 1681i(a)(6) — Results of Reinvestigation:** CRA must provide written notice of results within 5 business days of completion, including:

- A statement that the reinvestigation is completed  
- A consumer report that is based on the consumer's file as revised  
- A notice of the right to add a statement to the file  
- A notice that describes the method used to verify the information (upon consumer request)  
- **§ 1681i(a)(6)(B)(iii) — Upon consumer request, the CRA must disclose the method by which it verified the disputed information, including the name, address, and telephone number of any furnisher of information contacted.**

**Dispute strategy:** This is the "Method of Verification" (MOV) demand used in Round 2 letters. When the CRA comes back with "verified," you invoke § 1681i(a)(6)(B)(iii) and demand to know HOW they verified.

**§ 1681i(a)(7) — Description of Reinvestigation Procedure:** Not later than 15 days after receiving a consumer request for the description of the procedure used to determine accuracy or completeness, the CRA shall provide a description.

### § 1681n — Civil Liability for Willful Noncompliance

Any person who willfully fails to comply with any requirement of the FCRA is liable to the consumer in an amount equal to:

- (A) actual damages sustained by the consumer OR damages of **not less than $100 and not more than $1,000**, and  
- (B) in the case of liability of a natural person for obtaining a consumer report under false pretenses, actual damages of not less than $1,000, and  
- (2) **punitive damages** as the court may allow, and  
- (3) **reasonable attorney's fees** and costs.

### § 1681o — Civil Liability for Negligent Noncompliance

Any person who is negligent in failing to comply with any requirement of the FCRA is liable to the consumer in an amount equal to:

- (1) actual damages sustained, and  
- (2) reasonable attorney's fees and costs.

### § 1681s-2 — Responsibilities of Furnishers of Information

**§ 1681s-2(a) — Duty to Provide Accurate Information:**

- (a)(1)(A): A person shall not furnish any information relating to a consumer to any CRA if the person knows or has reasonable cause to believe that the information is inaccurate.  
- (a)(1)(B): Reporting information with actual knowledge of errors is prohibited.  
- (a)(2): Duty to correct and update information.  
- (a)(3): Duty to provide notice of dispute — If the completeness or accuracy of any information furnished is disputed to such person by a consumer, the person may not furnish the information to any CRA without notice that such information is disputed by the consumer.  
- (a)(5): Duty to provide notice of delinquency date — When reporting a delinquent account placed for collection, charged off, or similar action, the furnisher shall, within 90 days of furnishing the information, notify the CRA of the month and year of the **commencement of the delinquency that immediately preceded the action**. If the account was previously reported to a CRA, the furnisher shall report the **same date of delinquency** as the original creditor.

**§ 1681s-2(b) — Duties Upon Notice of Dispute:** After receiving notice pursuant to § 1681i(a)(2) of a dispute with regard to the completeness or accuracy of any information provided by a person to a CRA, the person shall:

- (A) conduct an investigation with respect to the disputed information;  
- (B) review all relevant information provided by the CRA pursuant to § 1681i(a)(2);  
- (C) report the results of the investigation to the CRA;  
- (D) if the investigation finds that the information is incomplete or inaccurate, report those results to all other nationwide CRAs to which the person furnished the information; and  
- (E) if an item of information disputed by a consumer is found to be inaccurate or incomplete or cannot be verified after any reinvestigation, for purposes of reporting to a CRA only, as appropriate based on the results of the reinvestigation **promptly** (i) modify the item, (ii) delete the item, OR (iii) permanently block the reporting of the item.

**Dispute strategy:** § 1681s-2(b) is the furnisher's investigation duty. Unlike § 1681s-2(a), which does not create a private right of action for consumers, § 1681s-2(b) DOES — consumers can sue furnishers directly for failing to reasonably investigate disputes received via the CRA.

**§ 1681s-2(a)(8) — Direct Disputes to Furnishers:** The Bureau has prescribed regulations (12 CFR 1022.43) identifying when a furnisher must reinvestigate a dispute based on a direct request from a consumer. Importantly, the statute recognizes that furnishers are NOT required to investigate disputes submitted by credit repair organizations (as defined in § 1679a(3)). This is the **CRO loophole** — furnishers may decline direct disputes they reasonably believe are templated by a CRO.

### § 1681p — Statute of Limitations

Actions under the FCRA must be brought the earlier of:

- 2 years after the date of discovery by the plaintiff of the violation, OR  
- 5 years after the date on which the violation occurs.

## 3.2 CROA — Credit Repair Organizations Act (15 U.S.C. §§ 1679–1679j)

### § 1679a — Definitions

A "credit repair organization" (CRO) is any person who uses interstate commerce to sell services for the express or implied purpose of:

- Improving any consumer's credit record, credit history, or credit rating, OR  
- Providing advice or assistance with regard to such improvement.

**Key exclusion:** Non-profit organizations, certain creditors, and banks are excluded.

### § 1679b — Prohibited Practices

A CRO may not:

- Make any statement that is untrue or misleading (directly or indirectly) to any CRA or to any person who has extended credit or is considering extending credit to a consumer, with respect to a consumer's creditworthiness  
- Counsel a consumer to make any such untrue or misleading statement  
- **Make or use any untrue or misleading representation** of the services of the CRO  
- Engage in any act, practice, or course of business that constitutes or results in the commission of a fraud or deception

### § 1679c — Disclosures Required

Before any contract for services, a CRO MUST provide the consumer with a specific "Consumer Credit File Rights Under State and Federal Law" statement — reproduced verbatim from the statute.

### § 1679d — Credit Repair Organizations Contracts

A written, signed contract is REQUIRED. Must include:

- Terms and conditions of payment, including total cost  
- Full and detailed description of services to be performed  
- Estimated performance date or length of time performance will take  
- The CRO's name and principal business address  
- Conspicuous notice of 3-day right to cancel

### § 1679e — Right to Cancel Contract

Consumer has **3 business days** from contract date to cancel without penalty or obligation.

### § 1679f — Noncompliance with this Subchapter

Contracts in violation of the CROA are void and unenforceable.

### § 1679g — Civil Liability

- Actual damages  
- Punitive damages  
- Attorney's fees  
- Class action available

### § 1679i — Statute of Limitations

5 years from the date of the violation OR the date of discovery of the violation by the consumer.

**⚠ COMPLIANCE CRITICAL FOR FUNDHUB CREDIT SOLUTIONS LLC:**

- Cannot charge before services are fully performed  
- Written contract required, detailing services, costs, timeline  
- Mandatory 3-day cancellation right in contract  
- Mandatory consumer disclosures before contract  
- No false or misleading statements about services or results

## 3.3 FDCPA — Fair Debt Collection Practices Act (15 U.S.C. § 1692\)

### § 1692e — False or Misleading Representations

A debt collector may not use any false, deceptive, or misleading representation or means in connection with the collection of any debt. Includes:

- False representation of character, amount, or legal status of debt  
- Threat to take action that cannot legally be taken or is not intended  
- Communication of credit information known to be false, including failure to communicate that a debt is disputed

**Dispute strategy:** When a collection agency reports a debt without flagging it as disputed (after receiving a dispute), they violate § 1692e(8). Combined with an FCRA § 1681s-2(a)(3) / Compliance Condition Code violation.

### § 1692g — Validation of Debts

Within 5 days after the initial communication, a debt collector must send the consumer a written notice containing:

- Amount of the debt  
- Name of the creditor to whom the debt is owed  
- Statement that unless the consumer disputes the debt within 30 days, the debt will be assumed valid  
- Statement that if the consumer disputes the debt in writing within 30 days, the debt collector will obtain verification of the debt and mail it to the consumer  
- Statement that upon written request within 30 days, the debt collector will provide name and address of original creditor

**§ 1692g(b) — After Dispute:** If the consumer disputes the debt in writing within 30 days, the debt collector must **cease collection** until verification is obtained and mailed to the consumer.

**Dispute strategy:** The § 1692g debt validation letter is the foundational tool for disputing collection accounts. Combined with FCRA direct dispute, it creates two parallel legal duties the collector must satisfy — verification (FDCPA) and investigation (FCRA).

### § 1692k — Civil Liability

- Actual damages  
- Statutory damages up to $1,000 per action  
- Attorney's fees and costs

## 3.4 Regulation V (12 CFR Part 1022, Subpart E) — Furnisher Rule

### 12 CFR 1022.42 — Accuracy and Integrity

Furnishers must:

- Establish and implement reasonable written policies and procedures regarding the accuracy and integrity of the information they furnish  
- Address the policies and procedures appropriate to the nature, size, complexity, and scope of the furnisher's activities  
- Review policies periodically and update as necessary

### 12 CFR 1022.43 — Direct Disputes

**The direct-to-furnisher dispute rule.** A consumer may file a direct dispute with a furnisher regarding:

- The consumer's liability for a credit account  
- The terms of a credit account  
- The consumer's performance or other conduct concerning an account  
- Any other information contained in a consumer report regarding an account that bears on the consumer's creditworthiness

**Furnisher MUST investigate unless:**

- The dispute is frivolous or irrelevant (defined narrowly)  
- The dispute was submitted by a credit repair organization (the CRO loophole)

**Investigation timeline:** Furnisher must conduct a reasonable investigation, review all relevant information, and complete the investigation and notify consumer of results within the same time period as CRA investigations (generally 30 days, extendable to 45).

**Direct dispute requirements (what the consumer must provide):**

- Sufficient information to identify the account  
- Specific information that the consumer is disputing and explanation of the basis  
- All supporting documentation or other information reasonably required to substantiate the basis of the dispute

**⚠ The CRO loophole:** The single biggest reason quality matters in letter drafting. A templated letter that looks like it came from a credit repair organization can be lawfully ignored. Letters must:

- Contain specific, account-level facts  
- Not use identical templated language across multiple consumers  
- Appear to be written by the consumer personally  
- Include consumer-specific supporting documentation

## 3.5 16 CFR Part 660 — FTC Furnisher Rule

Historical rule (pre-CFPB) — largely superseded by Regulation V, but still relevant for furnisher accuracy obligations. Essentially parallel to 12 CFR 1022\.

---

# SECTION 4 — DISPUTE LETTER STRATEGY FRAMEWORK

## 4.1 The 3-Round Attack Strategy

### Round 1 — Metro 2 Compliance Dispute (to CRAs)

**Recipient:** Equifax, Experian, TransUnion (separate letters for each, tailored to which bureau is reporting what) **Statutory Hook:** FCRA § 1681e(b) (CRA accuracy duty) \+ § 1681i (reasonable reinvestigation) **Tone:** Firm, professional, fact-specific **Deadline:** 30 days for CRA to investigate

**Structure:**

1. Consumer identification header (full legal name, current address, DOB, SSN last 4\)  
2. Clear statement of dispute purpose  
3. For each disputed item: identify the tradeline, specify the Metro 2 field violations, explain why the reporting is inaccurate or materially misleading  
4. Cite FCRA § 1681e(b), § 1681i(a)(1), § 1681i(a)(5)  
5. Request: investigation within 30 days, deletion if unverifiable, method of verification disclosure  
6. Include personal info corrections (old addresses, name variants) — Compliance Condition Code XA or Special Comment relevant  
7. Include inquiry removals for unauthorized hard inquiries — cite § 1681b (permissible purpose)  
8. Signature \+ date  
9. Enclosures: copy of ID, proof of address, any supporting documents

**Key Metro 2 violations to flag per tradeline type (see § 4.3 below)**

### Round 2 — FCRA Escalation / Method of Verification Demand

**Recipient:** CRAs (same bureaus) AND/OR directly to furnisher **Statutory Hook:** FCRA § 1681i(a)(6)(B)(iii) (MOV disclosure) \+ § 1681i(a)(7) (description of reinvestigation procedure) \+ § 1681s-2(b) (furnisher duty) \+ FDCPA § 1692g (for collections) **Tone:** Aggressive but professional; legal citation-heavy **Sent when:** Round 1 results come back "verified" without deletion

**Structure:**

1. Reference Round 1 dispute date and outcome  
2. For each item that was "verified":  
   - Demand method of verification disclosure (§ 1681i(a)(6)(B)(iii))  
   - Demand description of reinvestigation procedure (§ 1681i(a)(7))  
   - Cite Saunders v. Branch Banking (4th Cir.) — cannot just verify technically-correct info  
   - Cite Gorman v. Wolpoff (9th Cir.) — must flag disputed status  
   - Cite Sessa v. Trans Union (2d Cir.) — objectively verifiable standard applies  
3. For collections: parallel FDCPA § 1692g debt validation demand  
4. Warning: intent to file CFPB complaint, state AG complaint, potential FCRA litigation  
5. Demand response within 15 days  
6. Signature \+ date

### Round 3 — Final Notice / Willful Noncompliance

**Recipient:** CRAs AND furnisher AND cc: CFPB, state AG **Statutory Hook:** FCRA § 1681i(a)(5)(A) (failure to verify \= delete) \+ § 1681n (willful noncompliance, $100–$1,000 per violation \+ punitive) \+ § 1681o (negligent noncompliance) **Tone:** Final notice, litigation-ready **Sent when:** Round 2 fails to produce deletion or proper method of verification

**Structure:**

1. Reference Round 1 and Round 2 dates  
2. State: "This is your final notice under the FCRA."  
3. Cite § 1681i(a)(5)(A) — failure to verify within 30 days REQUIRES deletion  
4. Cite § 1681n — willful noncompliance ($100–$1,000 per violation \+ punitive \+ fees)  
5. Cite § 1681o — negligent noncompliance (actual \+ fees)  
6. For collections: cite FDCPA § 1692k (statutory up to $1,000 \+ fees)  
7. Specific demand: permanent deletion within 15 days  
8. Notice of intent to file CFPB complaint with copy enclosed  
9. Notice of intent to file state AG complaint with copy enclosed  
10. Notice of intent to pursue private action for statutory damages  
11. CC line showing CFPB and state AG mailing addresses  
12. Signature \+ date

## 4.2 Direct-to-Furnisher Disputes (12 CFR 1022.43)

**When to use:** Best when the consumer has specific documentary evidence (original contract, payment records, paid-in-full letter) that contradicts what's being reported.

**Structure:**

1. Consumer identification  
2. Specific account identification  
3. Exact information being disputed  
4. Basis for dispute (factual, specific)  
5. Supporting documentation attached  
6. Cite 15 USC § 1681s-2(b) — furnisher investigation duty  
7. Cite 12 CFR 1022.43 — direct dispute rule  
8. Demand deletion or correction within 30 days  
9. Demand Compliance Condition Code XB be reported during investigation  
10. Demand proper updated Compliance Condition Code after investigation (XC if consumer will disagree, not XH)

**⚠ CRO loophole mitigation:** The letter must look personal, not templated. Use specific facts, consumer voice, handwritten signature, personal address. Avoid generic legal boilerplate language that signals credit repair origin.

## 4.3 Violation Patterns by Tradeline Type

### Collections (Third-Party Debt Buyer or Collection Agency)

**Most common violations:**

- Missing K1 Segment (Original Creditor Name) — cannot identify source of debt  
- Missing DOFD (Field 25\) — 7-year clock unverifiable  
- Using Account Status Code other than 62, 93, DA, or DF  
- Re-aged DOFD (date of first delinquency shows after sale date, which is impossible)  
- Reporting without first sending § 1692g validation notice  
- Both original creditor AND collector reporting a balance (double-reporting)  
- Medical debt under $500 or within 365 days of DOFD (post-2023 rule)

**Letter citations:** FCRA § 1681s-2(a)(5) (DOFD must match original creditor), FCRA § 1681c(c) (7-year \+ 180 days from DOFD), FDCPA § 1692g (validation), FDCPA § 1692e(8) (dispute flag), Metro 2 Exhibit 4 (status codes limited)

### Charge-Offs (Account Status 97\)

**Most common violations:**

- Current Balance \> 0 after the account was sold (should be $0, K2 Sold To populated)  
- Date of Account Information stale (not updated monthly)  
- Payment History Profile inconsistent with DOFD  
- No Original Charge-off Amount reported (Field 23\)  
- Continuing to report 97 after reporting 89 (deed in lieu) or 94 (foreclosure completed)  
- Re-aged DOFD

**Letter citations:** FCRA § 1681e(b), § 1681s-2(b), Saunders v. BB\&T, Metro 2 Exhibit 4

### Late Payments (Account Status 71, 78, 80, 82, 83, 84\)

**Most common violations:**

- Status code inconsistent with Payment Rating (17B) and Payment History Profile (18)  
- Late payment reported during active forbearance (should have Special Comment Code CP)  
- Late payment reported during natural disaster period (should have Special Comment Code AW)  
- Late payment reported during active dispute (should have Compliance Condition Code XB)

**Letter citations:** FCRA § 1681e(b), § 1681s-2(a)(1)(A) (no knowingly inaccurate), Seamans (materially misleading)

### Medical Debt (Post-2023 Rules)

**Most common violations:**

- Medical collection under $500 — must be deleted (2023 rule change)  
- Medical debt reported within 365 days of DOFD (1-year wait rule)  
- Paid medical collections still reporting as open  
- Old medical collections past 7-year window

**Letter citations:** FCRA § 1681c, CDIA/CRA medical debt policy (1-year wait, $500 minimum)

### Repossessions (Account Status 63, 95, 96\)

**Most common violations:**

- Balance \> 0 after voluntary surrender/repossession and sale proceeds applied  
- Missing Special Comment Codes (AO, AZ, BI, BJ, BK as appropriate)  
- DOFD inconsistent with repo date

### Foreclosures (Account Status 65, 89, 94\)

**Most common violations:**

- 97 (charge-off) reported after 89 or 94 (prohibited under CRRG)  
- Missing Special Comment Code BO during foreclosure process  
- Balance inconsistent with foreclosure sale proceeds

### Bankruptcy-Included Accounts

**Most common violations:**

- Account with Consumer Information Indicator E (Ch 7 discharged) still showing Current Balance \> 0  
- Missing CII on an account included in bankruptcy  
- Status code showing delinquency on discharged account (should typically be status 13 with CII E/H)  
- Authorized user (ECOA Code 3\) not removed with Code Z on account included in bankruptcy  
- Account continuing to show past-due activity after petition date

**Letter citations:** FCRA § 1681e(b), Bankruptcy Code § 524 (discharge injunction), Metro 2 Exhibit 11 (CII requirements)

### Student Loans

**Most common violations:**

- Federal loans not properly showing deferment/forbearance (Special Comment Codes)  
- Old defaulted loans past 7-year window from DOFD  
- Rehabilitated loans not properly updated  
- Private loans discharged in bankruptcy (undue hardship) still reporting as active

### Hard Inquiries

**Most common violations:**

- Inquiry without permissible purpose under § 1681b  
- Duplicate inquiries same day (multiple hits from one application)  
- Inquiry after account was not opened (permissible purpose question)  
- Promotional inquiries incorrectly classified as hard inquiries

**Letter citations:** FCRA § 1681b (permissible purposes), § 1681m (adverse action notice)

### Personal Information Errors

**Most common violations:**

- Old addresses (more than 2 cycles old)  
- Incorrect or misspelled name variants  
- Wrong DOB or SSN fragments  
- Employment info that's out of date  
- Mixed files (information belonging to another consumer)

**Letter citations:** FCRA § 1681e(b), § 1681i(a)

## 4.4 Identity Theft Block (§ 1681c-2)

**When to use:** Any account opened fraudulently, unauthorized inquiries from identity theft, unauthorized address or personal info.

**Process:**

1. File FTC Identity Theft Report at identitytheft.gov  
2. File police report  
3. Submit to CRAs:  
   - The FTC Identity Theft Report  
   - Proof of identity  
   - Identification of the information to be blocked  
   - Statement that the information does not relate to any transaction by the consumer  
4. CRA MUST block within 4 business days

**This is the single most powerful dispute tool.** It bypasses the furnisher investigation process entirely.

## 4.5 CFPB and State AG Complaint Escalation

**CFPB Complaint** (consumerfinance.gov/complaint):

- Files within hours  
- Company typically responds within 15 days  
- Often triggers deletion where prior disputes failed  
- Creates public record visible to consumer  
- Used in Round 3 as threatened or actual escalation

**State AG Complaint:**

- Varies by state  
- Arizona Attorney General: azag.gov/consumer  
- Many states have specific credit reporting consumer divisions  
- Slower than CFPB but adds pressure

## 4.6 Letter Quality Rules (To Avoid CRO Dismissal)

Per 12 CFR 1022.43, furnishers can disregard direct disputes they reasonably believe came from a credit repair organization. To avoid dismissal:

1. **Use consumer-specific facts.** Every letter must reference specific account details — exact balance, exact dates, specific Metro 2 field and value.  
2. **Avoid templated legal language.** Replace generic phrases with specific references to the consumer's file.  
3. **Include consumer-provided documentation.** Original contracts, payment records, paid-in-full letters, FTC ID theft reports.  
4. **Handwritten signature when possible** (scanned signature image OK if not pixel-identical across letters).  
5. **Consumer's actual return address** (not a credit repair company PO box).  
6. **Avoid boilerplate opening/closing paragraphs.** Vary the opening across consumer letters.  
7. **First-person voice.** Write AS the consumer, not as a third party "representing" them.  
8. **Unique formatting per consumer.** Don't use identical letter templates with just name swaps.  
9. **Consumer-specific basis for each dispute.** "I never lived at this address" with proof beats "This address is inaccurate."

---

# SECTION 5 — TRADELINE VIOLATION CHECKLIST

**This is the programmatic checklist the AI runs against each tradeline on the soft pull.**

## 5.1 Universal Checks (Run on Every Tradeline)

| \# | Check | Metro 2 Field(s) | Violation Trigger |
| :---- | :---- | :---- | :---- |
| 1 | Is the Account Number accurate? | Field 7 | Account number doesn't match consumer's records |
| 2 | Is the Date Opened consistent across bureaus? | Field 10 | Different opening dates on different bureaus \= inaccuracy |
| 3 | Is the Portfolio Type correct? | Field 8 | Credit card reported as installment, etc. |
| 4 | Is the Account Type correct? | Field 9 | Mortgage reported as personal loan, etc. |
| 5 | Is the Date of Account Information current (within 30 days)? | Field 24 | DOAI older than 30 days \= stale reporting |
| 6 | Is the DOFD present and consistent? | Field 25 | Missing, or different from original creditor, or future date |
| 7 | Does the DOFD \+ 7 years \+ 180 days exceed today? | Field 25 | If YES, account must be deleted (FCRA § 1681c) |
| 8 | Is the ECOA Code correct? | Field 37 | Individual reported as joint, AU not marked, etc. |
| 9 | Is the Consumer Information Indicator appropriate? | Field 38 | Bankruptcy-included account missing CII |
| 10 | Is the Compliance Condition Code appropriate? | Field 20 | XH used when consumer still disagrees; stale XB |

## 5.2 Status Code Consistency Checks

| \# | Check | Fields | Violation Trigger |
| :---- | :---- | :---- | :---- |
| 11 | Is Account Status consistent with Current Balance? | 17A \+ 21 | Status 13/61-65 with non-zero balance |
| 12 | Is Account Status consistent with Amount Past Due? | 17A \+ 22 | Status 11 with past-due \> 0 |
| 13 | Is Account Status consistent with Payment Rating? | 17A \+ 17B | Status 97 without Payment Rating \= L |
| 14 | Is Account Status consistent with Payment History Profile? | 17A \+ 18 | Status 11 with late-payment codes in PHP |
| 15 | Does Account Status 97 follow 89 or 94? | 17A | Prohibited sequence under CRRG |
| 16 | Is Special Comment Code consistent with Account Status? | 17A \+ 19 | Code AU requires status 13/61-65 |
| 17 | Third-party collector using prohibited status code? | 17A | Anything other than 62, 93, DA, DF |

## 5.3 Charge-Off and Collection Checks

| \# | Check | Fields | Violation Trigger |
| :---- | :---- | :---- | :---- |
| 18 | For charge-off (97) that was sold: is Balance $0 and K2 populated? | 21 \+ K2 | Balance \> 0 after sale |
| 19 | For collection account: is K1 (Original Creditor) populated? | K1 | Missing K1 on collection |
| 20 | For charge-off: is Original Charge-off Amount reported? | Field 23 | Missing field 23 on 97 |
| 21 | Is the same debt reported by both original creditor AND collector? | N/A | Double-reporting |
| 22 | Medical debt under $500? | Portfolio/Type \+ Balance | Must be deleted |
| 23 | Medical debt within 365 days of DOFD? | Type \+ Field 25 | Cannot be reported |

## 5.4 Bankruptcy Checks

| \# | Check | Fields | Violation Trigger |
| :---- | :---- | :---- | :---- |
| 24 | Account included in bankruptcy: CII E/F/G/H present? | Field 38 | Missing post-discharge CII |
| 25 | Discharged account showing Current Balance \> 0? | 38 \+ 21 | Violation of discharge \+ FCRA |
| 26 | Authorized user account in BK: ECOA Code Z applied? | 37 | Should be deleted from AU's file |
| 27 | Status code showing delinquency on discharged account? | 17A \+ 38 | Should typically be 13 with CII E/H |

## 5.5 Dispute Status Checks

| \# | Check | Fields | Violation Trigger |
| :---- | :---- | :---- | :---- |
| 28 | Consumer has active dispute but no XB reported? | Field 20 | § 1681s-2(a)(3) violation |
| 29 | Investigation completed but XB still reported? | Field 20 | Should be removed or changed to XH/XC |
| 30 | Consumer disagrees with outcome but XH reported instead of XC? | Field 20 | Materially misleading |

## 5.6 Personal Information Checks

| \# | Check | Field | Violation Trigger |
| :---- | :---- | :---- | :---- |
| 31 | Old addresses (\>2 reporting cycles) | Address fields | Should be deletable |
| 32 | Name variants not matching consumer's legal name | Name fields | Mixed file risk |
| 33 | DOB mismatch | DOB field | Identity/mixed file |
| 34 | Employer info outdated | N1 Segment | Not updated |

## 5.7 Inquiry Checks

| \# | Check | Violation Trigger |
| :---- | :---- | :---- |
| 35 | Hard inquiry without permissible purpose under § 1681b | No account opened \+ no application on file |
| 36 | Same-day duplicate inquiries | Multiple pulls from one application |
| 37 | Inquiry from entity consumer doesn't recognize | Potential identity theft |
| 38 | Inquiry older than 2 years on hard inquiries | Should be removed |

## 5.8 Output Priority Ranking for AI Letter Generation

When multiple violations are found on a single tradeline, the AI should prioritize in this order for dispute letter emphasis:

1. **Most powerful (likely deletion):** 7-year window expired, identity theft, unverifiable DOFD, discharged bankruptcy balance  
2. **Strong (high leverage):** Re-aging, missing K1 on collection, double-reporting, status/balance contradictions  
3. **Moderate:** Compliance Condition Code errors, Payment History contradictions, missing Special Comments  
4. **Supporting:** Personal info errors, inquiry challenges

---

# AI PROMPT INTEGRATION GUIDE

## How to Use This Knowledge Base in the Underwrite IQ System

### Step 1: Load as Context Module

This document should be loaded as part of the Claude API system prompt for dispute letter generation. Recommended structure:

const METRO2\_KB \= fs.readFileSync('./METRO2\_MASTER\_KNOWLEDGE\_BASE.md', 'utf8');

const SYSTEM\_PROMPT \= \`

You are Underwrite IQ's dispute letter generator for FundHub Credit Solutions LLC.

You have comprehensive knowledge of Metro 2 format, FCRA, FDCPA, Regulation V, 

and federal case law contained in the knowledge base below.

${METRO2\_KB}

Your job is to analyze the client's credit report data and generate dispute letters 

that identify specific Metro 2 field violations and cite the correct statutes and 

case law. Letters must be consumer-specific, not templated, to avoid the CRO loophole 

under 12 CFR 1022.43.

\`;

### Step 2: Structure the Tradeline Input

Feed the AI each tradeline with Metro 2 field mappings already parsed:

{

  "creditor": "Midland Funding",

  "account\_number\_last4": "4521",

  "portfolio\_type": "O",

  "account\_type": "48",

  "date\_opened": "2019-03-15",

  "field\_17A\_account\_status": "93",

  "field\_17B\_payment\_rating": "G",

  "field\_18\_payment\_history": "GGGGGGGGGGGG...",

  "field\_19\_special\_comment": null,

  "field\_20\_compliance\_condition": null,

  "field\_21\_current\_balance": 2100,

  "field\_22\_amount\_past\_due": 2100,

  "field\_24\_date\_of\_account\_info": "2025-12-15",

  "field\_25\_dofd": null,

  "field\_37\_ecoa": "1",

  "field\_38\_cii": null,

  "k1\_original\_creditor": null,

  "k2\_purchased\_from": null,

  "bureau\_reporting": \["EQ", "EX", "TU"\]

}

### Step 3: Run the Violation Checklist

The AI uses Section 5's checklist to identify all applicable violations per tradeline.

### Step 4: Generate Letters with Citations

For each violation found, the AI cites:

- Metro 2 field and expected value (from Section 1\)  
- FCRA/FDCPA/Regulation V statute (from Section 3\)  
- Relevant case law holding (from Section 2\)  
- Strategy-appropriate language (from Section 4\)

### Step 5: Round-Specific Prompting

Use different sub-prompts for Round 1, Round 2, Round 3 — each builds on the prior round. Round 1 is Metro 2/accuracy-focused. Round 2 adds MOV demand and case law. Round 3 adds damages demand and complaint escalation.

### Step 6: CRO-Loophole Mitigation

Every generated letter must:

- Use consumer-specific facts (balances, dates, account numbers from the actual file)  
- Avoid identical language across consumers  
- Use first-person consumer voice  
- Reference consumer-specific documentation

### Recommended AI Temperature/Settings

- Temperature: 0.3–0.5 (lower \= more consistent citations; higher \= more consumer-voice variation)  
- Max tokens: 2000–3000 per letter  
- Use Claude Opus for Round 2/3 (complex legal citations) and Claude Sonnet for Round 1 (straightforward Metro 2\)

### Quality Validation Checklist (Post-Generation)

Before sending letters, validate:

- [ ] All cited Metro 2 fields are correctly referenced per Section 1  
- [ ] All statutory citations match Section 3 exactly  
- [ ] Case law citations match Section 2 (case name, citation, circuit)  
- [ ] Letter contains specific account-level facts  
- [ ] No identical phrasing used across multiple client letters  
- [ ] Consumer return address is the actual consumer's  
- [ ] Enclosures referenced are actually attached

## Updating This Knowledge Base

This knowledge base should be updated when:

- CDIA releases a new CRRG edition (approximately every 2 years)  
- Supreme Court or circuit courts issue new major FCRA rulings  
- CFPB issues new furnisher rules or significant consent orders  
- New Metro 2 codes are added or codes become obsolete (check [www.cdiaonline.org](http://www.cdiaonline.org) annually)

For live case law monitoring: set up CourtListener alerts (courtlistener.com) for "FCRA furnisher" and "Metro 2" queries.

For CFPB enforcement: check consumerfinance.gov/enforcement/actions/ monthly.

---

**END OF KNOWLEDGE BASE**

*Version 1.0 | Built for FundHub Credit Solutions LLC / Underwrite IQ*  
