#!/usr/bin/env python3
"""Run the layer-2 tests without Odoo.

    python3 pianola/tools/run_lib_tests.py

The test files live in ``pianola/tests`` so the Odoo runner picks them up too;
they are loaded here into a throwaway package so their relative imports keep
working outside ``odoo.addons``.
"""

import importlib.util
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MODULE_ROOT = os.path.dirname(HERE)
TESTS_DIR = os.path.join(MODULE_ROOT, "tests")
PACKAGE = "pianola_lib_tests"

#: Tests that need a database; the Odoo runner takes care of those.
SKIP = {"test_music_score"}


def load():
    sys.path.insert(0, os.path.join(MODULE_ROOT, "lib"))
    package = types.ModuleType(PACKAGE)
    package.__path__ = [TESTS_DIR]
    sys.modules[PACKAGE] = package

    suite = unittest.TestSuite()
    loader = unittest.TestLoader()
    for filename in sorted(os.listdir(TESTS_DIR)):
        if not filename.startswith("test_") or not filename.endswith(".py"):
            continue
        name = filename[:-3]
        if name in SKIP:
            continue
        spec = importlib.util.spec_from_file_location(
            "%s.%s" % (PACKAGE, name), os.path.join(TESTS_DIR, filename)
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        suite.addTests(loader.loadTestsFromModule(module))
    return suite


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(load())
    sys.exit(0 if result.wasSuccessful() else 1)
