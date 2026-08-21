"""Ticks to seconds.

A score is not one tempo. Converting with a single BPM is the difference
between a piece that stays in step for two minutes and one that drifts, so the
conversion integrates the tempo map segment by segment.
"""

import bisect

from .constants import DEFAULT_TEMPO_BPM, TICKS_PER_QUARTER


class TimeMap:
    def __init__(self, ticks_per_quarter=TICKS_PER_QUARTER, initial_bpm=DEFAULT_TEMPO_BPM):
        self.tpq = ticks_per_quarter
        self._tempos = {0: float(initial_bpm)}
        # Extra wall-clock time inserted at a tick, used by fermatas. Kept
        # apart from the tempo map because a hold is not a tempo change: it
        # stretches one moment without touching what comes after.
        self._pauses = {}
        self._dirty = True
        self._ticks = []
        self._bpms = []
        self._offsets = []

    # -- building -------------------------------------------------------

    def add_tempo(self, ticks, bpm):
        bpm = float(bpm)
        if bpm <= 0:
            return
        self._tempos[max(0, int(ticks))] = bpm
        self._dirty = True

    def add_pause(self, ticks, seconds):
        if seconds <= 0:
            return
        ticks = max(0, int(ticks))
        self._pauses[ticks] = self._pauses.get(ticks, 0.0) + float(seconds)
        self._dirty = True

    # -- querying -------------------------------------------------------

    def tempo_at(self, ticks):
        self._build()
        index = bisect.bisect_right(self._ticks, int(ticks)) - 1
        return self._bpms[max(0, index)]

    def seconds_at(self, ticks):
        """Absolute time of a tick, pauses at or before it included."""
        self._build()
        ticks = max(0, int(ticks))
        index = bisect.bisect_right(self._ticks, ticks) - 1
        index = max(0, index)
        elapsed = self._offsets[index] + self._span(
            self._ticks[index], ticks, self._bpms[index]
        )
        return elapsed + self._pause_before(ticks)

    def span_seconds(self, start_ticks, end_ticks):
        """Sounding length between two ticks, holds included."""
        return self.seconds_at(end_ticks) - self.seconds_at(start_ticks)

    def as_list(self):
        self._build()
        return list(zip(self._ticks, self._bpms))

    # -- internals ------------------------------------------------------

    def _span(self, from_ticks, to_ticks, bpm):
        return (to_ticks - from_ticks) / float(self.tpq) * (60.0 / bpm)

    def _pause_before(self, ticks):
        if not self._pauses:
            return 0.0
        return sum(value for at, value in self._pauses.items() if at <= ticks)

    def _build(self):
        if not self._dirty:
            return
        self._ticks = sorted(self._tempos)
        self._bpms = [self._tempos[t] for t in self._ticks]
        self._offsets = [0.0]
        for i in range(1, len(self._ticks)):
            self._offsets.append(
                self._offsets[i - 1]
                + self._span(self._ticks[i - 1], self._ticks[i], self._bpms[i - 1])
            )
        self._dirty = False
