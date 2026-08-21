"""Reach the layer-2 library from a test, with or without Odoo around it.

``lib/musicxml`` is deliberately Odoo-free, so the same test file has to be
importable two ways: through ``odoo.addons`` when the module is installed, and
straight off the filesystem when the compiler is exercised on its own with
``tools/run_lib_tests.py``.
"""

import os
import sys

try:  # running inside Odoo
    from odoo.addons.pianola.lib import musicxml
except ImportError:  # running as plain Python
    _LIB_PATH = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"
    )
    if _LIB_PATH not in sys.path:
        sys.path.insert(0, _LIB_PATH)
    import musicxml  # noqa: F401
