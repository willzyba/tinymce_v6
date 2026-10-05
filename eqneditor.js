/*
 * CodeCogs Equation Editor plugin for TinyMCE.
 *
 * Requirements: TinyMCE 6 or 7.
 *
 * Load this file after tinymce.min.js, then name 'eqneditor' in both the plugins and the
 * toolbar of your tinymce.init():
 *
 *   tinymce.init({
 *       selector: '#mytextarea',
 *       plugins: 'eqneditor',
 *       toolbar: 'eqneditor',
 *
 *       // Optional:
 *       eqneditor_server: 'fxtex.codecogs.com',    // where the editor's own code is served from
 *       eqneditor_render_url: 'https://latex.codecogs.com'   // where SVG equations are rendered
 *   });
 *
 * The dialog is maths-view only: no LaTeX markup and no rendered-equation preview are visible
 * until the author asks for them (the LaTeX and Inline toggles, bottom-left of the dialog).
 * Insert writes MathML directly by default - a dropdown next to those toggles switches to an
 * <img> against the SVG rendering service instead.
 */

( function () {
    'use strict';

    // Presentation MathML, plus the three non-"m" elements the converter can emit. Listed
    // rather than pattern-matched because TinyMCE's schema takes names, and because a list is
    // reviewable - a regex like /^m/ would also admit anything else beginning with m.
    var MATHML_ELEMENTS = [
        'math', 'semantics', 'annotation', 'annotation-xml',
        'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'mspace', 'mglyph',
        'mfrac', 'msqrt', 'mroot', 'mstyle', 'merror', 'mpadded', 'mphantom', 'menclose',
        'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover',
        'mmultiscripts', 'mprescripts', 'none',
        'mtable', 'mtr', 'mtd', 'mlabeledtr', 'maction'
    ];

    var DEFAULT_EDITOR_HOST = 'fxtex.codecogs.com';
    var DEFAULT_RENDER_URL = 'https://latex.codecogs.com';

    // One shared download per URL, however many TinyMCE instances a page has.
    var scriptPromises = {};

    function loadScriptOnce( url ) {
        if ( scriptPromises[ url ] ) {
            return scriptPromises[ url ];
        }

        scriptPromises[ url ] = new Promise( function ( resolve, reject ) {
            if ( typeof window.EqEditor !== 'undefined' ) {
                resolve();
                return;
            }

            var existing = document.querySelector( 'script[src="' + url + '"]' );
            var script = existing || document.createElement( 'script' );

            script.addEventListener( 'load', function () { resolve(); } );
            script.addEventListener( 'error', function () {
                reject( new Error( 'CodeCogs Equation Editor: could not load ' + url ) );
            } );

            if ( !existing ) {
                script.src = url;
                script.type = 'text/javascript';
                document.head.appendChild( script );
            }
        } );

        return scriptPromises[ url ];
    }

    // EqEditor.init() switches the converter every TextArea/MathView/Toolbar construction takes
    // on to fxTeX Pro - skip it and they keep the placeholder converter for their whole
    // lifetime (MathView showing "fxTeX Pro: not initialised" instead of the equation), even
    // once EqEditor.api.min.js itself has loaded. Called once per page, the same way
    // fxtexpro-boot.js does it site-wide: an empty licence is the normal, expected state until
    // a real one is configured, not an error to surface as a broken editor.
    var initPromise = null;

    function ensureInit( licence ) {
        if ( initPromise ) return initPromise;
        initPromise = ( typeof EqEditor.init === 'function' )
            ? EqEditor.init( { licence: licence || '' } ).catch( function ( err ) {
                window.console && console.warn( 'fxTeX Pro: ' + ( err && err.message || err ) );
            } )
            : Promise.resolve();
        return initPromise;
    }

    /**
     * Recovers the equation from a rendering URL, for reopening an <img>-inserted equation.
     * The renderer escapes the characters that would otherwise end the query string, so they
     * have to be turned back - "&plus;" in particular.
     */
    function decodeEquation( encoded ) {
        var latex = encoded;

        try {
            latex = decodeURIComponent( encoded );
        } catch ( e ) {
            // Not valid percent-encoding; still worth showing as it stands.
        }

        return latex
            .replace( /&space;/g, ' ' )
            .replace( /&plus;/g, '+' )
            .replace( /&hash;/g, '#' );
    }

    function escapeHtml( s ) {
        return String( s )
            .replace( /&/g, '&amp;' ).replace( /</g, '&lt;' )
            .replace( />/g, '&gt;' ).replace( /"/g, '&quot;' );
    }

    // Gaps in the shared fxeditor.css (loaded separately, asynchronously, from the host
    // configured below) this dialog needs but can't assume it will get:
    //  - editor.codecogs.com, the old default host and still configurable, serves an older stylesheet that
    //    predates the CCEqnEditor/CCMathViewHost/CCLatexInput class names entirely (only a
    //    local dev mirror does not have this gap), so the LaTeX/maths mutual-exclusion and the
    //    layout below are written defensively rather than left to fxeditor.css;
    //  - this dialog has no rendered-equation preview and no LaTeX box visible by default (see
    //    panelHtml()), so the maths view needs to fill the space between the toolbar and the
    //    bottom bar itself, which nothing outside this plugin has an opinion on.
    // Injected once, since it would otherwise race fxeditor.css over which rule wins.
    // The API's own injected @font-face for "Latin Modern Math" (the face MathView and every
    // rendered equation use) only carries local("Latin Modern Math") - no url() fallback - so
    // it silently falls back to whatever generic serif the visitor's OS has unless that exact
    // font happens to be installed, which it practically never is. A later @font-face for the
    // same family name replaces the API's src list rather than merging with it, so redeclaring
    // it here with a real url() (the same latinmodern-math.otf fxTeX's own bench pages use)
    // fixes every equation and symbol on the page, not just this dialog's.
    function injectStyleOverridesOnce( fontUrl ) {
        if ( document.getElementById( 'cc-eqneditor-style-overrides' ) ) return;
        var style = document.createElement( 'style' );
        style.id = 'cc-eqneditor-style-overrides';
        style.textContent =
            '@font-face { font-family: "Latin Modern Math"; font-display: swap; ' +
                'src: local("Latin Modern Math"), url("' + fontUrl.replace( /prototypes\/latinmodern-math\.otf$/, 'fonts/LatinModernMath-Regular.woff2' ) + '") format("woff2"), url("' + fontUrl + '") format("opentype"); }' +
            // Undo host resets (e.g. .cke_reset_all *) inside the toolbar icons and the maths view's MathML.
            '.CCToolbar svg:has(g[font-family]), .CCToolbar svg:has(g[font-family]) * { font: revert-layer !important; }' +
            // Icons drawn as <text>: the svg gets the API's own .cc_panel font (fxTeX Toolbar, 16px) back over host resets, and each <text> its own font-size attribute (revert-layer lets attributes win).
            '.CCToolbar svg:not(:has(g[font-family])) { font: normal normal 16px "fxTeX Toolbar" !important; }' +
            '.CCToolbar svg:not(:has(g[font-family])) * { font: revert-layer !important; }' +
            '.CCToolbar svg, .CCToolbar svg * { width: revert-layer !important; height: revert-layer !important; max-width: revert-layer !important; }' +
            '.CCToolbar svg g[font-family="fxTeX Toolbar"] { color: #000 !important; }' +
            '.CCMathView math, .CCMathView math * { font: revert-layer !important; ' +
                'width: revert-layer !important; height: revert-layer !important; padding: revert-layer !important; ' +
                'margin: revert-layer !important; text-transform: revert-layer !important; text-align: revert-layer !important; ' +
                'box-sizing: revert-layer !important; white-space: revert-layer !important; }' +
            apiMathRules() + apiCaretRules() +
            '.CCEqnEditor { display: flex !important; flex-direction: column !important; ' +
                'height: 520px !important; }' +
            '.CCEqnEditor .CCEditorBar, .CCEqnEditor .CCToolbarHost { flex: 0 0 auto; }' +
            // The toolbar host as wide as the dialog, no wider: sized to its own content instead
            // (width: auto) it kept the toolbar's whole row and ran past a narrow dialog
            // (`design.width`); at 100% the toolbar scrolls.
            '.CCEqnEditor .CCToolbarHost { align-self: flex-start; width: 100%; }' +
            '.CCEqnEditor .CCMathViewHost { ' +
                'flex: 1 1 auto; min-height: 0; display: flex; align-items: center; ' +
                'justify-content: center; overflow: auto; }' +
            '.CCEqnEditor[data-inline="on"] .CCMathViewHost { justify-content: flex-start; }' +
            '.CCEqnEditor[data-latex="on"] .CCMathViewHost { display: none !important; }' +
            '.CCEqnEditor .CCLatexInput { flex: 1 1 auto; min-height: 0; overflow: auto; }' +
            '.CCEqnEditor[data-latex="off"] .CCLatexInput { display: none !important; }' +
            '.CCEqnEditor .CCEqnOutput-hidden { display: none !important; }' +
            // The bottom bar: toggles left, Insert-as and the dialog's buttons right, one type size. All !important - host dialog resets otherwise restyle it.
            '.cc-eqn-bar { display: flex !important; flex-wrap: wrap !important; align-items: center !important; gap: 16px !important; flex: 0 0 auto !important; ' +
                'margin: 8px 0 0 !important; padding: 10px 0 0 !important; border: 0 !important; border-top: 1px solid #e2e8f0 !important; ' +
                'background: none !important; font: 13px/1.3 system-ui, -apple-system, "Segoe UI", Arial, sans-serif !important; color: #1c2530 !important; }' +
            '.cc-eqn-bar-right { display: flex !important; align-items: center !important; gap: 8px !important; margin: 0 0 0 auto !important; padding: 0 !important; font: inherit !important; color: inherit !important; }' +
            '.cc-eqn-bar .cc-switch { display: inline-flex !important; align-items: center !important; gap: 6px !important; margin: 0 !important; ' +
                'padding: 0 !important; font: inherit !important; color: #54647c !important; cursor: pointer !important; user-select: none !important; white-space: nowrap !important; }' +
            '.cc-eqn-bar .cc-switch input { position: absolute !important; width: 1px !important; height: 1px !important; margin: -1px !important; ' +
                'padding: 0 !important; border: 0 !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; opacity: 0 !important; }' +
            '.cc-eqn-bar .cc-switch-track { position: relative !important; display: inline-block !important; flex: 0 0 auto !important; width: 28px !important; ' +
                'height: 16px !important; margin: 0 !important; padding: 0 !important; border: 0 !important; border-radius: 8px !important; ' +
                'background: #ccc !important; transition: background .2s !important; }' +
            '.cc-eqn-bar .cc-switch-knob { position: absolute !important; display: block !important; top: 2px !important; left: 2px !important; ' +
                'width: 12px !important; height: 12px !important; margin: 0 !important; border-radius: 50% !important; background: #fff !important; transition: left .2s !important; }' +
            '.cc-eqn-bar .cc-switch input:checked + .cc-switch-track { background: #4caf50 !important; }' +
            '.cc-eqn-bar .cc-switch input:checked + .cc-switch-track .cc-switch-knob { left: 14px !important; }' +
            '.cc-eqn-bar .cc-switch input:focus-visible + .cc-switch-track { outline: 2px solid #003794 !important; outline-offset: 2px !important; }' +
            '.cc-eqn-bar .cc-switch input:disabled ~ * { opacity: .5 !important; cursor: default !important; }' +
            '.cc-eqn-bar .cc-switch-label { font: inherit !important; color: inherit !important; }' +
            '.cc-eqn-bar .cc-switch input:checked ~ .cc-switch-label { color: #003794 !important; font-weight: 600 !important; }' +
            '.cc-eqn-bar .cc-eqn-select { width: auto !important; height: 30px !important; margin: 0 !important; padding: 0 8px !important; ' +
                'border: 1px solid #cbd5e0 !important; border-radius: 4px !important; background: #fff !important; font: inherit !important; color: #1c2530 !important; cursor: pointer !important; }' +
            '.cc-eqn-bar .cc-eqn-btn { display: inline-flex !important; align-items: center !important; height: 30px !important; margin: 0 !important; ' +
                'padding: 0 16px !important; border: 1px solid #cbd5e0 !important; border-radius: 4px !important; background: #fff !important; ' +
                'font: inherit !important; color: #1c2530 !important; cursor: pointer !important; box-shadow: none !important; }' +
            '.cc-eqn-bar .cc-eqn-btn * { font: inherit !important; color: inherit !important; }' +
            '.cc-eqn-bar .cc-eqn-btn.cc-eqn-primary { background: #2c7a4b !important; border-color: #2c7a4b !important; color: #fff !important; }' +
            '.tox-dialog:has(.CCEqnEditor) { width: 850px !important; max-width: 96vw !important; height: auto !important; }' +
            // TinyMCE caps a dialog's body at 650px and scrolls the rest - a design taller than that has to be let through.
            '.tox-dialog:has(.CCEqnEditor) .tox-dialog__body-content { max-height: calc(100vh - 110px) !important; }';
        document.head.appendChild( style );
    }

    // Re-asserts the API's own .CCMathView/.fxtex rules, which host resets and revert-layer override.
    // The `design` option (see the README): how the editor looks, set by the site rather than the
    // author. The toolbar's rows and scale go to Toolbar.link() itself; everything else is applied
    // here, once the editor is mounted - CSS scoped to this editor's root, then the starting state of
    // the LaTeX toggle and the "Insert as" menu.
    // The dialog's size when the design does not set one: about 700 by 450 pixels.
    var DEFAULT_WIDTH = 700, DEFAULT_HEIGHT = 450;
    function designWidth( design ) { return Number( design && design.width ) > 0 ? Number( design.width ) : DEFAULT_WIDTH; }
    function designHeight( design ) { return Number( design && design.height ) > 0 ? Number( design.height ) : DEFAULT_HEIGHT; }
    // Gives an inserted image its size in em once the API has read it (Output.imageSize()): set on
    // the image after it goes in, since waiting before inserting it would lose the host's selection.
    // Marked with data-cc-size until then; an API without imageSize() leaves the image as it was.
    var sizingCount = 0;
    function sizeImage( output, apply ) {
        if ( !output || typeof output.imageSize !== 'function' ) return '';
        var mark = 'cc-size-' + ( ++sizingCount ) + '-' + Date.now();
        output.imageSize().then( function ( size ) { apply( mark, size ); } );
        return ' data-cc-size="' + mark + '"';
    }
    // An equation's own size, against a normal one (Output.setEquationSize()): normal is whatever
    // the site's .fxtex rule makes it, and this scales one equation on top. Chosen in the dialog's
    // Size control when the design shows it (design.sizeControl); otherwise an equation being edited
    // keeps the size it had.
    var SIZES = [ 50, 75, 100, 125, 150, 200, 300 ];
    function sizeOptions() {
        return SIZES.map( function ( pct ) {
            return '<option value="' + pct + '"' + ( pct === 100 ? ' selected' : '' ) + '>' + pct + '%</option>';
        } ).join( '' );
    }
    function showSize( select, scale ) {
        if ( !select ) return;
        var pct = String( Math.round( scale * 100 ) );
        if ( !select.querySelector( 'option[value="' + pct + '"]' ) ) {
            var option = document.createElement( 'option' );
            option.value = pct;
            option.textContent = pct + '%';
            select.appendChild( option );
        }
        select.value = pct;
    }
    // The size an equation on the page was inserted at - read once the API has loaded, which may
    // be after the double-click that asked for it. 1 without one.
    function sizeOf( el ) {
        return el && window.EqEditor && EqEditor.Output && typeof EqEditor.Output.equationSizeOf === 'function'
            ? EqEditor.Output.equationSizeOf( el ) : 1;
    }

    var designCount = 0;
    function applyDesign( root, design, latexToggle, insertSelect ) {
        if ( !root || !design ) return;
        if ( !root.id ) root.id = 'cc-eqn-design-' + ( ++designCount );
        var sel = '#' + root.id, css = '';
        var colour = String( design.colour || '' );
        if ( /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test( colour ) ) {
            css += sel + ' { --cc-accent: ' + colour + ';' +
                ' --cc-accent-soft: color-mix(in srgb, ' + colour + ' 11%, #fff);' +
                ' --cc-accent-soft-ring: color-mix(in srgb, ' + colour + ' 28%, #fff);' +
                ' --cc-accent-mid: color-mix(in srgb, ' + colour + ' 22%, #fff);' +
                ' --cc-accent-mid-ring: color-mix(in srgb, ' + colour + ' 43%, #fff); }';
        }
        if ( Number( design.mathSize ) > 0 ) css += sel + ' .CCMathView { font-size: ' + Number( design.mathSize ) + 'px !important; }';
        if ( Number( design.latexSize ) > 0 ) css += sel + ' .CCLatexInput { font-size: ' + Number( design.latexSize ) + 'px !important; }';
        if ( design.toolbar === false ) css += sel + ' .CCToolbar { display: none !important; }';
        if ( design.history === false ) css += sel + ' .CCEditorBar { display: none !important; }';
        if ( css ) {
            var style = document.createElement( 'style' );
            style.textContent = css;
            root.appendChild( style );
        }
        // The dialog's width and height (`width`, `height`), before any scaling: the box takes the width,
        // and the editing area whatever height makes the whole dialog the height asked for - measured,
        // since everything else in it (toolbar rows, the bottom bar) varies with the design. Hosts that
        // size their dialogs themselves (TinyMCE 4, CKEditor 4) are given both when they open it instead.
        var sizedBox = root.closest( '.tox-dialog, .mce-window, .cke_dialog, .ck-balloon-panel, .cc-eqneditor-modal, .tc-drop-down' ) || root;
        if ( !sizedBox.matches( '.mce-window, .cke_dialog' ) ) {
            sizedBox.style.setProperty( 'width', designWidth( design ) + 'px', 'important' );
            var area = root.querySelector( '.CCMathViewHost' );
            if ( area ) {
                // Measured, then measured again as the dialog settles - the toolbar fits itself to its row
                // after the dialog first lays out, and the fonts arrive - correcting by the difference each time.
                // A box with a height of its own (Froala's and Tiptap's modals) sizes to its contents instead.
                sizedBox.style.setProperty( 'height', 'auto', 'important' );
                var sizing = document.createElement( 'style' );
                root.appendChild( sizing );
                var h = 0;
                var fit = function () {
                    var shown = root.querySelector( '.CCLatexInput' ) && getComputedStyle( area ).display === 'none'
                        ? root.querySelector( '.CCLatexInput' ) : area;
                    // Scale may already be applied (see below), and on-screen sizes include it.
                    var applied = parseFloat( sizedBox.style.zoom ) || parseFloat( ( sizedBox.style.transform.match( /scale\(([\d.]+)\)/ ) || [] )[ 1 ] ) || 1;
                    var now = h || shown.getBoundingClientRect().height / applied;
                    h = Math.max( 120, Math.round( now + designHeight( design ) - sizedBox.getBoundingClientRect().height / applied ) );
                    // Never taller than the whole dialog asked for: a host that caps its dialog (and scrolls the
                    // rest) would otherwise be chased upwards on every pass.
                    h = Math.min( h, designHeight( design ) );
                    sizing.textContent = '#' + root.id + ' { height: auto !important; } #' + root.id + ' .CCMathViewHost, #' + root.id + ' .CCLatexInput { height: ' + h + 'px !important; min-height: ' + h + 'px !important; }';
                };
                fit();
                [ 150, 500, 1200 ].forEach( function ( t ) { setTimeout( fit, t ); } );
            }
        }
        // The whole dialog, box and contents together - see `dialogSize` in the README. Zoomed where
        // the host lays the dialog out (it grows in place); scaled where the host positions it itself
        // (CKEditor, TinyMCE 4, a TiddlyWiki drop-down), so that placement still holds.
        var size = Number( design.dialogSize );
        if ( size > 0 && size !== 1 ) {
            var box = root.closest( '.tox-dialog, .mce-window, .cke_dialog, .ck-balloon-panel, .cc-eqneditor-modal, .tc-drop-down' ) || root;
            var position = getComputedStyle( box ).position;
            if ( position === 'absolute' || position === 'fixed' ) {
                box.style.transform = 'scale(' + size + ')';
                box.style.transformOrigin = box.matches( '.ck-balloon-panel' ) ? 'top center'
                    : box.matches( '.tc-drop-down' ) ? 'top left' : 'center center';
                // A cap on the box's width (CKEditor 5's balloon: 96vw) holds before the scale - divided by it,
                // as for zoom below, or a scaled-down box is squeezed narrower than its own contents.
                box.style.removeProperty( 'max-width' );   // a host that reuses the box (CKEditor 5) would otherwise divide it again
                var cap = getComputedStyle( box ).maxWidth;
                if ( cap !== 'none' ) box.style.setProperty( 'max-width', 'calc(' + cap + ' / ' + size + ')', 'important' );
            } else {
                box.style.zoom = String( size );
                box.style.setProperty( 'max-width', 'calc(96vw / ' + size + ')', 'important' );   // still no wider than the window
            }
        }
        if ( insertSelect && design.insertAs && insertSelect.querySelector( 'option[value="' + design.insertAs + '"]' ) ) {
            insertSelect.value = design.insertAs;
        }
        if ( latexToggle && design.latex && !latexToggle.checked && !latexToggle.disabled ) {
            latexToggle.checked = true;
            latexToggle.dispatchEvent( new Event( 'change', { bubbles: true } ) );
        }
    }

    // Ready to type into, with its cursor showing: the MathView (or the LaTeX pane, when that is the
    // one showing) takes focus as the dialog opens - otherwise focus stays on whatever opened it.
    // The API draws the MathView's caret where the cursor is at that moment and only redraws it on an
    // edit or on focus, but a dialog goes on settling after it opens (fonts arrive, the toolbar fits
    // itself to its row) and moves the equation out from under it. Its focus handler only redraws
    // (the cursor stays where it is), so it is fired again whenever the editing area changes size.
    // The predictor (design.predictor): whole equations that start the way this one does - the API's
    // PredictorView - in a panel on the right of the editing area. The maths view and the markup pane
    // share one row with it, so it sits beside whichever is showing. The bar between them drags to
    // resize the panel, and its button (or Enter on the bar) folds it away; arrow keys resize it from
    // the keyboard. The width and whether it is folded are remembered in this browser.
    var PREDICTOR_WIDTH = 220, PREDICTOR_MIN = 140, PREDICTOR_KEY = 'cc-eqn-predictor';
    function addPredictor( root, design, textArea, mathView ) {
        if ( !root || !design || !design.predictor || typeof EqEditor === 'undefined' || !EqEditor.PredictorView ) return;
        var host = root.querySelector( '.CCMathViewHost' ), markup = root.querySelector( '.CCLatexInput' );
        var first = host || markup;
        if ( !first || root.querySelector( '.cc-eqn-work' ) ) return;
        injectPredictorStylesOnce();

        var saved = {};
        try { saved = JSON.parse( localStorage.getItem( PREDICTOR_KEY ) ) || {}; } catch ( e ) {}
        var width = Number( saved.width ) >= PREDICTOR_MIN ? Number( saved.width ) : PREDICTOR_WIDTH;

        var work = document.createElement( 'div' );
        work.className = 'cc-eqn-work';
        first.parentNode.insertBefore( work, first );
        var panes = document.createElement( 'div' );
        panes.className = 'cc-eqn-panes';
        if ( host ) panes.appendChild( host );
        if ( markup ) panes.appendChild( markup );

        var bar = document.createElement( 'div' );
        bar.className = 'cc-eqn-split';
        bar.tabIndex = 0;
        bar.setAttribute( 'role', 'separator' );
        bar.setAttribute( 'aria-orientation', 'vertical' );
        bar.setAttribute( 'aria-label', 'Resize the suggested equations' );
        var fold = document.createElement( 'button' );
        fold.type = 'button';
        fold.className = 'cc-eqn-split-fold';
        bar.appendChild( fold );

        var side = document.createElement( 'aside' );
        side.className = 'cc-eqn-predictor';
        side.id = root.id + '-predictor';
        side.setAttribute( 'aria-label', 'Suggested equations' );

        work.appendChild( panes );
        work.appendChild( bar );
        work.appendChild( side );

        function remember() {
            try { localStorage.setItem( PREDICTOR_KEY, JSON.stringify( { width: width, folded: work.classList.contains( 'cc-eqn-folded' ) } ) ); } catch ( e ) {}
        }
        function setWidth( w ) {
            // Never so wide that the editing area beside it has nothing left.
            var room = work.clientWidth - bar.offsetWidth - 160;
            width = Math.round( Math.max( PREDICTOR_MIN, room > PREDICTOR_MIN ? Math.min( w, room ) : w ) );
            side.style.width = width + 'px';
        }
        function setFolded( folded ) {
            work.classList.toggle( 'cc-eqn-folded', folded );
            fold.textContent = folded ? '‹' : '›';
            fold.title = folded ? 'Show suggested equations' : 'Hide suggested equations';
            bar.setAttribute( 'aria-expanded', folded ? 'false' : 'true' );
        }
        side.style.width = width + 'px';
        setFolded( !!saved.folded );

        fold.addEventListener( 'click', function () { setFolded( !work.classList.contains( 'cc-eqn-folded' ) ); remember(); } );
        bar.addEventListener( 'keydown', function ( e ) {
            if ( e.target !== bar ) return;
            if ( e.key === 'Enter' || e.key === ' ' ) {
                e.preventDefault(); setFolded( !work.classList.contains( 'cc-eqn-folded' ) ); remember();
            } else if ( ( e.key === 'ArrowLeft' || e.key === 'ArrowRight' ) && !work.classList.contains( 'cc-eqn-folded' ) ) {
                e.preventDefault(); setWidth( width + ( e.key === 'ArrowLeft' ? 20 : -20 ) ); remember();
            }
        } );
        // Dragged from anywhere on the bar but its button. Pointer movement is in screen pixels, which a
        // scaled dialog (design.dialogSize) does not share with the panel's own width - hence the ratio.
        bar.addEventListener( 'pointerdown', function ( e ) {
            if ( e.target === fold || e.button !== 0 ) return;
            e.preventDefault();
            var scale = work.getBoundingClientRect().width / ( work.offsetWidth || 1 ) || 1;
            var startX = e.clientX, startW = work.classList.contains( 'cc-eqn-folded' ) ? 0 : width;
            if ( startW === 0 ) { setFolded( false ); startW = PREDICTOR_MIN; setWidth( startW ); }
            bar.setPointerCapture( e.pointerId );
            work.classList.add( 'cc-eqn-dragging' );
            function move( ev ) { setWidth( startW + ( startX - ev.clientX ) / scale ); }
            function up() {
                bar.removeEventListener( 'pointermove', move );
                bar.removeEventListener( 'pointerup', up );
                bar.removeEventListener( 'pointercancel', up );
                work.classList.remove( 'cc-eqn-dragging' );
                remember();
            }
            bar.addEventListener( 'pointermove', move );
            bar.addEventListener( 'pointerup', up );
            bar.addEventListener( 'pointercancel', up );
        } );

        var show = design.predictorShow === 'latex' || design.predictorShow === 'both' ? design.predictorShow : 'mathml';
        var view = EqEditor.PredictorView.link( side.id, { limit: 6, show: show } ).addTextArea( textArea );
        if ( mathView ) view.addMathView( mathView );
    }

    // !important throughout: hosts reset their dialogs' contents (TinyMCE's .tox, CKEditor's
    // .ck-reset_all) more specifically than a plain class rule reaches.
    function injectPredictorStylesOnce() {
        if ( document.getElementById( 'cc-eqn-predictor-css' ) ) return;
        var style = document.createElement( 'style' );
        style.id = 'cc-eqn-predictor-css';
        style.textContent =
            '.cc-eqn-work { display: flex !important; flex: 1 1 auto !important; min-height: 0 !important; min-width: 0 !important; align-items: stretch !important; }' +
            '.cc-eqn-panes { display: flex !important; flex-direction: column !important; flex: 1 1 auto !important; min-width: 0 !important; min-height: 0 !important; }' +
            '.cc-eqn-split { flex: 0 0 auto !important; width: 9px !important; margin: 0 2px !important; cursor: col-resize !important; ' +
                'display: flex !important; align-items: center !important; justify-content: center !important; position: relative !important; ' +
                'background: transparent !important; touch-action: none !important; user-select: none !important; outline: none !important; }' +
            '.cc-eqn-split::before { content: "" !important; position: absolute !important; top: 0 !important; bottom: 0 !important; left: 4px !important; ' +
                'width: 1px !important; background: #d5dbe3 !important; }' +
            '.cc-eqn-split:hover::before, .cc-eqn-split:focus-visible::before, .cc-eqn-dragging .cc-eqn-split::before { left: 3px !important; width: 3px !important; background: var(--cc-accent, #003794) !important; }' +
            '.cc-eqn-split-fold { flex: 0 0 auto !important; position: relative !important; z-index: 1 !important; width: 16px !important; height: 34px !important; margin: 0 !important; padding: 0 !important; ' +
                'border: 1px solid #cbd5e0 !important; border-radius: 8px !important; background: #fff !important; color: #52606d !important; ' +
                'font: 14px/1 sans-serif !important; cursor: pointer !important; box-shadow: none !important; display: flex !important; align-items: center !important; justify-content: center !important; }' +
            '.cc-eqn-split-fold:hover { color: var(--cc-accent, #003794) !important; border-color: var(--cc-accent, #003794) !important; }' +
            // contain: size - the list's length is no reason for the dialog to grow; the panel takes the
            // editing area's height (stretched, as a flex item) and scrolls within it. layout, as the API
            // has it, keeps its search box anchored to the panel.
            '.cc-eqn-predictor { flex: 0 0 auto !important; min-width: 0 !important; min-height: 0 !important; overflow: auto !important; box-sizing: border-box !important; contain: size layout !important; }' +
            '.cc-eqn-folded .cc-eqn-predictor { display: none !important; }' +
            '.cc-eqn-dragging, .cc-eqn-dragging * { cursor: col-resize !important; user-select: none !important; }' +
            // The suggestions' maths set as the maths view's is: a host's reset (TinyMCE's .tox
            // :not(svg) { font-family: inherit; font-style: inherit }) outranks the API's .fxtex rules,
            // which left it in the dialog's sans-serif with its letters upright (the browser italicises
            // them through text-transform, which the reset takes too). Reverted to the browser's own
            // maths styling, as the maths view is, then the API's .fxtex rules re-asserted for the panel.
            '.cc-eqn-predictor math, .cc-eqn-predictor math * { font: revert-layer !important; text-transform: revert-layer !important; ' +
                'width: revert-layer !important; height: revert-layer !important; padding: revert-layer !important; margin: revert-layer !important; ' +
                'text-align: revert-layer !important; box-sizing: revert-layer !important; white-space: revert-layer !important; }';
        for ( var i = 0; i < document.styleSheets.length; i++ ) {
            var rules;
            try { rules = document.styleSheets[ i ].cssRules; } catch ( e ) { continue; }
            for ( var j = 0; j < rules.length; j++ ) {
                var r = rules[ j ], decls = '';
                var sel = r.selectorText && r.selectorText.replace( /:where\(\.fxEditor\)\s*/g, '' ).trim();
                if ( !sel || !/^\.fxtex\b/.test( sel ) || sel.indexOf( ',' ) > -1 ) continue;
                for ( var k = 0; k < r.style.length; k++ ) {
                    decls += r.style[ k ] + ':' + r.style.getPropertyValue( r.style[ k ] ) + ' !important;';
                }
                if ( decls ) style.textContent += '.cc-eqn-predictor ' + sel + '{' + decls + '}';
            }
        }
        document.head.appendChild( style );
    }

    function focusEditor( root ) {
        if ( !root ) return;
        var pane = root.querySelector( root.getAttribute( 'data-latex' ) === 'on' ? '.CCLatexInput' : '.CCMathView' );
        if ( pane ) pane.focus( { preventScroll: true } );
        var view = root.querySelector( '.CCMathView' ), host = view && view.parentElement;
        if ( host && !host.ccCaretWatch && typeof ResizeObserver !== 'undefined' ) {
            host.ccCaretWatch = new ResizeObserver( function () {
                var mv = host.querySelector( '.CCMathView' );
                if ( mv && document.activeElement === mv ) mv.dispatchEvent( new FocusEvent( 'focus' ) );
            } );
            host.ccCaretWatch.observe( host );
        }
    }

    function apiMathRules() {
        var out = '';
        for ( var i = 0; i < document.styleSheets.length; i++ ) {
            var rules;
            try { rules = document.styleSheets[ i ].cssRules; } catch ( e ) { continue; }
            for ( var j = 0; j < rules.length; j++ ) {
                var r = rules[ j ], decls = '';
                if ( !r.selectorText || !/(^|,)\s*(:where\(\.fxEditor\)\s*)?\.(fxtex|CCMathView)\b/.test( r.selectorText ) ) continue;
                for ( var k = 0; k < r.style.length; k++ ) {
                    decls += r.style[ k ] + ':' + r.style.getPropertyValue( r.style[ k ] ) + ' !important;';
                }
                if ( decls ) {
                    out += r.selectorText.replace( /:where\(\.fxEditor\)\s*/g, '' ).split( ',' ).map( function ( s ) {
                        s = s.trim();
                        return /^\.CCMathView\b/.test( s ) ? s : '.CCMathView ' + s;
                    } ).join( ',' ) + '{' + decls + '}';
                }
            }
        }
        return out;
    }

    // The same for the MathView's drawn caret and the area it is positioned in: TinyMCE's skin
    // (.tox :not(svg):not(rect) - position: static; width: auto; background) outranks the API's
    // own rules, and left alone the caret had no size, colour or place - no cursor at all. Every
    // declaration but display, which the API sets on the element itself to show and hide it.
    function apiCaretRules() {
        var out = '';
        for ( var i = 0; i < document.styleSheets.length; i++ ) {
            var rules;
            try { rules = document.styleSheets[ i ].cssRules; } catch ( e ) { continue; }
            for ( var j = 0; j < rules.length; j++ ) {
                var r = rules[ j ], decls = '';
                if ( !r.selectorText || !/\.CCMathView(Caret|Wrap)\b/.test( r.selectorText ) ) continue;
                for ( var k = 0; k < r.style.length; k++ ) {
                    if ( r.style[ k ] === 'display' ) continue;
                    decls += r.style[ k ] + ':' + r.style.getPropertyValue( r.style[ k ] ) + ' !important;';
                }
                if ( decls ) out += r.selectorText.replace( /:where\(\.fxEditor\)\s*/g, '' ) + '{' + decls + '}';
            }
        }
        return out;
    }

    var instanceCount = 0;

    tinymce.PluginManager.add( 'eqneditor', function ( editor ) {
        // Every part of the Equation Editor is addressed by element id, and previous versions
        // hard-coded 'toolbar', 'latexInput', 'output' and 'history'. Those are ordinary words
        // that a host page very often already owns, and two TinyMCE instances on one page
        // always collided. Each instance now gets its own ids; the styling comes from classes.
        var n = ++instanceCount;
        var ids = {
            root: 'cc-eqn-tm-' + n,
            history: 'cc-eqn-tm-history-' + n,
            toolbar: 'cc-eqn-tm-toolbar-' + n,
            mathview: 'cc-eqn-tm-mathview-' + n,
            latexInput: 'cc-eqn-tm-latex-' + n,
            output: 'cc-eqn-tm-output-' + n,
            toggleLatex: 'cc-eqn-tm-toggle-latex-' + n,
            toggleInline: 'cc-eqn-tm-toggle-inline-' + n,
            insertMode: 'cc-eqn-tm-insert-mode-' + n,
            size: 'cc-eqn-tm-size-' + n
        };

        var host = editor.getParam( 'eqneditor_server', DEFAULT_EDITOR_HOST );
        // A bare host means https; a full origin (e.g. http://localhost:8010 for local development) is used as it is.
        var origin = /^https?:\/\//.test( host ) ? host.replace( /\/+$/, '' ) : 'https://' + host;
        var renderUrl = editor.getParam( 'eqneditor_render_url', DEFAULT_RENDER_URL );
        var licence = editor.getParam( 'eqneditor_licence', '' );
        var design = editor.getParam( 'eqneditor_design', {} ) || {};

        var scriptUrl = editor.getParam(
            'eqneditor_script_url', origin + '/fxeditor.api.min.js' );
        var cssUrl = editor.getParam(
            'eqneditor_css_url', origin + '/fxeditor.css' );
        var mathmlCssUrl = editor.getParam(
            'eqneditor_mathml_css_url', origin + '/fxtex.css' );

        var apiReady = loadScriptOnce( scriptUrl );
        tinymce.DOM.loadCSS( cssUrl );
        tinymce.DOM.loadCSS( mathmlCssUrl );

        // Per-instance, so two editors on a page no longer overwrite each other's state -
        // these used to be implicit globals.
        var eqOutput = null;
        var eqTextArea = null;
        var eqMathView = null;
        var eqToolbar = null;

        editor.ui.registry.addIcon( 'cc-eqneditor-logo', '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="18px" height="20px" viewBox="0 0 18 20"><g><path d="M4,9.5H2L2.3,7h2.1l0.3-1.8C4.7,4.6,4.9,4.1,5,3.6c0.2-0.5,0.4-0.9,0.7-1.3c0.3-0.4,0.8-0.7,1.3-0.9C7.7,1.1,8.4,1,9.2,1c0.3,0,0.6,0,0.9,0c0.3,0,0.6,0.1,0.9,0.1l-0.5,2.7c-0.2-0.1-0.3-0.1-0.5-0.2c-0.1,0-0.3-0.1-0.5-0.1C9,3.7,8.6,3.8,8.4,4C8.1,4.2,7.9,4.7,7.8,5.4L7.6,7h2.3L9.5,9.5H7.2l-1.1,7.7H3L4,9.5z"/></g><g><path d="M11.1,15.3l-2.3-3.2h2.5l1.2,1.8l1.2-1.8H16l-2.2,3.2l2.6,3.6h-2.5l-1.5-2.3L10.8,19H8.4L11.1,15.3z"/></g></svg>' );

        function panelHtml() {
            return '' +
                '<div id="' + ids.root + '" class="CCEqnEditor" data-latex="off" data-inline="off">' +
                    '<div class="CCEditorBar">' +
                        '<div id="' + ids.history + '" class="CCHistory"></div>' +
                    '</div>' +
                    '<div id="' + ids.toolbar + '" class="CCToolbarHost"></div>' +
                    '<div id="' + ids.mathview + '" class="CCMathViewHost"></div>' +
                    // Hidden until the LaTeX toggle is on - see injectStyleOverridesOnce().
                    '<div id="' + ids.latexInput + '" class="CCLatexInput" autocorrect="off" ' +
                         'placeholder="Write LaTeX here..."></div>' +
                    // No rendered-equation preview in the dialog any more - MathView is the
                    // whole editing surface. eqOutput still needs a DOM element to bind to
                    // (it is what actually builds the SVG URL for the "Image (SVG)" insert
                    // mode), so the element stays, just not visible.
                    '<img id="' + ids.output + '" class="CCEqnOutput-hidden" alt="">' +
                    '<div class="CCBottomBar cc-eqn-bar">' +
                        '<label class="cc-switch" title="Left-align the equation instead of centring it">' +
                            '<input type="checkbox" id="' + ids.toggleInline + '">' +
                            '<span class="cc-switch-track"><span class="cc-switch-knob"></span></span>' +
                            '<span class="cc-switch-label">Inline</span>' +
                        '</label>' +
                        '<label class="cc-switch" title="Show or hide the LaTeX markup">' +
                            '<input type="checkbox" id="' + ids.toggleLatex + '">' +
                            '<span class="cc-switch-track"><span class="cc-switch-knob"></span></span>' +
                            '<span class="cc-switch-label">LaTeX markup</span>' +
                        '</label>' +
                        '<div class="cc-eqn-bar-right">' +
                            ( design.sizeControl
                                ? '<select class="cc-eqn-select" id="' + ids.size + '" title="This equation\'s size, against a normal one">' + sizeOptions() + '</select>'
                                : '' ) +
                            '<select class="cc-eqn-select" id="' + ids.insertMode + '" title="How to insert the equation">' +
                                '<option value="mathml" selected>Insert MathML</option>' +
                                '<option value="svg">Insert SVG</option>' +
                            '</select>' +
                            '<button type="button" class="cc-eqn-btn cc-cancel">Cancel</button>' +
                            '<button type="button" class="cc-eqn-btn cc-eqn-primary cc-ok">OK</button>' +
                        '</div>' +
                    '</div>' +
                '</div>';
        }

        function mount() {
            eqOutput = new EqEditor.Output( ids.output );
            eqOutput.setRenderURL( renderUrl );

            eqTextArea = EqEditor.TextArea.link( ids.latexInput )
                .addOutput( eqOutput )
                .addHistoryMenu( new EqEditor.History( ids.history ) );

            eqToolbar = EqEditor.Toolbar.link( ids.toolbar, design.toolbar || 'default', design.toolbarScale || 1 ).addTextArea( eqTextArea );

            // MathView arrived in the 5.x API. Guard rather than require it, so a site pinned
            // to an older bundle still gets the markup editor instead of a broken dialog.
            if ( typeof EqEditor.MathView !== 'undefined' ) {
                eqMathView = EqEditor.MathView.link( ids.mathview ).addTextArea( eqTextArea );
                eqToolbar.addMathView( eqMathView );
            } else {
                // Without a maths view the markup is the only thing to edit in - force it
                // visible however the dialog would otherwise have started.
                document.getElementById( ids.root ).setAttribute( 'data-latex', 'on' );
                document.getElementById( ids.toggleLatex ).checked = true;
                document.getElementById( ids.toggleLatex ).disabled = true;
            }

            var nodes = document.getElementById( ids.history ).childNodes;
            for ( var i = 0; i < nodes.length; i++ ) {
                if ( nodes[ i ].style ) {
                    nodes[ i ].style.padding = 'revert';
                }
            }

            document.getElementById( ids.toggleLatex ).addEventListener( 'change', function ( e ) {
                var visible = e.target.checked;
                var root = document.getElementById( ids.root );
                root.setAttribute( 'data-latex', visible ? 'on' : 'off' );
                // Hiding the maths view has to move the toolbar's target back to the LaTeX
                // box, and vice versa, otherwise a button pressed straight afterwards inserts
                // into a hidden pane.
                eqToolbar.setActiveTextArea( visible ? eqTextArea : ( eqMathView || eqTextArea ) );
            } );

            document.getElementById( ids.toggleInline ).addEventListener( 'change', function ( e ) {
                var inline = e.target.checked;
                document.getElementById( ids.root ).setAttribute( 'data-inline', inline ? 'on' : 'off' );
                if ( eqMathView ) eqMathView.setInline( inline );
                eqOutput.setInline( inline );
            } );

            addPredictor( document.getElementById( ids.root ), design, eqTextArea, eqMathView );
            applyDesign( document.getElementById( ids.root ), design,
                document.getElementById( ids.toggleLatex ), document.getElementById( ids.insertMode ) );
        }

        /**
         * The equation, in whichever of the two forms the "Insert as" dropdown is set to.
         *
         * TinyMCE filters content it does not recognise, and <math> is not in its default
         * element list - registerMathmlSchema() below teaches it to keep MathML rather than
         * silently stripping it.
         */
        function buildInsert() {
            var mode = document.getElementById( ids.insertMode ).value;

            if ( mode === 'svg' ) {
                var latex = eqTextArea.getTextArea().textContent.trim();
                // referrerpolicy="origin" rather than leaving it to the page's own
                // Referrer-Policy: latex.codecogs.com identifies the calling site by referer,
                // and a page with a stricter policy (or none at all, on some browsers'
                // defaults) would otherwise send none at all.
                return '<img class="fxtex" src="' + escapeHtml( eqOutput.exportAs( 'url' ) ) + '" ' +
                    'alt="' + escapeHtml( latex ) + '" referrerpolicy="origin"' + sizeImage( eqOutput, function ( mark, size ) {
                    var img = editor.dom.select( 'img[data-cc-size="' + mark + '"]' )[ 0 ];
                    if ( !img ) return;
                    if ( size ) editor.dom.setStyles( img, { width: size.width, height: size.height } );
                    editor.dom.setAttrib( img, 'data-cc-size', null );
                } ) + '>';
            }

            return eqOutput.exportAs( 'mathml' );
        }

        // `el`, when editing: the equation on the page, whose size the dialog starts from.
        function showDialog( latex, el ) {
            latex = latex || '';
            var startSize = 1;

            var dialog = editor.windowManager.open( {
                title: 'Equation Editor',
                size: 'large',
                body: {
                    type: 'panel',
                    items: [ { type: 'htmlpanel', html: panelHtml() } ]
                },
                buttons: [],
                onClose: function () {
                    // The suggestion list is appended to the document body rather than to the
                    // dialog, so it outlives the dialog unless it is dismissed explicitly.
                    if ( eqTextArea ) {
                        eqTextArea.close();
                    }
                }
            } );

            function doInsert() {
                var current = eqTextArea ? eqTextArea.getTextArea().textContent.trim() : '';
                if ( current ) {
                    if ( eqOutput.setEquationSize ) {
                        var sizeSelect = document.getElementById( ids.size );
                        eqOutput.setEquationSize( sizeSelect ? Number( sizeSelect.value ) / 100 : startSize );
                    }
                    editor.execCommand( 'mceInsertContent', false, buildInsert() );
                    eqTextArea.pushToHistory();
                }
                dialog.close();
            }

            // The dialog's DOM exists as soon as open() returns, but the Equation Editor's own
            // code may still be downloading - hence the wait. Clicking the toolbar button and
            // the script arriving used to be a race the user could lose.
            //
            // The editor is rebuilt on every open rather than cached: TinyMCE destroys a
            // dialog's DOM when it closes and builds fresh elements next time, so anything
            // held over from the previous open would be pointing at detached nodes - which
            // showed up as a second open with no toolbar and no maths view at all.
            apiReady.then( function () { return ensureInit( licence ); } ).then( function () {
                injectStyleOverridesOnce( cssUrl.slice( 0, cssUrl.lastIndexOf( '/' ) + 1 ) + 'prototypes/latinmodern-math.otf' );
                mount();
                startSize = sizeOf( el );
                showSize( document.getElementById( ids.size ), startSize );

                eqTextArea.clear();
                if ( latex ) {
                    eqTextArea.insert( latex, latex.length );
                }
                eqTextArea.notifyOutputs();
                focusEditor( document.getElementById( ids.root ) );

                document.getElementById( ids.root ).querySelector( '.cc-cancel' )
                    .addEventListener( 'click', function () { dialog.close(); } );
                document.getElementById( ids.root ).querySelector( '.cc-ok' )
                    .addEventListener( 'click', doInsert );
            } ).catch( function ( err ) {
                console.error( err );
                dialog.close();
                editor.notificationManager.open( {
                    text: 'The CodeCogs Equation Editor could not be loaded.',
                    type: 'error'
                } );
            } );
        }

        editor.ui.registry.addButton( 'eqneditor', {
            icon: 'cc-eqneditor-logo',
            tooltip: 'Insert Equation',
            onAction: function () { showDialog(); }
        } );

        editor.ui.registry.addMenuItem( 'eqneditor', {
            icon: 'cc-eqneditor-logo',
            text: 'Equation...',
            onAction: function () { showDialog(); }
        } );

        // TinyMCE filters out elements its schema does not know, and <math> is in no stock
        // configuration - so inserting MathML without allowing it produces an insert that
        // silently does nothing. The plugin registers them itself rather than asking every
        // integrator to paste a list of MathML element names into extended_valid_elements:
        // this plugin is the thing producing the markup, so it is the thing that should teach
        // the editor to keep it. PreInit is the hook - the schema is built by then and has not
        // yet been used to filter anything.
        editor.on( 'PreInit', function () {
            if ( !editor.schema || typeof editor.schema.addValidElements !== 'function' ) {
                console.warn( 'eqneditor: this TinyMCE build cannot be taught about <math>; ' +
                    'MathML equations may be stripped on insert - use the SVG insert mode instead.' );
                return;
            }

            // [*] keeps every attribute: MathML carries meaning in its attributes (display,
            // mathvariant, stretchy, the accessible label on the wrapper), and a filtered-down
            // version of an equation is a wrong equation.
            editor.schema.addValidElements(
                MATHML_ELEMENTS.map( function ( name ) { return name + '[*]'; } ).join( ',' ) );

            // The wrapper the converter puts the spoken text on.
            editor.schema.addValidElements( 'span[class|role|aria-label|aria-hidden]' );

            // img's default schema rule doesn't include referrerpolicy - without registering
            // it, TinyMCE's content sanitiser silently strips it from every inserted equation
            // image, and latex.codecogs.com stops being able to identify the referring site.
            //
            // schema.addValidElements('img[referrerpolicy]') looks like the right call, but for
            // an element the schema already has a rule for, it *replaces* that rule rather than
            // extending it - tried first, and confirmed by inspecting schema.getElementRule
            // ('img').attributes afterwards: it left referrerpolicy as the only valid attribute
            // on img, silently stripping src/alt/width/height from every image already on the
            // page. Mutating the existing rule directly is the only way to add one attribute
            // without discarding the rest of it.
            var imgRule = editor.schema.getElementRule( 'img' );
            if ( imgRule && imgRule.attributes && !imgRule.attributes.referrerpolicy ) {
                imgRule.attributes.referrerpolicy = {};
                imgRule.attributesOrder.push( 'referrerpolicy' );
            }
        } );

        // Double-click an equation to edit it again.
        editor.on( 'dblclick', function ( e ) {
            var target = e.target;
            if ( !target ) return;

            // An image equation: the LaTeX comes back out of the rendering request that
            // produced it.
            if ( target.nodeName.toLowerCase() === 'img' ) {
                var match = target.src.match( /(gif|svg|png)\.image\?(.*)/ );
                if ( match ) showDialog( decodeEquation( match[ 2 ] ), target );
                return;
            }

            // A MathML equation. The converter writes the source LaTeX into the <math>
            // element's own title, so an equation carries what it was written from and can be
            // reopened without anyone parsing MathML back into LaTeX.
            var math = target.closest && target.closest( 'math[title]' );
            if ( math ) {
                var latex = math.getAttribute( 'title' ).trim();
                if ( latex ) showDialog( latex, math );
            }
        } );

        return {
            getMetadata: function () {
                return {
                    name: 'CodeCogs Equation Editor',
                    url: 'https://editor.codecogs.com/docs/3-Tiny_MCE_v6.php'
                };
            }
        };
    } );
}() );
