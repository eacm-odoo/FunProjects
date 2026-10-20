/**
 * Find the nodes an inheritance xpath points to in a view architecture,
 * together with where they sit in the architecture text.
 *
 * Follows odoo.tools.template_inheritance.locate_node: the expression is
 * evaluated with the root element as context node, and Odoo applies the
 * spec to the first node found.
 */

export class LocatorError extends Error {}

const ENTITIES = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" };
const NODE_SET_TYPES = [
    XPathResult.UNORDERED_NODE_ITERATOR_TYPE,
    XPathResult.ORDERED_NODE_ITERATOR_TYPE,
];

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|quot|apos|lt|gt|amp);/g, (match, entity) => {
        if (entity.startsWith("#x")) {
            return String.fromCodePoint(parseInt(entity.slice(2), 16));
        }
        if (entity.startsWith("#")) {
            return String.fromCodePoint(parseInt(entity.slice(1), 10));
        }
        return ENTITIES[entity];
    });
}

/**
 * Accept either a bare expression or a whole `<xpath expr="..." ...>` tag
 * copied from an inheriting view.
 */
export function extractExpression(input) {
    let expression = input.trim();
    const tag = expression.match(/^<xpath\b[^>]*?\sexpr\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (tag) {
        expression = tag[1] ?? tag[2];
    }
    return decodeEntities(expression).trim();
}

function classTest(cls) {
    // Odoo compares against the whitespace-split class list, so a name that
    // is empty or contains whitespace can never match.
    if (!cls || /\s/.test(cls)) {
        return "false()";
    }
    const quote = cls.includes("'") ? '"' : "'";
    if (cls.includes(quote)) {
        return "false()";
    }
    return `contains(concat(' ', normalize-space(@class), ' '), ${quote} ${cls} ${quote})`;
}

/**
 * Rewrite Odoo's hasclass('a', 'b') extension function into plain XPath 1.0,
 * which is all the browser understands.
 */
export function translateHasclass(expression) {
    const call = /hasclass\s*\(/y;
    let result = "";
    let index = 0;
    while (index < expression.length) {
        const char = expression[index];
        if (char === "'" || char === '"') {
            const close = expression.indexOf(char, index + 1);
            const end = close === -1 ? expression.length : close + 1;
            result += expression.slice(index, end);
            index = end;
            continue;
        }
        call.lastIndex = index;
        if (!call.test(expression) || /[\w.:-]/.test(expression[index - 1] ?? "")) {
            result += char;
            index++;
            continue;
        }
        const classes = [];
        let cursor = call.lastIndex;
        for (;;) {
            while (/\s/.test(expression[cursor] ?? "")) {
                cursor++;
            }
            const quote = expression[cursor];
            if (quote === ")" && !classes.length) {
                break;
            }
            if (quote !== "'" && quote !== '"') {
                throw new LocatorError("hasclass() only accepts quoted class names.");
            }
            const close = expression.indexOf(quote, cursor + 1);
            if (close === -1) {
                throw new LocatorError("Unterminated string in hasclass().");
            }
            classes.push(expression.slice(cursor + 1, close));
            cursor = close + 1;
            while (/\s/.test(expression[cursor] ?? "")) {
                cursor++;
            }
            if (expression[cursor] === ")") {
                break;
            }
            if (expression[cursor] !== ",") {
                throw new LocatorError("hasclass() only accepts quoted class names.");
            }
            cursor++;
        }
        result += classes.length ? `(${classes.map(classTest).join(" and ")})` : "true()";
        index = cursor + 1;
    }
    return result;
}

function findTagEnd(text, start) {
    let quote = null;
    for (let index = start + 1; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            if (char === quote) {
                quote = null;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === ">") {
            return index + 1;
        }
    }
    return -1;
}

function skipPast(text, marker, from) {
    const index = text.indexOf(marker, from);
    return index === -1 ? -1 : index + marker.length;
}

function skipDoctype(text, start) {
    let depth = 0;
    for (let index = start + 2; index < text.length; index++) {
        if (text[index] === "[") {
            depth++;
        } else if (text[index] === "]") {
            depth--;
        } else if (text[index] === ">" && depth <= 0) {
            return index + 1;
        }
    }
    return -1;
}

/**
 * List every element of the text in document order with the offsets of its
 * start tag and of its end. The order matches getElementsByTagName("*") on
 * the parsed document, which is how the two are joined.
 */
export function scanElements(text) {
    const elements = [];
    const open = [];
    let index = text.indexOf("<");
    while (index !== -1) {
        let next;
        if (text.startsWith("<!--", index)) {
            next = skipPast(text, "-->", index + 4);
        } else if (text.startsWith("<![CDATA[", index)) {
            next = skipPast(text, "]]>", index + 9);
        } else if (text.startsWith("<?", index)) {
            next = skipPast(text, "?>", index + 2);
        } else if (text.startsWith("<!", index)) {
            next = skipDoctype(text, index);
        } else if (text[index + 1] === "/") {
            next = skipPast(text, ">", index);
            const element = open.pop();
            if (element && next !== -1) {
                element.end = next;
            }
        } else {
            next = findTagEnd(text, index);
            if (next === -1) {
                break;
            }
            const name = text.slice(index + 1).match(/^[^\s/>]+/)?.[0] ?? "";
            const element = { name, start: index, openEnd: next, end: next };
            elements.push(element);
            if (text[next - 2] !== "/") {
                open.push(element);
            }
        }
        if (next === -1) {
            break;
        }
        index = text.indexOf("<", next);
    }
    return elements;
}

function lineStarts(text) {
    const starts = [0];
    const newline = /\r\n|\r|\n/g;
    while (newline.exec(text)) {
        starts.push(newline.lastIndex);
    }
    return starts;
}

function toPosition(starts, offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= offset) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    return { row: low, column: offset - starts[low] };
}

/**
 * The expression to evaluate for what the user typed: hasclass() rewritten,
 * a whole `<xpath>` tag reduced to its expr.
 */
export function prepareExpression(input) {
    const expression = translateHasclass(extractExpression(input));
    if (!expression) {
        throw new LocatorError("Paste an xpath first.");
    }
    return expression;
}

export function parseArchitecture(text) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    const error = doc.getElementsByTagName("parsererror")[0];
    if (error) {
        const detail = error.textContent.match(/error on line (\d+) at column \d+: ([^\n]*)/);
        throw new LocatorError(
            detail
                ? `The architecture is not valid XML (line ${detail[1]}: ${detail[2].trim()}).`
                : "The architecture is not valid XML."
        );
    }
    return doc;
}

function evaluate(doc, expression) {
    const root = doc.documentElement;
    const resolver = (prefix) => root.lookupNamespaceURI(prefix);
    try {
        const probe = doc.evaluate(expression, root, resolver, XPathResult.ANY_TYPE, null);
        if (!NODE_SET_TYPES.includes(probe.resultType)) {
            throw new LocatorError("The xpath returns a value, not nodes.");
        }
        return doc.evaluate(expression, root, resolver, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    } catch (error) {
        if (error instanceof LocatorError) {
            throw error;
        }
        throw new LocatorError(`Invalid xpath: ${error.message.replace(/^Failed to execute .*?: /, "")}`);
    }
}

/**
 * The elements an expression selects, in document order. An attribute or a
 * text node stands for the element holding it.
 */
export function selectElements(doc, expression) {
    const snapshot = evaluate(doc, expression);
    const elements = new Set();
    for (let index = 0; index < snapshot.snapshotLength; index++) {
        let node = snapshot.snapshotItem(index);
        if (node.nodeType === Node.ATTRIBUTE_NODE) {
            node = node.ownerElement;
        } else if (node.nodeType !== Node.ELEMENT_NODE) {
            node = node.parentElement;
        }
        if (node) {
            elements.add(node);
        }
    }
    return [...elements];
}

/**
 * Parse an architecture and tell where each of its elements is in the text.
 *
 * @param {string} text
 * @returns {{doc: Document, nodes: Element[], positions: Map<Element, Position>}}
 *      nodes in document order; a Position is {row, column, openEndRow,
 *      endRow, tag}, rows being 0-based
 */
export function mapArchitecture(text) {
    const doc = parseArchitecture(text);
    const nodes = [...doc.getElementsByTagName("*")];
    const elements = scanElements(text);
    if (
        nodes.length !== elements.length ||
        nodes.some((node, index) => node.nodeName !== elements[index].name)
    ) {
        throw new LocatorError("Could not map the architecture text to its XML tree.");
    }
    const starts = lineStarts(text);
    const positions = new Map(
        nodes.map((node, index) => {
            const element = elements[index];
            const start = toPosition(starts, element.start);
            return [
                node,
                {
                    row: start.row,
                    column: start.column,
                    openEndRow: toPosition(starts, element.openEnd - 1).row,
                    endRow: toPosition(starts, element.end - 1).row,
                    tag: text.slice(element.start, element.openEnd),
                },
            ];
        })
    );
    return { doc, nodes, positions };
}

/**
 * @param {string} text the architecture as shown in the editor
 * @param {string} input the xpath, bare or as an `<xpath>` tag
 * @returns {object[]} the position of every matched element, in document
 *      order (see mapArchitecture); the first one is the node Odoo uses
 */
export function locate(text, input) {
    const expression = prepareExpression(input);
    const { doc, positions } = mapArchitecture(text);
    return selectElements(doc, expression).map((node) => positions.get(node));
}
