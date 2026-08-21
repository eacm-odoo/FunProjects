"""MusicXML in, playable timeline out.

This module is the whole of layer 2. It imports nothing from Odoo and can be
driven from a bare shell (``tools/compile_score.py``), which is what keeps it
testable without a database.

The pass order matters:

1. unfold the repeats, so everything after this works on one linear timeline;
2. walk every part measure by measure, collecting notes, pedal, tempo marks
   and dynamics in ticks;
3. build the tempo map and integrate it to get seconds;
4. merge tied notes, then apply articulation and fermatas, which change how
   long a note *sounds* without moving anything that follows.
"""

from dataclasses import dataclass, field

from .constants import (
    ARTICULATION_DURATION_FACTORS,
    ARTICULATION_VELOCITY_FACTORS,
    DEFAULT_FERMATA_FACTOR,
    DEFAULT_TEMPO_BPM,
    DEFAULT_VELOCITY,
    BEAT_UNIT_QUARTERS,
    DYNAMIC_VELOCITIES,
    HAND_LEFT,
    HAND_RIGHT,
    MIDI_HIGHEST,
    MIN_SOUNDING_SECONDS,
    TICKS_PER_QUARTER,
)
from .container import extract_musicxml
from .document import UnsupportedScore, parse_document
from .dynamics import VelocityCurve
from .events import Compilation, MeasureMark, NoteEvent, PartInfo, PedalEvent
from .parse_log import ParseLog
from .pitch import PitchError, pitch_to_midi, round_half_up
from .timemap import TimeMap
from .unfold import unfold

#: Measure children we knowingly skip: they carry no sound.
_SILENT_ELEMENTS = frozenset({
    "print", "barline", "harmony", "figured-bass", "grouping", "link",
    "bookmark", "listening",
})

_KEY_NAMES_MAJOR = {
    -7: "Cb", -6: "Gb", -5: "Db", -4: "Ab", -3: "Eb", -2: "Bb", -1: "F",
    0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#",
}
_KEY_NAMES_MINOR = {
    -7: "Ab", -6: "Eb", -5: "Bb", -4: "F", -3: "C", -2: "G", -1: "D",
    0: "A", 1: "E", 2: "B", 3: "F#", 4: "C#", 5: "G#", 6: "D#", 7: "A#",
}


@dataclass
class CompileOptions:
    fermata_factor: float = DEFAULT_FERMATA_FACTOR
    default_velocity: int = DEFAULT_VELOCITY
    tempo_override: float = 0.0   # 0 means "use what the file says"
    unfold_repeats: bool = True


@dataclass
class _RawNote:
    midi: int
    onset_ticks: int
    duration_ticks: int
    part_id: str
    part_index: int
    voice: int
    staff: int
    hand: str
    measure_number: str
    measure_index: int
    step: str
    alter: int
    octave: int
    tie_start: bool = False
    tie_stop: bool = False
    fermata: bool = False
    articulations: frozenset = frozenset()


@dataclass
class _PartState:
    divisions: int = 1
    beats: int = 4
    beat_type: int = 4
    fifths: int = 0
    mode: str = "major"
    transpose_semitones: int = 0
    staff_count: int = 1
    curves: dict = field(default_factory=dict)

    def curve(self, staff, initial):
        if staff not in self.curves:
            self.curves[staff] = VelocityCurve(initial)
        return self.curves[staff]

    def measure_ticks(self):
        if self.beat_type <= 0:
            return 4 * TICKS_PER_QUARTER
        return int(round(self.beats * (4.0 / self.beat_type) * TICKS_PER_QUARTER))


def compile_musicxml(data, options=None, log=None):
    """Compile MusicXML bytes into a :class:`Compilation`."""
    # An empty ParseLog is falsy, so these have to be identity checks or a
    # caller-supplied log gets silently replaced and every warning is lost.
    options = CompileOptions() if options is None else options
    log = ParseLog() if log is None else log

    document = parse_document(extract_musicxml(data), log)
    structure_part = max(document.parts, key=lambda p: len(p.measures))

    if options.unfold_repeats:
        order = unfold(structure_part.measures, log)
    else:
        order = list(range(len(structure_part.measures)))
    if not order:
        raise UnsupportedScore("the score has no measures")

    states = {part.id: _PartState(staff_count=part.staff_count) for part in document.parts}
    raw_notes = []
    pedals = []
    tempo_marks = []          # [(ticks, bpm)]
    measures = []
    inferred_hand_parts = set()

    global_tick = 0
    for position, source_index in enumerate(order):
        advances = []
        for part in document.parts:
            if source_index >= len(part.measures):
                continue
            advances.append(
                _walk_measure(
                    part=part,
                    measure=part.measures[source_index],
                    measure_index=position,
                    source_index=source_index,
                    measure_start=global_tick,
                    state=states[part.id],
                    options=options,
                    log=log,
                    raw_notes=raw_notes,
                    pedals=pedals,
                    tempo_marks=tempo_marks,
                    inferred_hand_parts=inferred_hand_parts,
                )
            )

        reference = states[structure_part.id]
        # A pickup bar is shorter than the time signature says, so the written
        # length is only a fallback for measures nobody wrote anything in.
        length = max(advances) if advances else 0
        if length <= 0:
            length = reference.measure_ticks()

        measures.append(
            MeasureMark(
                index=position,
                number=structure_part.measures[source_index].get("number")
                or str(source_index + 1),
                source_index=source_index,
                onset_ticks=global_tick,
                time_signature="%d/%d" % (reference.beats, reference.beat_type),
                is_pickup=(
                    position == 0 and length < reference.measure_ticks()
                ),
            )
        )
        global_tick += length

    total_ticks = global_tick

    # -- time -----------------------------------------------------------
    initial_tempo = options.tempo_override or _initial_tempo(tempo_marks)
    time_map = TimeMap(TICKS_PER_QUARTER, initial_tempo)
    if not options.tempo_override:
        for ticks, bpm in tempo_marks:
            time_map.add_tempo(ticks, bpm)

    # -- notes ----------------------------------------------------------
    merged = _merge_ties(raw_notes, log)
    _register_fermatas(merged, time_map, options, log)

    notes = []
    for raw in merged:
        state = states[raw.part_id]
        velocity = state.curve(raw.staff, options.default_velocity).value_at(raw.onset_ticks)
        velocity = _apply_articulation_velocity(velocity, raw.articulations)

        onset_seconds = time_map.seconds_at(raw.onset_ticks)
        written_seconds = time_map.span_seconds(
            raw.onset_ticks, raw.onset_ticks + raw.duration_ticks
        )
        factor = _articulation_duration_factor(raw.articulations)
        sounding = max(MIN_SOUNDING_SECONDS, written_seconds * factor)

        notes.append(
            NoteEvent(
                midi=raw.midi,
                onset_ticks=raw.onset_ticks,
                duration_ticks=raw.duration_ticks,
                onset_seconds=onset_seconds,
                duration_seconds=sounding,
                velocity=velocity,
                hand=raw.hand,
                part_id=raw.part_id,
                voice=raw.voice,
                staff=raw.staff,
                measure_number=raw.measure_number,
                measure_index=raw.measure_index,
                step=raw.step,
                alter=raw.alter,
                octave=raw.octave,
                is_tied_start=raw.tie_start,
                is_tied_stop=raw.tie_stop,
                articulations=raw.articulations,
            )
        )
    notes.sort(key=NoteEvent.sort_key)

    for pedal in pedals:
        pedal.onset_seconds = time_map.seconds_at(pedal.onset_ticks)
    pedals.sort(key=lambda p: (p.onset_ticks, p.part_id, p.staff))
    _mark_pedalled_notes(notes, pedals)

    for measure in measures:
        measure.onset_seconds = time_map.seconds_at(measure.onset_ticks)

    for part_id in sorted(inferred_hand_parts):
        log.info(
            "hand-inferred",
            "part %s has a single staff, so hands were split at middle C "
            "instead of read from <staff>" % part_id,
        )

    reference = states[structure_part.id]
    duration = max(
        [time_map.seconds_at(total_ticks)]
        + [n.onset_seconds + n.duration_seconds for n in notes]
    )

    return Compilation(
        notes=notes,
        pedals=pedals,
        measures=measures,
        parts=[
            PartInfo(
                id=part.id,
                name=part.name,
                instrument=part.instrument,
                staff_count=states[part.id].staff_count,
                midi_program=part.midi_program,
            )
            for part in document.parts
        ],
        tempo_map=time_map.as_list(),
        work_title=document.work_title,
        composer=document.composer,
        key_signature=_key_name(reference.fifths, reference.mode),
        time_signature="%d/%d" % (reference.beats, reference.beat_type),
        initial_tempo=initial_tempo,
        duration_seconds=duration,
        ticks_per_quarter=TICKS_PER_QUARTER,
        warnings=log.lines(),
    )


# ---------------------------------------------------------------------------
# measure walk
# ---------------------------------------------------------------------------


def _walk_measure(part, measure, measure_index, source_index, measure_start,
                  state, options, log, raw_notes, pedals, tempo_marks,
                  inferred_hand_parts):
    """Play one measure of one part. Returns how many ticks it took up."""
    number = measure.get("number") or str(source_index + 1)
    cursor = 0
    furthest = 0
    chord_onset = 0

    for child in measure:
        tag = child.tag

        if tag == "attributes":
            _read_attributes(child, state, log)

        elif tag == "note":
            cursor, chord_onset = _read_note(
                child, part, state, options, log, measure_start, cursor,
                chord_onset, measure_index, number, raw_notes,
                inferred_hand_parts,
            )

        elif tag == "backup":
            # Without this the left hand lands after the right hand instead of
            # under it, and the whole part is out of joint.
            cursor -= _ticks(child.findtext("duration"), state.divisions)
            if cursor < 0:
                log.warn(
                    "backup-underflow",
                    "measure %s of part %s backs up past its own start" % (number, part.id),
                )
                cursor = 0

        elif tag == "forward":
            cursor += _ticks(child.findtext("duration"), state.divisions)

        elif tag == "direction":
            _read_direction(
                child, part, state, options, log, measure_start, cursor,
                pedals, tempo_marks,
            )

        elif tag == "sound":
            _read_sound(child, state, options, measure_start + cursor, tempo_marks)

        elif tag not in _SILENT_ELEMENTS:
            log.unsupported(tag, "inside <measure>")

        furthest = max(furthest, cursor)

    return furthest


def _read_note(note, part, state, options, log, measure_start, cursor,
               chord_onset, measure_index, number, raw_notes,
               inferred_hand_parts):
    is_chord = note.find("chord") is not None
    is_rest = note.find("rest") is not None
    duration = _ticks(note.findtext("duration"), state.divisions)

    if note.find("grace") is not None:
        # Phase 2. A grace note has no <duration> of its own: treating it as a
        # zero-length note would put a click in the timeline, so it is dropped
        # outright and logged.
        log.warn(
            "grace-dropped",
            "grace notes are not implemented yet and were left out "
            "(first seen in measure %s of part %s)" % (number, part.id),
        )
        return cursor, chord_onset

    if note.find("unpitched") is not None:
        log.unsupported("unpitched", "percussion is not playable on a piano")
        if not is_chord:
            chord_onset = cursor
            cursor += duration
        return cursor, chord_onset

    onset = chord_onset if is_chord else cursor

    if is_rest:
        if not is_chord:
            chord_onset = cursor
            cursor += duration
        return cursor, chord_onset

    pitch = note.find("pitch")
    if pitch is None:
        log.warn("note-without-pitch", "a <note> has neither <pitch> nor <rest>")
        if not is_chord:
            chord_onset = cursor
            cursor += duration
        return cursor, chord_onset

    step = (pitch.findtext("step") or "C").strip()
    alter = round_half_up(pitch.findtext("alter") or 0)
    octave = int(pitch.findtext("octave") or 4)
    try:
        # <alter> already carries the key signature and any accidental.
        # Applying the key again here is the classic double-alteration bug.
        midi = pitch_to_midi(step, alter, octave) + state.transpose_semitones
    except PitchError as exc:
        log.warn("bad-pitch", str(exc))
        if not is_chord:
            chord_onset = cursor
            cursor += duration
        return cursor, chord_onset

    if not 0 <= midi <= MIDI_HIGHEST:
        log.warn("pitch-out-of-range", "MIDI %d is outside the playable range" % midi)
        if not is_chord:
            chord_onset = cursor
            cursor += duration
        return cursor, chord_onset

    voice = _int(note.findtext("voice"), 1)
    staff = _int(note.findtext("staff"), 0)
    if staff:
        hand = HAND_RIGHT if staff == 1 else HAND_LEFT
    else:
        staff = 1
        hand = HAND_RIGHT if midi >= 60 else HAND_LEFT
        inferred_hand_parts.add(part.id)

    tie_start, tie_stop = _read_ties(note)
    articulations, fermata = _read_notations(note, log, part.id, number)

    raw_notes.append(
        _RawNote(
            midi=midi,
            onset_ticks=measure_start + onset,
            # <duration> already accounts for dots and tuplets;
            # <time-modification> is notation and must not be applied again.
            duration_ticks=max(0, duration),
            part_id=part.id,
            part_index=0,
            voice=voice,
            staff=staff,
            hand=hand,
            measure_number=number,
            measure_index=measure_index,
            step=step,
            alter=alter,
            octave=octave,
            tie_start=tie_start,
            tie_stop=tie_stop,
            fermata=fermata,
            articulations=articulations,
        )
    )

    if not is_chord:
        chord_onset = cursor
        cursor += duration
    return cursor, chord_onset


def _read_ties(note):
    tie_start = tie_stop = False
    ties = note.findall("tie")
    if not ties:
        # <tied> is the printed slur-looking mark; when <tie> is missing some
        # exporters only write the notation, so it is read as a fallback.
        ties = note.findall("notations/tied")
    for tie in ties:
        if tie.get("type") == "start":
            tie_start = True
        elif tie.get("type") == "stop":
            tie_stop = True
    return tie_start, tie_stop


def _read_notations(note, log, part_id, number):
    articulations = set()
    fermata = False
    for notations in note.findall("notations"):
        for group in notations.findall("articulations"):
            for articulation in group:
                articulations.add(articulation.tag)
        if notations.find("fermata") is not None:
            fermata = True
        if notations.find("ornaments") is not None:
            log.warn(
                "ornaments-dropped",
                "ornaments (trills, mordents, turns) are not implemented yet "
                "and were played as plain notes (first seen in measure %s of "
                "part %s)" % (number, part_id),
            )
        if notations.find("arpeggiate") is not None:
            log.warn(
                "arpeggio-dropped",
                "arpeggio marks were ignored; the chord is struck as a block "
                "(first seen in measure %s of part %s)" % (number, part_id),
            )
        # <slur> is deliberately not read: a phrase mark does not change how
        # long a note sounds. Only <tie> does.
    return frozenset(articulations), fermata


def _read_attributes(attributes, state, log):
    divisions = attributes.findtext("divisions")
    if divisions:
        try:
            value = int(round(float(divisions)))
            if value > 0:
                state.divisions = value
        except ValueError:
            log.warn("bad-divisions", "<divisions>%s</divisions> is not a number" % divisions)

    time = attributes.find("time")
    if time is not None:
        beats = time.findtext("beats")
        beat_type = time.findtext("beat-type")
        if beats and beat_type:
            # A composite meter such as 3+2/8 is summed; it plays the same.
            state.beats = sum(_int(part, 0) for part in beats.split("+")) or state.beats
            state.beat_type = _int(beat_type, state.beat_type)

    key = attributes.find("key")
    if key is not None:
        state.fifths = _int(key.findtext("fifths"), state.fifths)
        state.mode = (key.findtext("mode") or state.mode or "major").strip().lower()

    staves = attributes.findtext("staves")
    if staves:
        state.staff_count = max(state.staff_count, _int(staves, 1))

    transpose = attributes.find("transpose")
    if transpose is not None:
        chromatic = _int(transpose.findtext("chromatic"), 0)
        octave_change = _int(transpose.findtext("octave-change"), 0)
        state.transpose_semitones = chromatic + 12 * octave_change
        if state.transpose_semitones:
            log.info(
                "transposing-part",
                "a transposing part was shifted by %d semitones to sounding pitch"
                % state.transpose_semitones,
            )


def _read_direction(direction, part, state, options, log, measure_start, cursor,
                    pedals, tempo_marks):
    offset = _ticks(direction.findtext("offset"), state.divisions)
    staff = _int(direction.findtext("staff"), 1)
    tick = max(0, measure_start + cursor + offset)
    curve = state.curve(staff, options.default_velocity)

    for direction_type in direction.findall("direction-type"):
        for child in direction_type:
            tag = child.tag
            if tag == "dynamics":
                for mark in child:
                    if mark.tag in DYNAMIC_VELOCITIES:
                        curve.add_dynamic(tick, DYNAMIC_VELOCITIES[mark.tag])
                    elif mark.tag != "other-dynamics":
                        log.unsupported("dynamics/%s" % mark.tag)
            elif tag == "wedge":
                wedge_type = child.get("type")
                if wedge_type in ("crescendo", "diminuendo"):
                    curve.start_wedge(tick, wedge_type)
                elif wedge_type in ("stop", "continue"):
                    curve.stop_wedge(tick)
            elif tag == "metronome":
                bpm = _metronome_bpm(child)
                if bpm:
                    tempo_marks.append((tick, bpm))
            elif tag == "pedal":
                pedal_type = child.get("type")
                if pedal_type in ("start", "stop", "change", "sostenuto"):
                    pedals.append(
                        PedalEvent(
                            onset_ticks=tick,
                            type="start" if pedal_type == "sostenuto" else pedal_type,
                            part_id=part.id,
                            staff=staff,
                        )
                    )
            elif tag == "octave-shift":
                # <pitch> is always the sounding pitch, so an 8va bracket is
                # engraving only and changes nothing here.
                log.info("octave-shift", "octave-shift brackets are printing only")
            elif tag in ("words", "segno", "coda", "rehearsal", "dashes",
                         "bracket", "dynamics", "harp-pedals", "damp",
                         "damp-all", "eyeglasses", "string-mute", "scordatura",
                         "image", "principal-voice", "accordion-registration",
                         "staff-divide", "other-direction", "percussion"):
                continue
            else:
                log.unsupported(tag, "inside <direction-type>")

    sound = direction.find("sound")
    if sound is not None:
        _read_sound(sound, state, options, tick, tempo_marks, curve)


def _read_sound(sound, state, options, tick, tempo_marks, curve=None):
    tempo = sound.get("tempo")
    if tempo:
        try:
            bpm = float(tempo)
            if bpm > 0:
                tempo_marks.append((tick, bpm))
        except ValueError:
            pass
    dynamics = sound.get("dynamics")
    if dynamics and curve is not None:
        try:
            # The attribute is a percentage of MIDI velocity 90.
            curve.add_dynamic(tick, float(dynamics) * 0.9)
        except ValueError:
            pass


def _metronome_bpm(metronome):
    per_minute = metronome.findtext("per-minute")
    beat_unit = (metronome.findtext("beat-unit") or "quarter").strip()
    if not per_minute:
        return 0.0
    try:
        value = float(per_minute.strip())
    except ValueError:
        return 0.0
    quarters = BEAT_UNIT_QUARTERS.get(beat_unit, 1.0)
    # Each dot adds half of what the previous one was worth.
    added = quarters
    for _ in range(len(metronome.findall("beat-unit-dot"))):
        added /= 2.0
        quarters += added
    return value * quarters


# ---------------------------------------------------------------------------
# post-processing
# ---------------------------------------------------------------------------


def _merge_ties(raw_notes, log):
    """Fold each tie chain into a single event.

    A tie means one key press held longer; a slur means nothing of the sort.
    Because the score is already unfolded, a tie crossing a bar line or a
    repeat ending is just two adjacent events on the same timeline.
    """
    if not raw_notes:
        return []

    buckets = {}
    for note in raw_notes:
        buckets.setdefault((note.part_id, note.voice, note.staff, note.midi), []).append(note)

    consumed = set()
    for chain in buckets.values():
        chain.sort(key=lambda n: n.onset_ticks)
        for index, note in enumerate(chain):
            if id(note) in consumed or not note.tie_start:
                continue
            end = note.onset_ticks + note.duration_ticks
            cursor = index + 1
            while cursor < len(chain):
                candidate = chain[cursor]
                if id(candidate) in consumed:
                    cursor += 1
                    continue
                if not candidate.tie_stop or candidate.onset_ticks != end:
                    break
                note.duration_ticks += candidate.duration_ticks
                note.fermata = note.fermata or candidate.fermata
                note.articulations = note.articulations | candidate.articulations
                end = note.onset_ticks + note.duration_ticks
                consumed.add(id(candidate))
                if not candidate.tie_start:
                    break
                cursor += 1

    merged = [note for note in raw_notes if id(note) not in consumed]
    dangling = sum(1 for n in merged if n.tie_stop and not n.tie_start)
    if dangling:
        log.warn(
            "tie-unmatched",
            "%d tied note(s) had no note to tie back to and were played on "
            "their own" % dangling,
        )
    return merged


def _register_fermatas(notes, time_map, options, log):
    """A hold stretches one moment of the clock, it is not a tempo change."""
    factor = max(1.0, float(options.fermata_factor or 1.0))
    if factor == 1.0:
        return
    pauses = {}
    for note in notes:
        if not note.fermata:
            continue
        end = note.onset_ticks + note.duration_ticks
        written = time_map.span_seconds(note.onset_ticks, end)
        pauses[end] = max(pauses.get(end, 0.0), written * (factor - 1.0))
    for tick, seconds in pauses.items():
        time_map.add_pause(tick, seconds)
    if pauses:
        log.info(
            "fermata",
            "%d fermata(s) held for %.2fx their written length" % (len(pauses), factor),
        )


def _articulation_duration_factor(articulations):
    factor = 1.0
    for name in articulations:
        factor = min(factor, ARTICULATION_DURATION_FACTORS.get(name, 1.0))
    return factor


def _apply_articulation_velocity(velocity, articulations):
    for name in articulations:
        velocity *= ARTICULATION_VELOCITY_FACTORS.get(name, 1.0)
    return max(1, min(MIDI_HIGHEST, int(round(velocity))))


def _mark_pedalled_notes(notes, pedals):
    """Flag the notes that are under the pedal when they are struck."""
    if not pedals:
        return
    down = {}
    changes = []
    for pedal in pedals:
        key = (pedal.part_id, pedal.staff)
        if pedal.type in ("start", "change"):
            down[key] = True
        else:
            down[key] = False
        changes.append((pedal.onset_ticks, key, down[key]))

    state = {}
    cursor = 0
    for note in sorted(notes, key=lambda n: n.onset_ticks):
        while cursor < len(changes) and changes[cursor][0] <= note.onset_ticks:
            _, key, value = changes[cursor]
            state[key] = value
            cursor += 1
        note.sustain_pedal = bool(state.get((note.part_id, note.staff)))


def _initial_tempo(tempo_marks):
    for ticks, bpm in sorted(tempo_marks):
        if ticks == 0:
            return bpm
    if tempo_marks:
        return sorted(tempo_marks)[0][1]
    return DEFAULT_TEMPO_BPM


def _key_name(fifths, mode):
    table = _KEY_NAMES_MINOR if (mode or "").startswith("minor") else _KEY_NAMES_MAJOR
    name = table.get(int(fifths))
    if not name:
        return ""
    return "%s %s" % (name, "minor" if table is _KEY_NAMES_MINOR else "major")


def _ticks(raw, divisions):
    """Renormalise a duration written in the part's own divisions."""
    if not raw:
        return 0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0
    if divisions <= 0:
        return 0
    return int(round(value * TICKS_PER_QUARTER / float(divisions)))


def _int(raw, default=0):
    try:
        return int(round(float((raw or "").strip())))
    except (AttributeError, TypeError, ValueError):
        return default
