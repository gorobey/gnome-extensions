/*
    Hide Panel with smart rules
    - Bar hidden if a window is maximized
    - Bar go hidden when a windows is dragged close to the top bar
    - Bar always visible in Overview
    - Bar visible if the mouse stays at the top for a minimum time
    - Bar remains visible when the mouse is over the bar or menus
    - Bar disappears after 300ms when the mouse leaves the sensitive area and the bar
    - Bar remains visible if a menu is open
*/

const Main = imports.ui.main;
const Panel = Main.panel;
const Meta = imports.gi.Meta;
const Overview = Main.overview;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;

const panel_height = Panel.get_height();
const proximity = panel_height + 50;

class Extension {
    constructor() {

        this._signals = [];
        this._hotArea = null;

        this._enterDelay = 0;
        this._leaveDelay = 750;

        this._mouseInside = false;
        this._inPanel = false;

        this._enterTimeoutId = null;
        this._leaveTimeoutId = null;
        this._updateLoop = null;
    }

    _show_panel() {
        if (this._panelAnimating) return;
        this._panelAnimating = true;
        Panel.show();
        Panel.ease({
            y: 0,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            onComplete: () => {
                this._panelAnimating = false;
            }
        });
    }

    _hide_panel() {
        if (this._panelAnimating) return;
        this._panelAnimating = true;
        Panel.ease({
            y: - panel_height,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            onComplete: () => {
                Panel.hide();
                this._panelAnimating = false;
            }
        });
    }

    _any_window_blocks_panel() {

        // Ottieni l'indice del monitor della barra (qui si assume monitor principale)
        const panelMonitor = Main.layoutManager.primaryIndex;

        const windows = global.get_window_actors()
            .map(a => a.meta_window)
            .filter(w =>
                w &&
                w.get_window_type() === Meta.WindowType.NORMAL &&
                w.showing_on_its_workspace() &&
                w.get_monitor() === panelMonitor // Solo finestre sullo stesso monitor della barra
            );

        for (let w of windows) {
            if (w.get_maximized() === Meta.MaximizeFlags.BOTH)
                return true;
            const rect = w.get_frame_rect();
            if (rect.y <= proximity)
                return true;
        }
        return false;
    }

    _update_panel_visibility() {
        // aggiorna lo stato reale del mouse
        let [x, y] = global.get_pointer();

        this._mouseInside = (y <= 5 && x > 0) || this._inPanel;

        // Caso 0: lock screen → barra sempre nascosta
        if (Main.screenShield.locked) {
            console.log('Nascondo: lock screen');
            this._hide_panel();
            return;
        }

        // Caso 1: Overview → barra sempre visibile
        if (Overview.visible) {
            console.log('Mostro: overview');
            this._show_panel();
            return;
        }

        // Caso 2: Menu aperto → barra visibile
        for (let name in Panel.statusArea) {
            const item = Panel.statusArea[name];
            if (item.menu && item.menu.isOpen) {
                console.log('Mostro: Menu aperto');
                this._show_panel();
                return;
            }
        }

        // Caso 3: Mouse dentro hot area o barra → barra visibile
        if (this._mouseInside && (global.display.get_grab_op() !== Meta.GrabOp.MOVING)) {
            console.log('Mostro: mouse dentro hot area o barra + no drag');
            this._show_panel();
            return;
        }

        // Caso 4: finestre che bloccano → barra nascosta
        if (this._any_window_blocks_panel()) {
            console.log('Nascondo: finestra massimizzata o vicino alla barra');
            this._hide_panel();
            return;
        }

        // Caso 5: default
        console.log('Mostro: default');
        this._show_panel();
    }

    _connect(obj, signal, handler) {
        const id = obj.connect(signal, handler);
        this._signals.push([obj, id]);
    }

    _createHotArea() {
        this._hotArea = new St.Widget({
            reactive: true,
            can_focus: false,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: 2,
            opacity: 0
        });

        Main.layoutManager.addTopChrome(this._hotArea);

        this._connect(this._hotArea, 'enter-event', () => this._startEnterTimer());
        this._connect(this._hotArea, 'leave-event', () => this._startLeaveTimer());

        // Barra
        this._connect(Panel, 'enter-event', () => {
            this._inPanel = true;
            this._cancelLeaveTimer();
        });
        this._connect(Panel, 'leave-event', () => {
            this._inPanel = false;
            this._startLeaveTimer();
        });

        // Menu topbar
        for (let name in Panel.statusArea) {
            const item = Panel.statusArea[name];
            if (!item.actor) continue;

            this._connect(item.actor, 'enter-event', () => {
                this._inPanel = true;
                this._cancelLeaveTimer();
            });
            this._connect(item.actor, 'leave-event', () => {
                this._inPanel = false;
                this._startLeaveTimer();
            });
            this._connect(Main.screenShield, 'locked', () => this._update_panel_visibility());
            this._connect(Main.screenShield, 'unlocked', () => this._update_panel_visibility());
        }

        // aggiorna larghezza quando cambia risoluzione
        this._connect(global.stage, 'notify::width', () => {
            this._hotArea.width = global.stage.width;
        });
    }

    _startEnterTimer() {
        // cancella timer di uscita
        this._cancelLeaveTimer();

        if (!this._enterTimeoutId) {
            this._enterTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._enterDelay, () => {
                this._update_panel_visibility();
                this._enterTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _startLeaveTimer() {
        this._cancelEnterTimer();
        if (!this._leaveTimeoutId) {
            this._leaveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._leaveDelay, () => {
                this._update_panel_visibility();
                this._leaveTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _cancelEnterTimer() {
        if (this._enterTimeoutId) {
            GLib.source_remove(this._enterTimeoutId);
            this._enterTimeoutId = null;
        }
    }

    _cancelLeaveTimer() {
        if (this._leaveTimeoutId) {
            GLib.source_remove(this._leaveTimeoutId);
            this._leaveTimeoutId = null;
        }
    }

    enable() {
        this._createHotArea();
        // Polling continuo per gestione lock screen, multi-finestra e workspace changes
        this._updateLoop = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._update_panel_visibility();
            return GLib.SOURCE_CONTINUE;
        });

        // Overview
        this._connect(Overview, 'showing', () => this._show_panel());
        this._connect(Overview, 'hiding', () => this._update_panel_visibility());

        // Cambio focus finestre
        this._connect(global.display, 'notify::focus-window', () => this._update_panel_visibility());

        // Creazione nuove finestre
        this._connect(global.display, 'window-created', (display, window) => {
            this._connect(window, 'notify::maximized-horizontally', () => this._update_panel_visibility());
            this._connect(window, 'notify::maximized-vertically', () => this._update_panel_visibility());
            this._connect(window, 'size-changed', () => this._update_panel_visibility());
            this._connect(window, 'position-changed', () => this._update_panel_visibility());
            this._connect(window, 'unmanaged', () => this._update_panel_visibility());
        });

        this._update_panel_visibility();
    }

    disable() {
        for (let [obj, id] of this._signals) {
            if (obj && id) obj.disconnect(id);
        }
        this._signals = [];

        if (this._hotArea) {
            Main.layoutManager.removeChrome(this._hotArea);
            this._hotArea.destroy();
            this._hotArea = null;
        }

        this._cancelEnterTimer();
        this._cancelLeaveTimer();

        if (this._updateLoop) {
            GLib.source_remove(this._updateLoop);
            this._updateLoop = null;
        }

        this._show_panel();
    }
}

function init() {
    return new Extension();
}