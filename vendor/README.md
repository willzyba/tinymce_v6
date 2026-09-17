# Vendored TinyMCE 7

A trimmed copy of the `tinymce` npm package (icons, models, plugins, skins, themes,
`tinymce.min.js`), committed here so our own docs/demo pages — and, for now, any other
site — have a real TinyMCE build to load without needing to vendor it themselves or depend
on a paid Tiny Cloud CDN key.

This is exactly the kind of third-party editor file that should **not** live inside
`eqneditor-v5-www`; that repo should reference it from here (or, once it exists, from the
CDN this folder gets pushed to) instead of keeping its own copy.

## Refreshing

```
cd tinymce/v6
npm install                     # pulls the current tinymce version into node_modules
rm -rf vendor
mkdir vendor
cp -R node_modules/tinymce/{icons,models,plugins,skins,themes,tinymce.min.js,tinymce.d.ts} vendor/
cp node_modules/tinymce/license.md vendor/LICENSE.md
```

Current version: TinyMCE 7.9.3 (`node_modules/tinymce/package.json`).

Our own plugin (`../eqneditor.js`) is not copied in here — it stays alongside this folder so a
consumer only ever needs `vendor/tinymce.min.js` plus `../eqneditor.js`.
