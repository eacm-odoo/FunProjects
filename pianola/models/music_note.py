from odoo import api, fields, models
from odoo.exceptions import ValidationError

from ..lib import musicxml


class MusicNote(models.Model):
    _name = "music.note"
    _description = "Note Event"
    _order = "onset_ticks, midi_number, id"
    _rec_name = "display_name"

    score_id = fields.Many2one(
        "music.score", required=True, ondelete="cascade", index=True
    )
    part_id = fields.Many2one("music.score.part", ondelete="cascade", index=True)

    measure_number = fields.Integer(index=True)
    voice = fields.Integer(default=1)
    staff = fields.Integer(default=1)
    hand = fields.Selection([("left", "Left"), ("right", "Right")], default="right")

    midi_number = fields.Integer(required=True, help="0 to 127. Middle C is 60.")
    pitch_step = fields.Selection(
        [(step, step) for step in "CDEFGAB"],
        default="C",
        help="How the note is written. Kept next to the MIDI number so F sharp "
             "and G flat still read differently even though they are one key.",
    )
    pitch_alter = fields.Integer(help="Semitones: -2 to 2.")
    pitch_octave = fields.Integer(default=4)

    onset_ticks = fields.Integer(index=True)
    duration_ticks = fields.Integer()
    onset_seconds = fields.Float(digits=(12, 4))
    duration_seconds = fields.Float(digits=(12, 4))

    velocity = fields.Integer(default=80, help="1 to 127.")
    is_tied_start = fields.Boolean()
    is_tied_stop = fields.Boolean()
    is_grace = fields.Boolean()
    sustain_pedal = fields.Boolean(help="The pedal was down when this note was struck.")

    display_name = fields.Char(compute="_compute_display_name")

    _midi_range = models.Constraint(
        "CHECK(midi_number >= 0 AND midi_number <= 127)",
        "A MIDI note number has to be between 0 and 127.",
    )
    _velocity_range = models.Constraint(
        "CHECK(velocity >= 0 AND velocity <= 127)",
        "A velocity has to be between 0 and 127.",
    )
    _duration_positive = models.Constraint(
        "CHECK(duration_ticks >= 0)",
        "A note cannot last a negative amount of time.",
    )

    @api.depends("pitch_step", "pitch_alter", "pitch_octave", "midi_number")
    def _compute_display_name(self):
        for note in self:
            if note.pitch_step:
                note.display_name = musicxml.spelled_name(
                    note.pitch_step, note.pitch_alter, note.pitch_octave
                )
            else:
                note.display_name = musicxml.midi_to_name(note.midi_number)

    @api.constrains("pitch_alter")
    def _check_pitch_alter(self):
        for note in self:
            if not -2 <= note.pitch_alter <= 2:
                raise ValidationError(
                    self.env._("A pitch alteration goes from -2 (double flat) to "
                               "+2 (double sharp).")
                )
