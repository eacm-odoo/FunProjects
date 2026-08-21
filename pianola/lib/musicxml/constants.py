"""Constants shared by the MusicXML compiler.

Nothing here imports Odoo: this package is plain Python on purpose (see
``tools/compile_score.py``).
"""

#: Internal resolution. MusicXML files declare their own ``<divisions>``, which
#: may differ between parts and change mid-piece, so every duration read from
#: the file is renormalised to this many ticks per quarter note.
TICKS_PER_QUARTER = 480

#: Semitone offset of each diatomic step inside its octave.
STEP_SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

#: MIDI range of a standard 88-key piano: A0 up to C8.
PIANO_LOWEST_MIDI = 21
PIANO_HIGHEST_MIDI = 108

MIDI_LOWEST = 0
MIDI_HIGHEST = 127

DEFAULT_TEMPO_BPM = 120.0
DEFAULT_VELOCITY = 80

#: Dynamic marks mapped to MIDI velocity. The value holds until the next mark.
DYNAMIC_VELOCITIES = {
    "pppppp": 8,
    "ppppp": 10,
    "pppp": 12,
    "ppp": 16,
    "pp": 32,
    "p": 48,
    "mp": 64,
    "mf": 80,
    "f": 96,
    "ff": 112,
    "fff": 127,
    "ffff": 127,
    "fffff": 127,
    "ffffff": 127,
    # Accented marks are not levels of their own; they are read as the level
    # they usually sit on, and the accent itself comes from the articulation.
    "fp": 96,
    "fz": 96,
    "sf": 96,
    "sfp": 96,
    "sfpp": 96,
    "sffz": 112,
    "sfz": 112,
    "rf": 96,
    "rfz": 96,
    "n": DEFAULT_VELOCITY,
}

#: How far a hairpin pushes the velocity when no explicit mark closes it.
WEDGE_FALLBACK_STEP = 24

#: Articulations scale the *sounding* duration. The onset of the next event
#: never moves: a staccato quarter still occupies a quarter of the bar.
ARTICULATION_DURATION_FACTORS = {
    "staccatissimo": 0.25,
    "staccato": 0.50,
    "spiccato": 0.40,
    "detached-legato": 0.75,
    "tenuto": 1.0,
    "strong-accent": 0.80,
}

#: Articulations that push the velocity of the attack.
ARTICULATION_VELOCITY_FACTORS = {
    "accent": 1.15,
    "strong-accent": 1.30,
}

#: A fermata holds the note this many times its written length. Editable per
#: score through ``music.score.fermata_factor``.
DEFAULT_FERMATA_FACTOR = 1.5

#: Shortest sounding duration we will emit, in seconds.
MIN_SOUNDING_SECONDS = 0.01

#: Fuse blowing on a runaway unfold (a repeat structure we misread).
MAX_UNFOLDED_MEASURES = 20000

#: ``<beat-unit>`` values expressed in quarter notes.
BEAT_UNIT_QUARTERS = {
    "1024th": 1 / 256,
    "512th": 1 / 128,
    "256th": 1 / 64,
    "128th": 1 / 32,
    "64th": 1 / 16,
    "32nd": 1 / 8,
    "16th": 1 / 4,
    "eighth": 1 / 2,
    "quarter": 1.0,
    "half": 2.0,
    "whole": 4.0,
    "breve": 8.0,
    "long": 16.0,
    "maxima": 32.0,
}

HAND_RIGHT = "right"
HAND_LEFT = "left"
