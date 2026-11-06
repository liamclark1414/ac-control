import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ACSimulator} from './simulator.js';

const TICK_SECONDS = 2;

// Temperature (°F) -> color. Blue when cold, sky, amber, red when hot.
const COLOR_STOPS = [
    [62, [59, 130, 246]],   // blue
    [70, [94, 200, 242]],   // sky
    [76, [245, 184, 61]],   // amber
    [84, [239, 68, 68]],    // red
];
// The bar under each room spans this range.
const BAR_MIN = 60;
const BAR_MAX = 88;

// A room is "at target" when within this many °F.
const AT_TARGET = 0.5;

// Icon per room name; anything else gets a house.
const ROOM_ICONS = {
    'Master Bed': 'weather-clear-night-symbolic',
    'Bedroom 2': 'weather-clear-night-symbolic',
    'Basement': 'go-down-symbolic',
    'Kitchen 1': 'emoji-food-symbolic',
};

function tempColor(temp) {
    const first = COLOR_STOPS[0], last = COLOR_STOPS[COLOR_STOPS.length - 1];
    if (temp <= first[0])
        return first[1];
    if (temp >= last[0])
        return last[1];
    for (let i = 1; i < COLOR_STOPS.length; i++) {
        const [t1, c1] = COLOR_STOPS[i];
        const [t0, c0] = COLOR_STOPS[i - 1];
        if (temp <= t1) {
            const f = (temp - t0) / (t1 - t0);
            return c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
        }
    }
    return last[1];
}

const rgb = c => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

// What a room is doing right now: {text, icon}.
function roomStatus(power, room) {
    if (!power)
        return {text: 'Off', icon: null};
    const diff = room.temp - room.target;
    if (diff > AT_TARGET)
        return {text: `Cooling · ${diff.toFixed(1)}° to go`, icon: 'go-down-symbolic'};
    if (diff < -AT_TARGET)
        return {text: `Heating · ${(-diff).toFixed(1)}° to go`, icon: 'go-up-symbolic'};
    return {text: 'At target', icon: 'object-select-symbolic'};
}

const ACIndicator = GObject.registerClass(
class ACIndicator extends PanelMenu.Button {
    _init(ac) {
        super._init(0.0, 'AC Control');
        this._ac = ac;
        this._lastPower = null;
        this.menu.box.add_style_class_name('ac-menu');

        // --- Top bar: icon + average temperature ---
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'weather-snow-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._icon);
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._buildHeader();

        // --- Power switch ---
        this._powerItem = new PopupMenu.PopupSwitchMenuItem('Air conditioner', ac.power);
        this._powerItem.connect('toggled', (_item, on) => {
            this._ac.setPower(on);
            this._sync();
        });
        // By default, clicking a menu item closes the menu. Just flip the switch instead.
        this._powerItem.activate = () => this._powerItem.toggle();
        this.menu.addMenuItem(this._powerItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Rooms'));

        // --- One row per room ---
        this._roomRows = ac.rooms.map((room, i) => this._buildRoomRow(room, i));

        this._sync();
    }

    // Big house-average temperature with a summary line next to it.
    _buildHeader() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('ac-header');

        this._headerTemp = new St.Label({
            style_class: 'ac-header-temp',
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(this._headerTemp);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(new St.Label({text: 'House average', style_class: 'ac-header-title'}));
        this._headerSummary = new St.Label({style_class: 'ac-header-summary'});
        text.add_child(this._headerSummary);
        item.add_child(text);

        this.menu.addMenuItem(item);
    }

    _buildRoomRow(room, i) {
        const item = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        item.add_style_class_name('ac-room-row');

        // Everything stacks vertically: the top line, then the bar.
        const body = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'ac-room-body',
        });
        item.add_child(body);

        const top = new St.BoxLayout({x_expand: true, style_class: 'ac-room-top'});
        body.add_child(top);

        // Round colored badge with the room icon.
        const badgeIcon = new St.Icon({
            icon_name: ROOM_ICONS[room.name] ?? 'user-home-symbolic',
            icon_size: 16,
        });
        const badge = new St.Bin({
            style_class: 'ac-room-badge',
            child: badgeIcon,
            y_align: Clutter.ActorAlign.CENTER,
        });
        top.add_child(badge);

        // Name, then "79.0°F  ↓ Cooling · 2.4° to go".
        const info = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        info.add_child(new St.Label({text: room.name, style_class: 'ac-room-name'}));
        const sub = new St.BoxLayout({style_class: 'ac-room-sub'});
        const current = new St.Label({
            style_class: 'ac-room-current',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const statusIcon = new St.Icon({
            icon_size: 12,
            style_class: 'ac-room-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const statusLabel = new St.Label({
            style_class: 'ac-room-status',
            y_align: Clutter.ActorAlign.CENTER,
        });
        statusLabel.opacity = 170;
        statusIcon.opacity = 170;
        sub.add_child(current);
        sub.add_child(statusIcon);
        sub.add_child(statusLabel);
        info.add_child(sub);
        top.add_child(info);

        // - target +
        const target = new St.Label({
            style_class: 'ac-target-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        target.set_pivot_point(0.5, 0.5);
        top.add_child(this._makeButton('list-remove-symbolic', i, -1, target));
        top.add_child(target);
        top.add_child(this._makeButton('list-add-symbolic', i, 1, target));

        // Gradient bar: dot = current temperature, tick = target.
        const bar = new St.DrawingArea({style_class: 'ac-temp-bar', x_expand: true});
        bar.connect('repaint', area => this._drawBar(area, this._ac.rooms[i]));
        body.add_child(bar);

        this.menu.addMenuItem(item);
        return {body, badge, badgeIcon, current, statusIcon, statusLabel, target, bar};
    }

    _makeButton(iconName, roomIndex, delta, targetLabel) {
        const button = new St.Button({
            style_class: 'icon-button ac-temp-button',
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => {
            this._ac.adjustTarget(roomIndex, delta);
            this._sync();
            // Little "pop" so the change is noticeable.
            targetLabel.remove_all_transitions();
            targetLabel.set_scale(1.25, 1.25);
            targetLabel.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        });
        return button;
    }

    _drawBar(area, room) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const pad = 6;               // room for the dot at the ends
        const trackH = 4;
        const y = h / 2;
        const xFor = t => {
            const f = (Math.min(BAR_MAX, Math.max(BAR_MIN, t)) - BAR_MIN) / (BAR_MAX - BAR_MIN);
            return pad + f * (w - 2 * pad);
        };

        // Track: rounded line with the same blue->red stops as the text colors.
        const grad = new Cairo.LinearGradient(pad, 0, w - pad, 0);
        for (const [t, c] of COLOR_STOPS) {
            const f = (t - BAR_MIN) / (BAR_MAX - BAR_MIN);
            grad.addColorStopRGBA(f, c[0] / 255, c[1] / 255, c[2] / 255, this._ac.power ? 0.85 : 0.35);
        }
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(trackH);
        cr.moveTo(pad, y);
        cr.lineTo(w - pad, y);
        cr.setSource(grad);
        cr.stroke();

        // Target: small vertical tick.
        const tx = xFor(room.target);
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.setLineWidth(2);
        cr.moveTo(tx, y - 6);
        cr.lineTo(tx, y + 6);
        cr.stroke();

        // Current: dot in the room's color with a white ring.
        const c = tempColor(room.temp);
        const cx = xFor(room.temp);
        cr.arc(cx, y, 5, 0, 2 * Math.PI);
        cr.setSourceRGBA(c[0] / 255, c[1] / 255, c[2] / 255, 1);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.setLineWidth(2);
        cr.stroke();

        cr.$dispose();
    }

    // Update every label/icon from the simulator's current state.
    _sync() {
        const {power, rooms} = this._ac;
        const avg = this._ac.averageTemp();
        const avgColor = tempColor(avg);

        // Top bar
        this._panelLabel.text = `${Math.round(avg)}°F`;
        this._icon.opacity = power ? 255 : 120;
        this._icon.style = power ? `color: ${rgb(avgColor)};` : null;
        this._powerItem.setToggleState(power);

        // Header
        this._headerTemp.text = `${Math.round(avg)}°`;
        this._headerTemp.style = `color: ${rgb(avgColor)};`;
        this._headerSummary.text = this._summary();

        // Rooms
        rooms.forEach((room, i) => {
            const row = this._roomRows[i];
            const c = tempColor(room.temp);
            const status = roomStatus(power, room);

            row.current.text = `${room.temp.toFixed(1)}°F`;
            row.current.style = `color: ${rgb(c)};`;
            row.badge.style = `background-color: ${rgba(c, 0.2)};`;
            row.badgeIcon.style = `color: ${rgb(c)};`;
            row.statusLabel.text = status.text;
            row.statusIcon.visible = status.icon !== null;
            if (status.icon)
                row.statusIcon.icon_name = status.icon;
            row.target.text = `${room.target}°`;
            row.bar.queue_repaint();
        });

        // Fade rooms when the system is off (only animate on change).
        if (power !== this._lastPower) {
            for (const row of this._roomRows) {
                row.body.ease({
                    opacity: power ? 255 : 130,
                    duration: this._lastPower === null ? 0 : 300,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            this._lastPower = power;
        }
    }

    _summary() {
        const {power, rooms} = this._ac;
        if (!power)
            return 'System off';
        let cooling = 0, heating = 0, ok = 0;
        for (const r of rooms) {
            const d = r.temp - r.target;
            if (d > AT_TARGET)
                cooling++;
            else if (d < -AT_TARGET)
                heating++;
            else
                ok++;
        }
        if (ok === rooms.length)
            return 'All rooms at target';
        const parts = [];
        if (cooling)
            parts.push(`${cooling} cooling`);
        if (heating)
            parts.push(`${heating} heating`);
        if (ok)
            parts.push(`${ok} at target`);
        return parts.join(' · ');
    }
});

export default class ACControlExtension extends Extension {
    enable() {
        this._ac = new ACSimulator();
        this._indicator = new ACIndicator(this._ac);
        // Position 0 on the right side = just left of the system icons.
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._ac.tick();
            this._indicator._sync();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._ac = null;
    }
}
