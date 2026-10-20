/**
 * Locate an xpath in the combined architecture of the open view (its own
 * arch with every inheriting view applied) and tell which view brought the
 * node it points to.
 *
 * Odoo is asked for the combined arch with `inherit_branding`: each node an
 * inheriting view adds then carries `data-oe-id` (that view) and
 * `data-oe-xpath` (its path in that view's own arch). An unmarked node came
 * with its nearest marked ancestor, the root being marked with the root view.
 *
 * Odoo evaluates a view's xpath before applying that view and the ones after
 * it, while this works on the arch with all of them applied; the result is
 * flagged when the view holding the xpath changes what it lands on.
 */
import { extractExpression, mapArchitecture, parseArchitecture, prepareExpression, selectElements } from "./locator.js";

/** Odoo could not be asked; the caller falls back to the editor's text. */
export class CombinedUnavailable extends Error {}

const BRANDING_ATTRIBUTES = [
    "data-oe-model",
    "data-oe-id",
    "data-oe-field",
    "data-oe-xpath",
    "data-oe-field-xpath",
    "data-oe-source-id",
    "data-oe-no-branding",
];
// Left by apply_inheritance_specs where it removed a node, so that the
// positions of the following siblings can still be told.
const REMOVAL_MARK = "apply-inheritance-specs-node-removal";
// Attributes that tell a node apart, to check a computed path landed on it.
const SIGNATURE_ATTRIBUTES = ["name", "id", "t-field", "t-call", "t-set", "t-name"];

/**
 * The id of the record open in the form, from the page address:
 * /web#id=42&model=ir.ui.view up to 17.0, /odoo/action-28/42 since 18.0.
 * Any other address, Odoo's or not, gives null.
 */
export function viewIdFromUrl(url) {
    if (!URL.canParse(url)) {
        return null;
    }
    const { protocol, hash, pathname } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") {
        return null;
    }
    let id = null;
    if (/^\/web\/?$/.test(pathname)) {
        const params = new URLSearchParams(hash.slice(1));
        id = params.get("model") === "ir.ui.view" ? params.get("id") : null;
    } else if (pathname.startsWith("/odoo/")) {
        id = pathname.split("/").findLast((segment) => /^\d+$/.test(segment));
    }
    return /^\d+$/.test(id ?? "") ? Number(id) : null;
}

/**
 * The address of another view's form, built from the current one, so it
 * stays on the same site; null unless both the address and the id are
 * what they should be.
 */
export function viewUrl(url, id) {
    if (!Number.isInteger(id) || id <= 0 || !viewIdFromUrl(url)) {
        return null;
    }
    const parsed = new URL(url);
    if (/^\/web\/?$/.test(parsed.pathname)) {
        const params = new URLSearchParams(parsed.hash.slice(1));
        params.set("id", id);
        parsed.hash = params.toString();
    } else {
        const segments = parsed.pathname.split("/");
        segments[segments.findLastIndex((segment) => /^\d+$/.test(segment))] = id;
        parsed.pathname = segments.join("/");
    }
    return parsed.toString();
}

/**
 * Take the branding off the tree, so the xpath runs on the arch Odoo
 * sees, and keep it on the side.
 */
function readBranding(doc) {
    const branding = new Map();
    for (const element of doc.getElementsByTagName("*")) {
        const id = element.getAttribute("data-oe-id");
        const xpath = element.getAttribute("data-oe-xpath") ?? element.getAttribute("data-oe-field-xpath");
        const copied = element.hasAttribute("data-oe-no-branding");
        if (id || xpath || copied) {
            branding.set(element, { viewId: Number(id) || null, xpath, copied });
        }
        BRANDING_ATTRIBUTES.forEach((name) => element.removeAttribute(name));
    }
    return branding;
}

/** 1-based position of an element among the same-tag siblings of its own arch. */
function ownPosition(element, branding) {
    let position = 1;
    for (let sibling = element.previousSibling; sibling; sibling = sibling.previousSibling) {
        if (sibling.nodeType === Node.PROCESSING_INSTRUCTION_NODE) {
            if (sibling.target === REMOVAL_MARK && sibling.data.trim() === element.nodeName) {
                position++;
            }
        } else if (
            sibling.nodeType === Node.ELEMENT_NODE &&
            sibling.nodeName === element.nodeName &&
            !branding.get(sibling)?.xpath
        ) {
            position++;
        }
    }
    return position;
}

/**
 * Which view an element comes from, by its branding, and its path in that
 * view's arch. `viewId` is null when the branding does not say: `t-field`
 * nodes get a path but no id, and `$0` copies lose both.
 */
function originOf(element, branding) {
    const steps = [];
    for (let node = element; ; node = node.parentElement) {
        const mark = branding.get(node);
        if (mark?.copied) {
            return { viewId: null, path: null };
        }
        if (mark?.xpath) {
            return { viewId: mark.viewId, path: mark.xpath + steps.join(""), anchor: node, anchorPath: mark.xpath };
        }
        if (!node.parentElement) {
            return { viewId: mark?.viewId ?? null, path: `/${node.nodeName}${steps.join("")}` };
        }
        steps.unshift(`/${node.nodeName}[${ownPosition(node, branding)}]`);
    }
}

function signatureOf(element) {
    const parts = SIGNATURE_ATTRIBUTES.filter((name) => element.hasAttribute(name)).map(
        (name) => `${name}=${element.getAttribute(name)}`
    );
    return parts.length ? `${element.nodeName} ${parts.join(" ")}` : null;
}

function isSameNode(candidate, element) {
    return candidate.nodeName === element.nodeName && signatureOf(candidate) === signatureOf(element);
}

/** The one content node of an arch looking like `element`, if there is exactly one. */
function findTwin(map, element) {
    const signature = signatureOf(element);
    if (!signature) {
        return null;
    }
    const twins = map.nodes.filter((node) => !node.hasAttribute("position") && signatureOf(node) === signature);
    return twins.length === 1 ? twins[0] : null;
}

/** Parse each view's arch once, the open view's being the editor's text. */
function archCache(page, openViewId) {
    const cache = new Map();
    return (view) => {
        if (!cache.has(view.id)) {
            try {
                cache.set(view.id, mapArchitecture(view.id === openViewId ? page.text : view.arch_base));
            } catch {
                cache.set(view.id, null);
            }
        }
        return cache.get(view.id);
    };
}

/**
 * Find an element of the combined arch in the arch of the view it comes
 * from. The branding path is tried first; nodes moved with
 * position="move" leave no trace though, and shift their siblings, so the
 * node found there has to look like the element, or it is searched for by
 * its signature, in that view and then in the others.
 */
function place(element, origin, views, archOf) {
    const view = views.find((candidate) => candidate.id === origin.viewId);
    const map = view && archOf(view);
    if (map) {
        let [node] = origin.path ? selectElements(map.doc, origin.path) : [];
        if (!node || !isSameNode(node, element)) {
            node = findTwin(map, element);
        }
        if (node) {
            return { view, position: map.positions.get(node) };
        }
    }
    const found = [];
    for (const candidate of views) {
        const candidateMap = archOf(candidate);
        const node = candidateMap && findTwin(candidateMap, element);
        if (node) {
            found.push({ view: candidate, position: candidateMap.positions.get(node) });
        }
    }
    // A node that cannot be found in the view its branding names (a `$0`
    // copy, say) is not credited to that view either.
    return found.length === 1 ? found[0] : { view: null, position: null };
}

/** Longest run of the expression that is stored the same whatever the escaping. */
function searchTerm(expression) {
    return expression.split(/[<>&"'\s]+/).reduce((best, part) => (part.length > best.length ? part : best), "");
}

/** Views of this tree holding an `<xpath>` with exactly this expression. */
async function findXpathViews(rpc, expression, treeIds) {
    const term = searchTerm(expression);
    if (term.length < 3) {
        return [];
    }
    const candidates = await rpc("search_read", {
        domain: [["arch_db", "ilike", term], ["inherit_id", "in", [...treeIds]]],
        fields: ["name", "xml_id", "arch_base"],
        limit: 50,
    });
    return candidates.filter((view) => {
        try {
            const doc = parseArchitecture(view.arch_base);
            return [...doc.getElementsByTagName("xpath")].some(
                (node) => node.getAttribute("expr")?.trim() === expression
            );
        } catch {
            return false;
        }
    });
}

/**
 * @param {{text: string, isArchField: boolean, url: string}} page the
 *      editor's text, whether it is the arch field of a view form, and the
 *      tab's address as Chrome reports it (the page cannot fake that one)
 * @param {string} input the xpath, bare or as an `<xpath>` tag
 * @param {(method: string, params: object) => Promise<any>} rpc
 * @returns {Promise<object>} what to show: `found`, then either `note`, or
 *      `total`, `origin` (the view of the first match, null if unknown),
 *      `place` (its position in that view's arch), `editorMatches` (what
 *      to mark in the editor) and `warning`
 */
export async function locateCombined(page, input, rpc) {
    const expression = prepareExpression(input);
    if (!page.isArchField) {
        throw new CombinedUnavailable("the editor is not the architecture of a view form");
    }
    const viewId = viewIdFromUrl(page.url);
    if (!viewId) {
        throw new CombinedUnavailable("the page address does not name a view");
    }
    const [openView] = await rpc("search_read", { domain: [["id", "=", viewId]], fields: ["arch_base"] });
    const normalize = (text) => (text || "").replace(/\r\n?/g, "\n").trimEnd();
    if (!openView || normalize(openView.arch_base) !== normalize(page.text)) {
        throw new CombinedUnavailable("the editor differs from the saved view");
    }

    const doc = parseArchitecture(await rpc("combined", { id: viewId }));
    const branding = readBranding(doc);
    const elements = selectElements(doc, expression);
    const treeIds = new Set([viewId, ...[...branding.values()].map((mark) => mark.viewId).filter(Boolean)]);
    const [views, xpathViews] = await Promise.all([
        rpc("search_read", { domain: [["id", "in", [...treeIds]]], fields: ["name", "xml_id", "arch_base"] }),
        findXpathViews(rpc, extractExpression(input), treeIds),
    ]);

    if (!elements.length) {
        return {
            found: false,
            note: xpathViews.length
                ? `View “${xpathViews[0].name}” uses this xpath, so the node existed when it was applied; ` +
                  "that view or a later one replaces or moves it."
                : null,
        };
    }

    const archOf = archCache(page, viewId);
    const placed = elements.map((element) => {
        const origin = originOf(element, branding);
        if (!origin.viewId && origin.anchor) {
            // A t-field node: find the view whose arch has it at that path.
            origin.viewId =
                views.find((view) => {
                    const map = archOf(view);
                    const [node] = map ? selectElements(map.doc, origin.anchorPath) : [];
                    return node && isSameNode(node, origin.anchor);
                })?.id ?? null;
        }
        return place(element, origin, views, archOf);
    });
    const [first] = placed;
    const isOpenView = first.view?.id === viewId;
    // The editor marks its first match as the one Odoo uses.
    const editorMatches =
        isOpenView && first.position
            ? placed.filter(({ view, position }) => view?.id === viewId && position).map(({ position }) => position)
            : [];

    let warning = null;
    if (xpathViews.length) {
        // Drop what the views holding the xpath added, and see whether the
        // xpath still lands on the same node.
        const holders = new Set(xpathViews.map((holder) => holder.id));
        for (const [element, mark] of branding) {
            if (mark.xpath && holders.has(mark.viewId)) {
                element.remove();
            }
        }
        if (selectElements(doc, expression)[0] !== elements[0]) {
            warning =
                `This xpath is in view “${xpathViews[0].name}”, which also adds nodes here. ` +
                "Odoo evaluates it before that view is applied, so the node it uses may be a different one.";
        }
    }

    return {
        found: true,
        total: elements.length,
        origin: first.view
            ? {
                  id: first.view.id,
                  name: first.view.name,
                  xmlId: first.view.xml_id || "",
                  isOpenView,
                  url: isOpenView ? null : viewUrl(page.url, first.view.id),
              }
            : null,
        place: first.position,
        editorMatches,
        warning,
    };
}
