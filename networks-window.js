import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

import {
    netbird_down,
    netbird_profile_list,
    netbird_profile_select,
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
        runResourceAction(state, ['networks', 'select', 'all'], 'All resources selected');
    });
    row.add_suffix(selectAllButton);

    const deselectAllButton = new Gtk.Button({
        label: 'Deselect All',
        sensitive: state.connected,
        valign: Gtk.Align.CENTER,
    });
    deselectAllButton.connect('clicked', () => {
        runResourceAction(state, ['networks', 'deselect', 'all'], 'All resources deselected');
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
        await refreshProfiles(state);
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

    try {
        const statusResult = await settleCommand(['status', '--json']);
        const networksResult = await settleCommand(['networks', 'list']);

        if (statusResult.ok) {
            try {
                const status = parseStatus(statusResult.value.stdout);
                state.connecting = isConnectingStatus(status.status);
                state.connected = status.connected;
                state.peers = status.peers;
                if (status.profileName)
                    setActiveProfile(state, status.profileName);
                state.resources = status.resources;
                await refreshProfiles(state);
                renderPeers(state);
            } catch (error) {
                state.connecting = false;
                state.connected = false;
                state.peers = [];
                state.profileName = '';
                state.resources = [];
                renderPeers(state, formatError(error));
                showToast(state.window, `Failed to load peers: ${formatError(error)}`);
            }
        } else {
            state.connecting = false;
            state.connected = false;
            state.peers = [];
            state.profileName = '';
            state.resources = [];
            renderPeers(state, formatError(statusResult.error));
            showToast(state.window, `Failed to load peers: ${formatError(statusResult.error)}`);
        }

        let resourceError = '';
        if (networksResult.ok) {
            try {
                state.resources = mergeResources(
                    state.resources,
                    parseNetworksList(networksResult.value.stdout));
            } catch (error) {
                resourceError = formatError(error);
                showToast(state.window, `Failed to parse resources: ${resourceError}`);
            }
        } else {
            resourceError = formatError(networksResult.error);
            showToast(state.window, `Failed to load resources: ${resourceError}`);
        }

        state.exitNodes = state.resources.filter(resource => resource.isExitNode);
        renderHome(state);
        renderResources(state, resourceError);
    } catch (error) {
        console.warn(`Failed to render NetBird networks window: ${formatError(error)}`);
        state.connecting = false;
        state.connected = false;
        renderHome(state, formatError(error));
        renderPeers(state, formatError(error));
        renderResources(state, formatError(error));
        showToast(state.window, `Failed to update networks: ${formatError(error)}`);
    } finally {
        setBusy(state, false);
        renderHome(state);
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
            ['networks', 'select', resource.id],
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
            ['networks', 'deselect', resource.id],
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

async function runResourceAction(state, args, successMessage) {
    if (state.busy)
        return;

    setBusy(state, true);
    try {
        await runNetBirdCommand(args);
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
    const [statusOutput, networksOutput] = await Promise.all([
        runNetBirdCommand(['status', '--json']),
        runNetBirdCommand(['networks', 'list']),
    ]);
    const status = parseStatus(statusOutput.stdout);
    state.connecting = isConnectingStatus(status.status);
    state.connected = status.connected;
    state.peers = status.peers;
    if (status.profileName)
        setActiveProfile(state, status.profileName);
    state.resources = mergeResources(status.resources, parseNetworksList(networksOutput.stdout));
    state.exitNodes = state.resources.filter(resource => resource.isExitNode);
    await refreshProfiles(state);
    renderHome(state);
    renderPeers(state);
    renderResources(state);
}

async function settleCommand(args) {
    try {
        return {
            ok: true,
            value: await runNetBirdCommand(args),
        };
    } catch (error) {
        console.warn(`netbird ${args.join(' ')} failed: ${formatError(error)}`);
        return {
            error,
            ok: false,
        };
    }
}

function runNetBirdCommand(args, timeoutMs = NETBIRD_COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const netbird = GLib.find_program_in_path('netbird') ?? 'netbird';
        let process;
        try {
            process = Gio.Subprocess.new(
                [netbird, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            reject(error);
            return;
        }

        const cancellable = new Gio.Cancellable();
        let settled = false;
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            settled = true;
            cancellable.cancel();
            process.force_exit();
            reject(new Error(`netbird ${args.join(' ')} timed out`));
            return GLib.SOURCE_REMOVE;
        });

        process.communicate_utf8_async(null, cancellable, (_process, result) => {
            if (settled)
                return;

            GLib.source_remove(timeoutId);
            try {
                const [, stdout, stderr] = process.communicate_utf8_finish(result);
                const status = process.get_exit_status();
                if (status !== 0) {
                    reject(new Error((stderr || stdout || `netbird exited with status ${status}`).trim()));
                    return;
                }

                resolve({
                    stderr: stderr ?? '',
                    stdout: stdout ?? '',
                });
            } catch (error) {
                reject(error);
            }
        });
    });
}

function parseStatus(output) {
    let details = {};
    try {
        details = JSON.parse(output);
    } catch (error) {
        throw new Error(`NetBird returned invalid status JSON: ${formatError(error)}`);
    }
    const status = firstString(
        details?.daemonStatus,
        details?.status,
        details?.connectionStatus,
        details?.state);
    const peerDetails = arrayValue(details?.peers?.details);
    const peers = peerDetails.map(peer => ({
        ip: firstString(peer?.netbirdIp, peer?.netbirdIP, peer?.IP),
        name: firstString(peer?.fqdn, peer?.FQDN, peer?.name, peer?.hostname),
        status: firstString(peer?.status, peer?.connStatus),
    }));

    return {
        connected: isConnectedStatus(status),
        peers,
        profileName: firstString(details?.profileName),
        resources: [
            ...collectResources(details),
            ...peerDetails.flatMap(peer => collectResources(peer, peer)),
        ],
        status,
    };
}

function parseNetworksList(output) {
    const text = stripAnsi(output).trim();
    if (!text || /^No networks available\.?$/i.test(text))
        return [];

    const parsed = parseNetworksJson(text);
    if (parsed)
        return parsed;

    return text
        .split('\n')
        .map(line => parseNetworkLine(line))
        .filter(Boolean);
}

function parseNetworksJson(text) {
    try {
        const data = JSON.parse(text);
        const values = Array.isArray(data)
            ? data
            : data?.networks ?? data?.routes ?? data?.resources;
        if (!Array.isArray(values))
            return null;

        return values.map(value => normalizeResource(value)).filter(resource => resource.id || resource.range);
    } catch {
        return null;
    }
}

function parseNetworkLine(line) {
    const raw = line.trim();
    if (!raw || raw.includes('---') || /^ID\s+/i.test(raw) || /^Network\s+/i.test(raw))
        return null;

    const selected = /\bselected\b/i.test(raw) || /^\s*\[[xX*]\]/.test(raw);
    const overlapping = /\boverlap/i.test(raw);
    const cleaned = raw
        .replace(/^\[[ xX*]\]\s*/, '')
        .replace(/\bselected\b/ig, '')
        .replace(/\boverlapp(?:ing|ed)?\b/ig, '')
        .trim();
    const columns = cleaned.split(/\s{2,}|\t+/).map(value => value.trim()).filter(Boolean);
    const id = columns[0] ?? cleaned.split(/\s+/)[0] ?? '';
    const range = columns.length >= 2 ? columns[1] : cleaned.split(/\s+/).slice(1).join(' ');

    return normalizeResource({
        id,
        range,
        resolvedIPs: columns.slice(2),
        selected,
        overlapping,
    });
}

function collectResources(value, peer = null) {
    const resources = [];
    for (const key of ['networks', 'Networks', 'routes', 'Routes', 'resources', 'Resources']) {
        for (const item of arrayValue(value?.[key]))
            resources.push(normalizeResource(item, peer));
    }
    return resources;
}

function normalizeResource(value, peer = null) {
    if (typeof value === 'string') {
        return {
            id: value,
            isExitNode: isExitNodeRange(value),
            overlapping: false,
            range: value,
            resolved: '',
            selected: false,
            sourcePeer: peer ? firstString(peer?.fqdn, peer?.name) : '',
        };
    }

    const range = [
        ...arrayOrSingle(value?.range),
        ...arrayOrSingle(value?.Range),
        ...arrayOrSingle(value?.ranges),
        ...arrayOrSingle(value?.domains),
        ...arrayOrSingle(value?.domain),
    ].map(cleanString).filter(Boolean).join(', ');
    const resolved = [
        ...arrayOrSingle(value?.resolvedIPs),
        ...arrayOrSingle(value?.resolvedIps),
        ...arrayOrSingle(value?.resolved_ips),
        ...arrayOrSingle(value?.ips),
        ...arrayOrSingle(value?.IPs),
    ].map(cleanString).filter(Boolean).join(', ');

    return {
        id: firstString(value?.id, value?.ID, value?.networkId, value?.routeId, value?.name, range),
        isExitNode: isExitNodeRange(range),
        overlapping: Boolean(value?.overlapping ?? value?.Overlapping ?? value?.overlaps),
        range,
        resolved,
        selected: Boolean(value?.selected ?? value?.Selected),
        sourcePeer: peer ? firstString(peer?.fqdn, peer?.name) : '',
    };
}

function mergeResources(...groups) {
    const seen = new Set();
    const resources = [];
    for (const group of groups) {
        for (const resource of group) {
            const key = `${resource.id}|${resource.range}|${resource.resolved}`;
            if (seen.has(key))
                continue;

            seen.add(key);
            resources.push(resource);
        }
    }
    return resources.filter(resource => resource.id || resource.range);
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

function stripAnsi(value) {
    return String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

function isConnectedStatus(status) {
    return String(status ?? '').toLowerCase() === 'connected';
}

function isConnectingStatus(status) {
    return String(status ?? '').toLowerCase() === 'connecting';
}

function isExitNodeRange(value) {
    return String(value ?? '')
        .split(/[,\s]+/)
        .some(part => part === '0.0.0.0/0' || part === '::/0');
}

function arrayValue(value) {
    return Array.isArray(value) ? value : [];
}

function arrayOrSingle(value) {
    if (Array.isArray(value))
        return value;

    return value === undefined || value === null ? [] : [value];
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
