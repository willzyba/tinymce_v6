# @codecogs/fxeditor-tinymce

[fxEditor](https://fxeditor.codecogs.com), CodeCogs' LaTeX equation editor, as a plugin for
[TinyMCE](https://www.tiny.cloud) 6 and 7. Authors build an equation in a maths view or as LaTeX,
and it goes into the document as MathML or as an image.

Full documentation, a live example and a design tool:
**[fxplugins.codecogs.com/docs/tinymce.html](https://fxplugins.codecogs.com/docs/tinymce.html)**

## Install

```bash
npm install @codecogs/fxeditor-tinymce
```

## Use

Load the plugin after TinyMCE, and name `eqneditor` in both `plugins` and `toolbar`:

```html
<script src="node_modules/tinymce/tinymce.min.js"></script>
<script src="node_modules/@codecogs/fxeditor-tinymce/eqneditor.js"></script>
<script>
  tinymce.init({
    selector: '#mytextarea',
    plugins: 'eqneditor',
    toolbar: 'eqneditor',
    eqneditor_server: 'fxtex.codecogs.com',
    eqneditor_licence: 'fx_pk_your-key-here',   // from the licence manager
    eqneditor_design: { colour: '#0f7a4d' }     // optional
  });
</script>
```

The plugin is a single script with no build step. The equation editor itself is fetched from
`fxtex.codecogs.com` the first time it is needed. Double-click an equation in the document to edit
it again. Using Angular? See
[fxplugins.codecogs.com/docs/angular.html](https://fxplugins.codecogs.com/docs/angular.html).

## Options

| Option | |
|---|---|
| `eqneditor_server` | Where the equation editor is loaded from: `fxtex.codecogs.com`, or your own fxTeX Server. A bare host means https. |
| `eqneditor_licence` | Your fxEditor licence key. Without one, equations show why they cannot render. |
| `eqneditor_design` | How the editor looks - toolbar, colour, sizes, the predictor. Build one with the design tool on the [documentation page](https://fxplugins.codecogs.com/docs/tinymce.html#customise). |
| `eqneditor_render_url` | The service that draws equations inserted as images. Defaults to `https://latex.codecogs.com`. |

## Licence

MIT. TinyMCE is licensed separately, as is fxEditor - see the documentation.
