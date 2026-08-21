import base64
import os

from odoo import _, fields, models
from odoo.exceptions import UserError

from ..lib import musicxml


class MusicScoreImport(models.TransientModel):
    _name = "music.score.import"
    _description = "Import a Score"

    name = fields.Char(string="Title")
    composer_id = fields.Many2one("res.partner", string="Composer")
    source_type = fields.Selection(
        [
            ("musicxml", "MusicXML"),
            ("midi", "MIDI"),
            ("pdf", "PDF (optical recognition)"),
        ],
        default="musicxml",
        required=True,
    )
    source_file = fields.Binary(string="File", required=True)
    source_filename = fields.Char()
    fermata_factor = fields.Float(
        default=musicxml.compiler.DEFAULT_FERMATA_FACTOR,
        help="How much longer a note under a fermata is held.",
    )

    def action_import(self):
        self.ensure_one()
        if self.source_type != "musicxml":
            raise UserError(
                _("Only MusicXML can be imported for now. MIDI and PDF come "
                  "with the later phases.")
            )

        score = self.env["music.score"].create({
            "name": self.name or self._guess_title(),
            "composer_id": self.composer_id.id,
            "source_type": self.source_type,
            "source_file": self.source_file,
            "source_filename": self.source_filename,
            "fermata_factor": self.fermata_factor,
        })
        score.action_parse()

        return {
            "type": "ir.actions.act_window",
            "name": _("Score"),
            "res_model": "music.score",
            "res_id": score.id,
            "view_mode": "form",
            "target": "current",
        }

    def _guess_title(self):
        """Take the title from the file, falling back to the file name."""
        if self.source_file:
            try:
                raw = musicxml.extract_musicxml(base64.b64decode(self.source_file))
                document = musicxml.document.parse_document(raw, musicxml.ParseLog())
                if document.work_title:
                    return document.work_title
            except Exception:  # noqa: BLE001 - a title is not worth failing over
                pass
        if self.source_filename:
            return os.path.splitext(self.source_filename)[0]
        return _("Untitled Score")
