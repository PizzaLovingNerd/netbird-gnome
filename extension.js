/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';


const NetBirdToggle = GObject.registerClass(
class NetBirdToggle extends QuickMenuToggle {
    constructor(gicon) {
        super({
            title: _('NetBird'),
            gicon,
            toggleMode: true,
        });

        this._profileItems = [];
        this._profileListCancellable = new Gio.Cancellable();
        this._profileListTimeoutId = 0;
        this._profileLoadTimedOut = false;
        this._vpnToggle = null;
        this._vpnCheckedSignalId = 0;

        // Use GNOME Shell's built-in quick settings header so NetBird matches
        // system menus such as Power Mode.
        this.menu.setHeader(gicon, _('NetBird'));

        this._addProfileStatusItem(_('Loading profiles...'));
        this._loadProfiles();

        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._separator);
        this._addAdvancedSettingsItem();

        this.connect('notify::checked', () => this._syncVpnQuickSetting());
    }

    _addProfileStatusItem(label) {
        this._clearProfileItems();

        const item = new PopupMenu.PopupMenuItem(label, {
            reactive: false,
            can_focus: false,
        });
        this._profileItems.push(item);
        this.menu.addMenuItem(item, 1);
    }

    _addProfileItem(profile, selected = false, position = -1) {
        const item = new PopupMenu.PopupMenuItem(profile);
        item.label.x_expand = true;

        // Keep the selected profile mark on the right, matching the user's
        // requested layout instead of PopupMenu's default left-side ornament.
        item._checkIcon = new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'popup-menu-icon',
            visible: false,
        });
        item.add_child(item._checkIcon);

        item.connect('activate', () => {
            // Profile switching is intentionally local for now; selecting a
            // row only updates the UI and does not call `netbird profile use`.
            this.subtitle = profile;
            this._selectProfileItem(item);
        });
        this._profileItems.push(item);
        this.menu.addMenuItem(item, position);

        if (selected) {
            this.subtitle = profile;
            this._selectProfileItem(item);
        }
    }

    _selectProfileItem(selectedItem) {
        this._profileItems.forEach(item => {
            if (!item._checkIcon)
                return;

            item._checkIcon.visible = item === selectedItem;
        });
    }

    _clearProfileItems() {
        this._profileItems.forEach(item => item.destroy());
        this._profileItems = [];
    }

    // Parses netbird profile list to find profiles.
    _loadProfiles() {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['netbird', 'profile', 'list'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            this._addProfileStatusItem(_('Unable to load profiles'));
            return;
        }

        this._profileLoadTimedOut = false;
        this._profileListTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            5,
            () => {
                this._profileLoadTimedOut = true;
                this._profileListTimeoutId = 0;
                this._addProfileStatusItem(_('Unable to load profiles'));
                proc.force_exit();
                return GLib.SOURCE_REMOVE;
            });

        proc.communicate_utf8_async(
            null,
            this._profileListCancellable,
            (subprocess, result) => {
                if (this._profileListTimeoutId) {
                    GLib.source_remove(this._profileListTimeoutId);
                    this._profileListTimeoutId = 0;
                }

                if (this._profileLoadTimedOut)
                    return;

                try {
                    const [, stdout] = subprocess.communicate_utf8_finish(result);
                    this._setProfiles(this._parseProfileList(stdout));
                } catch (error) {
                    if (!this._profileListCancellable.is_cancelled())
                        this._addProfileStatusItem(_('Unable to load profiles'));
                }
            });
    }

    _parseProfileList(output) {
        return output
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('Found '))
            .map(line => {
                const selected = line.startsWith('✓');
                return {
                    name: line.replace(/^[✓✗]\s*/, ''),
                    selected,
                };
            })
            .filter(profile => profile.name);
    }

    _setProfiles(profiles) {
        this._clearProfileItems();

        if (profiles.length === 0) {
            this._addProfileStatusItem(_('No profiles found'));
            return;
        }

        profiles.forEach((profile, index) => {
            this._addProfileItem(profile.name, profile.selected, index + 1);
        });
    }

    // Will not show the regular VPN quick setting as enabled if Netbird is the VPN running.
    _syncVpnQuickSetting() {
        const vpnToggle = Main.panel.statusArea.quickSettings?._network?._vpnToggle;
        if (!vpnToggle)
            return;

        if (this._vpnToggle !== vpnToggle) {
            if (this._vpnToggle && this._vpnCheckedSignalId) {
                this._vpnToggle.disconnect(this._vpnCheckedSignalId);
                this._vpnCheckedSignalId = 0;
            }

            this._vpnToggle = vpnToggle;
            this._vpnCheckedSignalId = vpnToggle.connect('notify::checked', () => {
                if (this.checked && vpnToggle.checked)
                    vpnToggle.checked = false;
            });
        }

        if (this.checked) {
            // NetBird is represented by this tile, so hide the active styling
            // from GNOME's generic VPN tile while this placeholder is enabled.
            vpnToggle.checked = false;
        } else {
            // Let GNOME Shell recalculate the VPN state from NetworkManager.
            vpnToggle._sync?.();
        }
    }

    _addAdvancedSettingsItem() {
        const item = new PopupMenu.PopupMenuItem(_('Advanced Settings'));
        item.connect('activate', () => {
            // Placeholder until the extension grows a real preferences panel.
            this.menu.close();
        });
        this.menu.addMenuItem(item);
    }

    destroy() {
        this._profileListCancellable.cancel();

        if (this._profileListTimeoutId)
            GLib.source_remove(this._profileListTimeoutId);

        if (this._vpnToggle && this._vpnCheckedSignalId)
            this._vpnToggle.disconnect(this._vpnCheckedSignalId);

        super.destroy();
    }
});

const NetBirdIndicator = GObject.registerClass(
class NetBirdIndicator extends SystemIndicator {
    constructor(gicon) {
        super();

        this._indicator = this._addIndicator();
        this._indicator.gicon = gicon;

        const toggle = new NetBirdToggle(gicon);
        toggle.bind_property('checked',
            this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        this.quickSettingsItems.push(toggle);
    }
});

export default class NetBirdExtension extends Extension {
    enable() {
        const iconFile = this.dir.get_child('icons').get_child('netbird-symbolic.svg');
        const icon = Gio.FileIcon.new(iconFile);

        this._indicator = new NetBirdIndicator(icon);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
