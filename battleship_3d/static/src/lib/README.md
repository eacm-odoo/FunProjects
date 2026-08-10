# Vendored libraries

Odoo asset bundles cannot pull from a CDN, so three.js **r184** lives here. The
files are checked in, and this is how they were produced:

```bash
npm pack three@0.184.0 && tar -xzf three-0.184.0.tgz
cp package/build/three.core.js                    static/src/lib/three.core.js
cp package/build/three.module.js                  static/src/lib/three.module.js
cp package/examples/jsm/controls/OrbitControls.js static/src/lib/OrbitControls.js
cp package/LICENSE                                static/src/lib/LICENSE
```

Two edits are needed for the sources to resolve inside the bundle:

* `three.core.js` and `three.module.js` get a `/** @odoo-module **/` first line.
  Their own `./three.core.js` import is relative, which Odoo's transpiler
  resolves on its own.
* `OrbitControls.js` gets the same first line, and its bare `from 'three'`
  becomes `from "@battleship_3d/lib/three.module"`, since Odoo has no
  node_modules resolution.

They are loaded by `battleship_3d.assets_game`, not by the backend or frontend
bundles: three.js weighs a couple of megabytes and is only fetched when
somebody actually opens the board.

License: three.js is MIT — keep `LICENSE` next to the files.
