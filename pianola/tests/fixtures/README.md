# Test fixtures

Empty on purpose: the repository carries no score files. Drop them here and
the regression test in `../test_midi.py` picks them up on its own; without
them it skips.

## What to put here

| MusicXML | Reference MIDI | Why |
|---|---|---|
| `bwv772.musicxml` | `bwv772.mid` | Two independent voices. Catches a left hand landing on the wrong tick. |
| `fur_elise.musicxml` | `fur_elise.mid` | Repeats, dynamics, pedal, a long timeline. Catches drift. |

Both pieces are public domain. Do not add anything still in copyright.

To add another pair, append it to `REGRESSION_PAIRS` in `../test_midi.py`.

## Exporting the reference MIDI from MuseScore

The comparison is `(midi_number, onset_ms, duration_ms)` per note with a ±10 ms
tolerance, and it fails below a 99% match. That only means anything if the
reference is exported from the same score, so:

1. Open the MusicXML in MuseScore — the same file you are dropping here, not a
   `.mscz` you edited afterwards.
2. *File → Export → MIDI*.
3. Turn **Expand repeats** on. The compiler unfolds them, so the reference has
   to as well.
4. Leave swing and any performance styling off.
5. If the score has no tempo mark, set one explicitly in both places rather
   than relying on each program's default.

Ornaments are a known difference: the compiler drops them for now, MuseScore
plays them out. Prefer editions without written-out ornaments, or expect the
match ratio to sit just under the threshold and say so in the test output.

## Checking a fixture by hand

```bash
python3 pianola/tools/compile_score.py pianola/tests/fixtures/bwv772.musicxml
```

prints the note count, the split between hands, the duration and the full
compilation log.
