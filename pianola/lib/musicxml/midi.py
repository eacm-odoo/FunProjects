"""Minimal Standard MIDI File reader and writer.

This exists for the regression test: export the compiled timeline, read the
reference file MuseScore produced for the same score, and compare the two note
by note. It is not a general purpose MIDI library and does not try to be.
"""

import struct

_HEADER = b"MThd"
_TRACK = b"MTrk"

#: One tick per millisecond, which makes the written file trivially
#: comparable with what the compiler already holds in seconds.
_WRITE_TPQ = 1000
_WRITE_TEMPO = 1000000  # microseconds per quarter note


def write_midi(compilation, program=0):
    """Serialise a :class:`~.events.Compilation` as a format 1 MIDI file."""
    events = []  # (tick, order, bytes)
    for note in compilation.notes:
        onset = int(round(note.onset_seconds * 1000))
        end = onset + max(1, int(round(note.duration_seconds * 1000)))
        channel = 0 if note.hand == "right" else 1
        events.append((onset, 1, bytes([0x90 | channel, note.midi, max(1, note.velocity)])))
        events.append((end, 0, bytes([0x80 | channel, note.midi, 0])))
    events.sort(key=lambda e: (e[0], e[1]))

    tempo_track = _chunk(
        _delta(0)
        + b"\xff\x51\x03"
        + struct.pack(">I", _WRITE_TEMPO)[1:]
        + _delta(0)
        + b"\xff\x2f\x00"
    )

    body = bytearray()
    for channel in (0, 1):
        body += _delta(0) + bytes([0xC0 | channel, program & 0x7F])
    previous = 0
    for tick, _order, payload in events:
        body += _delta(tick - previous) + payload
        previous = tick
    body += _delta(0) + b"\xff\x2f\x00"

    header = _HEADER + struct.pack(">IHHH", 6, 1, 2, _WRITE_TPQ)
    return header + tempo_track + _chunk(bytes(body))


def read_midi(data):
    """Return ``[(midi, onset_ms, duration_ms), ...]`` sorted by onset."""
    if data[:4] != _HEADER:
        raise ValueError("not a Standard MIDI File")
    length, fmt, track_count, division = struct.unpack(">IHHH", data[4:14])
    if division & 0x8000:
        raise ValueError("SMPTE time division is not supported")
    offset = 8 + length

    raw = []      # (tick, status, data1, data2)
    tempos = []   # (tick, microseconds per quarter)
    for _ in range(track_count):
        if data[offset:offset + 4] != _TRACK:
            break
        size = struct.unpack(">I", data[offset + 4:offset + 8])[0]
        _read_track(data[offset + 8:offset + 8 + size], raw, tempos)
        offset += 8 + size

    raw.sort(key=lambda e: e[0])
    to_ms = _tempo_converter(tempos, division)

    open_notes = {}
    notes = []
    for tick, status, data1, data2 in raw:
        kind = status & 0xF0
        key = (status & 0x0F, data1)
        if kind == 0x90 and data2 > 0:
            open_notes.setdefault(key, []).append(tick)
        elif kind in (0x80, 0x90):
            starts = open_notes.get(key)
            if starts:
                start = starts.pop(0)
                notes.append((data1, to_ms(start), to_ms(tick) - to_ms(start)))
    notes.sort(key=lambda n: (n[1], n[0]))
    return notes


def _read_track(chunk, raw, tempos):
    position = 0
    tick = 0
    running_status = None
    size = len(chunk)
    while position < size:
        delta, position = _read_varint(chunk, position)
        tick += delta
        if position >= size:
            break
        byte = chunk[position]
        if byte == 0xFF:
            position += 1
            meta_type = chunk[position]
            position += 1
            length, position = _read_varint(chunk, position)
            payload = chunk[position:position + length]
            position += length
            if meta_type == 0x51 and length == 3:
                tempos.append((tick, (payload[0] << 16) | (payload[1] << 8) | payload[2]))
            continue
        if byte in (0xF0, 0xF7):
            position += 1
            length, position = _read_varint(chunk, position)
            position += length
            continue
        if byte & 0x80:
            running_status = byte
            position += 1
        status = running_status
        if status is None:
            position += 1
            continue
        kind = status & 0xF0
        data1 = chunk[position]
        position += 1
        if kind in (0xC0, 0xD0):
            data2 = 0
        else:
            data2 = chunk[position]
            position += 1
        if kind in (0x80, 0x90):
            raw.append((tick, status, data1, data2))


def _tempo_converter(tempos, division):
    points = sorted(tempos) or [(0, 500000)]
    if points[0][0] != 0:
        points.insert(0, (0, 500000))
    table = [(0, 0.0, points[0][1])]  # (tick, milliseconds, tempo)
    for index in range(1, len(points)):
        previous_tick, previous_ms, previous_tempo = table[-1]
        tick = points[index][0]
        elapsed = (tick - previous_tick) / float(division) * previous_tempo / 1000.0
        table.append((tick, previous_ms + elapsed, points[index][1]))

    def convert(tick):
        entry = table[0]
        for candidate in table:
            if candidate[0] <= tick:
                entry = candidate
            else:
                break
        return int(round(
            entry[1] + (tick - entry[0]) / float(division) * entry[2] / 1000.0
        ))

    return convert


def _read_varint(data, position):
    value = 0
    while True:
        byte = data[position]
        position += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, position


def _delta(value):
    value = max(0, int(value))
    out = bytearray([value & 0x7F])
    value >>= 7
    while value:
        out.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(out)


def _chunk(payload):
    return _TRACK + struct.pack(">I", len(payload)) + payload
