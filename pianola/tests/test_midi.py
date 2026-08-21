import os
import unittest

from . import common
from .lib_loader import musicxml

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

#: (MusicXML file, reference MIDI file) pairs. Drop both in tests/fixtures and
#: the regression test picks them up; see the README there.
REGRESSION_PAIRS = [
    ("bwv772.musicxml", "bwv772.mid"),
    ("fur_elise.musicxml", "fur_elise.mid"),
]

#: How far a note may be off the reference, in milliseconds.
TOLERANCE_MS = 10

#: Share of notes that must match for a score to pass.
MIN_MATCH_RATIO = 0.99


class TestMidiCodec(unittest.TestCase):
    def test_round_trip(self):
        log = musicxml.ParseLog()
        compilation = musicxml.compile_musicxml(
            common.score([
                common.measure(1, common.attributes(staves=2) + common.tempo(60)
                               + common.note("C", 4, 8, staff=1)
                               + common.note("E", 4, 8, staff=1)
                               + common.backup(16)
                               + common.note("C", 3, 16, staff=2)),
            ]),
            log=log,
        )
        data = musicxml.midi.write_midi(compilation)
        self.assertEqual(data[:4], b"MThd")
        notes = musicxml.midi.read_midi(data)
        self.assertEqual(
            sorted(notes),
            sorted([(60, 0, 2000), (64, 2000, 2000), (48, 0, 4000)]),
        )

    def test_tempo_change_survives_the_round_trip(self):
        log = musicxml.ParseLog()
        compilation = musicxml.compile_musicxml(
            common.score([
                common.measure(1, common.attributes() + common.tempo(60)
                               + common.note("C", 4, 16)),
                common.measure(2, common.tempo(120) + common.note("D", 4, 16)),
            ]),
            log=log,
        )
        notes = musicxml.midi.read_midi(musicxml.midi.write_midi(compilation))
        self.assertEqual(notes, [(60, 0, 4000), (62, 4000, 2000)])


class TestMidiRegression(unittest.TestCase):
    """Compare the compiled timeline against a MIDI exported by MuseScore.

    This is the test that keeps the compiler honest once OMR lands: any drift
    in tempo handling, ties or repeats shows up here as a match ratio below
    the threshold instead of as a piece that quietly sounds wrong.
    """

    def _compare(self, xml_name, midi_name):
        xml_path = os.path.join(FIXTURES, xml_name)
        midi_path = os.path.join(FIXTURES, midi_name)
        if not (os.path.exists(xml_path) and os.path.exists(midi_path)):
            raise unittest.SkipTest(
                "fixtures %s and %s are not in tests/fixtures yet" % (xml_name, midi_name)
            )

        with open(xml_path, "rb") as handle:
            compilation = musicxml.compile_musicxml(handle.read())
        with open(midi_path, "rb") as handle:
            reference = musicxml.midi.read_midi(handle.read())

        ours = sorted(
            (n.midi, int(round(n.onset_seconds * 1000)),
             int(round(n.duration_seconds * 1000)))
            for n in compilation.notes
        )
        matched, unmatched = _match(ours, sorted(reference))
        ratio = matched / float(len(reference)) if reference else 0.0
        self.assertGreaterEqual(
            ratio,
            MIN_MATCH_RATIO,
            "%s: %d of %d reference notes matched within %d ms (%.2f%%). "
            "First misses: %s"
            % (xml_name, matched, len(reference), TOLERANCE_MS, ratio * 100,
               unmatched[:5]),
        )

    def test_regressions(self):
        skipped = []
        for xml_name, midi_name in REGRESSION_PAIRS:
            with self.subTest(score=xml_name):
                try:
                    self._compare(xml_name, midi_name)
                except unittest.SkipTest as exc:
                    skipped.append(str(exc))
        if len(skipped) == len(REGRESSION_PAIRS):
            raise unittest.SkipTest("no reference fixtures installed")


def _match(ours, reference):
    """Greedy nearest-onset match, tolerant to a few milliseconds of rounding."""
    pool = {}
    for midi, onset, duration in ours:
        pool.setdefault(midi, []).append((onset, duration))
    for entries in pool.values():
        entries.sort()

    matched = 0
    unmatched = []
    for midi, onset, duration in reference:
        candidates = pool.get(midi, [])
        best = None
        for index, (our_onset, our_duration) in enumerate(candidates):
            if abs(our_onset - onset) > TOLERANCE_MS:
                continue
            if abs(our_duration - duration) > TOLERANCE_MS:
                continue
            best = index
            break
        if best is None:
            unmatched.append((midi, onset, duration))
        else:
            candidates.pop(best)
            matched += 1
    return matched, unmatched
