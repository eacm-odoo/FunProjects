from odoo import fields, models


class MusicScorePart(models.Model):
    _name = "music.score.part"
    _description = "Score Part"
    _order = "score_id, id"

    score_id = fields.Many2one(
        "music.score", required=True, ondelete="cascade", index=True
    )
    external_id = fields.Char(
        string="MusicXML Id",
        help="The <part> id the file uses, kept so a recompile can match the "
             "same part again.",
    )
    name = fields.Char(required=True)
    instrument = fields.Char()
    staff_count = fields.Integer(default=1)
    midi_program = fields.Integer(default=1)
    note_ids = fields.One2many("music.note", "part_id", string="Notes")
