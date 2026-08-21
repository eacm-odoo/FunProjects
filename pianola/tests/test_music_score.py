import base64

import psycopg2

from odoo.exceptions import UserError, ValidationError
from odoo.tests.common import TransactionCase, tagged
from odoo.tools import mute_logger

from . import common

TWO_BARS = common.score([
    common.measure(
        1,
        common.attributes(staves=2)
        + common.tempo(60)
        + common.dynamic("mf", staff=1)
        + common.note("C", 4, 4, staff=1)
        + common.note("G", 4, 4, staff=1, chord=True)
        + common.note("D", 4, 4, staff=1)
        + common.note("E", 4, 8, staff=1, tie="start")
        + common.backup(16)
        + common.note("C", 3, 16, voice=5, staff=2),
    ),
    common.measure(
        2,
        common.note("E", 4, 4, staff=1, tie="stop")
        + common.rest(12, staff=1)
        + common.backup(16)
        + common.note("G", 2, 16, voice=5, staff=2),
    ),
], title="Two Bars", composer="Test")


@tagged("post_install", "-at_install")
class TestMusicScore(TransactionCase):
    """The ORM side: ingest, batch insert, and the cached timeline."""

    def _create_score(self, data=None, **values):
        return self.env["music.score"].create({
            "name": "Two Bars",
            "source_type": "musicxml",
            "source_file": base64.b64encode(data or TWO_BARS),
            "source_filename": "two_bars.musicxml",
            **values,
        })

    def test_a_new_score_starts_in_draft(self):
        score = self._create_score()
        self.assertEqual(score.state, "draft")
        self.assertFalse(score.playback_json)

    def test_compiling_fills_in_notes_parts_and_timeline(self):
        score = self._create_score()
        score.action_parse()

        self.assertEqual(score.state, "ready")
        self.assertEqual(score.part_count, 1)
        # Four right-hand events (the tied E counts once) and two left-hand ones.
        self.assertEqual(score.note_count, 6)
        self.assertEqual(score.key_signature, "C major")
        self.assertEqual(score.time_signature, "4/4")
        self.assertAlmostEqual(score.tempo_bpm, 60.0)
        self.assertAlmostEqual(score.duration_seconds, 8.0, places=3)
        self.assertTrue(score.playback_json)

    def test_hands_come_from_the_staff(self):
        score = self._create_score()
        score.action_parse()
        left = score.note_ids.filtered(lambda note: note.hand == "left")
        self.assertEqual(sorted(left.mapped("midi_number")), [43, 48])

    def test_tied_notes_are_stored_as_one_row(self):
        score = self._create_score()
        score.action_parse()
        held = score.note_ids.filtered(lambda note: note.midi_number == 64)
        self.assertEqual(len(held), 1)
        self.assertAlmostEqual(held.duration_seconds, 3.0, places=3)

    def test_playback_payload_matches_the_rows(self):
        score = self._create_score()
        score.action_parse()
        payload = score.get_playback_data()
        self.assertEqual(len(payload["notes"]), score.note_count)
        self.assertEqual(payload["time_signature"], "4/4")
        self.assertEqual(payload["duration"], 8.0)

    def test_recompiling_does_not_duplicate_anything(self):
        score = self._create_score()
        score.action_parse()
        before = score.note_count
        score.action_recompile()
        self.assertEqual(score.note_count, before)
        self.assertEqual(len(score.part_ids), 1)

    def test_reset_to_draft_clears_the_compiled_data(self):
        score = self._create_score()
        score.action_parse()
        score.action_reset_to_draft()
        self.assertEqual(score.state, "draft")
        self.assertEqual(score.note_count, 0)
        self.assertFalse(score.playback_json)

    def test_a_broken_file_lands_in_error_instead_of_raising(self):
        score = self._create_score(data=b"this is not a score")
        score.action_parse()
        self.assertEqual(score.state, "error")
        self.assertTrue(score.parse_log)
        self.assertEqual(score.note_count, 0)

    def test_a_score_without_a_file_cannot_be_compiled(self):
        score = self.env["music.score"].create({"name": "Empty"})
        score.action_parse()
        self.assertEqual(score.state, "error")

    def test_unsupported_source_types_say_so(self):
        score = self._create_score(source_type="pdf")
        score.action_parse()
        self.assertEqual(score.state, "error")
        self.assertIn("MusicXML", score.parse_log)

    @mute_logger("odoo.sql_db")
    def test_midi_number_is_constrained(self):
        score = self._create_score()
        score.action_parse()
        note = score.note_ids[0]
        with self.assertRaises(psycopg2.IntegrityError), self.cr.savepoint():
            note.midi_number = 200
            note.flush_recordset()

    def test_pitch_alteration_is_constrained(self):
        score = self._create_score()
        score.action_parse()
        with self.assertRaises(ValidationError):
            score.note_ids[0].write({"pitch_alter": 3})

    def test_note_display_name_keeps_the_written_spelling(self):
        score = self._create_score()
        score.action_parse()
        note = score.note_ids.filtered(lambda n: n.midi_number == 60)[0]
        self.assertEqual(note.display_name, "C4")

    def test_deleting_a_score_takes_its_notes_with_it(self):
        score = self._create_score()
        score.action_parse()
        note_ids = score.note_ids.ids
        score.unlink()
        self.assertFalse(self.env["music.note"].search([("id", "in", note_ids)]))


@tagged("post_install", "-at_install")
class TestMusicScoreImport(TransactionCase):
    def test_wizard_creates_and_compiles(self):
        wizard = self.env["music.score.import"].create({
            "source_type": "musicxml",
            "source_file": base64.b64encode(TWO_BARS),
            "source_filename": "two_bars.musicxml",
        })
        action = wizard.action_import()
        score = self.env["music.score"].browse(action["res_id"])
        self.assertEqual(score.state, "ready")
        # The title was taken from <work-title> rather than the file name.
        self.assertEqual(score.name, "Two Bars")

    def test_wizard_refuses_the_sources_that_are_not_ready(self):
        wizard = self.env["music.score.import"].create({
            "source_type": "pdf",
            "source_file": base64.b64encode(b"%PDF-1.4"),
            "source_filename": "score.pdf",
        })
        with self.assertRaises(UserError):
            wizard.action_import()
