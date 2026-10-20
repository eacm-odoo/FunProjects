# Odoo XPath Locator — Chrome extension

Paste the xpath of an inheriting view and the extension finds the node it
points to, tells you which view that node comes from and on which line, and
highlights it in the editor.

Works on Odoo 14.0 and later, in the form of `ir.ui.view`
(Settings › Technical › Views, **Architecture** tab).

## Installation

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `odoo_xpath_locator` folder.
3. Optionally pin it to the toolbar, and give it a shortcut in
   `chrome://extensions/shortcuts`.

## Usage

1. Open the parent view's form, on the **Architecture** tab.
2. Click the extension icon and paste the xpath, then press Enter.
   Both a bare expression (`/t/t/div/h2[3]`) and a whole tag copied from the
   inheriting view (`<xpath expr="//div[@name='x']" position="inside">`) work.
3. The popup shows the line, the opening tag and the view the node comes
   from.
   - If that is the open view, the node is highlighted in the editor: the
     opening tag gets a strong highlight and an underline, and its line
     number is marked in the gutter; the rest of the element, down to its
     closing tag, gets a light background; other matches in this view get a
     light highlight with a dashed underline.
   - If it comes from another view (added by an inheriting view), the popup
     names that view and gives the line in its own architecture. **Open that
     view** goes to its form; press Locate there again to highlight it.

The highlight goes away on the next search or as soon as the text is edited.

## How it matches

- The xpath is evaluated on the **combined** architecture: the open view's
  arch with every inheriting view applied, which is what Odoo's xpaths run
  against. The combined arch is only used, never shown.
- Full XPath 1.0, plus Odoo's `hasclass('a', 'b')`.
- The expression is evaluated with the root element as context node, as
  Odoo's `locate_node` does, so relative paths behave the same.
- When several nodes match, the first one is the node Odoo uses.
- An xpath that selects an attribute or text is shown on its element.

The view a node comes from is read from the branding Odoo adds when asked
(`inherit_branding`), and its line from the path that branding gives. When a
node was moved with `position="move"`, that path is off; the node is then
found again in the view's arch by its `name`, `id`, `t-field`, `t-call`,
`t-set` or `t-name`.

## What it asks Odoo

Through the web client's JSON-RPC endpoint, with the session of the open
tab, so with your own access rights (reading `ir.ui.view` takes the
Settings administrator group). Only these calls, on `ir.ui.view`, are
possible; none of them writes:

- `get_combined_arch` (`read_combined` on 14.0), with `inherit_branding`;
- `search_read`, to get the names, external ids and architectures of the
  views involved, and to find the views that hold the xpath.

Nothing leaves the browser for any other place:

- The calls are only made when the editor is the `arch_base` field and the
  tab's address is an Odoo view form (`/web#…model=ir.ui.view…` or
  `/odoo/…/<id>`). On any other page the extension stays local.
- The address and origin come from Chrome (`tab.url`), never from the page.
  The calls go to that origin, with an absolute URL that a `<base href>` in
  the page cannot redirect, and redirects are refused.
- "Open that view" only navigates within that same origin, to a view id that
  is a positive integer.

If those calls fail, if the address does not name a view, or if the editor
has unsaved changes, the extension searches the editor's text alone, as
before, and says so.

## Limits

- Odoo evaluates a view's xpath before applying that view and the ones after
  it; the combined arch has them all. When the view holding the xpath adds
  nodes that change where the xpath lands, the popup warns that the node Odoo
  uses may be a different one. Changes made by later views are not checked.
- A node with no `name`, `id` or `t-*` attribute that was moved, or copied
  with `$0`, cannot be traced to its view; the popup says so.
- Only the `ir.ui.view` form. Studio's XML editor is not supported.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3; permissions `activeTab` and `scripting` only |
| `popup.html`, `popup.css`, `popup.js` | The popup |
| `locator.js` | Parses an arch, evaluates the xpath, maps nodes to lines |
| `combined.js` | Works on the combined arch and finds the view each node comes from |
| `page.js` | Injected into the Odoo tab: reads the Ace editor, draws the highlight, makes the read-only calls |
| `icons/` | `xpath_logo.png` and the sizes generated from it |
