"""Tiny MusicXML builders.

Only for unit tests: each one is a couple of bars written to exercise exactly
one rule of the compiler. Real repertoire lives in ``tests/fixtures``.
"""

SCORE_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>%(title)s</work-title></work>
  <identification><creator type="composer">%(composer)s</creator></identification>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">%(measures)s</part>
</score-partwise>
"""

ATTRIBUTES_TEMPLATE = """
      <attributes>
        <divisions>%(divisions)d</divisions>
        <key><fifths>%(fifths)d</fifths><mode>%(mode)s</mode></key>
        <time><beats>%(beats)d</beats><beat-type>%(beat_type)d</beat-type></time>
        %(staves)s
      </attributes>"""


def attributes(divisions=4, fifths=0, mode="major", beats=4, beat_type=4, staves=0):
    return ATTRIBUTES_TEMPLATE % {
        "divisions": divisions,
        "fifths": fifths,
        "mode": mode,
        "beats": beats,
        "beat_type": beat_type,
        "staves": "<staves>%d</staves>" % staves if staves else "",
    }


def note(step="C", octave=4, duration=4, alter=None, voice=1, staff=None,
         chord=False, rest=False, grace=False, tie=None, notations="",
         note_type=""):
    parts = []
    if grace:
        parts.append("<grace/>")
    if chord:
        parts.append("<chord/>")
    if rest:
        parts.append("<rest/>")
    else:
        pitch = "<step>%s</step>" % step
        if alter is not None:
            pitch += "<alter>%d</alter>" % alter
        pitch += "<octave>%d</octave>" % octave
        parts.append("<pitch>%s</pitch>" % pitch)
    if not grace:
        parts.append("<duration>%d</duration>" % duration)
    if tie in ("start", "stop"):
        parts.append('<tie type="%s"/>' % tie)
    elif tie == "both":
        parts.append('<tie type="stop"/><tie type="start"/>')
    parts.append("<voice>%d</voice>" % voice)
    if note_type:
        parts.append("<type>%s</type>" % note_type)
    if staff:
        parts.append("<staff>%d</staff>" % staff)
    if notations:
        parts.append("<notations>%s</notations>" % notations)
    return "\n      <note>%s</note>" % "".join(parts)


def rest(duration=4, voice=1, staff=None):
    return note(duration=duration, voice=voice, staff=staff, rest=True)


def backup(duration):
    return "\n      <backup><duration>%d</duration></backup>" % duration


def forward(duration):
    return "\n      <forward><duration>%d</duration></forward>" % duration


def direction(body, staff=None, offset=0, sound=""):
    inner = "<direction-type>%s</direction-type>" % body
    if offset:
        inner += "<offset>%d</offset>" % offset
    if staff:
        inner += "<staff>%d</staff>" % staff
    if sound:
        inner += sound
    return "\n      <direction>%s</direction>" % inner


def dynamic(mark, staff=None):
    return direction("<dynamics><%s/></dynamics>" % mark, staff=staff)


def wedge(kind, staff=None):
    return direction('<wedge type="%s"/>' % kind, staff=staff)


def pedal(kind, staff=None):
    return direction('<pedal type="%s" line="yes"/>' % kind, staff=staff)


def tempo(bpm):
    return '\n      <sound tempo="%s"/>' % bpm


def measure(number, body, implicit=False):
    return '\n    <measure number="%s"%s>%s\n    </measure>' % (
        number,
        ' implicit="yes"' if implicit else "",
        body,
    )


def score(measures, title="Test", composer="Anon"):
    return (
        SCORE_TEMPLATE
        % {"title": title, "composer": composer, "measures": "".join(measures)}
    ).encode("utf-8")


def barline(location="right", repeat=None, times=0, ending="", ending_type=""):
    inner = ""
    if ending and ending_type:
        inner += '<ending number="%s" type="%s"/>' % (ending, ending_type)
    if repeat:
        inner += '<repeat direction="%s"%s/>' % (
            repeat,
            ' times="%d"' % times if times else "",
        )
    return '\n      <barline location="%s">%s</barline>' % (location, inner)


def words(text):
    return direction("<words>%s</words>" % text)


def sound(**attributes):
    rendered = " ".join('%s="%s"' % (k.replace("_", "-"), v) for k, v in attributes.items())
    return "\n      <sound %s/>" % rendered
