import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {GENERAL_PAGE_TITLE, SettingsManager} from './settingsManager.js';


const APPLICATION_ID = 'io.netbird.gnome.ProfileSettings';


function buildWindow(application) {
    const window = new Adw.PreferencesWindow({
        application,
        title: 'NetBird Settings',
        default_width: 640,
        default_height: 480,
        search_enabled: true,
    });

    const settings = new SettingsManager();
    const controller = createApplyController(window, settings);

    settings.pages.forEach(pageDefinition => {
        const page = pageDefinition.title === GENERAL_PAGE_TITLE
            ? createGeneralPage(settings, controller)
            : createPage(pageDefinition, settings);
        window.add(page);
    });

    return window;
}

function createApplyController(window, settings) {
    const pendingValues = new Map();
    const rowsByKey = new Map();
    const controller = {
        applyButton: null,
        pendingValues,
        rowsByKey,

        setPendingValue(rowDefinition, value) {
            const normalizedValue = settings.normalizeValue(rowDefinition.key, value);
            if (Object.is(normalizedValue, settings.getValue(rowDefinition.key)))
                pendingValues.delete(rowDefinition.key);
            else
                pendingValues.set(rowDefinition.key, normalizedValue);

            updateApplyButton(controller);
        },

        async apply() {
            const changes = Array.from(pendingValues.entries());
            if (changes.length === 0)
                return;

            setRowsSensitive(settings, rowsByKey, false);
            if (controller.applyButton)
                controller.applyButton.sensitive = false;

            try {
                for (const [key, value] of changes) {
                    await settings.setValue(key, value);
                    pendingValues.delete(key);
                }
            } catch (error) {
                console.warn(`Failed to apply NetBird settings: ${error}`);
                showToast(window, 'Failed to apply NetBird settings');
            } finally {
                setRowsSensitive(settings, rowsByKey, true);
                updateApplyButton(controller);
            }
        },

        cancel() {
            window.close();
        },
    };

    return controller;
}

function createApplyButtonsGroup(controller) {
    const cancelButton = new Gtk.Button({
        label: 'Cancel',
        halign: Gtk.Align.START,
    });
    cancelButton.connect('clicked', () => controller.cancel());

    const applyButton = new Gtk.Button({
        label: 'Apply',
        halign: Gtk.Align.END,
        hexpand: true,
        css_classes: ['suggested-action'],
        sensitive: false,
    });
    applyButton.connect('clicked', () => {
        controller.apply();
    });

    controller.applyButton = applyButton;

    const buttonBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    buttonBox.append(cancelButton);
    buttonBox.append(applyButton);

    const group = new Adw.PreferencesGroup();
    group.add(buttonBox);

    return group;
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

    window.add_toast(new Adw.Toast({title}));
}

function createGeneralPage(settings, controller) {
    const rowsByKey = new Map();
    const page = createPage(settings.getGeneralPage(), settings, {
        rowsByKey,
        controller,
    });

    settings.loadGeneralSettings().then(() => {
        rowsByKey.forEach((row, key) => {
            setRowValue(row, settings.getDefinition(key), settings.getValue(key));
        });
    });

    page.add(createApplyButtonsGroup(controller));

    return page;
}

function createPage(pageDefinition, settings, options = {}) {
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
            if (rowDefinition.key) {
                options.rowsByKey?.set(rowDefinition.key, row);
                options.controller?.rowsByKey.set(rowDefinition.key, row);
            }
            if (options.controller)
                bindRowToSettings(rowDefinition, row, settings, options.controller);

            group.add(row);
        });
    });

    return page;
}

function createRow(rowDefinition, settings) {
    const value = rowDefinition.key
        ? settings.getValue(rowDefinition.key)
        : rowDefinition.defaultValue;

    switch (rowDefinition.type) {
    case 'switch':
        return new Adw.SwitchRow({
            title: rowDefinition.title,
            subtitle: rowDefinition.subtitle ?? '',
            active: Boolean(value),
        });
    case 'entry':
        return new Adw.EntryRow({
            title: rowDefinition.title,
            text: value ?? '',
        });
    case 'password':
        return new Adw.PasswordEntryRow({
            title: rowDefinition.title,
            text: value ?? '',
        });
    case 'spin':
        return new Adw.SpinRow({
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
        });
    case 'action':
        return new Adw.ActionRow({
            title: rowDefinition.title,
            subtitle: rowDefinition.subtitle ?? '',
        });
    default:
        throw new Error(`Unsupported setting row type: ${rowDefinition.type}`);
    }
}

function bindRowToSettings(rowDefinition, row, settings, controller) {
    if (!rowDefinition.key)
        return;

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
            await activateSetting(rowDefinition, row, settings);
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

async function activateSetting(rowDefinition, row, settings) {
    row.sensitive = false;

    try {
        await settings.activate(rowDefinition.key);
    } catch (error) {
        console.warn(`Failed to activate ${rowDefinition.key}: ${error}`);
    } finally {
        row.sensitive = settings.supportsAction(rowDefinition.key);
    }
}

function setRowValue(row, rowDefinition, value) {
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

const application = new Adw.Application({
    application_id: APPLICATION_ID,
    flags: Gio.ApplicationFlags.FLAGS_NONE,
});

application.connect('activate', app => {
    const window = buildWindow(app);
    window.present();
});

application.run([]);
