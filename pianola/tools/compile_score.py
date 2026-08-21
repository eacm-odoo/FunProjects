#!/usr/bin/env python3
"""Compile a MusicXML file from a bare shell -- no Odoo, no database.

    python3 pianola/tools/compile_score.py score.musicxml
    python3 pianola/tools/compile_score.py score.mxl --json out.json
    python3 pianola/tools/compile_score.py score.mxl --midi out.mid

Layer 2 has to stay runnable this way: it is what makes the compiler testable
without standing a server up, and what the regression fixtures are built with.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import musicxml  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", help="a .musicxml, .xml or .mxl file")
    parser.add_argument("--json", dest="json_path", help="write the playback payload here")
    parser.add_argument("--midi", dest="midi_path", help="write the timeline as a MIDI file")
    parser.add_argument("--fermata-factor", type=float, default=1.5)
    parser.add_argument("--no-unfold", action="store_true",
                        help="keep written order instead of expanding repeats")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    with open(args.source, "rb") as handle:
        data = handle.read()

    log = musicxml.ParseLog()
    options = musicxml.CompileOptions(
        fermata_factor=args.fermata_factor,
        unfold_repeats=not args.no_unfold,
    )
    try:
        compilation = musicxml.compile_musicxml(data, options=options, log=log)
    except (musicxml.ContainerError, musicxml.UnsupportedScore) as exc:
        parser.exit(2, "cannot compile %s: %s\n" % (args.source, exc))

    if not args.quiet:
        print("%s -- %s" % (compilation.work_title or args.source, compilation.composer))
        print("  key %s, %s, %.1f bpm" % (
            compilation.key_signature or "?",
            compilation.time_signature or "?",
            compilation.initial_tempo,
        ))
        print("  %d notes, %d measures played, %d part(s), %.2f s" % (
            len(compilation.notes),
            len(compilation.measures),
            len(compilation.parts),
            compilation.duration_seconds,
        ))
        hands = {"left": 0, "right": 0}
        for note in compilation.notes:
            hands[note.hand] = hands.get(note.hand, 0) + 1
        print("  right hand %d, left hand %d" % (hands["right"], hands["left"]))
        if compilation.warnings:
            print("  log:")
            for line in compilation.warnings:
                print("    %s" % line)

    if args.json_path:
        with open(args.json_path, "w") as handle:
            json.dump(compilation.to_playback_dict(), handle)
        if not args.quiet:
            print("  wrote %s" % args.json_path)

    if args.midi_path:
        with open(args.midi_path, "wb") as handle:
            handle.write(musicxml.midi.write_midi(compilation))
        if not args.quiet:
            print("  wrote %s" % args.midi_path)

    return 0


if __name__ == "__main__":
    sys.exit(main())
