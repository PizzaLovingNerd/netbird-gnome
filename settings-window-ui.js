import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import {
    netbird_json_api_available,
    netbird_deregister,
    netbird_profile_add,
    netbird_profile_list,
    netbird_profile_remove,
    netbird_profile_select,
} from './api/index.js';
import {confirmProfileDeregister, promptProfileName} from './gtkProfileDialogs.js';
import {_} from './i18n.js';
import {GENERAL_PAGE_TITLE, SettingsManager} from './settingsManager.js';
import {setNetBirdWindowIcon} from './windowIcon.js';


const NETBIRD_PROFILE_TIMEOUT_MS = 30000;


export function createSettingsWindow(application) {
    const window = new Adw.ApplicationWindow({
        application,
        title: _('NetBird Settings'),
        default_width: 860,
        default_height: 600,
    });
    setNetBirdWindowIcon(window);

    const settings = new SettingsManager();
    const toastOverlay = new Adw.ToastOverlay();
    const controller = createApplyController(window, settings, toastOverlay);
    const title = new Adw.WindowTitle({
        title: GENERAL_PAGE_TITLE,
        subtitle: '',
    });

    const stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
        hexpand: true,
        vexpand: true,
    });

    const profileSwitcher = createProfileSwitcher(settings, controller, toastOverlay);
    const onProfilesChanged = async () => {
        const activeProfile = await profileSwitcher.refresh();
        await settings.loadSettings(activeProfile);
        controller.pendingValues.clear();
        updateApplyButton(controller);
        reloadSettingsValues(settings, controller);
        profileSwitcher.setSelected(settings.activeProfileName);
    };

    settings.pages.forEach(pageDefinition => {
        const page = createPage(pageDefinition, settings, {
            controller,
            onProfilesChanged,
            stack,
            toastOverlay,
            window,
        });

        const stackPage = stack.add_titled(page, pageDefinition.title, pageDefinition.title);
        stackPage.icon_name = pageDefinition.iconName;
    });

    stack.connect('notify::visible-child-name', () => {
        title.title = stack.visible_child_name ?? GENERAL_PAGE_TITLE;
    });

    toastOverlay.set_child(createSettingsLayout(stack, settings.pages));
    window.set_content(createWindowContent(
        createHeaderBar(controller, title, profileSwitcher),
        toastOverlay,
    ));

    initializeSettings(
        settings,
        controller,
        profileSwitcher,
        toastOverlay);

    return window;
}

async function initializeSettings(settings, controller, profileSwitcher, toastOverlay) {
    if (!netbird_json_api_available()) {
        setRowsSensitive(settings, controller.rowsByKey, false);
        showToast(toastOverlay, _('NetBird JSON API is unavailable'));
        return;
    }

    try {
        const activeProfile = await profileSwitcher.refresh();
        await loadSettingsValues(settings, controller, activeProfile);
    } catch (error) {
        console.warn(`Failed to initialize NetBird settings: ${error}`);
        setRowsSensitive(settings, controller.rowsByKey, false);
        showToast(toastOverlay, _('NetBird JSON API is unavailable'));
    }
}

function createApplyController(window, settings, toastOverlay) {
    const pendingValues = new Map();
    const rowsByKey = new Map();

    return {
        applyButton: null,
        pendingValues,
        rowsByKey,

        setPendingValue(rowDefinition, value) {
            const normalizedValue = settings.normalizeValue(rowDefinition.key, value);
            if (Object.is(normalizedValue, settings.getValue(rowDefinition.key)))
                pendingValues.delete(rowDefinition.key);
            else
                pendingValues.set(rowDefinition.key, normalizedValue);

            updateApplyButton(this);
        },

        async apply() {
            const changes = Array.from(pendingValues.entries());
            if (changes.length === 0)
                return;

            setRowsSensitive(settings, rowsByKey, false);
            if (this.applyButton)
                this.applyButton.sensitive = false;

            try {
                await settings.applyChanges(changes);
                pendingValues.clear();
                showToast(toastOverlay, _('Settings saved'));
            } catch (error) {
                console.warn(`Failed to apply NetBird settings: ${error}`);
                const message = String(error).includes('cancelled')
                    ? _('Settings save was cancelled')
                    : _('Failed to apply NetBird settings');
                showToast(toastOverlay, message);
            } finally {
                setRowsSensitive(settings, rowsByKey, true);
                updateApplyButton(this);
            }
        },

        cancel() {
            window.close();
        },
    };
}

function createProfileSwitcher(settings, controller, toastOverlay) {
    const profileMenu = new Gtk.DropDown({
        valign: Gtk.Align.CENTER,
    });
    let switchingProfile = false;

    const switcher = {
        widget: profileMenu,
        _profileNames: [],
        _suppressSwitch: false,

        async refresh() {
            this._suppressSwitch = true;

            try {
                const result = await netbird_profile_list({
                    timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
                });
                const profiles = result.profiles ?? [];
                const names = profiles.map(profile => profile.name);
                if (names.length === 0)
                    names.push(settings.activeProfileName || 'default');

                this._profileNames = names;
                profileMenu.set_model(Gtk.StringList.new(names));

                const activeProfile = result.activeProfile ||
                    settings.activeProfileName ||
                    names[0];
                const selectedIndex = Math.max(0, names.indexOf(activeProfile));
                profileMenu.set_selected(selectedIndex);
                return activeProfile;
            } finally {
                this._suppressSwitch = false;
            }
        },

        setSelected(profileName) {
            const index = this._profileNames.indexOf(profileName);
            if (index >= 0)
                profileMenu.set_selected(index);
        },
    };

    profileMenu.connect('notify::selected', async () => {
        if (switchingProfile || switcher._suppressSwitch)
            return;

        const index = profileMenu.get_selected();
        const profileName = switcher._profileNames[index];
        if (!profileName || profileName === settings.activeProfileName)
            return;

        switchingProfile = true;
        profileMenu.sensitive = false;

        try {
            controller.pendingValues.clear();
            updateApplyButton(controller);
            await settings.switchProfile(profileName);
            reloadSettingsValues(settings, controller);
            switcher.setSelected(settings.activeProfileName);
        } catch (error) {
            console.warn(`Failed to switch NetBird profile: ${error}`);
            showToast(toastOverlay, _('Failed to switch NetBird profile'));
            switcher.setSelected(settings.activeProfileName);
        } finally {
            profileMenu.sensitive = true;
            switchingProfile = false;
        }
    });

    return switcher;
}

function createHeaderBar(controller, title, profileSwitcher) {
    const headerBar = new Adw.HeaderBar({
        title_widget: title,
        show_start_title_buttons: false,
        show_end_title_buttons: false,
    });

    const cancelButton = new Gtk.Button({
        label: _('Cancel'),
    });
    cancelButton.connect('clicked', () => controller.cancel());
    headerBar.pack_start(cancelButton);

    headerBar.pack_start(profileSwitcher.widget);

    const applyButton = new Gtk.Button({
        label: _('Apply'),
        css_classes: ['suggested-action'],
        sensitive: false,
    });
    applyButton.connect('clicked', () => {
        controller.apply();
    });
    controller.applyButton = applyButton;
    headerBar.pack_end(applyButton);

    return headerBar;
}

function createWindowContent(headerBar, content) {
    const windowContent = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
    });

    content.hexpand = true;
    content.vexpand = true;

    windowContent.append(headerBar);
    windowContent.append(content);

    return windowContent;
}

function createSettingsLayout(stack, pages) {
    return new Adw.NavigationSplitView({
        sidebar: new Adw.NavigationPage({
            title: _('Sidebar'),
            child: createSidebar(stack, pages),
        }),
        content: new Adw.NavigationPage({
            title: _('Settings'),
            child: stack,
        }),
        sidebar_width_fraction: 0.2,
        hexpand: true,
        vexpand: true,
    });
}

function createSidebar(stack, pages) {
    const sidebar = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.SINGLE,
        vexpand: true,
        css_classes: ['navigation-sidebar'],
    });

    let firstRow = null;
    pages.forEach((pageDefinition, index) => {
        const row = createSidebarRow(pageDefinition);
        sidebar.append(row);

        if (index === 0)
            firstRow = row;
    });

    sidebar.connect('row-selected', (_listBox, row) => {
        if (row?._pageName && stack.visible_child_name !== row._pageName)
            stack.visible_child_name = row._pageName;
    });

    stack.connect('notify::visible-child-name', () => {
        const pageName = stack.visible_child_name;
        for (let row = sidebar.get_first_child(); row; row = row.get_next_sibling()) {
            if (row._pageName === pageName) {
                sidebar.select_row(row);
                break;
            }
        }
    });

    if (firstRow)
        sidebar.select_row(firstRow);

    return sidebar;
}

function createSidebarRow(pageDefinition) {
    const row = new Gtk.ListBoxRow({
        name: pageDefinition.title,
    });
    row._pageName = pageDefinition.title;

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        margin_top: 7,
        margin_bottom: 7,
        margin_start: 8,
        margin_end: 8,
    });

    box.append(new Gtk.Image({
        icon_name: pageDefinition.iconName,
        pixel_size: 16,
    }));

    box.append(new Gtk.Label({
        label: pageDefinition.title,
        xalign: 0,
        hexpand: true,
    }));

    row.set_child(box);

    return row;
}

function createPage(pageDefinition, settings, {
    controller = null,
    onProfilesChanged = null,
    stack = null,
    toastOverlay = null,
    window = null,
} = {}) {
    if (pageDefinition.type === 'profiles')
        return createProfilesPage(pageDefinition, settings, controller, toastOverlay, window, onProfilesChanged);

    const page = new Adw.PreferencesPage({
        title: pageDefinition.title,
        icon_name: pageDefinition.iconName,
    });

    pageDefinition.groups.forEach(groupDefinition => {
        const group = new Adw.PreferencesGroup({
            title: groupDefinition.title,
        });
        page.add(group);

        groupDefinition.rows.forEach(rowDefinition => {
            const row = createRow(rowDefinition, settings);
            if (controller && rowDefinition.key) {
                controller.rowsByKey.set(rowDefinition.key, row);
                bindRowToSettings(rowDefinition, row, settings, controller, {
                    stack,
                    toastOverlay,
                });
            }

            group.add(row);
        });
    });

    return page;
}

function createProfilesPage(pageDefinition, settings, controller, toastOverlay, window, onProfilesChanged = null) {
    const page = new Adw.PreferencesPage({
        title: pageDefinition.title,
        icon_name: pageDefinition.iconName,
    });

    const profilesGroup = new Adw.PreferencesGroup({
        title: _('Profiles'),
    });
    page.add(profilesGroup);

    const addRow = new Adw.ActionRow({
        title: _('Add Profile'),
        subtitle: _('Create a new NetBird profile'),
        use_markup: false,
    });
    const addButton = new Gtk.Button({
        label: _('Add'),
        css_classes: ['suggested-action'],
        valign: Gtk.Align.CENTER,
    });
    addRow.add_suffix(addButton);
    addRow.activatable_widget = addButton;

    const profileRows = [];
    let busy = false;

    const setProfileRows = rows => {
        profileRows.forEach(row => profilesGroup.remove(row));
        profileRows.length = 0;

        rows.forEach(row => {
            profilesGroup.add(row);
            profileRows.push(row);
        });

        profilesGroup.remove(addRow);
        profilesGroup.add(addRow);
    };

    const refreshProfiles = async () => {
        if (!netbird_json_api_available()) {
            addButton.sensitive = false;
            setProfileRows([
                createStatusRow(
                    _('NetBird JSON API Unavailable'),
                    _('Profile management requires the upcoming NetBird JSON API.')),
            ]);
            return;
        }

        if (profileRows.length === 0) {
            setProfileRows([
                createStatusRow(_('Loading Profiles'), _('Reading NetBird profiles...')),
            ]);
        }

        try {
            const result = await netbird_profile_list({
                timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
            });
            renderProfileRows(result.profiles);
        } catch (error) {
            console.warn(`Failed to load NetBird profiles: ${error}`);
            setProfileRows([
                createStatusRow(_('Failed to Load Profiles'), String(error)),
                createRefreshProfilesRow(refreshProfiles),
            ]);
            showToast(toastOverlay, _('Failed to load NetBird profiles'));
        }
    };

    const setBusy = value => {
        busy = value;
        addButton.sensitive = !busy;
        profileRows.forEach(row => {
            row.sensitive = !busy;
        });
    };

    const runProfileAction = async (callback, failureTitle, profilesChanged = null) => {
        if (busy)
            return;

        setBusy(true);
        try {
            await callback();
            await refreshProfiles();
            if (profilesChanged)
                await profilesChanged();
        } catch (error) {
            console.warn(`${failureTitle}: ${error}`);
            showToast(toastOverlay, failureTitle);
        } finally {
            setBusy(false);
        }
    };

    const renderProfileRows = profiles => {
        const rows = [createRefreshProfilesRow(refreshProfiles)];
        if (profiles.length === 0) {
            rows.push(createStatusRow(_('No Profiles'), _('Add a profile to get started.')));
        } else {
            profiles.forEach(profile => {
                rows.push(createProfileRow(profile, {
                    onDeregister: profileName => confirmProfileDeregister({
                        parent: window,
                        profileName,
                        onAccept: () => runProfileAction(
                            () => netbird_deregister(profileName, {
                                timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
                            }),
                            _('Failed to deregister profile %s').replace('%s', profileName),
                            onProfilesChanged),
                    }),
                    onRemove: profileName => runProfileAction(
                        () => netbird_profile_remove(profileName, {
                            timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
                        }),
                        _('Failed to remove profile %s').replace('%s', profileName),
                        onProfilesChanged),
                }));
            });
        }

        setProfileRows(rows);
    };

    addButton.connect('clicked', () => {
        promptProfileName({
            parent: window,
            onAccept: profileName => runProfileAction(
                () => netbird_profile_add(profileName, {
                    timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
                }),
                _('Failed to add profile %s').replace('%s', profileName),
                onProfilesChanged),
        });
    });

    profilesGroup.add(addRow);
    refreshProfiles();

    return page;
}

function createRefreshProfilesRow(onRefresh) {
    const row = new Adw.ActionRow({
        title: _('Refresh Profiles'),
        subtitle: _('Reload the current NetBird profile list'),
        use_markup: false,
    });
    const button = new Gtk.Button({
        icon_name: 'view-refresh-symbolic',
        valign: Gtk.Align.CENTER,
    });
    setAccessibleLabel(button, _('Refresh Profiles'));
    button.connect('clicked', () => {
        onRefresh();
    });
    row.add_suffix(button);
    row.activatable_widget = button;

    return row;
}

function createProfileRow(profile, {
    onDeregister,
    onRemove,
}) {
    const row = new Adw.ActionRow({
        title: profile.name,
        subtitle: profile.selected ? _('Active profile') : '',
        use_markup: false,
    });

    row.add_prefix(new Gtk.Image({
        icon_name: profile.selected ? 'object-select-symbolic' : 'avatar-default-symbolic',
        pixel_size: 16,
    }));

    const deregisterButton = new Gtk.Button({
        label: _('Deregister'),
        valign: Gtk.Align.CENTER,
    });
    deregisterButton.connect('clicked', () => {
        onDeregister(profile.name);
    });
    row.add_suffix(deregisterButton);

    const removeButton = new Gtk.Button({
        label: _('Remove'),
        css_classes: ['destructive-action'],
        valign: Gtk.Align.CENTER,
        sensitive: !profile.selected,
        tooltip_text: profile.selected
            ? _('Switch to another profile before removing')
            : _('Delete this profile'),
    });
    removeButton.connect('clicked', () => {
        onRemove(profile.name);
    });
    row.add_suffix(removeButton);

    return row;
}

function createStatusRow(title, subtitle = '') {
    return new Adw.ActionRow({
        title,
        subtitle,
        activatable: false,
        use_markup: false,
    });
}

function createRow(rowDefinition, settings) {
    const value = rowDefinition.key
        ? settings.getValue(rowDefinition.key)
        : rowDefinition.defaultValue;

    let row;
    switch (rowDefinition.type) {
    case 'switch':
        row = new Adw.SwitchRow({
            title: rowDefinition.title,
            subtitle: rowDefinition.subtitle ?? '',
            active: Boolean(value),
            use_markup: false,
        });
        break;
    case 'entry':
        row = new Adw.EntryRow({
            title: rowDefinition.title,
            text: value ?? '',
            use_markup: false,
        });
        break;
    case 'password':
        row = new Adw.PasswordEntryRow({
            title: rowDefinition.title,
            text: value ?? '',
            use_markup: false,
        });
        break;
    case 'spin':
        row = new Adw.SpinRow({
            title: rowDefinition.title,
            subtitle: rowDefinition.subtitle ?? '',
            adjustment: new Gtk.Adjustment({
                lower: rowDefinition.lower,
                upper: rowDefinition.upper,
                step_increment: rowDefinition.stepIncrement ?? 1,
                page_increment: rowDefinition.pageIncrement ?? 10,
                value,
            }),
            climb_rate: 1,
            digits: 0,
            use_markup: false,
        });
        break;
    case 'action':
        row = new Adw.ActionRow({
            title: rowDefinition.title,
            subtitle: rowDefinition.subtitle ?? '',
            use_markup: false,
        });
        break;
    default:
        throw new Error(`Unsupported setting row type: ${rowDefinition.type}`);
    }

    return row;
}

function bindRowToSettings(rowDefinition, row, settings, controller, {
    stack = null,
    toastOverlay = null,
} = {}) {
    switch (rowDefinition.type) {
    case 'switch':
        row.sensitive = settings.supportsWrite(rowDefinition.key);
        row.connect('notify::active', () => {
            if (row._syncingFromSettings)
                return;

            controller.setPendingValue(rowDefinition, row.active);
        });
        break;
    case 'action':
        row.activatable = settings.supportsAction(rowDefinition.key);
        row.connect('activated', async () => {
            if (rowDefinition.key === 'profile' && stack) {
                stack.visible_child_name = 'Profiles';
                return;
            }

            await activateSetting(rowDefinition, row, settings, toastOverlay);
        });
        break;
    case 'entry':
    case 'password':
        row.connect('notify::text', () => {
            if (row._syncingFromSettings)
                return;

            controller.setPendingValue(rowDefinition, row.text);
        });
        break;
    case 'spin':
        row.connect('notify::value', () => {
            if (row._syncingFromSettings)
                return;

            controller.setPendingValue(rowDefinition, row.value);
        });
        break;
    }
}

async function activateSetting(rowDefinition, row, settings, toastOverlay = null) {
    const previousSubtitle = row.subtitle ?? '';
    row.sensitive = false;

    try {
        const result = await settings.activate(rowDefinition.key);
        const message = formatActionResult(rowDefinition, result);
        if (message && row.subtitle !== undefined)
            row.subtitle = message;
        if (message)
            showToast(toastOverlay, message);
    } catch (error) {
        console.warn(`Failed to activate ${rowDefinition.key}: ${error}`);
        if (row.subtitle !== undefined)
            row.subtitle = previousSubtitle;
        showToast(
            toastOverlay,
            _('Failed to activate %s').replace('%s', rowDefinition.title));
    } finally {
        row.sensitive = settings.supportsAction(rowDefinition.key);
    }
}

function formatActionResult(rowDefinition, result) {
    if (rowDefinition.key === 'updateDaemon')
        return result?.message || _('Daemon update request completed');

    if (rowDefinition.key === 'createDebugBundle')
        return _('Debug bundle created');

    return result?.message ?? '';
}

async function loadSettingsValues(settings, controller, profileName) {
    await settings.loadSettings(profileName);
    reloadSettingsValues(settings, controller);
}

function reloadSettingsValues(settings, controller) {
    controller.rowsByKey.forEach((row, key) => {
        const definition = settings.getDefinition(key);
        const value = settings.getValue(key);

        if (key === 'profile' && row.subtitle !== undefined)
            row.subtitle = settings.activeProfileName || _('Open profile management');

        setRowValue(row, definition, value);
    });
}

function setRowValue(row, rowDefinition, value) {
    // Updating rows from the daemon should not mark them as user edits.
    row._syncingFromSettings = true;
    switch (rowDefinition.type) {
    case 'switch':
        if (row.active !== Boolean(value))
            row.active = Boolean(value);
        break;
    case 'entry':
    case 'password':
        if (row.text !== String(value ?? ''))
            row.text = String(value ?? '');
        break;
    case 'spin':
        if (row.value !== Number(value))
            row.value = Number(value);
        break;
    }
    row._syncingFromSettings = false;
}

function updateApplyButton(controller) {
    if (controller.applyButton)
        controller.applyButton.sensitive = controller.pendingValues.size > 0;
}

function setRowsSensitive(settings, rowsByKey, sensitive) {
    rowsByKey.forEach((row, key) => {
        row.sensitive = sensitive && settings.supportsWrite(key);
    });
}

function showToast(window, title) {
    if (typeof window.add_toast !== 'function')
        return;

    window.add_toast(new Adw.Toast({title, use_markup: false}));
}

function setAccessibleLabel(widget, label) {
    widget.update_property([Gtk.AccessibleProperty.LABEL], [label]);
}
