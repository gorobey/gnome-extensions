/* 
    Hide Panel with smart rules
    - Bar hidden if a window is maximized or overlaps the top bar
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

class Extension {
    constructor() {
        this.panel_height = Panel.get_height();
        this._signals = [];
        this._hotArea = null;

        // Flags mouse
        this._inHotArea = false;
        this._inPanel = false;
        this._mouseInside = false;

        // timers
        this._enterTimeoutId = null;
        this._leaveTimeoutId = null;

        // config
        this._enterDelay = 300;   // ms permanenza prima di mostrare
        this._leaveDelay = 300;   // ms prima di nascondere
    }

    _any_window_blocks_panel() {
        const windows = global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(w => w && w.get_window_type() === Meta.WindowType.NORMAL && w.showing_on_its_workspace());

        for (let w of windows) {
            // finestra massimizzata?
            if (w.get_maximized() === Meta.MaximizeFlags.BOTH) {
                return true;
            }
            // finestra che invade lo spazio della topbar?
            let rect = w.get_frame_rect();
            if (rect.y <= this.panel_height) {
                return true;
            }
        }
        return false;
    }

    _update_panel_visibility() {
        // aggiorna lo stato reale del mouse
        this._mouseInside = this._inHotArea || this._inPanel;

        // Caso 1: Overview → barra sempre visibile
        if (Overview.visible) {
            Panel.show();
            return;
        }

        // Caso 2: Menu aperto → barra visibile
        for (let name in Panel.statusArea) {
            const item = Panel.statusArea[name];
            if (item.menu && item.menu.isOpen) {
                Panel.show();
                return;
            }
        }

        // Caso 3: Mouse dentro hot area o barra → barra visibile
        if (this._mouseInside) {
            Panel.show();
            return;
        }

        // Caso 4: finestre che bloccano → barra nascosta
        if (this._any_window_blocks_panel()) {
            Panel.hide();
            return;
        }

        // Caso 5: default → barra visibile
        Panel.show();
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
            height: 5, // zona sensibile
            opacity: 0, // invisibile
        });

        Main.layoutManager.addTopChrome(this._hotArea);

        // Hot area
        this._connect(this._hotArea, 'enter-event', () => {
            this._inHotArea = true;
            this._startEnterTimer();
        });

        this._connect(this._hotArea, 'leave-event', () => {
            this._inHotArea = false;
            this._startLeaveTimer();
        });

        // La barra stessa è zona attiva
        this._connect(Panel, 'enter-event', () => {
            this._inPanel = true;
            this._cancelLeaveTimer();
            this._update_panel_visibility();
        });

        this._connect(Panel, 'leave-event', () => {
            this._inPanel = false;
            this._startLeaveTimer();
        });

        // I menu della barra devono considerarsi zona attiva
        for (let name in Panel.statusArea) {
            const item = Panel.statusArea[name];
            if (!item.actor) continue;

            this._connect(item.actor, 'enter-event', () => {
                this._inPanel = true;
                this._cancelLeaveTimer();
                this._mouseInside = true;
                this._update_panel_visibility();
            });

            this._connect(item.actor, 'leave-event', () => {
                this._inPanel = false;
                this._startLeaveTimer();
            });
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
            this._enterTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                this._enterDelay,
                () => {
                    this._mouseInside = this._inHotArea || this._inPanel;
                    this._update_panel_visibility();
                    this._enterTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    _startLeaveTimer() {
        if (this._enterTimeoutId) {
            GLib.source_remove(this._enterTimeoutId);
            this._enterTimeoutId = null;
        }

        if (!this._leaveTimeoutId) {
            this._leaveTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                this._leaveDelay,
                () => {
                    this._mouseInside = this._inHotArea || this._inPanel;
                    this._update_panel_visibility();
                    this._leaveTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }
            );
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

        this._connect(Overview, 'showing', () => this._show_panel());
        this._connect(Overview, 'hiding', () => this._update_panel_visibility());

        this._connect(global.display, 'notify::focus-window', () => this._update_panel_visibility());

        // Creazione nuove finestre
        this._connect(global.display, 'window-created', (display, window) => {
            this._connect(window, 'notify::maximized-horizontally', () => this._update_panel_visibility());
            this._connect(window, 'notify::maximized-vertically', () => this._update_panel_visibility());
            this._connect(window, 'size-changed', () => this._update_panel_visibility());
            this._connect(window, 'position-changed', () => this._update_panel_visibility());
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

        if (this._enterTimeoutId) {
            GLib.source_remove(this._enterTimeoutId);
            this._enterTimeoutId = null;
        }
        if (this._leaveTimeoutId) {
            GLib.source_remove(this._leaveTimeoutId);
            this._leaveTimeoutId = null;
        }

        this._show_panel();
    }
}

function init() {
    return new Extension();
}
