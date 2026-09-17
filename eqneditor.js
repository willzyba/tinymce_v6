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
 *       eqneditor_server: 'editor.codecogs.com',    // where the editor's own code is served from
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

    var DEFAULT_EDITOR_HOST = 'editor.codecogs.com';
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

    // Gaps in the shared eqneditor.css (loaded separately, asynchronously, from the host
    // configured below) this dialog needs but can't assume it will get:
    //  - editor.codecogs.com, the default host, currently serves an older stylesheet that
    //    predates the CCEqnEditor/CCMathViewHost/CCLatexInput class names entirely (only a
    //    local dev mirror does not have this gap), so the LaTeX/maths mutual-exclusion and the
    //    layout below are written defensively rather than left to eqneditor.css;
    //  - this dialog has no rendered-equation preview and no LaTeX box visible by default (see
    //    panelHtml()), so the maths view needs to fill the space between the toolbar and the
    //    bottom bar itself, which nothing outside this plugin has an opinion on.
    // Injected once, since it would otherwise race eqneditor.css over which rule wins.
    function injectStyleOverridesOnce() {
        if ( document.getElementById( 'cc-eqneditor-style-overrides' ) ) return;
        var style = document.createElement( 'style' );
        style.id = 'cc-eqneditor-style-overrides';
        style.textContent =
            '.CCEqnEditor { display: flex !important; flex-direction: column !important; ' +
                'height: 520px !important; }' +
            '.CCEqnEditor .CCEditorBar, .CCEqnEditor .CCToolbarHost { flex: 0 0 auto; }' +
            '.CCEqnEditor .CCMathViewHost { ' +
                'flex: 1 1 auto; min-height: 0; display: flex; align-items: center; ' +
                'justify-content: center; overflow: auto; }' +
            '.CCEqnEditor[data-inline="on"] .CCMathViewHost { justify-content: flex-start; }' +
            '.CCEqnEditor[data-latex="on"] .CCMathViewHost { display: none !important; }' +
            '.CCEqnEditor .CCLatexInput { flex: 1 1 auto; min-height: 0; overflow: auto; }' +
            '.CCEqnEditor[data-latex="off"] .CCLatexInput { display: none !important; }' +
            '.CCEqnEditor .CCEqnOutput-hidden { display: none !important; }' +
            '.CCBottomBar { flex: 0 0 auto; display: flex; align-items: center; gap: 16px; ' +
                'padding-top: 10px; margin-top: 8px; border-top: 1px solid #e2e8f0; }' +
            '.CCBottomBar select { font-size: 13px; padding: 4px 6px; }' +
            '.CCBottomBar-actions { margin-left: auto; display: flex; gap: 8px; }' +
            '.CCBottomBar-actions button { padding: 6px 18px; border-radius: 4px; ' +
                'border: 1px solid #cbd5e0; background: #fff; cursor: pointer; font-size: 13px; }' +
            '.CCBottomBar-actions button.cc-primary { background: #2c7a4b; ' +
                'border-color: #2c7a4b; color: #fff; }' +
            '.tox-dialog:has(.CCEqnEditor) { width: 850px !important; max-width: 96vw !important; }';
        document.head.appendChild( style );
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
            insertMode: 'cc-eqn-tm-insert-mode-' + n
        };

        var host = editor.getParam( 'eqneditor_server', DEFAULT_EDITOR_HOST );
        var renderUrl = editor.getParam( 'eqneditor_render_url', DEFAULT_RENDER_URL );

        var scriptUrl = editor.getParam(
            'eqneditor_script_url', 'https://' + host + '/eqneditor.api.min.js' );
        var cssUrl = editor.getParam(
            'eqneditor_css_url', 'https://' + host + '/eqneditor.css' );
        var mathmlCssUrl = editor.getParam(
            'eqneditor_mathml_css_url', 'https://' + host + '/fxtex.css' );

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
                    '<div class="CCBottomBar">' +
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
                        '<select id="' + ids.insertMode + '" title="How to insert the equation">' +
                            '<option value="mathml" selected>Insert as MathML</option>' +
                            '<option value="svg">Insert as image (SVG)</option>' +
                        '</select>' +
                        '<div class="CCBottomBar-actions">' +
                            '<button type="button" class="cc-cancel">Cancel</button>' +
                            '<button type="button" class="cc-primary cc-ok">Ok</button>' +
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

            eqToolbar = EqEditor.Toolbar.link( ids.toolbar, 'default', 1.4 ).addTextArea( eqTextArea );

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
                return '<img src="' + escapeHtml( eqOutput.exportAs( 'url' ) ) + '" ' +
                    'alt="' + escapeHtml( latex ) + '" referrerpolicy="origin">';
            }

            return eqOutput.exportAs( 'mathml' );
        }

        function showDialog( latex ) {
            latex = latex || '';

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
            apiReady.then( function () {
                injectStyleOverridesOnce();
                mount();

                eqTextArea.clear();
                if ( latex ) {
                    eqTextArea.insert( latex, latex.length );
                }
                eqTextArea.notifyOutputs();

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
                if ( match ) showDialog( decodeEquation( match[ 2 ] ) );
                return;
            }

            // A MathML equation. The converter writes the source LaTeX into the <math>
            // element's own title, so an equation carries what it was written from and can be
            // reopened without anyone parsing MathML back into LaTeX.
            var math = target.closest && target.closest( 'math[title]' );
            if ( math ) {
                var latex = math.getAttribute( 'title' ).trim();
                if ( latex ) showDialog( latex );
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
