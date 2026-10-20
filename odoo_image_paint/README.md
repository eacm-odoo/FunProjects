# Odoo Image Paint — Chrome extension

Pick an image on an Odoo page, touch it up in a small paint editor, and save
it back to the record. Works on Odoo 14.0 and later, in any view that shows a
record's image: forms, kanbans, lists, avatars.

## Installation

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `odoo_image_paint` folder.
3. Optionally pin it to the toolbar, and give it a shortcut in
   `chrome://extensions/shortcuts`.

## Usage

1. On an Odoo page, click the extension icon. Every image of a record gets an
   outline; hovering one shows its model, record id and field.
2. Click the image to edit. **Esc**, **Cancel** or another click on the icon
   leaves the picker.
3. Edit, then **Save to Odoo**. A confirmation shows the image Odoo holds now
   next to the new one, and names the record and field it replaces. Nothing is
   written before you confirm.
4. After a save, **Revert** puts back the image the field had when you opened
   the editor, after a confirmation too. It is there only while the editor
   stays open: Odoo keeps no copy of an image once it is replaced.

Closing the editor with unsaved changes asks first.

## Tools

| Tool | Key | Options |
| --- | --- | --- |
| Pencil | B | size |
| Eraser (to transparent) | E | size |
| Line | L | size; Shift snaps to 45° |
| Rectangle | R | size, outline or filled; Shift makes a square |
| Ellipse | O | size, outline or filled; Shift makes a circle |
| Fill | F | tolerance |
| Text | T | font size, bold; Enter finishes, Shift+Enter adds a line, Esc drops it |
| Pick a color | I | goes back to the previous tool |
| Crop | C | drag the area to keep, then **Crop** or Enter; Esc clears the selection |

Also: rotate left and right, flip horizontally and vertically, undo
(Ctrl+Z) and redo (Ctrl+Y or Ctrl+Shift+Z), Ctrl+S to save, `[` and `]` for
the size, zoom with `+` and `-`, `0` to fit, `1` for actual size, or Ctrl and
the mouse wheel.

## Which field it writes

The image on the page is often a smaller copy: forms show `image_128` as a
preview of `image_1920`, kanbans and avatars show `image_128` or
`avatar_128`. Those copies are related to (or computed from) `image_1920`,
so writing into one of them would leave a 128 px copy in `image_1920`. The
extension always edits and saves the full-size field:

- the widget's own field when the image belongs to one (`name` on the
  image), otherwise the field in the image URL;
- `<name>_1024`, `_512`, `_256` and `_128` become `<name>_1920` when the
  model has it (`image_variant_128` becomes `image_variant_1920`);
- `avatar_*` becomes `image_1920`;
- a read-only field is refused.

The image URL gives the record: `/web/image?model=…&id=…&field=…` (14.0 to
17.0) or `/web/image/<model>/<id>/<field>` (18.0 and later). Attachments,
static files and images inside HTML fields are not record fields and are not
offered.

When the field is empty (an avatar with only initials, for example), the
editor starts from a blank 512 × 512 image, and Revert empties the field
again.

## Formats

- A JPEG is saved as JPEG; erased areas become white.
- Anything else is saved as PNG. Odoo 19 stores WebP without resizing it,
  and 14.0 to 16.0 turn it into PNG anyway.
- An SVG is turned into a bitmap, and an animated GIF keeps only its first
  frame. The confirmation says so.
- Odoo scales `image_1920` down to 1920 px on its own side; the confirmation
  says so when the image is larger.

## What it asks Odoo

Through the web client's JSON-RPC endpoint, with the session of the open
tab, so with your own access rights. Only these calls, on the picked
record's model, are possible:

- `fields_get`, to find the full-size field and check it is writable;
- `read` of that field (and `display_name`) when the editor opens, before
  each save or revert (to warn you if someone changed the image meanwhile),
  and after it, to know what Odoo stored;
- `write` of that one field on that one record, after you confirm a save or
  a revert.

Nothing else leaves the browser:

- The extension only runs in a tab after you click its icon there
  (`activeTab`); it has no access to any site otherwise.
- The address and origin come from Chrome (`tab.url`), never from the page.
  The calls go to that origin, with an absolute URL that a `<base href>` in
  the page cannot redirect, and redirects are refused.
- Images from another origin are not offered.

The write goes straight to the record, like an RPC call: it does not wait
for the form to be saved, and a field that only the view makes read-only can
still be written if your access rights allow it.

## Limits

- After a save, the page's copies of that record's image are reloaded. Other
  views of it (another record's avatar of the same user, for example) show
  the new image after a reload.
- A record that is not saved yet, or an image picked in the form but not
  saved, has nothing to write to: save the form first.
- The editor runs in the page's top frame only.
- No rectangular selection to move or copy parts of the image.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3; permissions `activeTab` and `scripting` only |
| `background.js` | Service worker: on a click on the icon, injects the scripts below into the tab |
| `odoo.js` | Reads image URLs, picks the full-size field, makes the JSON-RPC calls |
| `imaging.js` | Decodes and encodes the image; fill, rotate, flip, crop |
| `paint.js` | The edited image, its undo history, and the drawing tools |
| `ui.js` | Styles, icons, and the shadow-DOM overlay that keeps Odoo's CSS and hotkeys out |
| `picker.js` | Outlines the images and lets you pick one |
| `editor.js` | The editor window, with the save and revert confirmations |
| `main.js` | Entry point called on each click on the icon |
| `icons/` | `logo_paint.png` and the sizes generated from it |
