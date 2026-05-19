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

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {
    netbird_down,
    netbird_profile_list,
    netbird_profile_select,
    netbird_status,
    netbird_up,
} from './api/index.js';

const NETBIRD_COMMAND_TIMEOUT_MS = 30000;
const NETBIRD_QUERY_TIMEOUT_MS = 5000;
const NETBIRD_ERROR_NOTIFY_THROTTLE_US = 30000000;
const NETBIRD_VPN_TOGGLE_NAMES = /\b(netbird|wiretrustee|wt0)\b/i;


function formatErrorMessage(error) {
    const output = [
        error?.message,
        error?.stdout,
        error?.stderr,
    ].filter(Boolean).join('\n').trim();

    if (!output)
        return String(error);

    const firstUsefulLine = output
        .split('\n')
        .map(line => line.trim())
        .find(line => line && !line.includes('caller_not_available')) ?? output;

    return firstUsefulLine.length > 240
        ? `${firstUsefulLine.slice(0, 237)}...`
        : firstUsefulLine;
}


const NetBirdToggle = GObject.registerClass(
class NetBirdToggle extends QuickMenuToggle {
    constructor(gicon, indicator) {
        super({
            title: 'NetBird',
            subtitle: '',
            gicon,
            toggleMode: false,
        });

        this._indicator = indicator;
        this._profileItems = [];
        this._selectedProfileName = '';
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._hasError = false;
        this._loadingProfiles = false;
        this._settingCheckedFromStatus = false;
        this._toggleCommandInProgress = false;
        this._statusRefreshInProgress = false;
        this._lastConnectedStatus = false;
        this._quickSettingsMenu = Main.panel.statusArea.quickSettings.menu;
        this._quickSettingsMenuSignalId = 0;
        this._vpnToggle = null;
        this._vpnToggleSignalIds = [];
        this._vpnToggleHiddenByNetBird = false;
        this._lastErrorNotificationUs = 0;

        this.menu.setHeader(gicon, 'NetBird');

        this._addProfileStatusItem('Loading profiles...');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addAdvancedSettingsItem();

        this.connect('clicked', () => this._onToggleClicked());
        this._quickSettingsMenuSignalId = this._quickSettingsMenu.connect(
            'open-state-changed',
            (_menu, isOpen) => this._onQuickSettingsOpenStateChanged(isOpen));
        this._watchVpnQuickSetting();

        this._loadProfiles();

        if (this._quickSettingsMenu.isOpen)
            this._refreshStatus();
    }

    _addProfileItem(profileName) {
        const item = new PopupMenu.PopupMenuItem(profileName);
        item._profileName = profileName;
        item.label.x_expand = true;

        item._checkIcon = new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'popup-menu-icon',
            visible: false,
        });
        item.add_child(item._checkIcon);

        item.connect('activate', () => {
            this._selectProfile(profileName, item);
        });

        this._profileItems.push(item);
        this.menu.addMenuItem(item, this._profileItems.length);

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

    async _loadProfiles() {
        if (this._destroyed || this._loadingProfiles)
            return;

        this._loadingProfiles = true;

        try {
            const {profiles} = await netbird_profile_list({
                cancellable: this._cancellable,
                timeoutMs: NETBIRD_QUERY_TIMEOUT_MS,
            });

            if (this._destroyed)
                return;

            this._clearErrorState();
            this._clearProfileItems();

            if (profiles.length === 0) {
                this._addProfileStatusItem('No profiles found');
                return;
            }

            profiles.forEach(profile => {
                this._addProfileItem(profile.name);
            });

            this._selectProfileName(this._selectedProfileName);
        } catch (error) {
            if (!this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to load NetBird profiles', error);
                this._addProfileStatusItem('Unable to load profiles');
            }
        } finally {
            this._loadingProfiles = false;
        }
    }

    async _selectProfile(profileName, item) {
        if (this._destroyed || this._toggleCommandInProgress)
            return;

        this.subtitle = 'Switching profile...';
        this._setCheckedFromStatus(false);
        this._syncVpnQuickSetting();
        this._selectProfileItem(item);
        this._toggleCommandInProgress = true;

        try {
            await netbird_profile_select(profileName, {
                cancellable: this._cancellable,
                timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
            });

            this._clearErrorState();
        } catch (error) {
            if (!this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to select NetBird profile', error);
                this._loadProfiles();
            }
        } finally {
            this._toggleCommandInProgress = false;
            this._refreshStatus();
        }
    }

    async _onToggleClicked() {
        if (this._toggleCommandInProgress)
            return;

        const requestedChecked = !this.checked;
        this.subtitle = requestedChecked ? 'Connecting...' : 'Disconnecting...';
        this._toggleCommandInProgress = true;

        try {
            if (requestedChecked) {
                await netbird_up({
                    cancellable: this._cancellable,
                    onLoginUrlOpen: () => this._notifyBrowserLogin(),
                    profileName: this._selectedProfileName,
                    timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
                });
            } else {
                await netbird_down({
                    cancellable: this._cancellable,
                    timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
                });
            }

            this._clearErrorState();
        } catch (error) {
            if (!this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to change NetBird status', error);
            }
        } finally {
            this._toggleCommandInProgress = false;
            this._refreshStatus();
        }
    }

    async _refreshStatus() {
        if (this._destroyed || this._toggleCommandInProgress || this._statusRefreshInProgress)
            return;

        this._statusRefreshInProgress = true;

        try {
            const status = await netbird_status({
                cancellable: this._cancellable,
                timeoutMs: NETBIRD_QUERY_TIMEOUT_MS,
            });

            if (!this._destroyed && !this._toggleCommandInProgress) {
                this._clearErrorState();
                this._syncFromStatus(status);
            }
        } catch (error) {
            if (!this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to refresh NetBird status', error);
            }
        } finally {
            this._statusRefreshInProgress = false;
        }
    }

    _onQuickSettingsOpenStateChanged(isOpen) {
        if (!isOpen)
            return;

        this._watchVpnQuickSetting();
        this._refreshStatus();
    }

    _watchVpnQuickSetting() {
        const vpnToggle = Main.panel.statusArea.quickSettings?._network?._vpnToggle ?? null;
        if (this._vpnToggle === vpnToggle)
            return;

        this._unwatchVpnQuickSetting();

        if (!vpnToggle)
            return;

        this._vpnToggle = vpnToggle;
        this._vpnToggleSignalIds = [
            vpnToggle.connect('notify::checked', () => this._refreshStatus()),
            vpnToggle.connect('notify::visible', () => this._syncVpnQuickSetting()),
            vpnToggle.connect('notify::subtitle', () => this._syncVpnQuickSetting()),
            vpnToggle.connect('notify::icon-name', () => this._syncVpnQuickSetting()),
        ];
    }

    _unwatchVpnQuickSetting() {
        if (!this._vpnToggle)
            return;

        this._vpnToggleSignalIds.forEach(id => this._vpnToggle.disconnect(id));
        if (this._vpnToggleHiddenByNetBird)
            this._vpnToggle.visible = true;

        this._vpnToggle = null;
        this._vpnToggleSignalIds = [];
        this._vpnToggleHiddenByNetBird = false;
    }

    _setCheckedFromStatus(checked) {
        this._settingCheckedFromStatus = true;
        if (this.checked !== checked)
            this.checked = checked;
        this._settingCheckedFromStatus = false;

        this._indicator.visible = checked;
    }

    _syncFromStatus(status) {
        this._lastConnectedStatus = status.connected;
        this._setCheckedFromStatus(status.connected);
        this._syncVpnQuickSetting();

        if (status.profileName)
            this._setSelectedProfileName(status.profileName);

        if (this._hasError)
            return;

        if (status.status.toLowerCase() === 'connecting') {
            this.subtitle = 'Connecting...';
            return;
        }

        this.subtitle = this._selectedProfileName;
    }

    _setSelectedProfileName(profileName) {
        this._selectedProfileName = profileName;
        this._selectProfileName(profileName);
    }

    _selectProfileName(profileName) {
        let selectedItem = null;
        for (const item of this._profileItems) {
            if (item._profileName === profileName) {
                selectedItem = item;
                break;
            }
        }

        this._selectProfileItem(selectedItem);
    }

    _syncVpnQuickSetting() {
        this._watchVpnQuickSetting();

        if (!this._vpnToggle)
            return;

        const shouldHideVpnToggle =
            this._lastConnectedStatus && this._vpnToggleLooksLikeNetBird(this._vpnToggle);

        if (shouldHideVpnToggle) {
            this._vpnToggleHiddenByNetBird = true;
            if (this._vpnToggle.visible)
                this._vpnToggle.visible = false;
        } else if (this._vpnToggleHiddenByNetBird) {
            this._vpnToggleHiddenByNetBird = false;
            this._vpnToggle.visible = true;
        }
    }

    _vpnToggleLooksLikeNetBird(vpnToggle) {
        const labels = [
            vpnToggle.title,
            vpnToggle.subtitle,
            vpnToggle.label?.text,
            vpnToggle._label?.text,
            vpnToggle._title?.text,
            vpnToggle._subtitle?.text,
        ];

        return labels.some(label =>
            typeof label === 'string' && NETBIRD_VPN_TOGGLE_NAMES.test(label));
    }

    _setErrorState() {
        this._hasError = true;
        this.subtitle = 'ERROR';
    }

    _clearErrorState() {
        if (!this._hasError)
            return;

        this._hasError = false;
        this.subtitle = this._selectedProfileName;
    }

    _notifyCliError(context, error) {
        const message = formatErrorMessage(error);
        console.warn(`${context}: ${message}`);

        const nowUs = GLib.get_monotonic_time();
        if (nowUs - this._lastErrorNotificationUs < NETBIRD_ERROR_NOTIFY_THROTTLE_US)
            return;

        this._lastErrorNotificationUs = nowUs;
        Main.notify('NetBird', `${context}: ${message}`);
    }

    _notifyBrowserLogin() {
        Main.notify('NetBird', 'Launching browser for NetBird sign in');
    }

    _addAdvancedSettingsItem() {
        const item = new PopupMenu.PopupMenuItem('Advanced Settings');
        item.connect('activate', () => {
            // Placeholder until the extension grows a real preferences panel.
            this.menu.close();
        });
        this.menu.addMenuItem(item);
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();

        this._unwatchVpnQuickSetting();

        if (this._quickSettingsMenuSignalId) {
            this._quickSettingsMenu.disconnect(this._quickSettingsMenuSignalId);
            this._quickSettingsMenuSignalId = 0;
        }

        super.destroy();
    }
});

const NetBirdIndicator = GObject.registerClass(
class NetBirdIndicator extends SystemIndicator {
    constructor(gicon) {
        super();

        this._indicator = this._addIndicator();
        this._indicator.gicon = gicon;
        this._indicator.visible = false;

        const toggle = new NetBirdToggle(gicon, this._indicator);
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
