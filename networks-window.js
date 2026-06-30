import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {
    netbird_json_api_available,
    netbird_down,
    netbird_network_deselect,
    netbird_network_list,
    netbird_network_select,
    netbird_profile_list,
    netbird_profile_select,
    netbird_status,
    netbird_up,
} from './api/index.js';
import {
    configureNetBirdApplicationIdentity,
    NETBIRD_APPLICATION_ID,
    registerNetBirdIcon,
    setNetBirdWindowIcon,
} from './windowIcon.js';


const NETBIRD_COMMAND_TIMEOUT_MS = 30000;
const NETBIRD_PROFILE_TIMEOUT_MS = 30000;

configureNetBirdApplicationIdentity();


function createNetworksWindow(application) {
    const window = new Adw.PreferencesWindow({
        application,
        title: 'Networks',
        default_width: 760,
        default_height: 560,
        search_enabled: false,
    });
    setNetBirdWindowIcon(window);

    const ui = createNetworksUi(window);
    window.add(ui.homePage.widget);
    window.add(ui.peersPage.widget);
    window.add(ui.resourcesPage.widget);

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        ui.refresh();
        return GLib.SOURCE_REMOVE;
    });

    return window;
}

function createNetworksUi(window) {
    const homePage = createHomePage();
    const peersPage = createListPage({
        emptySubtitle: 'No peers were reported by NetBird.',
        emptyTitle: 'No Peers Available',
        iconName: 'computer-symbolic',
        title: 'Peers',
    });
    const resourcesPage = createListPage(
        {
            emptySubtitle: 'No routed networks or resources have been shared with this peer.',
            emptyTitle: 'No Resources Available',
            iconName: 'network-workgroup-symbolic',
            title: 'Resources',
        });

    const state = {
        busy: false,
        connecting: false,
        connected: false,
        exitNodes: [],
        homePage,
        peers: [],
        peersPage,
        profileName: '',
        profileSwitcher: null,
        refreshButtons: [],
        resources: [],
        resourcesPage,
        resourceActionButtons: [],
        window,
    };

    addProfileSwitcherRow(homePage, state);
    addRefreshRow(peersPage, state);
    addResourceControlsRow(resourcesPage, state);

    return {
        homePage,
        peersPage,
        refresh: () => refresh(state),
        resourcesPage,
    };
}

function createHomePage() {
    const page = new Adw.PreferencesPage({
        hexpand: true,
        icon_name: 'go-home-symbolic',
        title: 'Home',
        vexpand: true,
    });
    const statusGroup = new Adw.PreferencesGroup();
    const detailsGroup = new Adw.PreferencesGroup();
    page.add(statusGroup);
    page.add(detailsGroup);

    return {
        detailRows: [],
        detailsGroup,
        listGroup: statusGroup,
        rows: [],
        statusGroup,
        widget: page,
    };
}

function createListPage({
    emptySubtitle,
    emptyTitle,
    iconName,
    title,
}) {
    const page = new Adw.PreferencesPage({
        hexpand: true,
        icon_name: iconName,
        title,
        vexpand: true,
    });
    const controlsGroup = new Adw.PreferencesGroup();
    const listGroup = new Adw.PreferencesGroup();
    page.add(controlsGroup);
    page.add(listGroup);

    return {
        controlsGroup,
        emptySubtitle,
        emptyTitle,
        listGroup,
        rows: [],
        widget: page,
    };
}

function addRefreshRow(page, state) {
    const row = new Adw.ActionRow({
        title: 'Refresh',
        subtitle: 'Reload peers and resources from NetBird',
        activatable: false,
    });
    const button = new Gtk.Button({
        icon_name: 'view-refresh-symbolic',
        tooltip_text: 'Refresh',
        valign: Gtk.Align.CENTER,
    });
    button.connect('clicked', () => {
        refresh(state);
    });
    row.add_suffix(button);
    row.activatable_widget = button;
    page.controlsGroup.add(row);
    state.refreshButtons.push(button);
}

function addProfileSwitcherRow(page, state) {
    const row = new Adw.ActionRow({
        title: 'Profile',
        subtitle: 'Active NetBird profile',
        activatable: false,
    });
    const profileMenu = new Gtk.DropDown({
        sensitive: false,
        valign: Gtk.Align.CENTER,
    });

    state.profileSwitcher = {
        busy: false,
        menu: profileMenu,
        names: [],
        row,
        suppressChange: false,
    };

    profileMenu.connect('notify::selected', () => {
        void switchProfileFromMenu(state);
    });

    row.add_suffix(profileMenu);
    row.activatable_widget = profileMenu;
    page.detailsGroup.add(row);

    void refreshProfiles(state);
}

function addResourceControlsRow(page, state) {
    addRefreshRow(page, state);

    const row = new Adw.ActionRow({
        title: 'Resource Selection',
        subtitle: 'Accept all routed resources or disable them for this peer',
        activatable: false,
    });
    const selectAllButton = new Gtk.Button({
        label: 'Select All',
        sensitive: state.connected,
        valign: Gtk.Align.CENTER,
    });
    selectAllButton.connect('clicked', () => {
        runResourceAction(state, {
            all: true,
            select: true,
        }, 'All resources selected');
    });
    row.add_suffix(selectAllButton);

    const deselectAllButton = new Gtk.Button({
        label: 'Deselect All',
        sensitive: state.connected,
        valign: Gtk.Align.CENTER,
    });
    deselectAllButton.connect('clicked', () => {
        runResourceAction(state, {
            all: true,
            select: false,
        }, 'All resources deselected');
    });
    row.add_suffix(deselectAllButton);

    page.controlsGroup.add(row);
    state.resourceActionButtons.push(selectAllButton, deselectAllButton);
}

async function refreshProfiles(state) {
    const switcher = state.profileSwitcher;
    if (!switcher || switcher.busy)
        return '';

    switcher.busy = true;
    switcher.menu.sensitive = false;
    let activeProfile = '';

    if (!netbird_json_api_available()) {
        switcher.row.subtitle = 'NetBird JSON API unavailable';
        switcher.busy = false;
        return activeProfile;
    }

    try {
        const result = await netbird_profile_list({
            timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
        });
        const names = (result.profiles ?? [])
            .map(profile => profile.name)
            .filter(Boolean);

        if (names.length === 0)
            names.push(state.profileName || 'default');

        switcher.names = names;
        switcher.suppressChange = true;
        switcher.menu.set_model(Gtk.StringList.new(names));
        activeProfile = result.activeProfile || state.profileName || names[0] || '';
        setActiveProfile(state, activeProfile, {syncMenu: false});
        selectProfileInMenu(state, activeProfile);
    } catch (error) {
        console.warn(`Failed to load NetBird profiles: ${formatError(error)}`);
        switcher.row.subtitle = 'Profiles could not be loaded';
    } finally {
        switcher.suppressChange = false;
        switcher.busy = false;
        switcher.menu.sensitive = switcher.names.length > 0 && !state.busy;
    }

    return activeProfile;
}

async function switchProfileFromMenu(state) {
    const switcher = state.profileSwitcher;
    if (!switcher || switcher.suppressChange || switcher.busy || state.busy)
        return;

    const profileName = switcher.names[switcher.menu.get_selected()];
    if (!profileName || profileName === state.profileName)
        return;

    switcher.busy = true;
    switcher.menu.sensitive = false;
    setBusy(state, true);

    try {
        await netbird_profile_select(profileName, {
            timeoutMs: NETBIRD_PROFILE_TIMEOUT_MS,
        });
        setActiveProfile(state, profileName);
        await refreshAfterAction(state);
        showToast(state.window, `Switched to ${profileName}`);
    } catch (error) {
        console.warn(`Failed to switch NetBird profile: ${formatError(error)}`);
        showToast(state.window, `Failed to switch profile: ${formatError(error)}`);
        selectProfileInMenu(state, state.profileName);
    } finally {
        setBusy(state, false);
        switcher.busy = false;
        switcher.menu.sensitive = switcher.names.length > 0;
        renderHome(state);
    }
}

function selectProfileInMenu(state, profileName) {
    const switcher = state.profileSwitcher;
    if (!switcher)
        return;

    const index = Math.max(0, switcher.names.indexOf(profileName));
    switcher.menu.set_selected(index);
}

function setActiveProfile(state, profileName, {syncMenu = true} = {}) {
    if (!profileName)
        return;

    state.profileName = profileName;
    syncProfileSwitcher(state, {syncMenu});
}

function syncProfileSwitcher(state, {syncMenu = true} = {}) {
    const switcher = state.profileSwitcher;
    if (!switcher || !state.profileName)
        return;

    switcher.row.subtitle = state.profileName;
    if (syncMenu && switcher.names.includes(state.profileName)) {
        switcher.suppressChange = true;
        selectProfileInMenu(state, state.profileName);
        switcher.suppressChange = false;
    }
}

async function refresh(state) {
    if (state.busy)
        return;

    setBusy(state, true);
    renderLoading(state);
    let homeError = '';

    try {
        if (!netbird_json_api_available()) {
            const message = 'This window requires the upcoming NetBird JSON API.';
            homeError = message;
            state.connecting = false;
            state.connected = false;
            state.peers = [];
            state.resources = [];
            state.exitNodes = [];
            renderHome(state, message);
            renderPeers(state, message);
            renderResources(state, message);
            return;
        }

        const [status, networks] = await Promise.all([
            netbird_status({timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS}),
            netbird_network_list({timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS}),
        ]);

        state.connecting = isConnectingStatus(status.status);
        state.connected = status.connected;
        state.peers = normalizePeers(status.details);
        if (status.profileName)
            setActiveProfile(state, status.profileName);
        state.resources = networks.networks;
        await refreshProfiles(state);
        renderPeers(state);

        state.exitNodes = state.resources.filter(resource => resource.isExitNode);
        renderHome(state);
        renderResources(state);
    } catch (error) {
        console.warn(`Failed to render NetBird networks window: ${formatError(error)}`);
        homeError = formatError(error);
        state.connecting = false;
        state.connected = false;
        renderHome(state, homeError);
        renderPeers(state, homeError);
        renderResources(state, homeError);
        showToast(state.window, `Failed to update networks: ${homeError}`);
    } finally {
        setBusy(state, false);
        renderHome(state, homeError);
    }
}

function renderLoading(state) {
    clearRows(state.homePage);
    clearDetailRows(state.homePage);
    clearRows(state.peersPage);
    clearRows(state.resourcesPage);
    addRow(state.homePage, createHomeStatusRow({
        connecting: state.connecting,
        connected: state.connected,
        exitNodes: state.exitNodes,
        loading: true,
        profileName: state.profileName,
        state,
    }));
    addDetailRow(state.homePage, createExitNodesRow(state.exitNodes, state.connected));
    addRow(state.peersPage, createStatusRow('Loading Peers', 'Reading NetBird peer status...'));
    addRow(state.resourcesPage, createStatusRow('Loading Resources', 'Reading NetBird routed resources...'));
}

function renderHome(state, errorMessage = '') {
    clearRows(state.homePage);
    clearDetailRows(state.homePage);
    addRow(state.homePage, createHomeStatusRow({
        connecting: state.connecting,
        connected: state.connected,
        errorMessage,
        exitNodes: state.exitNodes,
        profileName: state.profileName,
        state,
    }));
    addDetailRow(state.homePage, createExitNodesRow(state.exitNodes, state.connected));
}

function renderPeers(state, errorMessage = '') {
    clearRows(state.peersPage);
    addConnectionWarningRow(state.peersPage, state.connected);

    if (state.peers.length === 0) {
        addRow(state.peersPage, createStatusRow(
            errorMessage ? 'Peers Could Not Be Loaded' : state.peersPage.emptyTitle,
            errorMessage || state.peersPage.emptySubtitle,
            errorMessage ? 'dialog-warning-symbolic' : 'computer-symbolic',
            state.connected));
        return;
    }

    if (errorMessage) {
        addRow(state.peersPage, createStatusRow(
            'Peer Status Warning',
            errorMessage,
            'dialog-warning-symbolic'));
    }

    for (const peer of state.peers)
        addRow(state.peersPage, createPeerRow(peer, state.connected));
}

function renderResources(state, errorMessage = '') {
    clearRows(state.resourcesPage);
    addConnectionWarningRow(state.resourcesPage, state.connected);

    if (state.resources.length === 0) {
        addRow(state.resourcesPage, createStatusRow(
            errorMessage ? 'Resources Could Not Be Loaded' : state.resourcesPage.emptyTitle,
            errorMessage || state.resourcesPage.emptySubtitle,
            errorMessage ? 'dialog-warning-symbolic' : 'network-workgroup-symbolic',
            state.connected));
        return;
    }

    if (errorMessage) {
        addRow(state.resourcesPage, createStatusRow(
            'Resource Status Warning',
            errorMessage,
            'dialog-warning-symbolic'));
    }

    for (const resource of state.resources)
        addRow(state.resourcesPage, createResourceRow(resource, state));
}

function createHomeStatusRow({
    connecting = false,
    connected,
    errorMessage = '',
    exitNodes,
    loading = false,
    profileName,
    state,
}) {
    const statusTitle = loading
        ? 'Loading'
        : connecting ? 'Connecting...' : connected ? 'Connected' : 'Disconnected';
    const statusSubtitle = errorMessage ||
        (connecting
            ? 'Connecting to NetBird...'
            : connected
            ? profileName || 'NetBird is connected'
            : 'Connect to NetBird to see networks and resources');
    const statusBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 12,
        margin_end: 12,
        halign: Gtk.Align.CENTER,
        hexpand: true,
    });
    statusBox.append(new Gtk.Image({
        icon_name: 'netbird',
        pixel_size: 96,
    }));
    const statusSwitch = new Gtk.Switch({
        active: connected || connecting,
        sensitive: Boolean(state) && !state.busy && !loading,
        halign: Gtk.Align.CENTER,
    });
    statusSwitch.connect('notify::active', () => {
        if (!state)
            return;

        void runConnectionAction(state, statusSwitch.active);
    });
    statusBox.append(statusSwitch);
    statusBox.append(new Gtk.Label({
        label: statusTitle,
        css_classes: ['title-4'],
        halign: Gtk.Align.CENTER,
    }));
    statusBox.append(new Gtk.Label({
        label: statusSubtitle,
        css_classes: ['dim-label'],
        halign: Gtk.Align.CENTER,
        justify: Gtk.Justification.CENTER,
        wrap: true,
    }));

    return statusBox;
}

function createExitNodesRow(exitNodes, connected) {
    const row = new Adw.ExpanderRow({
        title: 'Exit Nodes',
        subtitle: exitNodes.length > 0
            ? `${exitNodes.length} available`
            : 'No exit nodes available',
        sensitive: connected,
    });
    row.add_prefix(new Gtk.Image({
        icon_name: 'go-jump-symbolic',
        pixel_size: 16,
    }));

    if (exitNodes.length === 0) {
        row.add_row(new Adw.ActionRow({
            title: 'No exit nodes available',
            subtitle: connected
                ? 'No advertised default routes were reported by NetBird'
                : 'Connect to NetBird to see exit nodes',
            activatable: false,
        }));
        return row;
    }

    for (const exitNode of exitNodes) {
        const child = new Adw.ActionRow({
            title: exitNode.id || 'Exit Node',
            subtitle: resourceSubtitle(exitNode),
            activatable: false,
        });
        child.add_prefix(new Gtk.Image({
            icon_name: exitNode.selected
                ? 'object-select-symbolic'
                : 'go-jump-symbolic',
            pixel_size: 16,
        }));
        row.add_row(child);
    }

    return row;
}

function addConnectionWarningRow(page, connected) {
    if (connected)
        return;

    addRow(page, createStatusRow(
        'Connect to NetBird',
        'Connect to NetBird to see networks and resources.',
        'dialog-warning-symbolic',
        true));
}

function createPeerRow(peer, connected) {
    const row = new Adw.ActionRow({
        title: peer.name || 'Peer',
        subtitle: [peer.ip, peer.status].filter(Boolean).join(' - '),
        activatable: false,
        sensitive: connected,
    });
    row.add_prefix(new Gtk.Image({
        icon_name: isConnectedStatus(peer.status)
            ? 'network-transmit-receive-symbolic'
            : 'network-offline-symbolic',
        pixel_size: 16,
    }));
    return row;
}

function createResourceRow(resource, state) {
    const row = new Adw.ActionRow({
        title: resource.id || 'Resource',
        subtitle: resourceSubtitle(resource),
        activatable: false,
        sensitive: state.connected,
    });
    row.add_prefix(new Gtk.Image({
        icon_name: resource.isExitNode ? 'go-jump-symbolic' : 'network-workgroup-symbolic',
        pixel_size: 16,
    }));

    const selectButton = new Gtk.Button({
        icon_name: 'object-select-symbolic',
        sensitive: state.connected,
        tooltip_text: 'Select Resource',
        valign: Gtk.Align.CENTER,
    });
    selectButton.connect('clicked', () => {
        runResourceAction(
            state,
            {networkIds: [resource.id], select: true},
            `Selected ${resource.id}`);
    });
    row.add_suffix(selectButton);

    const deselectButton = new Gtk.Button({
        icon_name: 'edit-delete-symbolic',
        sensitive: state.connected,
        tooltip_text: 'Deselect Resource',
        valign: Gtk.Align.CENTER,
    });
    deselectButton.connect('clicked', () => {
        runResourceAction(
            state,
            {networkIds: [resource.id], select: false},
            `Deselected ${resource.id}`);
    });
    row.add_suffix(deselectButton);

    return row;
}

function createStatusRow(title, subtitle, iconName = 'network-workgroup-symbolic', sensitive = true) {
    const row = new Adw.ActionRow({
        title,
        subtitle,
        activatable: false,
        sensitive,
    });
    row.add_prefix(new Gtk.Image({
        icon_name: iconName,
        pixel_size: 16,
    }));
    return row;
}

async function runResourceAction(state, {
    all = false,
    networkIds = [],
    select,
}, successMessage) {
    if (state.busy)
        return;

    setBusy(state, true);
    try {
        if (select) {
            await netbird_network_select(networkIds, {
                all,
                timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
            });
        } else {
            await netbird_network_deselect(networkIds, {
                all,
                timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
            });
        }
        showToast(state.window, successMessage);
        await refreshAfterAction(state);
    } catch (error) {
        console.warn(`NetBird resource action failed: ${error}`);
        showToast(state.window, formatError(error));
    } finally {
        setBusy(state, false);
        renderHome(state);
    }
}

async function runConnectionAction(state, connect) {
    if (state.busy)
        return;

    state.connecting = connect;
    state.connected = connect ? false : state.connected;
    setBusy(state, true);
    renderHome(state);

    try {
        if (connect) {
            await netbird_up({
                profileName: state.profileName,
                timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
            });
        } else {
            await netbird_down({
                timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS,
            });
        }
        showToast(state.window, connect ? 'NetBird connection started' : 'NetBird disconnected');
        state.connecting = false;
        await refreshAfterAction(state);
    } catch (error) {
        console.warn(`NetBird connection action failed: ${error}`);
        showToast(state.window, formatError(error));
        state.connecting = false;
        renderHome(state);
    } finally {
        setBusy(state, false);
        renderHome(state);
    }
}

async function refreshAfterAction(state) {
    const [status, networks] = await Promise.all([
        netbird_status({timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS}),
        netbird_network_list({timeoutMs: NETBIRD_COMMAND_TIMEOUT_MS}),
    ]);
    state.connecting = isConnectingStatus(status.status);
    state.connected = status.connected;
    state.peers = normalizePeers(status.details);
    if (status.profileName)
        setActiveProfile(state, status.profileName);
    state.resources = networks.networks;
    state.exitNodes = state.resources.filter(resource => resource.isExitNode);
    await refreshProfiles(state);
    renderHome(state);
    renderPeers(state);
    renderResources(state);
}

function normalizePeers(details) {
    const peers = details?.fullStatus?.peers ?? details?.peers?.details ?? [];
    if (!Array.isArray(peers))
        return [];

    return peers.map(peer => ({
        ip: firstString(peer?.IP, peer?.ip, peer?.netbirdIp),
        name: firstString(peer?.fqdn, peer?.name, peer?.hostname),
        status: firstString(peer?.connStatus, peer?.status),
    }));
}

function resourceSubtitle(resource) {
    const parts = [];
    if (resource.range)
        parts.push(resource.range);
    if (resource.resolved)
        parts.push(`Resolved: ${resource.resolved}`);
    if (resource.sourcePeer)
        parts.push(`Peer: ${resource.sourcePeer}`);
    if (resource.selected)
        parts.push('Selected');
    if (resource.overlapping)
        parts.push('Overlapping');
    if (resource.isExitNode)
        parts.push('Exit node');
    return parts.join(' - ') || 'No range or domain details';
}

function clearRows(page) {
    for (const row of page.rows)
        page.listGroup.remove(row);

    page.rows = [];
}

function clearDetailRows(page) {
    if (!page.detailsGroup || !page.detailRows)
        return;

    for (const row of page.detailRows)
        page.detailsGroup.remove(row);

    page.detailRows = [];
}

function addRow(page, row) {
    page.listGroup.add(row);
    page.rows.push(row);
}

function addDetailRow(page, row) {
    page.detailsGroup.add(row);
    page.detailRows.push(row);
}

function setBusy(state, busy) {
    state.busy = busy;
    for (const button of state.refreshButtons)
        button.sensitive = !busy;
    for (const button of state.resourceActionButtons)
        button.sensitive = !busy && state.connected;
    if (state.profileSwitcher)
        state.profileSwitcher.menu.sensitive =
            !busy &&
            !state.profileSwitcher.busy &&
            state.profileSwitcher.names.length > 0;
}

function isConnectedStatus(status) {
    return String(status ?? '').toLowerCase() === 'connected';
}

function isConnectingStatus(status) {
    return String(status ?? '').toLowerCase() === 'connecting';
}

function firstString(...values) {
    for (const value of values) {
        const text = cleanString(value);
        if (text)
            return text;
    }
    return '';
}

function cleanString(value) {
    if (value === undefined || value === null)
        return '';

    return String(value).trim();
}

function showToast(window, title) {
    if (typeof window.add_toast === 'function')
        window.add_toast(new Adw.Toast({title}));
}

function formatError(error) {
    return String(error?.message ?? error).replace(/^Error:\s*/, '');
}


const application = new Adw.Application({
    application_id: NETBIRD_APPLICATION_ID,
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});

application.connect('activate', app => {
    registerNetBirdIcon();
    createNetworksWindow(app).present();
});

application.run([]);
