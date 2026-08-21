import unittest

from .lib_loader import musicxml


class TestPitch(unittest.TestCase):
    """Written pitch to MIDI. Everything else rests on this being right."""

    def test_middle_c(self):
        self.assertEqual(musicxml.pitch_to_midi("C", 0, 4), 60)

    def test_piano_range(self):
        self.assertEqual(musicxml.pitch_to_midi("A", 0, 0), musicxml.PIANO_LOWEST_MIDI)
        self.assertEqual(musicxml.pitch_to_midi("C", 0, 8), musicxml.PIANO_HIGHEST_MIDI)

    def test_every_natural_of_octave_four(self):
        expected = {"C": 60, "D": 62, "E": 64, "F": 65, "G": 67, "A": 69, "B": 71}
        for step, midi in expected.items():
            self.assertEqual(musicxml.pitch_to_midi(step, 0, 4), midi, step)

    def test_single_accidentals(self):
        self.assertEqual(musicxml.pitch_to_midi("F", 1, 4), 66)
        self.assertEqual(musicxml.pitch_to_midi("G", -1, 4), 66)

    def test_double_accidentals(self):
        self.assertEqual(musicxml.pitch_to_midi("F", 2, 4), 67)
        self.assertEqual(musicxml.pitch_to_midi("B", -2, 4), 69)

    def test_accidentals_crossing_the_octave(self):
        # B sharp belongs to octave 3 on paper but sounds as middle C.
        self.assertEqual(musicxml.pitch_to_midi("B", 1, 3), 60)
        self.assertEqual(musicxml.pitch_to_midi("C", -1, 4), 59)

    def test_alter_is_rounded_to_a_semitone(self):
        # Quarter tones exist in MusicXML; a piano has no key for them.
        self.assertEqual(musicxml.pitch_to_midi("C", 0.5, 4), 61)

    def test_enharmonic_spelling_is_kept(self):
        self.assertEqual(musicxml.pitch_to_midi("F", 1, 4), musicxml.pitch_to_midi("G", -1, 4))
        self.assertEqual(musicxml.spelled_name("F", 1, 4), "F#4")
        self.assertEqual(musicxml.spelled_name("G", -1, 4), "Gb4")
        self.assertEqual(musicxml.spelled_name("B", -2, 4), "Bbb4")

    def test_unknown_step_is_rejected(self):
        with self.assertRaises(musicxml.PitchError):
            musicxml.pitch_to_midi("H", 0, 4)

    def test_out_of_midi_range_is_rejected(self):
        with self.assertRaises(musicxml.PitchError):
            musicxml.pitch_to_midi("C", 0, 12)

    def test_midi_to_name(self):
        self.assertEqual(musicxml.midi_to_name(60), "C4")
        self.assertEqual(musicxml.midi_to_name(21), "A0")
        self.assertEqual(musicxml.midi_to_name(66), "F#4")

    def test_black_keys(self):
        self.assertTrue(musicxml.is_black_key(61))
        self.assertFalse(musicxml.is_black_key(60))
        self.assertEqual(
            sum(1 for m in range(21, 109) if musicxml.is_black_key(m)), 36
        )
