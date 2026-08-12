/** @odoo-module **/
/**
 * The four faces the board's chrome is drawn in.
 *
 * They are pulled at runtime rather than shipped in the bundle: the board is
 * the only screen in the database that uses them, and it is already a lazy
 * bundle. Every rule in `battleship_board.scss` names a fallback stack, so a
 * browser that never reaches Google Fonts gets a plainer board and not a broken
 * one.
 *
 * Called from the board's `setup`, which covers both places it is mounted: the
 * backend client action and the public page.
 */

const LINK_ID = "o_battleship_fonts";
const HREF =
    "https://fonts.googleapis.com/css2" +
    "?family=Big+Shoulders+Display:wght@500;700;800" +
    "&family=Special+Elite" +
    "&family=IBM+Plex+Sans:wght@400;500;600;700" +
    "&family=IBM+Plex+Mono:wght@400;600" +
    "&display=swap";

export function loadNavalFonts() {
    if (document.getElementById(LINK_ID)) {
        return;
    }
    const preconnect = document.createElement("link");
    preconnect.rel = "preconnect";
    preconnect.href = "https://fonts.gstatic.com";
    preconnect.crossOrigin = "anonymous";
    document.head.appendChild(preconnect);

    const link = document.createElement("link");
    link.id = LINK_ID;
    link.rel = "stylesheet";
    link.href = HREF;
    document.head.appendChild(link);
}
