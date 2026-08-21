"""Warning collector for the compiler.

Anything the compiler does not understand ends up here instead of raising:
a score that is 98% right and says so beats a traceback.
"""


class ParseLog:
    def __init__(self):
        # code -> [first message, count, level]
        self._entries = {}
        self._order = []

    def _add(self, level, code, message):
        entry = self._entries.get(code)
        if entry is None:
            self._entries[code] = [message, 1, level]
            self._order.append(code)
        else:
            entry[1] += 1

    def info(self, code, message):
        self._add("INFO", code, message)

    def warn(self, code, message):
        self._add("WARN", code, message)

    def error(self, code, message):
        self._add("ERROR", code, message)

    def unsupported(self, element, context=""):
        """Record a MusicXML element we deliberately do not handle yet."""
        self.warn(
            "unsupported:%s" % element,
            "<%s> is not supported yet%s; it was ignored"
            % (element, " (%s)" % context if context else ""),
        )

    @property
    def counts(self):
        return {code: entry[1] for code, entry in self._entries.items()}

    def count(self, level=None):
        return sum(
            entry[1]
            for entry in self._entries.values()
            if level is None or entry[2] == level
        )

    def has_errors(self):
        return self.count("ERROR") > 0

    def lines(self):
        out = []
        for code in self._order:
            message, times, level = self._entries[code]
            suffix = " (x%d)" % times if times > 1 else ""
            out.append("%s %s%s" % (level, message, suffix))
        return out

    def render(self):
        return "\n".join(self.lines())

    def __len__(self):
        return self.count()

    def __repr__(self):
        return "<ParseLog %d entries>" % len(self._order)
