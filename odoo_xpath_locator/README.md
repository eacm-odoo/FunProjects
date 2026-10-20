# Odoo XPath Locator — Chrome extension

Paste the xpath of an inheriting view and the extension finds the node it
points to in the parent view's architecture, highlights it in the editor and
tells you its line number.

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
3. The popup shows the line and the opening tag. In the editor:
   - the opening tag gets a strong highlight and an underline, and its line
     number is marked in the gutter;
   - the rest of the element, down to its closing tag, gets a light background;
   - any other match gets a light highlight with a dashed underline.

The highlight goes away on the next search or as soon as the text is edited.

## How it matches

- Full XPath 1.0, plus Odoo's `hasclass('a', 'b')`.
- The expression is evaluated with the root element as context node, as
  Odoo's `locate_node` does, so relative paths behave the same.
- When several nodes match, the popup lists them all and the first one is
  marked as the node Odoo will use.
- An xpath that selects an attribute or text is shown on its element.

## Limits

- It searches the architecture shown in the editor, which is the parent
  view's own arch. Nodes added by other inheriting views are not there, so an
  xpath that targets them is reported as not found.
- Only the `ir.ui.view` form. Studio's XML editor is not supported.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3; permissions `activeTab` and `scripting` only |
| `popup.html`, `popup.css`, `popup.js` | The popup |
| `locator.js` | Parses the arch, evaluates the xpath, maps nodes to lines |
| `page.js` | Injected into the Odoo tab: reads the Ace editor and draws the highlight |
| `icons/` | `xpath_logo.png` and the sizes generated from it |
