"""Written pitch to MIDI number.

MusicXML hands over ``<alter>`` with the key signature and any accidental
already resolved, so the key signature must *not* be applied a second time
here -- doing that is the classic way to end up a semitone off.
"""

import math

from .constants import MIDI_HIGHEST, MIDI_LOWEST, STEP_SEMITONES

#: Preferred spelling of each pitch class, used only to name a MIDI number when
#: no written spelling is available.
_SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

_ALTER_SUFFIX = {-2: "bb", -1: "b", 0: "", 1: "#", 2: "##"}


def round_half_up(value):
    """Round half away from zero.

    ``round()`` rounds halves to even, which would send a quarter-sharp C down
    and a quarter-sharp D up. A piano needs one rule, not two.
    """
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 0
    return int(math.floor(value + 0.5)) if value >= 0 else int(math.ceil(value - 0.5))


class PitchError(ValueError):
    """Raised when a ``<pitch>`` element cannot be turned into a MIDI number."""


def pitch_to_midi(step, alter=0, octave=4):
    """Return the MIDI number of a written pitch.

    ``alter`` is in semitones and may be fractional in MusicXML (quarter
    tones); it is rounded to the nearest semitone because a piano has no key
    for anything in between.
    """
    try:
        semitone = STEP_SEMITONES[step.strip().upper()]
    except (AttributeError, KeyError):
        raise PitchError("unknown pitch step %r" % (step,))
    try:
        octave = int(octave)
    except (TypeError, ValueError):
        raise PitchError("unknown octave %r" % (octave,))
    midi = (octave + 1) * 12 + semitone + round_half_up(alter or 0)
    if not MIDI_LOWEST <= midi <= MIDI_HIGHEST:
        raise PitchError(
            "pitch %s%s%s is outside the MIDI range (%d)"
            % (step, _ALTER_SUFFIX.get(round_half_up(alter or 0), ""), octave, midi)
        )
    return midi


def spelled_name(step, alter=0, octave=4):
    """Name a pitch the way it is written, keeping enharmonic spelling.

    F sharp and G flat press the same key but are not the same note on paper,
    and the interface shows what the composer wrote.
    """
    alter = round_half_up(alter or 0)
    suffix = _ALTER_SUFFIX.get(alter)
    if suffix is None:
        suffix = ("+" if alter > 0 else "-") * abs(alter)
    return "%s%s%s" % (step.strip().upper(), suffix, octave)


def midi_to_name(midi):
    """Name a MIDI number with sharp spelling, for display only."""
    midi = int(midi)
    return "%s%d" % (_SHARP_NAMES[midi % 12], midi // 12 - 1)


def is_black_key(midi):
    return (int(midi) % 12) in (1, 3, 6, 8, 10)
