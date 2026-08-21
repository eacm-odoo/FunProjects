import unittest
from xml.etree import ElementTree

from . import common
from .lib_loader import musicxml


def measures_of(xml_bytes):
    root = ElementTree.fromstring(xml_bytes)
    return root.find("part").findall("measure")


def order_of(measures_xml):
    log = musicxml.ParseLog()
    measures = measures_of(common.score(measures_xml))
    return musicxml.unfold.unfold(measures, log), log


class TestUnfold(unittest.TestCase):
    """Repeats become playback order before anything else looks at the score."""

    def test_no_repeats_is_document_order(self):
        order, _log = order_of([
            common.measure(1, common.attributes() + common.note()),
            common.measure(2, common.note()),
            common.measure(3, common.note()),
        ])
        self.assertEqual(order, [0, 1, 2])

    def test_plain_repeat(self):
        order, _log = order_of([
            common.measure(
                1,
                common.barline("left", repeat="forward")
                + common.attributes()
                + common.note(),
            ),
            common.measure(2, common.note() + common.barline("right", repeat="backward")),
            common.measure(3, common.note()),
        ])
        self.assertEqual(order, [0, 1, 0, 1, 2])

    def test_repeat_without_an_opening_barline_goes_back_to_the_start(self):
        order, _log = order_of([
            common.measure(1, common.attributes() + common.note()),
            common.measure(2, common.note() + common.barline("right", repeat="backward")),
        ])
        self.assertEqual(order, [0, 1, 0, 1])

    def test_repeat_played_three_times(self):
        order, _log = order_of([
            common.measure(
                1,
                common.barline("left", repeat="forward")
                + common.attributes()
                + common.note(),
            ),
            common.measure(
                2, common.note() + common.barline("right", repeat="backward", times=3)
            ),
        ])
        self.assertEqual(order, [0, 1, 0, 1, 0, 1])

    def test_first_and_second_endings(self):
        order, _log = order_of([
            common.measure(
                1,
                common.barline("left", repeat="forward")
                + common.attributes()
                + common.note(),
            ),
            common.measure(
                2,
                common.barline("left", ending="1", ending_type="start")
                + common.note()
                + common.barline(
                    "right", repeat="backward", ending="1", ending_type="stop"
                ),
            ),
            common.measure(
                3,
                common.barline("left", ending="2", ending_type="start")
                + common.note()
                + common.barline("right", ending="2", ending_type="discontinue"),
            ),
            common.measure(4, common.note()),
        ])
        # Bar 2 is the first-time bar, bar 3 the second-time bar.
        self.assertEqual(order, [0, 1, 0, 2, 3])

    def test_three_endings(self):
        # The first-time bar covers passes 1 and 2, the last one covers pass 3.
        order, _log = order_of([
            common.measure(
                1,
                common.barline("left", repeat="forward")
                + common.attributes()
                + common.note(),
            ),
            common.measure(
                2,
                common.barline("left", ending="1,2", ending_type="start")
                + common.note()
                + common.barline(
                    "right", repeat="backward", times=3, ending="1,2", ending_type="stop"
                ),
            ),
            common.measure(
                3,
                common.barline("left", ending="3", ending_type="start")
                + common.note()
                + common.barline("right", ending="3", ending_type="discontinue"),
            ),
        ])
        self.assertEqual(order, [0, 1, 0, 1, 0, 2])

    def test_da_capo_al_fine(self):
        order, _log = order_of([
            common.measure(1, common.attributes() + common.note()),
            common.measure(2, common.note() + common.sound(fine="yes")),
            common.measure(3, common.note()),
            common.measure(4, common.note() + common.sound(dacapo="yes")),
        ])
        self.assertEqual(order, [0, 1, 2, 3, 0, 1])

    def test_dal_segno_al_coda(self):
        order, _log = order_of([
            common.measure(1, common.attributes() + common.note()),
            common.measure(2, common.note() + common.sound(segno="segno")),
            common.measure(3, common.note() + common.sound(tocoda="coda")),
            common.measure(4, common.note() + common.sound(dalsegno="segno")),
            common.measure(5, common.note() + common.sound(coda="coda")),
        ])
        # Straight through, back to the segno at bar 2, then out to the coda.
        self.assertEqual(order, [0, 1, 2, 3, 1, 2, 4])

    def test_da_capo_written_as_words(self):
        order, _log = order_of([
            common.measure(1, common.attributes() + common.note()),
            common.measure(2, common.note() + common.words("Fine")),
            common.measure(3, common.note() + common.words("D.C. al Fine")),
        ])
        self.assertEqual(order, [0, 1, 2, 0, 1])

    def test_repeats_are_not_taken_again_after_a_da_capo(self):
        order, log = order_of([
            common.measure(
                1,
                common.barline("left", repeat="forward")
                + common.attributes()
                + common.note(),
            ),
            common.measure(2, common.note() + common.barline("right", repeat="backward")),
            common.measure(3, common.note() + common.sound(dacapo="yes")),
        ])
        self.assertEqual(order, [0, 1, 0, 1, 2, 0, 1, 2])
        self.assertIn("jump-dacapo", log.counts)
