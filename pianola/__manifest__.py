{
    "name": "Pianola",
    "summary": "Import sheet music, compile it to a note timeline and play it on an 88-key piano",
    "description": """
Pianola
=======

Turns a score into a playable timeline and shows it on an 88-key keyboard.

The module is built in three layers that can be tested in isolation:

* **Ingest** -- brings a score in as MusicXML (``.musicxml``, ``.xml`` or a
  zipped ``.mxl``). Other sources (MIDI, PDF through OMR) plug in behind the
  same contract.
* **Compile** -- ``lib/musicxml`` is plain Python with no Odoo import: it reads
  MusicXML and returns a flat, ordered list of note events with absolute times
  in seconds. Repeats are unfolded, ties merged, tempo changes integrated
  piecewise. It runs from a bare shell with ``tools/compile_score.py``.
* **Playback** -- OWL 2 client action driving the Web Audio API (next phase).

The compiled timeline is cached on the score as ``playback_json`` and the
runtime reads only that; the ``music.note`` rows exist so OMR mistakes can be
fixed by hand in the backend.
""",
    "version": "19.0.1.0.0",
    "category": "Tools",
    "license": "LGPL-3",
    "author": "Odoo Development Services",
    "website": "https://www.odoo.com",
    "depends": ["base", "web"],
    "data": [
        "security/pianola_groups.xml",
        "security/ir.model.access.csv",
        "views/music_score_views.xml",
        "views/music_score_part_views.xml",
        "views/music_note_views.xml",
        "wizard/music_score_import_views.xml",
        "views/pianola_menus.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "pianola/static/src/scss/pianola.scss",
        ],
    },
    "application": True,
    "installable": True,
}
