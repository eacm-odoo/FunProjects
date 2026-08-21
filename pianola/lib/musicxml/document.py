"""Read the MusicXML tree into something the walker can iterate.

Only structure is resolved here: part metadata and the measure elements in
document order. Interpreting what is inside a measure is the walker's job.
"""

from dataclasses import dataclass, field
from xml.etree import ElementTree


class UnsupportedScore(ValueError):
    pass


@dataclass
class Part:
    id: str
    name: str = ""
    instrument: str = ""
    midi_program: int = 1
    staff_count: int = 1
    measures: list = field(default_factory=list)


@dataclass
class Document:
    parts: list = field(default_factory=list)
    work_title: str = ""
    composer: str = ""
    measure_count: int = 0


def strip_namespaces(root):
    """MusicXML is normally namespace-free, but exporters differ."""
    for element in root.iter():
        if isinstance(element.tag, str) and "}" in element.tag:
            element.tag = element.tag.rsplit("}", 1)[1]
    return root


def parse_document(xml_bytes, log):
    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as exc:
        raise UnsupportedScore("the file is not valid XML: %s" % exc)
    strip_namespaces(root)

    if root.tag == "score-timewise":
        raise UnsupportedScore(
            "score-timewise files are not supported; convert to score-partwise"
        )
    if root.tag != "score-partwise":
        raise UnsupportedScore("root element is <%s>, expected <score-partwise>" % root.tag)

    document = Document(
        work_title=_work_title(root),
        composer=_creator(root, "composer"),
    )

    metadata = _part_list(root)
    for part_element in root.findall("part"):
        part_id = part_element.get("id") or "P%d" % (len(document.parts) + 1)
        info = metadata.get(part_id, {})
        measures = part_element.findall("measure")
        part = Part(
            id=part_id,
            name=info.get("name") or part_id,
            instrument=info.get("instrument") or "",
            midi_program=info.get("midi_program") or 1,
            staff_count=_staff_count(measures),
            measures=measures,
        )
        document.parts.append(part)

    if not document.parts:
        raise UnsupportedScore("the score has no <part> element")

    counts = {len(p.measures) for p in document.parts}
    document.measure_count = max(counts)
    if len(counts) > 1:
        log.warn(
            "measure-count-mismatch",
            "parts do not have the same number of measures (%s); the longest one "
            "drives the structure" % ", ".join(str(c) for c in sorted(counts)),
        )
    return document


def _text(element, path, default=""):
    found = element.find(path)
    if found is None or found.text is None:
        return default
    return found.text.strip()


def _work_title(root):
    title = _text(root, "work/work-title")
    return title or _text(root, "movement-title")


def _creator(root, creator_type):
    for creator in root.findall("identification/creator"):
        if (creator.get("type") or "").lower() == creator_type:
            return (creator.text or "").strip()
    return ""


def _part_list(root):
    metadata = {}
    for score_part in root.findall("part-list/score-part"):
        part_id = score_part.get("id")
        if not part_id:
            continue
        program = _text(score_part, "midi-instrument/midi-program")
        metadata[part_id] = {
            "name": _text(score_part, "part-name"),
            "instrument": _text(score_part, "score-instrument/instrument-name"),
            "midi_program": int(program) if program.isdigit() else 1,
        }
    return metadata


def _staff_count(measures):
    count = 1
    for measure in measures:
        for staves in measure.iter("staves"):
            try:
                count = max(count, int((staves.text or "1").strip()))
            except ValueError:
                continue
    return count
