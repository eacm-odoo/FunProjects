# Odoo Image Paint — Chrome extension

Pick an image or a PDF on an Odoo page, touch it up in a small paint editor,
and save it to Odoo. Works on Odoo 14.0 and later.

- A record's **image field** (forms, kanbans, lists, avatars) is saved back
  into the record, with a Revert.
- An **attachment** (an image or a PDF in the chatter, in a files field, or
  open in the preview) is never changed: saving creates an edited copy next
  to it.

## Installation

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `odoo_image_paint` folder.
3. Optionally pin it to the toolbar, and give it a shortcut in
   `chrome://extensions/shortcuts`.

## Usage

1. On an Odoo page, click the extension icon. Every record image and every
   image or PDF attachment gets an outline; hovering one shows what it is.
   When the attachment preview (or a dialog) is open, only what it shows is
   outlined.
2. Click the one to edit. **Esc**, **Cancel** or another click on the icon
   leaves the picker.
3. Edit, then save. Nothing is written before you confirm.
   - **Save to Odoo**, for an image field: the confirmation shows the image
     Odoo holds now next to the new one, and names the record and field it
     replaces. After a save, **Revert** puts back the image the field had
     when you opened the editor, after a confirmation too. It is there only
     while the editor stays open: Odoo keeps no copy of an image once it is
     replaced.
   - **Save a copy**, for an attachment: the confirmation names the copy
     ("photo (edited).jpg") and the record it is attached to, the same as
     the original's. Later saves in the same editor **update that copy**.
     The copy shows among the record's attachments after a reload.

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

Also: rotate left and right, flip horizontally and vertically (not on a
PDF), undo (Ctrl+Z) and redo (Ctrl+Y or Ctrl+Shift+Z), Ctrl+S to save, `[`
and `]` for the size, zoom with `+` and `-`, `0` to fit, `1` for actual
size, or Ctrl and the mouse wheel. On a PDF, Page Up and Page Down change
page.

## PDFs

A PDF is edited page by page, each page with its own undo history. The page
is shown under a transparent layer, and you draw on that layer only:

- The eraser erases what you drew, not the PDF's own content.
- Fill and Pick a color see the page as it looks, and fill on your layer.
- Rotate turns the page (its `/Rotate`), Crop sets its crop box. Neither
  touches the content: the copy still holds the whole page.

The copy is the original PDF with, on each edited page, your drawing added on
top as one image, and the rotation and crop box set. The PDF's text stays
text and its images are not re-encoded, so the copy stays searchable. Its
metadata is the original's.

Refused: encrypted and password-protected PDFs. A digitally signed PDF can be
edited, but the copy's signature is no longer valid (the original keeps
it); the confirmation says so.

pdf.js and pdf-lib (see `lib/README.md`) are only loaded into the tab the
first time a PDF is opened.

## Which field it writes

Only for image fields; attachments are never written.

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

When the field is empty (an avatar with only initials, for example), the
editor starts from a blank 512 × 512 image, and Revert empties the field
again.

An attachment that stores an image field (`res_field` set) is edited as that
field.

## What it finds on the page

- Image fields: `/web/image?model=…&id=…&field=…` (14.0 to 17.0) or
  `/web/image/<model>/<id>/<field>` (18.0 and later).
- Attachments: `/web/image/<id>…`, `/web/content/<id>…`, `/web/content?id=…`
  (14.0 chatter), `/web/image/ir.attachment/<id>/…` (PDF thumbnails), and
  the PDF open in Odoo's pdf.js viewer (the attachment preview, or the
  document shown next to a vendor bill). They are looked up first, and only
  images Chrome can read (PNG, JPEG, GIF, WebP, BMP, ICO, SVG) and PDFs are
  outlined: no Word, Excel, CSV, text or TIFF files.

From 17.0, a chatter card for a file without a thumbnail carries no link to
it: open its preview, then click the icon.

## Formats

- Image fields: a JPEG is saved as JPEG; erased areas become white.
  Anything else is saved as PNG. Odoo 19 stores WebP without resizing it,
  and 14.0 to 16.0 turn it into PNG anyway.
- Copies of attachments keep the format when the browser can write it (PNG,
  JPEG, WebP); a GIF, BMP, ICO or SVG becomes a PNG named `.png`.
- An SVG is turned into a bitmap, and an animated GIF keeps only its first
  frame. The confirmation says so.
- Odoo scales `image_1920`, and attachments in PNG or JPEG, down to 1920 px
  (for attachments, unless `base.image_autoresize_max_px` says otherwise);
  the confirmation says so when the image is larger.

## What it asks Odoo

Through the web client's JSON-RPC endpoint, with the session of the open
tab, so with your own access rights. Only these calls are possible:

- image fields, on the picked record's model:
  - `fields_get`, to find the full-size field and check it is writable;
  - `read` of that field (and `display_name`) when the editor opens, before
    each save or revert (to warn you if someone changed the image
    meanwhile), and after it, to know what Odoo stored;
  - `write` of that one field on that one record, after you confirm a save
    or a revert;
- attachments, on `ir.attachment`:
  - `read` of the name, type and record of the attachments on the page, to
    keep only images and PDFs, and of the picked one's content;
  - `create` of the copy (name, content, type, and the original's record),
    after you confirm;
  - `write` of the content of that copy only, when you update it.

Nothing else leaves the browser:

- The extension only runs in a tab after you click its icon there
  (`activeTab`); it has no access to any site otherwise.
- The address and origin come from Chrome (`tab.url`), never from the page.
  The calls go to that origin, with an absolute URL that a `<base href>` in
  the page cannot redirect, and redirects are refused.
- Images and PDFs from another origin are not offered.

The field write goes straight to the record, like an RPC call: it does not
wait for the form to be saved, and a field that only the view makes
read-only can still be written if your access rights allow it.

## Limits

- After saving an image field, the page's copies of that record's image are
  reloaded. Other views of it (another record's avatar of the same user,
  for example) show the new image after a reload.
- A record that is not saved yet, or an image picked in the form but not
  saved, has nothing to write to: save the form first.
- Images inside HTML fields and website pages are attachments too. Their
  copy is attached next to the original and does not replace the image in
  the text.
- Documents (Enterprise) serves its files from its own routes: they are not
  offered.
- JPEG 2000 images inside a PDF may not show in the editor; they stay as
  they are in the copy.
- The editor runs in the page's top frame only.
- No rectangular selection to move or copy parts of the image.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3; permissions `activeTab` and `scripting` only |
| `background.js` | Service worker: on a click on the icon, injects the scripts below into the tab; injects `lib/` when a PDF is opened |
| `odoo.js` | Reads image and attachment URLs, picks the full-size field, makes the JSON-RPC calls |
| `imaging.js` | Decodes and encodes images; fill, rotate, flip, crop |
| `paint.js` | The edited image or page, its undo history, and the drawing tools |
| `pdfdoc.js` | Renders PDF pages and writes the edited copy |
| `ui.js` | Styles, icons, and the shadow-DOM overlay that keeps Odoo's CSS and hotkeys out |
| `picker.js` | Outlines the images and PDFs and lets you pick one |
| `editor.js` | The editor window, with the save, copy and revert confirmations |
| `main.js` | Entry point called on each click on the icon |
| `lib/` | pdf.js and pdf-lib, with their licenses and how they were built |
| `icons/` | `logo_paint.png` and the sizes generated from it |
