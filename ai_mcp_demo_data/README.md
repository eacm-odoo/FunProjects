# AI MCP Demo Data

Data-only module for **saas~19.4** that loads a full year of believable business
activity into a database, so the **AI MCP Server** (`ai_mcp`) has something real
to answer questions about during a customer demo.

No Python runs at install time: every record and every state change (confirm,
validate, post, pay, reconcile) is expressed in XML, which is what an imported
module on Odoo Online is allowed to do.

## The story

*TechFlow Distribution*, a B2B technology distributor invoicing in USD. History
runs from January 2026 to 24 August 2026, and the confirmed pipeline continues
to December 2026, so there are future orders and future deliveries on purpose.

## What gets loaded

| | |
|---|---|
| Customers | 120 companies in 8 countries (valid tax IDs, payment terms, tags, credit limits) + 90 contacts and invoicing/delivery addresses |
| Salespeople | 5 users in 3 sales teams |
| Products | 150 across 10 categories: hardware (barcode, weight, volume, stock), software licenses and services |
| Taxes | Own taxes (8.25%, 5%, 6%, exempt, export), 3 tax groups and an international fiscal position |
| Stock | Opening inventory adjustment dated 2 January 2026, sized from the demand of the year |
| Sales orders | 1100 spread over 2026: quotations, sent, cancelled and ~800 confirmed |
| Deliveries | ~500 validated and backdated, ~300 pending (some of them late) |
| Invoices | ~540 customer invoices + 25 credit notes, posted in date order |
| Payments | ~430 payments matched to their invoice: paid, partially paid, open and overdue |

## Requirements

* Accounting must be usable. If the company has **no chart of accounts**, the
  module loads the generic one (`generic_coa`) before anything else; if it
  already has one, that step does nothing and the existing accounts, journals
  and fiscal country are used as they are. The module always creates its own
  taxes on top.
* One company, one currency (USD), one warehouse in **1-step delivery**.
* The database should not already contain sales orders named `SO26-****`:
  order names are fixed so the invoices can quote their source document.

Installing creates **5 internal users** (no password, so they cannot log in).
On Odoo Online those count against the subscription: remove them from
`data/01_res_users.xml` and regenerate if that is a problem.

## Install

Zip the folder and import it from **Apps → Import Module**, or drop it in the
addons path and install `ai_mcp_demo_data`.

Loading takes several minutes: the module confirms ~800 orders, validates ~500
transfers, posts ~560 invoices and reconciles ~430 payments.

To remove the data, uninstall the module — Odoo deletes the records it created,
posted entries included.

## Regenerating

Everything under `data/` is generated, do not edit it by hand:

```bash
python3 tools/gen_ai_mcp_demo_data.py
```

The volume, the dates and the ratios (delivered, invoiced, paid) are constants
at the top of that script. The random seed is fixed, so the same dataset comes
out on every run.

Then check the result against the source of the target series before installing
— a single wrong field name aborts the whole install:

```bash
python3 tools/validate_ai_mcp_demo_data.py [/path/to/odoo]
```

It verifies XML well-formedness, that every field exists on its model (in
records, in domains, in `Command` payloads and in `write` calls), that no
computed field is written, that selection values and method names exist, that
the arguments passed to each `<function>` match its signature, and that every
`ref()` resolves.

## Questions to try through MCP

* Which customers have the highest overdue balance right now?
* What is the revenue per month in 2026, and which product category leads it?
* Which confirmed orders are still waiting to be delivered, and how late are they?
* Who is the top salesperson this year, and what does their pipeline look like
  for the rest of 2026?
* Which products are running low on stock compared to what has been sold?
