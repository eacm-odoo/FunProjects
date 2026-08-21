import unittest

from .lib_loader import musicxml

TPQ = musicxml.TICKS_PER_QUARTER
TimeMap = musicxml.timemap.TimeMap


class TestTimeMap(unittest.TestCase):
    """Ticks to seconds. A single BPM would drift; this integrates by segment."""

    def test_constant_tempo(self):
        time_map = TimeMap(TPQ, 60.0)
        self.assertAlmostEqual(time_map.seconds_at(TPQ), 1.0)
        self.assertAlmostEqual(time_map.seconds_at(TPQ * 8), 8.0)

    def test_tempo_change_midway(self):
        time_map = TimeMap(TPQ, 60.0)
        time_map.add_tempo(TPQ * 4, 120.0)
        # Four quarters at 60, then four at 120.
        self.assertAlmostEqual(time_map.seconds_at(TPQ * 4), 4.0)
        self.assertAlmostEqual(time_map.seconds_at(TPQ * 8), 6.0)

    def test_three_tempo_sections(self):
        time_map = TimeMap(TPQ, 120.0)
        time_map.add_tempo(TPQ * 4, 60.0)
        time_map.add_tempo(TPQ * 8, 240.0)
        self.assertAlmostEqual(time_map.seconds_at(TPQ * 4), 2.0)
        self.assertAlmostEqual(time_map.seconds_at(TPQ * 8), 6.0)
        self.assertAlmostEqual(time_map.seconds_at(TPQ * 12), 7.0)

    def test_tempo_at(self):
        time_map = TimeMap(TPQ, 90.0)
        time_map.add_tempo(TPQ * 4, 144.0)
        self.assertEqual(time_map.tempo_at(0), 90.0)
        self.assertEqual(time_map.tempo_at(TPQ * 3), 90.0)
        self.assertEqual(time_map.tempo_at(TPQ * 4), 144.0)

    def test_later_tempo_does_not_move_earlier_notes(self):
        time_map = TimeMap(TPQ, 60.0)
        before = time_map.seconds_at(TPQ * 2)
        time_map.add_tempo(TPQ * 4, 30.0)
        self.assertAlmostEqual(time_map.seconds_at(TPQ * 2), before)

    def test_pause_shifts_everything_after_it(self):
        time_map = TimeMap(TPQ, 60.0)
        time_map.add_pause(TPQ * 2, 1.5)
        self.assertAlmostEqual(time_map.seconds_at(TPQ), 1.0)
        self.assertAlmostEqual(time_map.seconds_at(TPQ * 2), 3.5)
        self.assertAlmostEqual(time_map.seconds_at(TPQ * 4), 5.5)

    def test_span_seconds(self):
        time_map = TimeMap(TPQ, 60.0)
        time_map.add_tempo(TPQ * 2, 120.0)
        self.assertAlmostEqual(time_map.span_seconds(TPQ, TPQ * 4), 2.0)

    def test_zero_and_negative_tempo_are_ignored(self):
        time_map = TimeMap(TPQ, 60.0)
        time_map.add_tempo(TPQ, 0)
        time_map.add_tempo(TPQ * 2, -30)
        self.assertAlmostEqual(time_map.seconds_at(TPQ * 4), 4.0)
