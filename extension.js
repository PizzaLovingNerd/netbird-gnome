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
    netbird_json_api_available,
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
const NETBIRD_INITIAL_REFRESH_RETRY_MS = 3000;
const NETBIRD_APPLICATION_ID = 'io.netbird.gnome';
const NETBIRD_APPLICATION_NAME = 'NetBird for GNOME';
const NETBIRD_VPN_TOGGLE_NAMES = /\b(netbird|wiretrustee|wt0)\b/i;

const NETBIRD_STATUS_ICON_FILES = {
    connected: 'netbird-systemtray-connected-macos.svg',
    connecting: 'netbird-systemtray-connecting-macos.svg',
    disconnected: 'netbird-systemtray-disconnected-macos.svg',
    error: 'netbird-systemtray-error-macos.svg',
    updateConnected: 'netbird-systemtray-update-connected-macos.svg',
    updateDisconnected: 'netbird-systemtray-update-disconnected-macos.svg',
};


function addMenuActionItem(menu, label, iconName, onActivate) {
    const item = new PopupMenu.PopupImageMenuItem(label, iconName);
    item.connect('activate', onActivate);
    menu.addMenuItem(item);
}

function disconnectSignal(object, signalId, context) {
    if (!object || !signalId)
        return;

    try {
        object.disconnect(signalId);
    } catch (error) {
        console.warn(`${context}: ${error}`);
    }
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
    constructor(extension, icons, indicator) {
        const gicon = icons.disconnected;
        super({
            title: 'NetBird',
            subtitle: '',
            gicon,
            toggleMode: false,
        });

        this._extension = extension;
        this._icons = icons;
        this._gicon = gicon;
        this._headerSubtitle = null;
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
        this._initialRefreshSourceIds = [];
        this._menuOpenSignalId = 0;
        this._lastConnectedStatus = false;
        this._lastUpdateAvailable = false;
        this._lastErrorNotificationUs = 0;

        this._setStatusIcon({
            connected: false,
            panelVisible: false,
            updateAvailable: false,
        });
        this._setHeader(null);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._createAddProfileMenuItem();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        addMenuActionItem(this.menu, 'Refresh', 'view-refresh-symbolic', () => {
            this._refreshNetBirdState();
        });
        addMenuActionItem(this.menu, 'Networks', 'network-workgroup-symbolic', () => {
            this.menu.close();
            this._extension.openNetworksWindow();
        });
        addMenuActionItem(this.menu, 'NetBird Settings', 'preferences-system-symbolic', () => {
            this.menu.close();
            this._extension.openProfileSettingsWindow();
        });

        this.connect('clicked', () => {
            this._runAsync(
                this._onToggleClicked(),
                'Failed to handle NetBird toggle');
        });
        this._menuOpenSignalId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen && this._profileItems.length === 0 && !this._loadingProfiles)
                this._refreshNetBirdState({preserveExisting: false});
        });

        this._scheduleInitialRefresh(0);
        this._scheduleInitialRefresh(NETBIRD_INITIAL_REFRESH_RETRY_MS);
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
            this._runAsync(
                this._selectProfile(profileName, item),
                'Failed to select NetBird profile');
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
            onAccept: profileName => this._runAsync(
                this._addProfile(profileName),
                'Failed to add NetBird profile'),
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
            this._runAsync(
                this._refreshStatus(),
                'Failed to refresh NetBird status');
        } catch (error) {
            if (!this._destroyed && !this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to add NetBird profile', error);
            }
        }
    }

    _refreshNetBirdState({preserveExisting = true} = {}) {
        if (this._destroyed)
            return;

        this._runAsync(
            this._loadProfiles({preserveExisting}),
            'Failed to load NetBird profiles');
        this._runAsync(
            this._refreshStatus(),
            'Failed to refresh NetBird status');
    }

    _scheduleInitialRefresh(delayMs) {
        const sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delayMs,
            () => {
                this._initialRefreshSourceIds =
                    this._initialRefreshSourceIds.filter(id => id !== sourceId);

                if (!this._destroyed) {
                    this._runAsync(
                        this._loadProfiles({preserveExisting: false}),
                        'Failed to load NetBird profiles');
                    this._runAsync(
                        this._refreshStatus(),
                        'Failed to refresh NetBird status');
                }

                return GLib.SOURCE_REMOVE;
            });

        this._initialRefreshSourceIds.push(sourceId);
    }

    _clearInitialRefreshes() {
        for (const sourceId of this._initialRefreshSourceIds)
            GLib.source_remove(sourceId);

        this._initialRefreshSourceIds = [];
    }

    async _loadProfiles({preserveExisting = false} = {}) {
        if (this._destroyed)
            return;

        if (!netbird_json_api_available()) {
            this._setJsonApiUnavailableState();
            if (!preserveExisting && this._profileItems.length === 0)
                this._showProfileStatus('NetBird JSON API unavailable');
            return;
        }

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
            if (!this._destroyed && !this._cancellable.is_cancelled()) {
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
                this._runAsync(
                    this._loadProfiles(pending),
                    'Failed to load NetBird profiles');
        }
    }

    async _selectProfile(profileName, item) {
        if (this._destroyed || this._toggleCommandInProgress)
            return;

        this.subtitle = 'Switching profile...';
        this._setCheckedFromStatus(false);
        this._selectProfileItem(item);
        this._toggleCommandInProgress = true;

        try {
            await netbird_profile_select(profileName, {
                cancellable: this._cancellable,
                timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
            });

            if (this._destroyed)
                return;

            this._clearErrorState();
        } catch (error) {
            if (!this._destroyed && !this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to select NetBird profile', error);
                this._runAsync(
                    this._loadProfiles({preserveExisting: true}),
                    'Failed to load NetBird profiles');
            }
        } finally {
            this._toggleCommandInProgress = false;
            if (!this._destroyed)
                this._runAsync(
                    this._refreshStatus(),
                    'Failed to refresh NetBird status');
        }
    }

    async _onToggleClicked() {
        if (this._destroyed)
            return;

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
        this._setIconState(operation === 'connect' ? 'connecting' : 'disconnected');
    }

    _endToggleCommand() {
        this._toggleOperation = null;
        this._toggleCommandCancellable = null;
        this._toggleCancelRequested = false;
        this._toggleCommandInProgress = false;
    }

    async _runToggleOperation(operation) {
        if (this._destroyed)
            return;

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

            if (this._destroyed)
                return;

            if (!this._toggleCancelRequested)
                this._clearErrorState();
        } catch (error) {
            if (this._toggleCancelRequested ||
                isCancellation(error, this._toggleCommandCancellable))
                return;

            if (!this._destroyed && !this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to change NetBird status', error);
            }
        } finally {
            if (!this._toggleCancelRequested) {
                this._endToggleCommand();
                if (!this._destroyed)
                    this._runAsync(
                        this._refreshStatus(),
                        'Failed to refresh NetBird status');
            }
        }
    }

    async _cancelToggleOperation() {
        if (this._destroyed)
            return;

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

            if (this._destroyed)
                return;

            this._clearErrorState();
        } catch (error) {
            if (!this._destroyed &&
                !this._cancellable.is_cancelled() &&
                !isCancellation(error, commandCancellable))
                this._notifyCliError('Failed to cancel NetBird connection', error);
        } finally {
            this._endToggleCommand();
            if (!this._destroyed) {
                this._setCheckedFromStatus(false);
                this._runAsync(
                    this._refreshStatus(),
                    'Failed to refresh NetBird status');
            }
        }
    }

    async _cancelConnect() {
        if (this._destroyed)
            return;

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

            if (this._destroyed)
                return;

            this._clearErrorState();
        } catch (error) {
            if (!this._destroyed && !this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to cancel NetBird connection', error);
            }
        } finally {
            this._endToggleCommand();
            if (!this._destroyed) {
                this._setCheckedFromStatus(false);
                this._runAsync(
                    this._refreshStatus(),
                    'Failed to refresh NetBird status');
            }
        }
    }

    async _refreshStatus() {
        if (this._destroyed || this._toggleCommandInProgress || this._statusRefreshInProgress)
            return;

        if (!netbird_json_api_available()) {
            this._lastConnectedStatus = false;
            this._lastUpdateAvailable = false;
            this._setCheckedFromStatus(false);
            this._setJsonApiUnavailableState();
            return;
        }

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
            if (!this._destroyed && !this._cancellable.is_cancelled()) {
                this._setErrorState();
                this._notifyCliError('Failed to refresh NetBird status', error);
            }
        } finally {
            this._statusRefreshInProgress = false;
        }
    }

    _setCheckedFromStatus(checked) {
        this._settingCheckedFromStatus = true;
        if (this.checked !== checked)
            this.checked = checked;
        this._settingCheckedFromStatus = false;

        if (this._hasError)
            return;

        this._setStatusIcon({
            connected: checked,
            updateAvailable: this._lastUpdateAvailable,
        });
    }

    _syncFromStatus(status) {
        this._lastConnectedStatus = status.connected;
        this._lastUpdateAvailable = Boolean(status.updateAvailable);
        this._setCheckedFromStatus(status.connected);

        if (status.profileName)
            this._setSelectedProfileName(status.profileName);

        if (this._hasError)
            return;

        if (status.status.toLowerCase() === 'connecting') {
            this._connectingFromStatus = true;
            this._setIconState('connecting');
            this._indicator.visible = true;
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
        this._headerSubtitle = subtitle;
        const hasSubtitle = Boolean(subtitle);
        this.menu.setHeader(this._gicon, 'NetBird', hasSubtitle ? subtitle : null);
    }

    _setIconState(state) {
        const gicon = this._icons[state] ?? this._icons.disconnected;
        if (this._gicon === gicon)
            return;

        this._gicon = gicon;
        this.gicon = gicon;
        this._indicator.gicon = gicon;
        this._setHeader(this._headerSubtitle);
    }

    _setStatusIcon({
        connected = this._lastConnectedStatus,
        panelVisible = null,
        updateAvailable = this._lastUpdateAvailable,
    } = {}) {
        const state = updateAvailable
            ? connected ? 'updateConnected' : 'updateDisconnected'
            : connected ? 'connected' : 'disconnected';

        this._setIconState(state);
        this._indicator.visible = panelVisible ?? (connected || updateAvailable);
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

    _setErrorState(subtitle = 'ERROR') {
        this._hasError = true;
        this._setIconState('error');
        this._indicator.visible = true;
        this.subtitle = subtitle;
    }

    _clearErrorState() {
        if (!this._hasError)
            return;

        this._hasError = false;
        this._setStatusIcon();
        this.subtitle = this._selectedProfileName;
    }

    _notifyCliError(context, error) {
        if (this._destroyed)
            return;

        const message = formatErrorMessage(error);
        console.warn(`${context}: ${message}`);

        const nowUs = GLib.get_monotonic_time();
        if (nowUs - this._lastErrorNotificationUs < NETBIRD_ERROR_NOTIFY_THROTTLE_US)
            return;

        this._lastErrorNotificationUs = nowUs;
        Main.notify('NetBird', `${context}: ${message}`);
    }

    _notifyBrowserLogin() {
        if (this._destroyed)
            return;

        Main.notify('NetBird', 'Launching browser for NetBird sign in');
    }

    _setJsonApiUnavailableState() {
        this._setErrorState('Service unavailable');
        this._notifyCliError(
            'NetBird service unavailable',
            new Error('The NetBird JSON socket is unavailable. Start NetBird with JSON API support enabled.'));
    }

    _runAsync(promise, context) {
        Promise.resolve(promise).catch(error => {
            if (this._destroyed || this._cancellable.is_cancelled())
                return;

            this._setErrorState();
            this._notifyCliError(context, error);
        });
    }

    destroy() {
        this._destroyed = true;
        this._clearInitialRefreshes();
        disconnectSignal(
            this.menu,
            this._menuOpenSignalId,
            'Failed to disconnect NetBird menu open signal');
        this._menuOpenSignalId = 0;
        this._toggleCommandCancellable?.cancel();
        this._cancellable.cancel();

        super.destroy();
    }
});

const NetBirdIndicator = GObject.registerClass(
class NetBirdIndicator extends SystemIndicator {
    constructor(extension, icons) {
        super();

        this._destroyed = false;
        this._indicator = this._addIndicator();
        this._indicator.gicon = icons.disconnected;
        this._indicator.visible = false;

        const toggle = new NetBirdToggle(extension, icons, this._indicator);
        this.quickSettingsItems.push(toggle);
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;

        for (const item of [...this.quickSettingsItems])
            item.destroy();

        this.quickSettingsItems.length = 0;
        super.destroy();
    }
});

export default class NetBirdExtension extends Extension {
    constructor(metadata) {
        super(metadata);

        this._indicator = null;
        this._networksWindowProcess = null;
        this._settingsWindowProcess = null;
        this._vpnDownCancellable = null;
        this._vpnDownInProgress = false;
        this._vpnPatchToken = {};
        this._vpnToggle = null;
        this._vpnToggleCheckedSignalId = 0;
        this._vpnWatchSourceId = 0;
    }

    openProfileSettingsWindow() {
        this._ensureDesktopFile();

        const settingsWindow = this.dir.get_child('settings-window.js').get_path();
        this._openTrackedWindow('_settingsWindowProcess', settingsWindow, 'settings');
    }

    openNetworksWindow() {
        this._ensureDesktopFile();

        const networksWindow = this.dir.get_child('networks-window.js').get_path();
        this._openTrackedWindow('_networksWindowProcess', networksWindow, 'networks');
    }

    _openTrackedWindow(processProperty, windowPath, label) {
        const existingProcess = this[processProperty];
        if (existingProcess && !existingProcess.get_if_exited())
            return;

        const gjs = GLib.find_program_in_path('gjs') ?? 'gjs';

        try {
            const launcher = new Gio.SubprocessLauncher({});
            launcher.setenv('NETBIRD_GNOME_EXTENSION_DIR', this.dir.get_path(), true);
            const process = launcher.spawnv([gjs, '-m', windowPath]);
            this[processProperty] = process;

            process.wait_async(null, (subprocess, result) => {
                try {
                    subprocess.wait_finish(result);
                } catch (error) {
                    console.warn(`Failed to watch NetBird ${label} window process: ${error}`);
                } finally {
                    if (this[processProperty] === subprocess)
                        this[processProperty] = null;
                }
            });
        } catch (error) {
            Main.notify('NetBird', `Failed to open ${label}: ${formatErrorMessage(error)}`);
        }
    }

    enable() {
        if (this._indicator)
            this.disable();

        this._ensureDesktopFile();

        const icons = this._createIconSet();
        let indicator = null;

        try {
            indicator = new NetBirdIndicator(this, icons);
            Main.panel.statusArea.quickSettings.addExternalIndicator(indicator);
            this._indicator = indicator;
            this._scheduleNativeVpnWatch();
        } catch (error) {
            indicator?.destroy();
            this._indicator = null;
            throw error;
        }
    }

    _createIconSet() {
        const iconsDir = this.dir.get_child('icons');
        const fallback = Gio.icon_new_for_string(
            iconsDir.get_child('netbird.svg').get_path());
        const icons = {};

        for (const [state, fileName] of Object.entries(NETBIRD_STATUS_ICON_FILES)) {
            const file = iconsDir.get_child(fileName);
            icons[state] = file.query_exists(null)
                ? Gio.icon_new_for_string(file.get_path())
                : fallback;
        }

        return icons;
    }

    _ensureDesktopFile() {
        const extensionDir = this.dir.get_path();
        if (!extensionDir)
            return;

        const desktopDir = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'applications',
        ]);
        const desktopPath = GLib.build_filenamev([
            desktopDir,
            `${NETBIRD_APPLICATION_ID}.desktop`,
        ]);
        const gjs = GLib.find_program_in_path('gjs') ?? 'gjs';
        const settingsWindow = GLib.build_filenamev([extensionDir, 'settings-window.js']);
        const iconPath = GLib.build_filenamev([extensionDir, 'icons', 'netbird.svg']);
        const contents = [
            '[Desktop Entry]',
            'Type=Application',
            `Name=${NETBIRD_APPLICATION_NAME}`,
            'Comment=NetBird Quick Setting for GNOME',
            `Exec=${GLib.shell_quote(gjs)} -m ${GLib.shell_quote(settingsWindow)}`,
            `Icon=${iconPath}`,
            'NoDisplay=true',
            'StartupNotify=false',
            'Categories=Network;GNOME;GTK;',
            '',
        ].join('\n');

        try {
            GLib.mkdir_with_parents(desktopDir, 0o755);
            GLib.file_set_contents(desktopPath, contents);
        } catch (error) {
            console.warn(`Failed to write NetBird desktop entry: ${error}`);
        }
    }

    disable() {
        this._unwatchNativeVpnToggle();

        if (this._vpnWatchSourceId) {
            GLib.source_remove(this._vpnWatchSourceId);
            this._vpnWatchSourceId = 0;
        }

        this._vpnDownCancellable?.cancel();
        this._vpnDownCancellable = null;
        this._vpnDownInProgress = false;

        if (!this._indicator)
            return;

        this._indicator.destroy();
        this._indicator = null;
    }

    _scheduleNativeVpnWatch() {
        if (this._vpnWatchSourceId)
            return;

        this._vpnWatchSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._vpnWatchSourceId = 0;

            if (!this._indicator)
                return GLib.SOURCE_REMOVE;

            this._watchNativeVpnToggle();
            return GLib.SOURCE_REMOVE;
        });
    }

    _watchNativeVpnToggle() {
        const vpnToggle = Main.panel.statusArea.quickSettings?._network?._vpnToggle ?? null;
        if (this._vpnToggle === vpnToggle)
            return;

        this._unwatchNativeVpnToggle();

        if (!vpnToggle)
            return;

        this._vpnToggle = vpnToggle;
        this._patchNativeVpnToggle();
        this._vpnToggleCheckedSignalId = vpnToggle.connect(
            'notify::checked',
            () => this._onNativeVpnCheckedChanged());
    }

    _unwatchNativeVpnToggle() {
        if (!this._vpnToggle)
            return;

        this._unpatchNativeVpnToggle();
        disconnectSignal(
            this._vpnToggle,
            this._vpnToggleCheckedSignalId,
            'Failed to disconnect native VPN toggle signal');
        this._vpnToggle = null;
        this._vpnToggleCheckedSignalId = 0;
    }

    _patchNativeVpnToggle() {
        if (!this._vpnToggle)
            return;

        if (this._vpnToggle._netBirdPatchOwner === this._vpnPatchToken)
            return;

        if (this._vpnToggle._netBirdPatchOwner)
            this._restoreNativeVpnToggle(this._vpnToggle);

        const vpnToggle = this._vpnToggle;
        const originalActivate = vpnToggle.activate;
        const originalGetActiveItems = vpnToggle._getActiveItems;
        const originalGetPrimaryItem = vpnToggle._getPrimaryItem;

        if (typeof originalActivate !== 'function' ||
            typeof originalGetActiveItems !== 'function' ||
            typeof originalGetPrimaryItem !== 'function')
            return;

        vpnToggle._netBirdOriginalActivate = originalActivate;
        vpnToggle._netBirdOriginalGetActiveItems = originalGetActiveItems;
        vpnToggle._netBirdOriginalGetPrimaryItem = originalGetPrimaryItem;
        vpnToggle._netBirdPatchOwner = this._vpnPatchToken;

        const extension = this;
        vpnToggle.activate = function () {
            if (!this.checked)
                extension._disconnectNetBirdForNativeVpn();

            originalActivate.call(this);
        };

        vpnToggle._getActiveItems = function* () {
            for (const item of originalGetActiveItems.call(this)) {
                if (!extension._vpnItemLooksLikeNetBird(item))
                    yield item;
            }
        };

        vpnToggle._getPrimaryItem = function () {
            const [activeItem] = this._getActiveItems();
            if (activeItem)
                return activeItem;

            const itemSorter = this._itemSorter;
            if (itemSorter?.itemsByMru) {
                for (const item of itemSorter.itemsByMru()) {
                    if (!extension._vpnItemLooksLikeNetBird(item) &&
                        item.timestamp > 0)
                        return item;
                }
            }

            if (itemSorter?.[Symbol.iterator]) {
                for (const item of itemSorter) {
                    if (!extension._vpnItemLooksLikeNetBird(item) &&
                        item.visible)
                        return item;
                }
            }

            return null;
        };

        this._syncNativeVpnToggle();
    }

    _unpatchNativeVpnToggle() {
        if (!this._vpnToggle ||
            this._vpnToggle._netBirdPatchOwner !== this._vpnPatchToken)
            return;

        this._restoreNativeVpnToggle(this._vpnToggle);
        this._syncNativeVpnToggle();
    }

    _restoreNativeVpnToggle(vpnToggle) {
        if (vpnToggle._netBirdOriginalActivate)
            vpnToggle.activate = vpnToggle._netBirdOriginalActivate;
        if (vpnToggle._netBirdOriginalGetActiveItems)
            vpnToggle._getActiveItems = vpnToggle._netBirdOriginalGetActiveItems;
        if (vpnToggle._netBirdOriginalGetPrimaryItem)
            vpnToggle._getPrimaryItem = vpnToggle._netBirdOriginalGetPrimaryItem;

        delete vpnToggle._netBirdOriginalActivate;
        delete vpnToggle._netBirdOriginalGetActiveItems;
        delete vpnToggle._netBirdOriginalGetPrimaryItem;
        delete vpnToggle._netBirdPatchOwner;
    }

    _syncNativeVpnToggle() {
        try {
            this._vpnToggle?._sync?.();
        } catch (error) {
            console.warn(`Failed to sync native VPN toggle: ${error}`);
        }
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

    _onNativeVpnCheckedChanged() {
        if (!this._indicator || !this._vpnToggle?.checked)
            return;

        this._disconnectNetBirdForNativeVpn().catch(error => {
            console.warn(`Failed to disconnect NetBird for native VPN: ${formatErrorMessage(error)}`);
        });
    }

    async _disconnectNetBirdForNativeVpn() {
        if (this._vpnDownInProgress || !netbird_json_api_available())
            return;

        this._vpnDownInProgress = true;
        this._vpnDownCancellable?.cancel();
        this._vpnDownCancellable = new Gio.Cancellable();
        const cancellable = this._vpnDownCancellable;

        try {
            await netbird_down({
                cancellable,
                timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
            });
        } catch (error) {
            if (!cancellable.is_cancelled())
                console.warn(`Failed to disconnect NetBird for native VPN: ${error}`);
        } finally {
            if (this._vpnDownCancellable === cancellable)
                this._vpnDownCancellable = null;
            this._vpnDownInProgress = false;
        }
    }
}
