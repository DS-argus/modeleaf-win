# Third-party notices

This is a reviewed inventory for the direct production dependencies and copied production assets currently checked into this repository. It deliberately does not state a Modeleaf product license and does not enumerate or infer transitive dependency terms. The verifier reads the machine-review block below; update its exact resolved metadata and this human-readable notice together after an authoritative review.

## Direct production dependencies

- `@tauri-apps/api` 2.11.1 — Apache-2.0 OR MIT, as recorded by `package-lock.json`.
- `pdfjs-dist` 6.2.108 — Apache-2.0, as recorded by `package-lock.json`.
- `smol-toml` 1.8.0 — BSD-3-Clause, as recorded by `package-lock.json`.
- `fs2` 0.4.3 and `serde_json` 1.0.151 — MIT OR Apache-2.0, as recorded by `src-tauri/Cargo.lock`.
- Rust direct dependencies are resolved by `src-tauri/Cargo.lock`. Resolved crate manifests and their included license files were reviewed and record MIT OR Apache-2.0 terms.

## smol-toml BSD-3-Clause notice

Copyright (c) Squirrel Chat et al., All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Copied PDF.js assets

The copied PDF.js 6.2.108 asset manifest binds every shipped file to its byte length and SHA-256. The included license files remain the source for their associated CMaps, ICC profile, standard fonts, and WASM components. This notice does not replace or rewrite those terms.

## Upstream theme palettes

The seven chrome palettes are copied from `DS-argus/modeleaf` at the recorded revision. The upstream source location is attributed for each palette. The upstream theme attribution records these palettes under MIT terms.

<!-- third-party-review
{
  "dependencies": [
    { "ecosystem": "npm", "name": "@tauri-apps/api", "version": "2.11.1", "license": "Apache-2.0 OR MIT", "source": "https://registry.npmjs.org/@tauri-apps/api/-/api-2.11.1.tgz", "requiredNotice": "License expression recorded in package-lock.json." },
    { "ecosystem": "npm", "name": "pdfjs-dist", "version": "6.2.108", "license": "Apache-2.0", "source": "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz", "requiredNotice": "Copied PDF.js assets and their included notice files are reviewed below." },
    { "ecosystem": "npm", "name": "smol-toml", "version": "1.8.0", "license": "BSD-3-Clause", "source": "https://registry.npmjs.org/smol-toml/-/smol-toml-1.8.0.tgz", "requiredNotice": "BSD-3-Clause license recorded in package-lock.json; retain the upstream license notice." },
    { "ecosystem": "cargo", "name": "fs2", "version": "0.4.3", "license": "MIT OR Apache-2.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "requiredNotice": "License expression verified against the resolved crate manifest; retain the corresponding MIT and Apache-2.0 notices." },
    { "ecosystem": "cargo", "name": "rand", "version": "0.8.7", "license": "MIT OR Apache-2.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "requiredNotice": "License expression verified against the resolved crate manifest; retain the corresponding MIT and Apache-2.0 notices." },
    { "ecosystem": "cargo", "name": "serde", "version": "1.0.229", "license": "MIT OR Apache-2.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "requiredNotice": "License expression verified against the resolved crate manifest; retain the corresponding MIT and Apache-2.0 notices." },
    { "ecosystem": "cargo", "name": "serde_json", "version": "1.0.151", "license": "MIT OR Apache-2.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "requiredNotice": "License expression verified against the resolved crate manifest; retain the corresponding MIT and Apache-2.0 notices." },
    { "ecosystem": "cargo", "name": "tauri", "version": "2.11.5", "license": "MIT OR Apache-2.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "requiredNotice": "License expression verified against the resolved crate manifest; retain the corresponding MIT and Apache-2.0 notices." },
    { "ecosystem": "cargo", "name": "tauri-build", "version": "2.6.3", "license": "MIT OR Apache-2.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "requiredNotice": "License expression verified against the resolved crate manifest; retain the corresponding MIT and Apache-2.0 notices." },
    { "ecosystem": "cargo", "name": "tauri-plugin-single-instance", "version": "2.4.3", "license": "MIT OR Apache-2.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "requiredNotice": "License expression verified against the resolved crate manifest; retain the corresponding MIT and Apache-2.0 notices." },
    { "ecosystem": "cargo", "name": "url", "version": "2.5.8", "license": "MIT OR Apache-2.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "requiredNotice": "License expression verified against the resolved crate manifest; retain the corresponding MIT and Apache-2.0 notices." },
    { "ecosystem": "cargo", "name": "webview2-com", "version": "0.38.2", "license": "MIT", "source": "registry+https://github.com/rust-lang/crates.io-index", "requiredNotice": "License verified against the resolved crate manifest; retain the upstream MIT notice." },
    { "ecosystem": "cargo", "name": "windows", "version": "0.61.3", "license": "MIT OR Apache-2.0", "source": "registry+https://github.com/rust-lang/crates.io-index", "requiredNotice": "License expression verified against the resolved crate manifest; retain the corresponding MIT and Apache-2.0 notices." }
  ],
  "assets": [
    { "name": "pdfjs-dist", "version": "6.2.108", "license": "Apache-2.0; see copied distribution license notices where supplied.", "source": "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz", "requiredNotice": "PDF.js source headers in build/pdf.mjs, build/pdf.worker.min.mjs, web/pdf_viewer.mjs, and web/pdf_viewer.css.", "prefix": "build/" },
    { "name": "pdfjs-dist", "version": "6.2.108", "license": "Apache-2.0; see copied distribution license notices where supplied.", "source": "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz", "requiredNotice": "PDF.js source headers in web/pdf_viewer.mjs and web/pdf_viewer.css.", "prefix": "web/" },
    { "name": "pdfjs-dist", "version": "6.2.108", "license": "BSD-3-Clause text in cmaps/LICENSE.", "source": "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz", "requiredNotice": "Retain public/assets/pdfjs-6.2.108/cmaps/LICENSE.", "prefix": "cmaps/" },
    { "name": "pdfjs-dist", "version": "6.2.108", "license": "CC0 1.0 Universal text in iccs/LICENSE.", "source": "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz", "requiredNotice": "Retain public/assets/pdfjs-6.2.108/iccs/LICENSE.", "prefix": "iccs/" },
    { "name": "pdfjs-dist", "version": "6.2.108", "license": "See LICENSE_FOXIT and LICENSE_LIBERATION in the copied font directory.", "source": "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz", "requiredNotice": "Retain public/assets/pdfjs-6.2.108/standard_fonts/LICENSE_FOXIT and LICENSE_LIBERATION.", "prefix": "standard_fonts/" },
    { "name": "pdfjs-dist", "version": "6.2.108", "license": "See copied LICENSE_JBIG2, LICENSE_OPENJPEG, LICENSE_QCMS, and PDF.js WASM notices.", "source": "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.2.108.tgz", "requiredNotice": "Retain all public/assets/pdfjs-6.2.108/wasm/LICENSE* files.", "prefix": "wasm/" }
  ],
  "themes": [
    { "id": "tokyo-night", "revision": "d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "license": "MIT", "source": "https://github.com/DS-argus/modeleaf/tree/d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "requiredNotice": "Palette attribution to Modeleaf Theme.swift/BuiltInThemes.swift." },
    { "id": "gruvbox-dark", "revision": "d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "license": "MIT", "source": "https://github.com/DS-argus/modeleaf/tree/d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "requiredNotice": "Palette attribution to Modeleaf Theme.swift/BuiltInThemes.swift." },
    { "id": "solarized-dark", "revision": "d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "license": "MIT", "source": "https://github.com/DS-argus/modeleaf/tree/d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "requiredNotice": "Palette attribution to Modeleaf Theme.swift/BuiltInThemes.swift." },
    { "id": "dracula", "revision": "d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "license": "MIT", "source": "https://github.com/DS-argus/modeleaf/tree/d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "requiredNotice": "Palette attribution to Modeleaf Theme.swift/BuiltInThemes.swift." },
    { "id": "everforest", "revision": "d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "license": "MIT", "source": "https://github.com/DS-argus/modeleaf/tree/d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "requiredNotice": "Palette attribution to Modeleaf Theme.swift/BuiltInThemes.swift." },
    { "id": "nord", "revision": "d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "license": "MIT", "source": "https://github.com/DS-argus/modeleaf/tree/d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "requiredNotice": "Palette attribution to Modeleaf Theme.swift/BuiltInThemes.swift." },
    { "id": "catppuccin-latte", "revision": "d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "license": "MIT", "source": "https://github.com/DS-argus/modeleaf/tree/d809e2e4d6aa5f257c91ff38b2cd4503e17405f0", "requiredNotice": "Palette attribution to Modeleaf Theme.swift/BuiltInThemes.swift." }
  ]
}
-->
