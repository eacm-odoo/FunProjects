"""Turn the written measure order into the order the piece is actually played.

Everything downstream -- ties, tempo, dynamics -- works on a single linear
timeline, so repeats have to be resolved first. If a structure cannot be read,
the piece falls back to straight document order and says so in the log rather
than failing.
"""

import re
from dataclasses import dataclass, field

from .constants import MAX_UNFOLDED_MEASURES

_DACAPO_RE = re.compile(r"\bd\.?\s*c\.?\b|\bda\s+capo\b", re.IGNORECASE)
_DALSEGNO_RE = re.compile(r"\bd\.?\s*s\.?\b|\bdal\s+segno\b", re.IGNORECASE)
_FINE_RE = re.compile(r"\bfine\b", re.IGNORECASE)
_TOCODA_RE = re.compile(r"\bto\s+coda\b|\bal\s+coda\b", re.IGNORECASE)


@dataclass
class MeasureStructure:
    index: int
    number: str = ""
    implicit: bool = False
    forward_repeat: bool = False
    backward_repeat: bool = False
    backward_times: int = 2
    ending_numbers: frozenset = frozenset()
    ending_start: bool = False
    ending_stop: bool = False
    segno: bool = False
    coda: bool = False
    to_coda: bool = False
    fine: bool = False
    dacapo: bool = False
    dalsegno: bool = False
    jump_targets_coda: bool = False


def read_structure(measures):
    return [_measure_structure(index, m) for index, m in enumerate(measures)]


def unfold(measures, log):
    """Return the list of measure indices in playback order."""
    structures = read_structure(measures)
    total = len(structures)
    if not total:
        return []

    segno_index = next((s.index for s in structures if s.segno), None)
    coda_index = next((s.index for s in structures if s.coda), None)

    order = []
    stack = []          # [[repeat start index, pass number], ...]
    jumped = False      # a D.C./D.S. has been taken
    index = 0
    guard = 0

    while 0 <= index < total:
        guard += 1
        if guard > MAX_UNFOLDED_MEASURES:
            log.warn(
                "unfold-runaway",
                "the repeat structure did not resolve after %d measures; the "
                "score is played in written order" % MAX_UNFOLDED_MEASURES,
            )
            return list(range(total))

        structure = structures[index]

        if structure.forward_repeat and not jumped:
            if not stack or stack[-1][0] != index:
                stack.append([index, 1])

        if structure.ending_start and not jumped:
            current_pass = stack[-1][1] if stack else 1
            if structure.ending_numbers and current_pass not in structure.ending_numbers:
                index = _ending_stop_index(structures, index) + 1
                continue

        order.append(index)

        if jumped and structure.to_coda and coda_index is not None:
            index = coda_index
            continue

        if jumped and structure.fine:
            break

        if structure.backward_repeat and not jumped:
            start = stack[-1][0] if stack else 0
            passes = stack[-1][1] if stack else 1
            if passes < structure.backward_times:
                if stack:
                    stack[-1][1] += 1
                else:
                    stack.append([0, 2])
                index = start
                continue
            if stack:
                stack.pop()
            index += 1
            continue

        if structure.ending_stop and stack:
            # Last alternative ending of the group: the repeat is done with.
            stack.pop()

        if structure.dacapo and not jumped:
            jumped = True
            stack = []
            log.info(
                "jump-dacapo",
                "da capo taken at measure %s; repeats are not played again on "
                "the way back, per the usual convention" % structure.number,
            )
            index = 0
            continue

        if structure.dalsegno and not jumped:
            jumped = True
            stack = []
            if segno_index is None:
                log.warn(
                    "jump-no-segno",
                    "measure %s asks for a dal segno but there is no segno in "
                    "the score; jumping to the beginning instead" % structure.number,
                )
            log.info(
                "jump-dalsegno",
                "dal segno taken at measure %s; repeats are not played again "
                "on the way back" % structure.number,
            )
            index = segno_index if segno_index is not None else 0
            continue

        index += 1

    return order


def _ending_stop_index(structures, start):
    for candidate in range(start, len(structures)):
        if structures[candidate].ending_stop:
            return candidate
    return len(structures) - 1


def _measure_structure(index, measure):
    structure = MeasureStructure(
        index=index,
        number=measure.get("number") or str(index + 1),
        implicit=(measure.get("implicit") == "yes"),
    )

    for barline in measure.findall("barline"):
        repeat = barline.find("repeat")
        if repeat is not None:
            direction = repeat.get("direction")
            if direction == "forward":
                structure.forward_repeat = True
            elif direction == "backward":
                structure.backward_repeat = True
                times = repeat.get("times")
                if times and times.isdigit() and int(times) > 1:
                    structure.backward_times = int(times)
        ending = barline.find("ending")
        if ending is not None:
            numbers = _ending_numbers(ending)
            ending_type = ending.get("type")
            if ending_type == "start":
                structure.ending_start = True
                structure.ending_numbers = numbers
            elif ending_type in ("stop", "discontinue"):
                structure.ending_stop = True
                if not structure.ending_numbers:
                    structure.ending_numbers = numbers

    for sound in measure.iter("sound"):
        if sound.get("segno"):
            structure.segno = True
        if sound.get("coda"):
            structure.coda = True
        if sound.get("tocoda"):
            structure.to_coda = True
        if sound.get("fine"):
            structure.fine = True
        if sound.get("dacapo") == "yes":
            structure.dacapo = True
        if sound.get("dalsegno"):
            structure.dalsegno = True

    for direction_type in measure.iter("direction-type"):
        if direction_type.find("segno") is not None:
            structure.segno = True
        if direction_type.find("coda") is not None:
            structure.coda = True
        for words in direction_type.findall("words"):
            _read_words(structure, (words.text or "").strip())

    return structure


def _read_words(structure, text):
    """Read a printed instruction such as "D.C. al Fine" or "To Coda".

    A jump names its own target -- "al Fine", "al Coda" -- so the target words
    must not be read as a Fine or a To Coda sitting on this very bar.
    """
    if not text:
        return
    if _DACAPO_RE.search(text):
        structure.dacapo = True
        return
    if _DALSEGNO_RE.search(text):
        structure.dalsegno = True
        return
    if _TOCODA_RE.search(text):
        structure.to_coda = True
        return
    if _FINE_RE.search(text):
        structure.fine = True


def _ending_numbers(ending):
    raw = ending.get("number") or ""
    numbers = set()
    for chunk in re.split(r"[,\s]+", raw):
        chunk = chunk.strip()
        if chunk.isdigit():
            numbers.add(int(chunk))
    return frozenset(numbers)
