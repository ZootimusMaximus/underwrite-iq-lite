# N-Series SMS Templates (Nurture Workflows)

All 8 templates correspond to the N-Series Nurture Workflows defined in the
GHL Source of Truth (03/18/2026). Each workflow already has an email template
but was missing its SMS counterpart. These fill that gap.

**GHL workflow folder:**
https://app.gohighlevel.com/v2/location/ORh91GeY4acceSASSnLR/automation/workflows?folder=887bde34-f586-4e53-977d-0ab92a459816&tab=list&listTab=all

**Conventions:**
- GHL merge fields use `{{contact.first_name}}` syntax
- All messages include `Reply STOP to unsubscribe.` for TCPA compliance
- Messages target single-segment SMS (160 chars) where possible; a few
  exceed slightly due to required content

---

## N-01 — Long-Term Cold Nurture SMS

**Trigger:** Tag Added `nurture:cold`
**Gate:** Tags `client:funding` and `client:repair` are NOT present
**Exit:** If client tag is added
**GHL Workflow:** https://app.gohighlevel.com/location/ORh91GeY4acceSASSnLR/workflow/c1172aa2-9a44-4eef-a439-8347457f60bd/advanced-canvas

**Message body:**

```
Hi {{contact.first_name}} — still thinking about business funding? We can help you understand your options in 60 seconds: {{fundhub.analyzer_url}} Reply STOP to unsubscribe.
```

**Char count:** ~160 (varies with name/URL length)
**Notes:** Pairs with Cold Nurture Email. Low-pressure, links to the free analyzer as a re-entry point.

---

## N-02 — Long-Term Warm Nurture SMS

**Trigger:** Tag Added `nurture:warm`
**Gate:** Analyzer Recommendation is present AND Call is NOT booked
**Exit:** If not eligible
**GHL Workflow:** https://app.gohighlevel.com/location/ORh91GeY4acceSASSnLR/workflow/d7e27768-7c48-4329-80f4-f0b6a77980a1/advanced-canvas

**Message body:**

```
Hi {{contact.first_name}} — your credit analyzer results are ready. Book a free strategy call and we'll walk you through your funding options: {{fundhub.booking_url}} Reply STOP to unsubscribe.
```

**Char count:** ~185 (two-segment; content required to drive booking action)
**Notes:** Pairs with Warm Nurture Email. The goal is to convert a warm lead into a booked call.

---

## N-03 — Long-Term Hot Nurture SMS

**Trigger:** Tag Added `nurture:hot`
**Gate:** Analyzer Recommendation is present AND Call is NOT booked
**Exit:** If not eligible
**GHL Workflow:** https://app.gohighlevel.com/location/ORh91GeY4acceSASSnLR/workflow/831135dd-175d-4854-b555-1d7582a30249/advanced-canvas

**Message body:**

```
{{contact.first_name}}, your funding profile looks strong. Let's lock in your options before anything changes — book your call now: {{fundhub.booking_url}} Reply STOP to unsubscribe.
```

**Char count:** ~175 (two-segment; urgency-driven copy is intentional)
**Notes:** Pairs with Hot Nurture Email. More direct/urgent tone. Creates urgency without being pushy.

---

## N-04 — Post-Funding Nurture SMS

**Trigger:** Pipeline Stage Changed: Funding Pipeline > F23 Post-Funding Monitoring
**Gate:** Tag `client:funding` present (or Lifecycle Status = Funding Client)
**Exit:** If not funding client
**GHL Workflow:** https://app.gohighlevel.com/location/ORh91GeY4acceSASSnLR/workflow/e7607d09-4882-470a-ac56-8ed216c573a8/logs

**Message body:**

```
Hi {{contact.first_name}} — congrats on your funding! Your FundHub team is here if you need anything. We'll check in soon with next steps. Reply STOP to unsubscribe.
```

**Char count:** ~158
**Notes:** Pairs with Post-Funding Email. Warm, supportive tone. Reinforces relationship for second-wave readiness. Also triggered by F-08 automation (Add to N-04 Post-Funding Nurture).

---

## N-05 — Repair-Complete Nurture SMS

**Trigger:** Custom Field Updated: Repair Complete Date
**Gate:** Tag `client:repair` present
**Exit:** If not repair client
**GHL Workflow:** https://app.gohighlevel.com/location/ORh91GeY4acceSASSnLR/workflow/7f14403f-27d6-49d5-b93c-3126c6c2d809/advanced-canvas

**Message body:**

```
{{contact.first_name}}, great news — your credit repair program is complete! Your advisor will reach out about upgrade options. Reply STOP to unsubscribe.
```

**Char count:** ~149
**Notes:** Pairs with Repair-Complete Email. Sets expectation for upgrade conversation (tag `upgrade:ready` triggers S-10 Upgrade Call Routing).

---

## N-06 — Renewal / Second-Wave Funding SMS

**Trigger:** Daily Scheduler
**Gate:** Funding Locked Date is older than 6 months AND Tag `client:funding` present
**Exit:** If not eligible
**GHL Workflow:** https://app.gohighlevel.com/location/ORh91GeY4acceSASSnLR/workflow/61b70897-fbf8-47e2-ae09-ea51a4af0279/advanced-canvas

**Message body:**

```
Hi {{contact.first_name}} — it's been 6+ months since your last funding round. You may qualify for additional capital. Want to explore your options? Reply YES or call us. Reply STOP to unsubscribe.
```

**Char count:** ~192 (two-segment; reply-YES CTA drives engagement)
**Notes:** Pairs with Renewal Email. Two-way SMS — a "YES" reply can trigger a task or workflow in GHL. Drives second-wave revenue.

---

## N-07 — Global Re-Engagement (Inactive Leads) SMS

**Trigger:** Daily Scheduler (no activity for X days — threshold TBD)
**Gate:** Lifecycle Status is NOT Funding Client or Repair Client
**Exit:** If client
**GHL Workflow:** https://app.gohighlevel.com/location/ORh91GeY4acceSASSnLR/workflow/1a52896e-7dae-4649-8ad5-f4afc614a731/advanced-canvas

**Message body:**

```
Hi {{contact.first_name}} — it's been a while! Business funding options change fast. See what you qualify for today: {{fundhub.analyzer_url}} Reply STOP to unsubscribe.
```

**Char count:** ~160
**Notes:** Pairs with Re-engagement Email. Targets inactive non-clients only. Links back to analyzer as a zero-friction re-entry.

---

## N-08 — Analyzer Re-Run (6-12 Months) SMS

**Trigger:** Analyzer Last Run Date older than 6-12 months (Custom Date Reminder)
**Gate:** Tag `client:funding` OR `client:repair` present
**Exit:** If not a client
**GHL Workflow:** https://app.gohighlevel.com/location/ORh91GeY4acceSASSnLR/workflow/fbfcba38-ac99-4cfb-94c6-fee38117b0ae/advanced-canvas

**Message body:**

```
Hi {{contact.first_name}} — your credit profile may have changed since your last analysis. Run a free refresh to stay on track: {{fundhub.analyzer_url}} Reply STOP to unsubscribe.
```

**Char count:** ~173 (slight two-segment; necessary for clarity)
**Notes:** Pairs with Analyzer Refresh Email. Targets existing clients only. Keeps credit analysis current so the team can proactively surface new opportunities.

---

## Merge Field Reference

| Placeholder | GHL Field | Notes |
|---|---|---|
| `{{contact.first_name}}` | Contact First Name | Standard GHL merge field |
| `{{fundhub.analyzer_url}}` | Analyzer entry URL | Public link that starts UnderwriteIQ flow |
| `{{fundhub.booking_url}}` | Booking calendar URL | GHL calendar link for strategy calls |

## Implementation Notes

1. **Add each SMS as a "Send SMS" action** in the corresponding GHL workflow, immediately after (or parallel to) the existing email send step.
2. **TCPA compliance:** Every message ends with `Reply STOP to unsubscribe.` per carrier and legal requirements.
3. **Character counts** are approximate — GHL merge fields expand at send time. Test with real contact data to verify segment count.
4. **N-06 uses two-way SMS** — configure a GHL trigger or inbound webhook to handle "YES" replies (e.g., create a task for the advisor or auto-book a call).
5. **Inactive threshold for N-07** is not yet defined in the spec ("X days — definition deferred"). Recommend 60-90 days of no activity as a starting point.
6. **Analyzer URL placeholder** (`{{fundhub.analyzer_url}}`) should be replaced with the actual GHL custom field or static URL used for the public analyzer entry point. Same for `{{fundhub.booking_url}}`.
