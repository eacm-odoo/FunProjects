import io
import unittest
import zipfile

from . import common
from .lib_loader import musicxml

TPQ = musicxml.TICKS_PER_QUARTER


def compile_score(measures, options=None):
    log = musicxml.ParseLog()
    compilation = musicxml.compile_musicxml(
        common.score(measures), options=options, log=log
    )
    return compilation, log


def onsets(compilation):
    return [(n.midi, n.onset_ticks, n.duration_ticks) for n in compilation.notes]


class TestCompilerBasics(unittest.TestCase):
    def test_two_bars_of_quarters(self):
        compilation, log = compile_score([
            common.measure(1, common.attributes() + common.tempo(60) + "".join(
                common.note(step, 4, 4) for step in "CDEF"
            )),
            common.measure(2, "".join(common.note(step, 4, 4) for step in "GABC")),
        ])
        self.assertEqual(len(compilation.notes), 8)
        self.assertEqual(log.count("WARN"), 0)
        self.assertEqual(
            [n.onset_ticks for n in compilation.notes],
            [TPQ * i for i in range(8)],
        )
        # 60 bpm, so a quarter is exactly one second.
        self.assertAlmostEqual(compilation.notes[4].onset_seconds, 4.0)
        self.assertAlmostEqual(compilation.duration_seconds, 8.0)

    def test_metadata(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes(fifths=-3, mode="minor", beats=3,
                                                beat_type=4) + common.note()),
        ])
        self.assertEqual(compilation.work_title, "Test")
        self.assertEqual(compilation.composer, "Anon")
        self.assertEqual(compilation.key_signature, "C minor")
        self.assertEqual(compilation.time_signature, "3/4")

    def test_key_signature_is_not_applied_twice(self):
        # In G major, MusicXML still writes <alter>1</alter> on the F sharp.
        # Adding the key on top of it would produce a G natural.
        compilation, _log = compile_score([
            common.measure(1, common.attributes(fifths=1)
                           + common.note("F", 4, 4, alter=1)),
        ])
        self.assertEqual(compilation.notes[0].midi, 66)
        self.assertEqual(compilation.notes[0].name, "F#4")

    def test_rests_advance_the_cursor_without_sounding(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.rest(8)
                           + common.note("C", 4, 8)),
        ])
        self.assertEqual(len(compilation.notes), 1)
        self.assertEqual(compilation.notes[0].onset_ticks, TPQ * 2)

    def test_dots_and_tuplets_come_from_duration(self):
        # <duration> already accounts for both; <time-modification> is notation
        # and must not be applied a second time.
        compilation, _log = compile_score([
            common.measure(1, common.attributes(divisions=12)
                           + common.note("C", 4, 18)   # dotted quarter
                           + common.note("D", 4, 6)
                           + common.note("E", 4, 8)    # eighth triplet
                           + common.note("F", 4, 8)
                           + common.note("G", 4, 8)),
        ])
        self.assertEqual(
            [n.duration_ticks for n in compilation.notes],
            [720, 240, 320, 320, 320],
        )

    def test_divisions_may_change_mid_piece(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes(divisions=4) + common.note("C", 4, 16)),
            common.measure(2, common.attributes(divisions=256)
                           + common.note("D", 4, 1024)),
        ])
        self.assertEqual([n.duration_ticks for n in compilation.notes], [TPQ * 4, TPQ * 4])
        self.assertEqual(compilation.notes[1].onset_ticks, TPQ * 4)

    def test_time_signature_change(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes(beats=4) + common.note("C", 4, 16)),
            common.measure(2, common.attributes(beats=3) + common.note("D", 4, 12)),
            common.measure(3, common.note("E", 4, 12)),
        ])
        self.assertEqual(
            [n.onset_ticks for n in compilation.notes],
            [0, TPQ * 4, TPQ * 7],
        )
        self.assertEqual(compilation.time_signature, "3/4")

    def test_pickup_measure_is_not_padded(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.note("G", 3, 4), implicit=True),
            common.measure(2, common.note("C", 4, 16)),
        ])
        self.assertEqual(compilation.notes[1].onset_ticks, TPQ)
        self.assertTrue(compilation.measures[0].is_pickup)


class TestCompilerPolyphony(unittest.TestCase):
    def test_chord_shares_the_onset_and_does_not_advance(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes()
                           + common.note("C", 4, 4)
                           + common.note("E", 4, 4, chord=True)
                           + common.note("G", 4, 4, chord=True)
                           + common.note("D", 4, 4)),
        ])
        self.assertEqual(
            onsets(compilation),
            [(60, 0, TPQ), (64, 0, TPQ), (67, 0, TPQ), (62, TPQ, TPQ)],
        )

    def test_backup_puts_the_left_hand_under_the_right(self):
        compilation, _log = compile_score([
            common.measure(
                1,
                common.attributes(staves=2)
                + "".join(common.note(s, 4, 4, voice=1, staff=1) for s in "CDEF")
                + common.backup(16)
                + common.note("C", 3, 16, voice=5, staff=2),
            ),
        ])
        left = [n for n in compilation.notes if n.hand == "left"]
        self.assertEqual(len(left), 1)
        self.assertEqual(left[0].onset_ticks, 0)
        self.assertEqual(left[0].duration_ticks, TPQ * 4)
        self.assertEqual(len([n for n in compilation.notes if n.hand == "right"]), 4)

    def test_forward_skips_time(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.forward(8)
                           + common.note("C", 4, 8)),
        ])
        self.assertEqual(compilation.notes[0].onset_ticks, TPQ * 2)

    def test_hand_follows_the_staff_element_not_the_pitch(self):
        # A left-hand part written above middle C still belongs to staff 2.
        compilation, _log = compile_score([
            common.measure(1, common.attributes(staves=2)
                           + common.note("C", 5, 16, voice=5, staff=2)),
        ])
        self.assertEqual(compilation.notes[0].hand, "left")

    def test_hand_is_inferred_when_no_staff_is_written(self):
        compilation, log = compile_score([
            common.measure(1, common.attributes()
                           + common.note("C", 5, 8)
                           + common.note("C", 3, 8)),
        ])
        self.assertEqual([n.hand for n in compilation.notes], ["right", "left"])
        self.assertIn("hand-inferred", log.counts)


class TestCompilerTies(unittest.TestCase):
    def test_tie_across_a_bar_line_is_one_event(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.rest(8)
                           + common.note("E", 4, 8, tie="start")),
            common.measure(2, common.note("E", 4, 4, tie="stop") + common.rest(12)),
        ])
        self.assertEqual(len(compilation.notes), 1)
        note = compilation.notes[0]
        self.assertEqual(note.onset_ticks, TPQ * 2)
        self.assertEqual(note.duration_ticks, TPQ * 3)

    def test_chain_of_three_tied_notes(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.note("C", 4, 16, tie="start")),
            common.measure(2, common.note("C", 4, 16, tie="both")),
            common.measure(3, common.note("C", 4, 16, tie="stop")),
        ])
        self.assertEqual(len(compilation.notes), 1)
        self.assertEqual(compilation.notes[0].duration_ticks, TPQ * 12)

    def test_a_slur_does_not_merge_anything(self):
        compilation, _log = compile_score([
            common.measure(
                1,
                common.attributes()
                + common.note("C", 4, 8, notations='<slur type="start" number="1"/>')
                + common.note("D", 4, 8, notations='<slur type="stop" number="1"/>'),
            ),
        ])
        self.assertEqual(len(compilation.notes), 2)
        self.assertEqual([n.duration_ticks for n in compilation.notes], [TPQ * 2, TPQ * 2])

    def test_tie_only_merges_the_same_pitch(self):
        compilation, log = compile_score([
            common.measure(1, common.attributes() + common.note("C", 4, 8, tie="start")
                           + common.note("D", 4, 8, tie="stop")),
        ])
        self.assertEqual(len(compilation.notes), 2)
        self.assertIn("tie-unmatched", log.counts)

    def test_tie_across_a_repeat_boundary(self):
        compilation, _log = compile_score([
            common.measure(
                1,
                common.barline("left", repeat="forward")
                + common.attributes()
                + common.note("C", 4, 16),
            ),
            common.measure(
                2,
                common.note("E", 4, 16, tie="start")
                + common.barline("right", repeat="backward"),
            ),
            common.measure(3, common.note("E", 4, 16, tie="stop")),
        ])
        # First pass: the tied E runs into the repeat and stops there, because
        # what follows is bar 1 again, not the note it was tied to.
        held = [n for n in compilation.notes if n.midi == 64]
        self.assertEqual([n.duration_ticks for n in held], [TPQ * 4, TPQ * 8])


class TestCompilerDynamics(unittest.TestCase):
    def test_dynamic_mark_holds_until_the_next_one(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.dynamic("pp")
                           + common.note("C", 4, 8)
                           + common.note("D", 4, 8)),
            common.measure(2, common.dynamic("ff") + common.note("E", 4, 16)),
        ])
        self.assertEqual([n.velocity for n in compilation.notes], [32, 32, 112])

    def test_hairpin_interpolates_to_the_next_mark(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.dynamic("p")
                           + common.wedge("crescendo")
                           + "".join(common.note(s, 4, 4) for s in "CDEF")),
            common.measure(2, common.wedge("stop") + common.dynamic("f")
                           + common.note("G", 4, 16)),
        ])
        self.assertEqual([n.velocity for n in compilation.notes], [48, 60, 72, 84, 96])

    def test_accent_pushes_the_velocity(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.dynamic("mf")
                           + common.note("C", 4, 8)
                           + common.note("D", 4, 8,
                                         notations="<articulations><accent/></articulations>")),
        ])
        self.assertEqual([n.velocity for n in compilation.notes], [80, 92])

    def test_staccato_shortens_the_sound_but_not_the_beat(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.tempo(60)
                           + common.note("C", 4, 4,
                                         notations="<articulations><staccato/></articulations>")
                           + common.note("D", 4, 4)),
        ])
        first, second = compilation.notes
        self.assertAlmostEqual(first.duration_seconds, 0.5)
        self.assertAlmostEqual(second.onset_seconds, 1.0)


class TestCompilerTempo(unittest.TestCase):
    def test_tempo_change_is_integrated_not_averaged(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.tempo(60)
                           + common.note("C", 4, 16)),
            common.measure(2, common.tempo(120) + common.note("D", 4, 16)),
            common.measure(3, common.note("E", 4, 16)),
        ])
        self.assertAlmostEqual(compilation.notes[0].onset_seconds, 0.0)
        self.assertAlmostEqual(compilation.notes[1].onset_seconds, 4.0)
        self.assertAlmostEqual(compilation.notes[2].onset_seconds, 6.0)
        self.assertEqual(compilation.initial_tempo, 60.0)

    def test_metronome_mark_with_a_dotted_beat_unit(self):
        compilation, _log = compile_score([
            common.measure(
                1,
                common.attributes(beats=6, beat_type=8)
                + common.direction(
                    "<metronome><beat-unit>quarter</beat-unit>"
                    "<beat-unit-dot/><per-minute>40</per-minute></metronome>"
                )
                + common.note("C", 4, 12),
            ),
        ])
        # A dotted quarter is 1.5 quarters, so 40 of them a minute is 60 bpm.
        self.assertAlmostEqual(compilation.initial_tempo, 60.0)

    def test_fermata_holds_the_clock(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.tempo(60)
                           + common.note("C", 4, 16, notations="<fermata/>")),
            common.measure(2, common.note("D", 4, 16)),
        ])
        first, second = compilation.notes
        self.assertAlmostEqual(first.duration_seconds, 6.0)   # 4s written x 1.5
        self.assertAlmostEqual(second.onset_seconds, 6.0)

    def test_fermata_factor_is_configurable(self):
        options = musicxml.CompileOptions(fermata_factor=1.0)
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.tempo(60)
                           + common.note("C", 4, 16, notations="<fermata/>")),
            common.measure(2, common.note("D", 4, 16)),
        ], options=options)
        self.assertAlmostEqual(compilation.notes[1].onset_seconds, 4.0)


class TestCompilerPedal(unittest.TestCase):
    def test_pedal_is_a_track_of_its_own(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes() + common.tempo(60)
                           + common.pedal("start") + common.note("C", 4, 16)),
            common.measure(2, common.note("D", 4, 16) + common.pedal("stop")),
        ])
        self.assertEqual([p.type for p in compilation.pedals], ["start", "stop"])
        self.assertAlmostEqual(compilation.pedals[0].onset_seconds, 0.0)
        self.assertAlmostEqual(compilation.pedals[1].onset_seconds, 8.0)
        self.assertTrue(compilation.notes[0].sustain_pedal)


class TestCompilerUnsupported(unittest.TestCase):
    def test_grace_notes_are_dropped_and_logged(self):
        compilation, log = compile_score([
            common.measure(1, common.attributes()
                           + common.note("B", 3, 0, grace=True)
                           + common.note("C", 4, 16)),
        ])
        self.assertEqual(len(compilation.notes), 1)
        self.assertEqual(compilation.notes[0].midi, 60)
        self.assertEqual(compilation.notes[0].onset_ticks, 0)
        self.assertIn("grace-dropped", log.counts)

    def test_ornaments_are_logged(self):
        _compilation, log = compile_score([
            common.measure(1, common.attributes()
                           + common.note("C", 4, 16,
                                         notations="<ornaments><trill-mark/></ornaments>")),
        ])
        self.assertIn("ornaments-dropped", log.counts)

    def test_unknown_element_is_logged_once_per_kind(self):
        _compilation, log = compile_score([
            common.measure(1, common.attributes() + common.note("C", 4, 8)
                           + "<nonsense/>" + common.note("D", 4, 8) + "<nonsense/>"),
        ])
        self.assertEqual(log.counts.get("unsupported:nonsense"), 2)

    def test_timewise_scores_are_refused_clearly(self):
        with self.assertRaises(musicxml.UnsupportedScore):
            musicxml.compile_musicxml(b"<score-timewise></score-timewise>")

    def test_broken_xml_is_refused_clearly(self):
        with self.assertRaises(musicxml.UnsupportedScore):
            musicxml.compile_musicxml(b"<score-partwise>")


class TestContainer(unittest.TestCase):
    def test_plain_musicxml_passes_through(self):
        raw = common.score([common.measure(1, common.attributes() + common.note())])
        self.assertEqual(musicxml.extract_musicxml(raw), raw)

    def test_compressed_mxl_is_unpacked(self):
        raw = common.score([common.measure(1, common.attributes() + common.note())])
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr(
                "META-INF/container.xml",
                '<container><rootfiles><rootfile full-path="score.xml"/>'
                "</rootfiles></container>",
            )
            archive.writestr("score.xml", raw)
        compilation = musicxml.compile_musicxml(buffer.getvalue())
        self.assertEqual(len(compilation.notes), 1)

    def test_empty_file_is_refused(self):
        with self.assertRaises(musicxml.ContainerError):
            musicxml.extract_musicxml(b"")


class TestPlaybackPayload(unittest.TestCase):
    def test_shape(self):
        compilation, _log = compile_score([
            common.measure(1, common.attributes(staves=2) + common.tempo(60)
                           + common.note("C", 4, 16, staff=1)
                           + common.backup(16)
                           + common.note("C", 3, 16, staff=2)),
        ])
        payload = compilation.to_playback_dict()
        self.assertEqual(payload["version"], 1)
        self.assertEqual(payload["duration"], 4.0)
        self.assertEqual(payload["time_signature"], "4/4")
        self.assertEqual(len(payload["notes"]), 2)
        self.assertEqual(payload["notes"][0], [60, 0, 4000, 80, 0, 0])
        self.assertEqual(payload["notes"][1], [48, 0, 4000, 80, 1, 0])
        self.assertEqual(payload["measures"], [[0, "1", 0]])
