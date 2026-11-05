# Third-party notices

The root [MIT license](LICENSE) applies to this project's original code. It does not relicense dependencies, vendor files, provider SDKs, fonts or other third-party material. Those components retain their respective copyright, license terms and notices.

## Included vendor code

- `vendor/shadcn-tailwind-4.13.0.css` is accompanied by the original MIT notice, **Copyright (c) 2023 shadcn**, in [vendor/shadcn-tailwind-4.13.0.LICENSE.md](vendor/shadcn-tailwind-4.13.0.LICENSE.md). Preserve that notice when distributing this file or substantial portions of it.
- UI components derived from shadcn/ui retain the upstream MIT attribution. See the included notice above and the upstream project's own license.

## npm dependencies

[DEPENDENCY_LICENSES.md](docs/DEPENDENCY_LICENSES.md) records every non-root package entry in the committed npm lockfile with its declared license. The lockfile includes production, development, optional and platform-specific packages; the list does not assert that every entry is bundled into the app.

Licenses in the dependency graph include MIT and other terms, including Apache, BSD, ISC, LGPL, MPL and Creative Commons. A package's own license and notice files are authoritative; metadata can use SPDX expressions and must not be treated as a grant to relicense everything as MIT. When redistributing source, a package, a server artifact or browser bundles, preserve required notices and review the license obligations for the components actually included. Regenerate the inventory when the lockfile changes.

Google, Supabase, Clobe, Toss Payments and hosting services have their own account and API terms. This repository supplies integration code; it does not include another account's credentials or grant service access.
