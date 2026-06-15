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
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {
    netbird_down,
    netbird_profile_add,
    netbird_profile_list,
    netbird_profile_select,
    netbird_status,
    netbird_up,
} from './api/index.js';
import {formatErrorMessage, isCancellation} from './extensionErrors.js';
import {promptProfileName} from './profile-add-dialog.js';
import {readProfileEmail} from './profileState.js';

const NETBIRD_COMMAND_TIMEOUT_MS = 30000;
const NETBIRD_QUERY_TIMEOUT_MS = 5000;
const NETBIRD_ERROR_NOTIFY_THROTTLE_US = 30000000;
const NETBIRD_VPN_TOGGLE_NAMES = /\b(netbird|wiretrustee|wt0)\b/i;


function addMenuActionItem(menu, label, iconName, onActivate) {
    const item = new PopupMenu.PopupImageMenuItem(label, iconName);
    item.connect('activate', onActivate);
    menu.addMenuItem(item);
}

function readStringProperty(object, propertyName) {
    try {
        const value = object?.[propertyName];
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

const NetBirdToggle = GObject.registerClass(
class NetBirdToggle extends QuickMenuToggle {
    constructor(extension, gicon, indicator) {
        super({
            title: 'NetBird',
            subtitle: '',
            gicon,
            toggleMode: false,
        });

        this._extension = extension;
        this._gicon = gicon;
        this._indicator = indicator;
        this._profileItems = [];
        this._profileStatusItem = null;
        this._addProfileMenuItem = null;
        this._profileSectionIndex = 1;
        this._selectedProfileName = '';
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._hasError = false;
        this._loadingProfiles = false;
        this._pendingProfileLoad = null;
        this._settingCheckedFromStatus = false;
        this._toggleCommandInProgress = false;
        this._toggleOperation = null;
        this._toggleCommandCancellable = null;
        this._toggleCancelRequested = false;
        this._connectingFromStatus = false;
        this._statusRefreshInProgress = false;
        this._lastConnectedStatus = false;
        this._quickSettingsMenu = Main.panel.statusArea.quickSettings.menu;
        this._quickSettingsMenuSignalId = 0;
        this._vpnToggle = null;
        this._vpnToggleSignalIds = [];
        this._vpnToggleOriginalGetActiveItems = null;
        this._vpnToggleOriginalGetPrimaryItem = null;
        this._lastErrorNotificationUs = 0;
        this._activationFailedFilterInstalled = false;
        this._networkIndicator = null;
        this._originalOnActivationFailed = null;
        this._vpnActivationFailedEmitted = false;

        this._setHeader(null);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._createAddProfileMenuItem();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        addMenuActionItem(this.menu, 'Networks', 'network-workgroup-symbolic', () => {
            // Placeholder until Networks gets its dedicated NetBird settings view.
            this.menu.close();
        });
        addMenuActionItem(this.menu, 'NetBird Settings', 'preferences-system-symbolic', () => {
            this.menu.close();
            this._extension.openProfileSettingsWindow();
        });

        this.connect('clicked', () => this._onToggleClicked());
        this._quickSettingsMenuSignalId = this._quickSettingsMenu.connect(
            'open-state-changed',
            (_menu, isOpen) => this._onQuickSettingsOpenStateChanged(isOpen));
        this._watchVpnQuickSetting();
        this._installNetworkActivationFailedFilter();

        this._loadProfiles();

        if (this._quickSettingsMenu.isOpen)
            this._refreshStatus();
    }

    _createAddProfileMenuItem() {
        this._addProfileMenuItem = new PopupMenu.PopupImageMenuItem(
            'Add Profile',
            'list-add-symbolic');
        this._addProfileMenuItem.connect('activate', () => {
            this.menu.close();
            this._openAddProfileDialog();
        });
        this.menu.addMenuItem(this._addProfileMenuItem, this._profileSectionIndex);
    }

    _repositionAddProfileMenuItem() {
        if (!this._addProfileMenuItem)
            return;

        const profileBlockLength = this._profileItems.length +
            (this._profileStatusItem ? 1 : 0);
        this.menu.moveMenuItem(
            this._addProfileMenuItem,
            this._profileSectionIndex + profileBlockLength);
    }

    _clearProfileStatusItem() {
        if (!this._profileStatusItem)
            return;

        this._profileStatusItem.destroy();
        this._profileStatusItem = null;
        this._repositionAddProfileMenuItem();
    }

    _showProfileStatus(label) {
        this._clearProfileStatusItem();

        const item = new PopupMenu.PopupMenuItem(label, {
            reactive: false,
            can_focus: false,
        });

        this._profileStatusItem = item;
        this.menu.addMenuItem(item, this._profileSectionIndex);
        this._repositionAddProfileMenuItem();
    }

    _findProfileItem(profileName) {
        return this._profileItems.find(item => item._profileName === profileName) ?? null;
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

        const index = this._profileSectionIndex + this._profileItems.length;
        this.menu.addMenuItem(item, index);
        this._profileItems.push(item);
        this._repositionAddProfileMenuItem();
    }

    _removeProfileItem(profileName) {
        const item = this._findProfileItem(profileName);
        if (!item)
            return;

        item.destroy();
        this._profileItems = this._profileItems.filter(
            profileItem => profileItem !== item);
        this._repositionAddProfileMenuItem();
    }

    _selectProfileItem(selectedItem) {
        this._profileItems.forEach(item => {
            item._checkIcon.visible = item === selectedItem;
        });
    }

    _syncProfileList(profiles, activeProfile) {
        this._clearProfileStatusItem();

        const namesFromServer = new Set(profiles.map(profile => profile.name));

        for (const item of [...this._profileItems]) {
            if (!namesFromServer.has(item._profileName))
                this._removeProfileItem(item._profileName);
        }

        for (const profile of profiles) {
            if (!this._findProfileItem(profile.name))
                this._addProfileItem(profile.name);
        }

        if (this._profileItems.length === 0)
            this._showProfileStatus('No profiles found');

        if (activeProfile)
            this._setSelectedProfileName(activeProfile);
        else
            this._selectProfileName(this._selectedProfileName);
    }

    _openAddProfileDialog() {
        promptProfileName({
            onAccept: profileName => this._addProfile(profileName),
        });
    }

    async _addProfile(profileName) {
        if (this._destroyed || this._toggleCommandInProgress)
            return;

        try {
            await netbird_profile_add(profileName, {
                cancellable: this._cancellable,
                timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
            });

            if (this._destroyed)
                return;

            this._clearErrorState();
            await this._loadProfiles({preserveExisting: true});
            this._refreshStatus();
        } catch (error) {
            if (!this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to add NetBird profile', error);
            }
        }
    }

    async _loadProfiles({preserveExisting = false} = {}) {
        if (this._destroyed)
            return;

        if (this._loadingProfiles) {
            this._pendingProfileLoad = {preserveExisting};
            return;
        }

        const showLoadingStatus = !preserveExisting && this._profileItems.length === 0;
        if (showLoadingStatus)
            this._showProfileStatus('Loading profiles...');

        this._loadingProfiles = true;

        try {
            const {activeProfile, profiles} = await netbird_profile_list({
                cancellable: this._cancellable,
                timeoutMs: NETBIRD_QUERY_TIMEOUT_MS,
            });

            if (this._destroyed)
                return;

            this._clearErrorState();
            this._syncProfileList(profiles, activeProfile);
        } catch (error) {
            if (!this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to load NetBird profiles', error);

                if (!preserveExisting && this._profileItems.length === 0)
                    this._showProfileStatus('Unable to load profiles');
            }
        } finally {
            this._loadingProfiles = false;

            const pending = this._pendingProfileLoad;
            this._pendingProfileLoad = null;
            if (pending && !this._destroyed)
                this._loadProfiles(pending);
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
                this._loadProfiles({preserveExisting: true});
            }
        } finally {
            this._toggleCommandInProgress = false;
            this._refreshStatus();
        }
    }

    async _onToggleClicked() {
        if (this._toggleCommandInProgress) {
            await this._cancelToggleOperation();
            return;
        }

        if (this._connectingFromStatus) {
            await this._cancelConnect();
            return;
        }

        const requestedChecked = !this.checked;
        await this._runToggleOperation(requestedChecked ? 'connect' : 'disconnect');
    }

    _beginToggleCommand(operation) {
        this._toggleCommandCancellable?.cancel();
        this._toggleCommandCancellable = new Gio.Cancellable();
        this._toggleCancelRequested = false;
        this._toggleOperation = operation;
        this._toggleCommandInProgress = true;
    }

    _endToggleCommand() {
        this._toggleOperation = null;
        this._toggleCommandCancellable = null;
        this._toggleCancelRequested = false;
        this._toggleCommandInProgress = false;
    }

    async _runToggleOperation(operation) {
        this._beginToggleCommand(operation);
        this.subtitle = operation === 'connect' ? 'Connecting...' : 'Disconnecting...';

        try {
            if (operation === 'connect') {
                await netbird_up({
                    cancellable: this._toggleCommandCancellable,
                    onLoginUrlOpen: () => this._notifyBrowserLogin(),
                    profileName: this._selectedProfileName,
                    timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
                });
            } else {
                await netbird_down({
                    cancellable: this._toggleCommandCancellable,
                    timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
                });
            }

            if (!this._toggleCancelRequested)
                this._clearErrorState();
        } catch (error) {
            if (this._toggleCancelRequested ||
                isCancellation(error, this._toggleCommandCancellable))
                return;

            if (!this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to change NetBird status', error);
            }
        } finally {
            if (!this._toggleCancelRequested) {
                this._endToggleCommand();
                this._refreshStatus();
            }
        }
    }

    async _cancelToggleOperation() {
        if (!this._toggleCommandInProgress || this._toggleCancelRequested)
            return;

        this._toggleCancelRequested = true;
        const operation = this._toggleOperation;
        const commandCancellable = this._toggleCommandCancellable;
        commandCancellable?.cancel();
        this.subtitle = 'Cancelling...';

        try {
            if (operation === 'connect') {
                await netbird_down({
                    cancellable: this._cancellable,
                    timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
                });
            }
            this._clearErrorState();
        } catch (error) {
            if (!this._cancellable.is_cancelled() && !isCancellation(error, commandCancellable))
                this._notifyCliError('Failed to cancel NetBird connection', error);
        } finally {
            this._endToggleCommand();
            this._setCheckedFromStatus(false);
            this._refreshStatus();
        }
    }

    async _cancelConnect() {
        if (this._toggleCommandInProgress) {
            await this._cancelToggleOperation();
            return;
        }

        this._beginToggleCommand('disconnect');
        this.subtitle = 'Cancelling...';

        try {
            await netbird_down({
                cancellable: this._cancellable,
                timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
            });
            this._clearErrorState();
        } catch (error) {
            if (!this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to cancel NetBird connection', error);
            }
        } finally {
            this._endToggleCommand();
            this._setCheckedFromStatus(false);
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
        this._installNetworkActivationFailedFilter();
        this._loadProfiles({preserveExisting: true});
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
        this._patchVpnQuickSetting();
        this._vpnToggleSignalIds = [
            vpnToggle.connect('notify::checked', () => this._refreshStatus()),
            vpnToggle.connect('notify::subtitle', () => this._syncVpnQuickSetting()),
            vpnToggle.connect('notify::icon-name', () => this._syncVpnQuickSetting()),
            vpnToggle.connect('activation-failed', () => {
                this._vpnActivationFailedEmitted = true;
            }),
        ];
    }

    _unwatchVpnQuickSetting() {
        if (!this._vpnToggle)
            return;

        this._vpnToggleSignalIds.forEach(id => this._vpnToggle.disconnect(id));
        this._unpatchVpnQuickSetting();
        this._vpnToggle = null;
        this._vpnToggleSignalIds = [];
    }

    _setCheckedFromStatus(checked) {
        this._settingCheckedFromStatus = true;
        if (this.checked !== checked)
            this.checked = checked;
        this._settingCheckedFromStatus = false;

        this._indicator.visible = false;
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
            this._connectingFromStatus = true;
            this.subtitle = 'Connecting...';
            return;
        }

        this._connectingFromStatus = false;
        this.subtitle = this._selectedProfileName;
    }

    _setSelectedProfileName(profileName) {
        this._selectedProfileName = profileName;
        this._setHeader(readProfileEmail(this._selectedProfileName) || null);
        this._selectProfileName(profileName);
    }

    _setHeader(subtitle) {
        const hasSubtitle = Boolean(subtitle);
        this.menu.setHeader(this._gicon, 'NetBird', hasSubtitle ? subtitle : null);

        const header = this.menu._header;
        if (!header)
            return;

        // GNOME Shell does not expose enough public API to align this custom
        // quick settings header, so the private header actors are adjusted here.
        header.style = hasSubtitle
            ? 'padding-top: 8px; padding-bottom: 8px;'
            : 'padding-top: 8px; padding-bottom: 8px; min-height: 48px;';
        header.y_align = Clutter.ActorAlign.CENTER;
        header.get_children().forEach(child => {
            child.y_align = Clutter.ActorAlign.CENTER;
        });

        const labelOffset = hasSubtitle ? -2 : 5;
        [this.menu._headerTitle, this.menu._headerSubtitle].forEach(label => {
            if (!label)
                return;

            label.y_expand = !hasSubtitle && label === this.menu._headerTitle;
            label.y_align = Clutter.ActorAlign.CENTER;
            label.translation_y = labelOffset;
        });

        if (this.menu._headerSubtitle) {
            this.menu._headerSubtitle.visible = hasSubtitle;
            this.menu._headerSubtitle.height = hasSubtitle ? -1 : 0;
        }
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

        if (!this._vpnToggle) {
            this._indicator.visible = this._lastConnectedStatus;
            return;
        }

        this._patchVpnQuickSetting();
        this._vpnToggle._sync?.();
        this._indicator.visible = this._lastConnectedStatus;
    }

    _patchVpnQuickSetting() {
        if (!this._vpnToggle ||
            this._vpnToggleOriginalGetActiveItems ||
            this._vpnToggleOriginalGetPrimaryItem)
            return;

        const originalGetActiveItems = this._vpnToggle._getActiveItems;
        const originalGetPrimaryItem = this._vpnToggle._getPrimaryItem;
        if (typeof originalGetActiveItems !== 'function' ||
            typeof originalGetPrimaryItem !== 'function')
            return;

        this._vpnToggleOriginalGetActiveItems = originalGetActiveItems;
        this._vpnToggleOriginalGetPrimaryItem = originalGetPrimaryItem;

        const netBirdToggle = this;
        this._vpnToggle._getActiveItems = function* () {
            for (const item of originalGetActiveItems.call(this)) {
                if (!netBirdToggle._vpnItemLooksLikeNetBird(item))
                    yield item;
            }
        };

        this._vpnToggle._getPrimaryItem = function () {
            const [activeItem] = this._getActiveItems();
            if (activeItem)
                return activeItem;

            const itemSorter = this._itemSorter;
            if (itemSorter?.itemsByMru) {
                for (const item of itemSorter.itemsByMru()) {
                    if (!netBirdToggle._vpnItemLooksLikeNetBird(item) &&
                        item.timestamp > 0)
                        return item;
                }
            }

            if (itemSorter?.[Symbol.iterator]) {
                for (const item of itemSorter) {
                    if (!netBirdToggle._vpnItemLooksLikeNetBird(item) &&
                        item.visible)
                        return item;
                }
            }

            return null;
        };
    }

    _unpatchVpnQuickSetting() {
        if (!this._vpnToggle)
            return;

        if (this._vpnToggleOriginalGetActiveItems)
            this._vpnToggle._getActiveItems = this._vpnToggleOriginalGetActiveItems;
        if (this._vpnToggleOriginalGetPrimaryItem)
            this._vpnToggle._getPrimaryItem = this._vpnToggleOriginalGetPrimaryItem;

        this._vpnToggleOriginalGetActiveItems = null;
        this._vpnToggleOriginalGetPrimaryItem = null;
        this._vpnToggle._sync?.();
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

    _vpnItemLooksLikeNetBird(item) {
        const labels = [
            readStringProperty(item, 'name'),
            readStringProperty(item, 'title'),
            item?.label?.text,
            item?._label?.text,
            item?._connection?.get_id?.(),
            item?._activeConnection?.connection?.get_id?.(),
        ];

        return labels.some(label =>
            typeof label === 'string' && NETBIRD_VPN_TOGGLE_NAMES.test(label));
    }

    _installNetworkActivationFailedFilter() {
        const network = Main.panel.statusArea.quickSettings?._network ?? null;
        if (!network || this._activationFailedFilterInstalled)
            return;

        this._networkIndicator = network;
        this._originalOnActivationFailed = network._onActivationFailed.bind(network);
        network._onActivationFailed = () => {
            const fromVpn = this._vpnActivationFailedEmitted;
            this._vpnActivationFailedEmitted = false;

            if (fromVpn && this._shouldSuppressNetworkActivationFailed()) {
                network._notification?.destroy();
                network._notification = null;
                return;
            }

            this._originalOnActivationFailed();
        };
        this._activationFailedFilterInstalled = true;
    }

    _uninstallNetworkActivationFailedFilter() {
        if (!this._activationFailedFilterInstalled || !this._networkIndicator)
            return;

        this._networkIndicator._onActivationFailed = this._originalOnActivationFailed;
        this._networkIndicator = null;
        this._originalOnActivationFailed = null;
        this._activationFailedFilterInstalled = false;
        this._vpnActivationFailedEmitted = false;
    }

    _shouldSuppressNetworkActivationFailed() {
        if (this._toggleCommandInProgress)
            return true;

        this._watchVpnQuickSetting();
        return this._vpnToggle && this._vpnToggleLooksLikeNetBird(this._vpnToggle);
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

    destroy() {
        this._destroyed = true;
        this._toggleCommandCancellable?.cancel();
        this._cancellable.cancel();

        this._unwatchVpnQuickSetting();
        this._uninstallNetworkActivationFailedFilter();

        if (this._quickSettingsMenuSignalId) {
            this._quickSettingsMenu.disconnect(this._quickSettingsMenuSignalId);
            this._quickSettingsMenuSignalId = 0;
        }

        super.destroy();
    }
});

const NetBirdIndicator = GObject.registerClass(
class NetBirdIndicator extends SystemIndicator {
    constructor(extension, gicon) {
        super();

        this._indicator = this._addIndicator();
        this._indicator.gicon = gicon;
        this._indicator.visible = false;

        const toggle = new NetBirdToggle(extension, gicon, this._indicator);
        this.quickSettingsItems.push(toggle);
    }
});

export default class NetBirdExtension extends Extension {
    openProfileSettingsWindow() {
        const settingsWindow = this.dir.get_child('settings-window.js').get_path();
        const gjs = GLib.find_program_in_path('gjs') ?? 'gjs';

        try {
            const launcher = new Gio.SubprocessLauncher({});
            launcher.setenv('NETBIRD_GNOME_EXTENSION_DIR', this.dir.get_path(), true);
            launcher.spawnv([gjs, '-m', settingsWindow]);
        } catch (error) {
            Main.notify('NetBird', `Failed to open settings: ${formatErrorMessage(error)}`);
        }
    }

    enable() {
        const iconFile = this.dir.get_child('icons').get_child('netbird-symbolic.svg');
        const icon = Gio.FileIcon.new(iconFile);

        this._indicator = new NetBirdIndicator(this, icon);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
