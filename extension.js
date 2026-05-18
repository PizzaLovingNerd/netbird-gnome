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
import {
    connectNetBird,
    disconnectNetBird,
    getActiveNetBirdProfile,
    getCurrentUsername,
    getNetBirdStatus,
    loadNetBirdProfiles,
    loginNetBird,
    switchNetBirdProfile,
    waitForNetBirdLogin,
} from './netbirdExtensionApi.js';


const NETBIRD_STATUS_POLL_SECONDS = 5;
const NETBIRD_UP_STATUSES = new Set(['Connecting', 'Connected']);
const NETBIRD_VPN_TOGGLE_NAMES = /\b(netbird|wiretrustee|wt0)\b/i;
const NETBIRD_DISCONNECT_FAILURE_SUPPRESS_MS = 10000;
const NETBIRD_PROFILE_TIMEOUT_MS = 15000;
const NETBIRD_CONNECT_TIMEOUT_MS = 65000;
const NETBIRD_LOGIN_TIMEOUT_MS = 90000;
const NETBIRD_DEFAULT_PROFILE = 'default';
const NETBIRD_PROFILE_RELOAD_RETRY_MS = 1500;


const NetBirdToggle = GObject.registerClass(
class NetBirdToggle extends QuickMenuToggle {
    constructor(gicon, indicator) {
        super({
            title: _('NetBird'),
            gicon,
            toggleMode: true,
        });

        this._gicon = gicon;
        this._indicator = indicator;
        this._profileItems = [];
        this._profileListCancellable = new Gio.Cancellable();
        this._profileLoadInProgress = false;
        this._profileSwitchInProgress = false;
        this._profileReloadRetryId = 0;
        this._username = getCurrentUsername();
        this._destroyed = false;
        this._vpnToggle = null;
        this._vpnIndicator = null;
        this._networkIndicator = null;
        this._statusCancellable = new Gio.Cancellable();
        this._statusPollId = 0;
        this._statusRefreshInProgress = false;
        this._settingCheckedFromStatus = false;
        this._toggleCommandInProgress = false;
        this._lastStatus = '';
        this._vpnToggleSignalIds = [];
        this._vpnToggleHiddenByNetBird = false;
        this._vpnIndicatorPatched = false;
        this._originalNetworkActivationFailed = null;
        this._suppressNetworkActivationFailedUntil = 0;

        // Use GNOME Shell's built-in quick settings header so NetBird matches
        // system menus such as Power Mode.
        this.menu.setHeader(gicon, _('NetBird'));

        this._addProfileStatusItem(_('Loading profiles...'));
        this._loadProfiles();

        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._separator);
        this._addAdvancedSettingsItem();

        this.connect('notify::checked', () => this._onCheckedChanged());
        this._refreshStatus();
        this._statusPollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            NETBIRD_STATUS_POLL_SECONDS,
            () => {
                this._refreshStatus();
                return GLib.SOURCE_CONTINUE;
            });
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
        const item = new PopupMenu.PopupMenuItem(profile.name);
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
            this._switchProfile(profile, item);
        });
        this._profileItems.push(item);
        this.menu.addMenuItem(item, position);

        if (selected) {
            this.subtitle = profile.name;
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

    async _loadProfiles() {
        if (this._destroyed || this._profileLoadInProgress)
            return;

        if (this._profileListCancellable.is_cancelled())
            this._profileListCancellable = new Gio.Cancellable();

        this._profileLoadInProgress = true;

        try {
            const profiles = await loadNetBirdProfiles({
                cancellable: this._profileListCancellable,
                timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
                username: this._username,
            });

            if (!this._destroyed)
                this._setProfiles(profiles);
        } catch (error) {
            if (!this._profileListCancellable.is_cancelled()) {
                console.warn(`Failed to load NetBird profiles: ${error}`);
                this._addProfileStatusItem(_('Unable to load profiles'));
            }
        } finally {
            this._profileLoadInProgress = false;

            if (!this._destroyed && this._profileListCancellable.is_cancelled())
                this._profileListCancellable = new Gio.Cancellable();
        }
    }

    _setProfiles(profiles) {
        this._clearProfileItems();

        if (profiles.length === 0) {
            this._addProfileStatusItem(_('No profiles found'));
            return;
        }

        profiles.forEach((profile, index) => {
            this._addProfileItem(profile, profile.selected, index + 1);
        });
    }

    async _switchProfile(profile, item) {
        if (this._destroyed || this._profileSwitchInProgress ||
            this._toggleCommandInProgress || profile.selected)
            return;

        this._profileSwitchInProgress = true;
        this._toggleCommandInProgress = true;
        const wasEnabled = this.checked || NETBIRD_UP_STATUSES.has(this._lastStatus);
        this.subtitle = profile.name;
        this._selectProfileItem(item);

        try {
            await switchNetBirdProfile(profile.name, {
                cancellable: this._profileListCancellable,
                timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
                username: this._profileUsername(profile),
            });

            const status = await getNetBirdStatus({
                cancellable: this._statusCancellable,
                timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
                waitForReady: true,
            });

            if (NETBIRD_UP_STATUSES.has(status.status)) {
                this._suppressNetworkActivationFailed();
                await disconnectNetBird({
                    cancellable: this._statusCancellable,
                    timeoutMs: NETBIRD_CONNECT_TIMEOUT_MS,
                });
            }

            if (wasEnabled)
                await this._connectProfile(profile);
        } catch (error) {
            if (!this._profileListCancellable.is_cancelled()) {
                console.warn(`Failed to switch NetBird profile: ${error}`);
                Main.notify(_('NetBird'), error.message ?? String(error));
            }
        } finally {
            this._profileSwitchInProgress = false;
            this._toggleCommandInProgress = false;
            this._scheduleProfileReload();
            this._refreshStatus();
        }
    }

    _profileUsername(profile) {
        // NetBird's built-in default profile is not tied to the previous
        // account username; passing one can leave the daemon in a bad state.
        if (profile.name === NETBIRD_DEFAULT_PROFILE)
            return '';

        return profile.username || this._username;
    }

    _scheduleProfileReload() {
        this._loadProfiles();

        if (this._profileReloadRetryId)
            GLib.source_remove(this._profileReloadRetryId);

        this._profileReloadRetryId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            NETBIRD_PROFILE_RELOAD_RETRY_MS,
            () => {
                this._profileReloadRetryId = 0;
                this._loadProfiles();
                return GLib.SOURCE_REMOVE;
            });
    }

    _onCheckedChanged() {
        this._syncVpnQuickSetting();

        if (this._settingCheckedFromStatus)
            return;

        this._setNetBirdEnabled(this.checked);
    }

    async _setNetBirdEnabled(enabled) {
        if (this._toggleCommandInProgress)
            return;

        this._toggleCommandInProgress = true;
        this._syncVpnQuickSetting();

        try {
            if (enabled) {
                await this._connectActiveProfile();
            } else {
                this._suppressNetworkActivationFailed();
                await disconnectNetBird({
                    cancellable: this._statusCancellable,
                    timeoutMs: NETBIRD_CONNECT_TIMEOUT_MS,
                });
            }
        } catch (error) {
            if (!this._statusCancellable.is_cancelled()) {
                console.warn(`Failed to ${enabled ? 'start' : 'stop'} NetBird: ${error}`);
                Main.notify(_('NetBird'), error.message ?? String(error));
            }
        } finally {
            if (!enabled)
                this._suppressNetworkActivationFailed();

            this._toggleCommandInProgress = false;
            this._refreshStatus();
            this._syncVpnQuickSetting();
        }
    }

    async _connectActiveProfile() {
        const activeProfile = await getActiveNetBirdProfile({
            cancellable: this._statusCancellable,
            timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
        });

        await this._connectProfile({
            name: activeProfile.profileName || NETBIRD_DEFAULT_PROFILE,
            username: activeProfile.username,
        });
    }

    async _connectProfile(profile) {
        const profileName = profile.name || NETBIRD_DEFAULT_PROFILE;
        const username = this._profileUsername({
            name: profileName,
            username: profile.username,
        });
        try {
            const status = await getNetBirdStatus({
                cancellable: this._statusCancellable,
                timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
                waitForReady: true,
            });

            if (NETBIRD_UP_STATUSES.has(status.status))
                return;
        } catch (error) {
            if (!this._statusCancellable.is_cancelled())
                console.warn(`Failed to read NetBird status before connect: ${error}`);
        }

        const login = await loginNetBird({
            cancellable: this._statusCancellable,
            profileName,
            timeoutMs: NETBIRD_LOGIN_TIMEOUT_MS,
            username,
        });

        if (login.needsSSOLogin) {
            const uri = login.verificationURIComplete || login.verificationURI;
            if (uri) {
                Gio.AppInfo.launch_default_for_uri(
                    uri,
                    global.create_app_launch_context(0, -1));
            }

            Main.notify(
                _('Sign in to NetBird'),
                login.userCode
                    ? `${_('Complete sign-in in your browser. Code:')} ${login.userCode}`
                    : _('Complete sign-in in your browser.'));

            await waitForNetBirdLogin(login.userCode, {
                cancellable: this._statusCancellable,
            });
        }

        await connectNetBird({
            cancellable: this._statusCancellable,
            profileName,
            timeoutMs: NETBIRD_CONNECT_TIMEOUT_MS,
            username,
        });
    }

    async _refreshStatus() {
        if (this._statusRefreshInProgress || this._toggleCommandInProgress)
            return;

        this._statusRefreshInProgress = true;

        try {
            const status = await getNetBirdStatus({cancellable: this._statusCancellable});
            this._lastStatus = status.status;
            this._setCheckedFromStatus(NETBIRD_UP_STATUSES.has(status.status));
            this._syncVpnQuickSetting();
        } catch (error) {
            if (!this._statusCancellable.is_cancelled())
                console.warn(`Failed to refresh NetBird status: ${error}`);
        } finally {
            this._statusRefreshInProgress = false;
        }
    }

    _setCheckedFromStatus(checked) {
        if (this.checked === checked)
            return;

        // Status polling mirrors CLI changes in the UI; it should not send a
        // second up/down command back to the daemon.
        this._settingCheckedFromStatus = true;
        this.checked = checked;
        this._settingCheckedFromStatus = false;
    }

    // NetBird owns its own tile. Reuse GNOME's VPN status indicator while active
    // and hide the generic VPN tile so NetworkManager's switch cannot fight the
    // daemon.
    _syncVpnQuickSetting() {
        const netBirdActive = this.checked ||
            this._toggleCommandInProgress ||
            NETBIRD_UP_STATUSES.has(this._lastStatus);
        const networkIndicator = Main.panel.statusArea.quickSettings?._network;
        this._installNetworkActivationFailureFilter(networkIndicator);

        const vpnToggle = networkIndicator?._vpnToggle;
        if (!vpnToggle) {
            this._restoreVpnStatusIcon();
            this._indicator.visible = this.checked;
            return;
        }

        if (this._vpnToggle !== vpnToggle)
            this._setVpnQuickSetting(vpnToggle);

        const shouldHide = netBirdActive ||
            this._vpnToggleLooksLikeNetBird(vpnToggle);

        this._syncVpnStatusIcon(netBirdActive);

        if (shouldHide) {
            this._vpnToggleHiddenByNetBird = true;
            if (vpnToggle.visible)
                vpnToggle.visible = false;
        } else if (this._vpnToggleHiddenByNetBird) {
            this._vpnToggleHiddenByNetBird = false;
            vpnToggle.visible = true;
        }
    }

    _setVpnQuickSetting(vpnToggle) {
        this._restoreVpnQuickSetting();
        this._vpnToggle = vpnToggle;

        this._vpnToggleSignalIds = [
            vpnToggle.connect('notify::visible', () => this._syncVpnQuickSetting()),
            vpnToggle.connect('notify::subtitle', () => this._syncVpnQuickSetting()),
            vpnToggle.connect('notify::icon-name', () => this._syncVpnQuickSetting()),
            vpnToggle.connect('notify::checked', () => this._syncVpnQuickSetting()),
        ];
    }

    _disconnectVpnQuickSettingSignals() {
        if (!this._vpnToggle)
            return;

        this._vpnToggleSignalIds.forEach(id => this._vpnToggle.disconnect(id));
        this._vpnToggleSignalIds = [];
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

    _installNetworkActivationFailureFilter(networkIndicator) {
        if (this._networkIndicator === networkIndicator)
            return;

        this._restoreNetworkActivationFailureFilter();

        if (!networkIndicator?._onActivationFailed)
            return;

        this._networkIndicator = networkIndicator;
        this._originalNetworkActivationFailed = networkIndicator._onActivationFailed;
        networkIndicator._onActivationFailed = (...args) => {
            if (this._shouldSuppressNetworkActivationFailed())
                return;

            return this._originalNetworkActivationFailed.apply(networkIndicator, args);
        };
    }

    _suppressNetworkActivationFailed() {
        this._suppressNetworkActivationFailedUntil =
            GLib.get_monotonic_time() + NETBIRD_DISCONNECT_FAILURE_SUPPRESS_MS * 1000;
    }

    _shouldSuppressNetworkActivationFailed() {
        return GLib.get_monotonic_time() <= this._suppressNetworkActivationFailedUntil;
    }

    _restoreNetworkActivationFailureFilter() {
        if (this._networkIndicator && this._originalNetworkActivationFailed)
            this._networkIndicator._onActivationFailed = this._originalNetworkActivationFailed;

        this._networkIndicator = null;
        this._originalNetworkActivationFailed = null;
        this._suppressNetworkActivationFailedUntil = 0;
    }

    _syncVpnStatusIcon(netBirdActive) {
        const vpnIndicator = Main.panel.statusArea.quickSettings?._network?._vpnIndicator;

        if (this._vpnIndicator && this._vpnIndicator !== vpnIndicator)
            this._restoreVpnStatusIcon();

        this._vpnIndicator = vpnIndicator ?? null;

        if (netBirdActive && this._vpnIndicator) {
            this._vpnIndicatorPatched = true;
            this._vpnIndicator.gicon = this._gicon;
            this._vpnIndicator.visible = true;
            this._indicator.visible = false;
        } else {
            this._restoreVpnStatusIcon();
            this._indicator.visible = this.checked;
        }
    }

    _restoreVpnStatusIcon() {
        if (this._vpnIndicatorPatched && this._vpnIndicator) {
            this._vpnIndicator.gicon = null;
            if (this._vpnToggle)
                this._vpnIndicator.icon_name = this._vpnToggle.icon_name;
        }

        this._vpnIndicatorPatched = false;
        this._vpnIndicator = null;
    }

    _restoreVpnQuickSetting() {
        if (this._vpnToggle) {
            this._disconnectVpnQuickSettingSignals();
            if (this._vpnToggleHiddenByNetBird)
                this._vpnToggle.visible = true;

            this._restoreVpnStatusIcon();
            this._vpnToggleHiddenByNetBird = false;
            this._vpnToggle = null;
        }
        this._indicator.visible = false;
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
        this._destroyed = true;
        this._profileListCancellable.cancel();
        this._statusCancellable.cancel();

        if (this._statusPollId)
            GLib.source_remove(this._statusPollId);

        if (this._profileReloadRetryId)
            GLib.source_remove(this._profileReloadRetryId);

        this._restoreVpnQuickSetting();
        this._restoreNetworkActivationFailureFilter();

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
