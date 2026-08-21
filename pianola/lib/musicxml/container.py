"""Get the MusicXML bytes out of whatever the user uploaded.

A ``.mxl`` is a zip whose ``META-INF/container.xml`` points at the real score;
a ``.musicxml`` or ``.xml`` is already the score.
"""

import io
import zipfile
from xml.etree import ElementTree

_ZIP_MAGIC = b"PK\x03\x04"


class ContainerError(ValueError):
    pass


def is_compressed(data):
    return data[:4] == _ZIP_MAGIC


def extract_musicxml(data):
    """Return the uncompressed MusicXML bytes of ``data``."""
    if not data:
        raise ContainerError("empty file")
    if not is_compressed(data):
        return data
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ContainerError("not a readable .mxl archive: %s" % exc)
    with archive:
        names = archive.namelist()
        for candidate in _rootfile_paths(archive):
            if candidate in names:
                return archive.read(candidate)
        # No usable container.xml: fall back to the first score-looking entry.
        for name in names:
            if name.startswith("META-INF/") or name.endswith("/"):
                continue
            if name.lower().endswith((".musicxml", ".xml")):
                return archive.read(name)
    raise ContainerError("no MusicXML entry found inside the .mxl archive")


def _rootfile_paths(archive):
    try:
        container = archive.read("META-INF/container.xml")
    except KeyError:
        return []
    try:
        root = ElementTree.fromstring(container)
    except ElementTree.ParseError:
        return []
    paths = []
    for rootfile in root.iter("rootfile"):
        path = rootfile.get("full-path")
        if path:
            paths.append(path)
    return paths
