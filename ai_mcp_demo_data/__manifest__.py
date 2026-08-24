# Part of Odoo. See LICENSE file for full copyright and licensing details.
{
    "name": "AI MCP Demo Data",
    "version": "1.0.0",
    "category": "Productivity",
    "summary": "Realistic sales, inventory and accounting data to demo the Odoo MCP server",
    "description": """
AI MCP Demo Data
================
Data-only module (no Python is executed at install time, so it can be imported
on Odoo Online / SaaS ~19.4) that fills a database with a coherent year of
business activity, meant to be queried through the **AI MCP Server**
(``ai_mcp``) during customer demos.

Contents
--------
* 120 customer companies (8 countries, valid tax IDs, payment terms, tags,
  credit limits) and 90 contacts and delivery/invoicing addresses
* 150 products in 10 categories: hardware with barcodes, weights and stock,
  software licenses and services
* Own taxes (8.25%, 5%, 6%, exempt, export) and an international fiscal position
* Opening stock booked as an inventory adjustment dated January 2026
* 1100 sales orders spread over 2026, with quotations, confirmed orders and
  cancellations, and a **confirmed pipeline running into the future**
* Deliveries: validated and backdated for what has shipped, still pending
  (some of them late) for the rest
* ~540 customer invoices and 25 credit notes, posted in chronological order
* ~430 customer payments, matched against their invoice, leaving a realistic
  aged receivable (paid, partially paid, open and overdue)

Requirements
------------
* A chart of accounts must already be installed on the company
  (the module creates its own taxes but posts on the existing accounts)
* Single company, single currency
* Dates are fixed on calendar year 2026

The data is regenerated with ``tools/gen_ai_mcp_demo_data.py``.
""",
    "author": "Odoo Development Services",
    "website": "https://www.odoo.com",
    "license": "LGPL-3",
    "depends": [
        "sale_management",
        "sale_stock",
        "account",
    ],
    "data": [
        "data/00_account_chart.xml",
        "data/01_res_users.xml",
        "data/02_account_tax.xml",
        "data/03_res_partner.xml",
        "data/04_product_product.xml",
        "data/05_stock_quant.xml",
        "data/06_sale_order.xml",
        "data/07_sale_order_confirm.xml",
        "data/08_stock_picking.xml",
        "data/09_account_move.xml",
        "data/10_account_move_post.xml",
        "data/11_account_payment.xml",
    ],
    "installable": True,
    "application": False,
}
