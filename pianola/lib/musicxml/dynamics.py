"""Velocity over time, per part and staff.

A dynamic mark holds until the next one. A hairpin does not have a level of
its own: it ramps from where it starts to whatever mark closes it, which is
why the curve can only be evaluated once the whole part has been read.
"""

import bisect

from .constants import DEFAULT_VELOCITY, MIDI_HIGHEST, WEDGE_FALLBACK_STEP


class VelocityCurve:
    def __init__(self, initial=DEFAULT_VELOCITY):
        self.initial = int(initial)
        self._marks = {}        # tick -> velocity
        self._wedges = []       # [start_tick, kind, stop_tick|None]
        self._built = False
        self._mark_ticks = []
        self._mark_values = []
        self._ramps = []        # (t0, t1, v0, v1)
        self._ramp_starts = []

    def add_dynamic(self, ticks, velocity):
        self._marks[max(0, int(ticks))] = _clamp(velocity)
        self._built = False

    def start_wedge(self, ticks, kind):
        self._wedges.append([max(0, int(ticks)), kind, None])
        self._built = False

    def stop_wedge(self, ticks):
        for wedge in reversed(self._wedges):
            if wedge[2] is None:
                wedge[2] = max(0, int(ticks))
                break
        self._built = False

    def value_at(self, ticks):
        self._build()
        ticks = int(ticks)
        index = bisect.bisect_right(self._ramp_starts, ticks) - 1
        while index >= 0:
            t0, t1, v0, v1 = self._ramps[index]
            if t0 <= ticks < t1:
                ratio = (ticks - t0) / float(t1 - t0)
                return _clamp(round(v0 + (v1 - v0) * ratio))
            index -= 1
        return self._step_value(ticks)

    # -- internals ------------------------------------------------------

    def _step_value(self, ticks):
        index = bisect.bisect_right(self._mark_ticks, int(ticks)) - 1
        if index < 0:
            return self.initial
        return self._mark_values[index]

    def _build(self):
        if self._built:
            return
        self._mark_ticks = sorted(self._marks)
        self._mark_values = [self._marks[t] for t in self._mark_ticks]
        self._built = True  # _step_value is used while building the ramps

        ramps = []
        for start, kind, stop in self._wedges:
            if kind not in ("crescendo", "diminuendo"):
                continue
            v0 = self._step_value(start)
            next_index = bisect.bisect_right(self._mark_ticks, start)
            if next_index < len(self._mark_ticks):
                end = self._mark_ticks[next_index]
                v1 = self._mark_values[next_index]
            elif stop is not None and stop > start:
                end = stop
                step = WEDGE_FALLBACK_STEP if kind == "crescendo" else -WEDGE_FALLBACK_STEP
                v1 = _clamp(v0 + step)
            else:
                continue
            if end > start:
                ramps.append((start, end, v0, v1))

        ramps.sort()
        self._ramps = ramps
        self._ramp_starts = [r[0] for r in ramps]


def _clamp(velocity):
    return max(1, min(MIDI_HIGHEST, int(round(float(velocity)))))
