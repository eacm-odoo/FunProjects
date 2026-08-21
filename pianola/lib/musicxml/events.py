"""The output of the compiler: a flat, ordered, Odoo-free timeline."""

from dataclasses import dataclass, field

from .constants import HAND_RIGHT
from .pitch import spelled_name


@dataclass
class NoteEvent:
    """One key press. Tied notes have already been merged into one of these."""

    midi: int
    onset_ticks: int
    duration_ticks: int
    onset_seconds: float = 0.0
    duration_seconds: float = 0.0
    velocity: int = 80
    hand: str = HAND_RIGHT
    part_id: str = ""
    voice: int = 1
    staff: int = 1
    measure_number: str = ""
    measure_index: int = 0
    step: str = "C"
    alter: int = 0
    octave: int = 4
    is_tied_start: bool = False
    is_tied_stop: bool = False
    is_grace: bool = False
    sustain_pedal: bool = False
    articulations: frozenset = frozenset()

    @property
    def end_ticks(self):
        return self.onset_ticks + self.duration_ticks

    @property
    def name(self):
        return spelled_name(self.step, self.alter, self.octave)

    def sort_key(self):
        return (self.onset_ticks, self.part_id, self.staff, self.voice, self.midi)


@dataclass
class PedalEvent:
    """A sustain pedal change, kept on its own track.

    Audio consumes this separately: while the pedal is down a note keeps
    ringing past its written duration, which is not something we can bake into
    the note durations without lying about the score.
    """

    onset_ticks: int
    onset_seconds: float = 0.0
    type: str = "start"  # start | change | stop
    part_id: str = ""
    staff: int = 1


@dataclass
class MeasureMark:
    """Where a played measure starts. Repeats make numbers appear twice."""

    index: int          # position in the unfolded playback order
    number: str         # measure number as printed
    source_index: int   # index in document order
    onset_ticks: int
    onset_seconds: float = 0.0
    time_signature: str = ""
    is_pickup: bool = False


@dataclass
class PartInfo:
    id: str
    name: str = ""
    instrument: str = ""
    staff_count: int = 1
    midi_program: int = 1


@dataclass
class Compilation:
    """Everything the playback layer and the ORM need."""

    notes: list = field(default_factory=list)
    pedals: list = field(default_factory=list)
    measures: list = field(default_factory=list)
    parts: list = field(default_factory=list)
    tempo_map: list = field(default_factory=list)   # [(ticks, bpm)]
    work_title: str = ""
    composer: str = ""
    key_signature: str = ""
    time_signature: str = ""
    initial_tempo: float = 120.0
    duration_seconds: float = 0.0
    ticks_per_quarter: int = 480
    warnings: list = field(default_factory=list)

    def note_count(self):
        return len(self.notes)

    def to_playback_dict(self):
        """Compact form cached in ``music.score.playback_json``.

        Notes go out as arrays rather than objects: a Chopin ballade is well
        past ten thousand of them and the key names would triple the payload
        for nothing.
        """
        hands = {"right": 0, "left": 1}
        return {
            "version": 1,
            "title": self.work_title,
            "composer": self.composer,
            "duration": round(self.duration_seconds, 4),
            "tempo": round(self.initial_tempo, 3),
            "time_signature": self.time_signature,
            "key_signature": self.key_signature,
            "ticks_per_quarter": self.ticks_per_quarter,
            "parts": [
                {"id": p.id, "name": p.name, "instrument": p.instrument}
                for p in self.parts
            ],
            # [midi, onset_ms, duration_ms, velocity, hand, measure_index]
            "notes": [
                [
                    n.midi,
                    int(round(n.onset_seconds * 1000)),
                    int(round(n.duration_seconds * 1000)),
                    n.velocity,
                    hands.get(n.hand, 0),
                    n.measure_index,
                ]
                for n in self.notes
            ],
            # [onset_ms, type]
            "pedals": [
                [int(round(p.onset_seconds * 1000)), p.type] for p in self.pedals
            ],
            # [measure_index, printed_number, onset_ms]
            "measures": [
                [m.index, m.number, int(round(m.onset_seconds * 1000))]
                for m in self.measures
            ],
            "tempo_map": [
                [int(t), round(bpm, 3)] for t, bpm in self.tempo_map
            ],
            "warning_count": len(self.warnings),
        }
