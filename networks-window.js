import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';


const APPLICATION_ID = 'io.netbird.gnome.Networks';
const NETBIRD_COMMAND_TIMEOUT_MS = 30000;


function createNetworksWindow(application) {
    const window = new Adw.PreferencesWindow({
        application,
        title: 'Networks',
        default_width: 760,
        default_height: 560,
        search_enabled: false,
    });

    const ui = createNetworksUi(window);
    window.add(ui.peersPage.widget);
    window.add(ui.resourcesPage.widget);

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        ui.refresh();
        return GLib.SOURCE_REMOVE;
    });

    return window;
}

function createNetworksUi(window) {
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
        peers: [],
        peersPage,
        refreshButtons: [],
        resources: [],
        resourcesPage,
        resourceActionButtons: [],
        window,
    };

    addRefreshRow(peersPage, state);
    addResourceControlsRow(resourcesPage, state);

    return {
        peersPage,
        refresh: () => refresh(state),
        resourcesPage,
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

function addResourceControlsRow(page, state) {
    addRefreshRow(page, state);

    const row = new Adw.ActionRow({
        title: 'Resource Selection',
        subtitle: 'Accept all routed resources or disable them for this peer',
        activatable: false,
    });
    const selectAllButton = new Gtk.Button({
        label: 'Select All',
        valign: Gtk.Align.CENTER,
    });
    selectAllButton.connect('clicked', () => {
        runResourceAction(state, ['networks', 'select', 'all'], 'All resources selected');
    });
    row.add_suffix(selectAllButton);

    const deselectAllButton = new Gtk.Button({
        label: 'Deselect All',
        valign: Gtk.Align.CENTER,
    });
    deselectAllButton.connect('clicked', () => {
        runResourceAction(state, ['networks', 'deselect', 'all'], 'All resources deselected');
    });
    row.add_suffix(deselectAllButton);

    page.controlsGroup.add(row);
    state.resourceActionButtons.push(selectAllButton, deselectAllButton);
}

async function refresh(state) {
    if (state.busy)
        return;

    setBusy(state, true);
    renderLoading(state);

    try {
        const [statusOutput, networksOutput] = await Promise.all([
            runNetBirdCommand(['status', '--json']),
            runNetBirdCommand(['networks', 'list']),
        ]);
        const status = parseStatus(statusOutput.stdout);
        state.peers = status.peers;
        state.resources = mergeResources(status.resources, parseNetworksList(networksOutput.stdout));
        renderPeers(state);
        renderResources(state);
    } catch (error) {
        console.warn(`Failed to load NetBird networks window: ${error}`);
        state.peers = [];
        state.resources = [];
        renderPeers(state, formatError(error));
        renderResources(state, formatError(error));
        showToast(state.window, `Failed to load networks: ${formatError(error)}`);
    } finally {
        setBusy(state, false);
    }
}

function renderLoading(state) {
    clearRows(state.peersPage);
    clearRows(state.resourcesPage);
    addRow(state.peersPage, createStatusRow('Loading Peers', 'Reading NetBird peer status...'));
    addRow(state.resourcesPage, createStatusRow('Loading Resources', 'Reading NetBird routed resources...'));
}

function renderPeers(state, errorMessage = '') {
    clearRows(state.peersPage);
    if (state.peers.length === 0) {
        addRow(state.peersPage, createStatusRow(
            errorMessage ? 'Peers Could Not Be Loaded' : state.peersPage.emptyTitle,
            errorMessage || state.peersPage.emptySubtitle,
            errorMessage ? 'dialog-warning-symbolic' : 'computer-symbolic'));
        return;
    }

    for (const peer of state.peers)
        addRow(state.peersPage, createPeerRow(peer));
}

function renderResources(state, errorMessage = '') {
    clearRows(state.resourcesPage);
    if (state.resources.length === 0) {
        addRow(state.resourcesPage, createStatusRow(
            errorMessage ? 'Resources Could Not Be Loaded' : state.resourcesPage.emptyTitle,
            errorMessage || state.resourcesPage.emptySubtitle,
            errorMessage ? 'dialog-warning-symbolic' : 'network-workgroup-symbolic'));
        return;
    }

    for (const resource of state.resources)
        addRow(state.resourcesPage, createResourceRow(resource, state));
}

function createPeerRow(peer) {
    const row = new Adw.ActionRow({
        title: peer.name || 'Peer',
        subtitle: [peer.ip, peer.status].filter(Boolean).join(' - '),
        activatable: false,
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
    });
    row.add_prefix(new Gtk.Image({
        icon_name: resource.isExitNode ? 'go-jump-symbolic' : 'network-workgroup-symbolic',
        pixel_size: 16,
    }));

    const selectButton = new Gtk.Button({
        icon_name: 'object-select-symbolic',
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

function createStatusRow(title, subtitle, iconName = 'network-workgroup-symbolic') {
    const row = new Adw.ActionRow({
        title,
        subtitle,
        activatable: false,
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
        const [statusOutput, networksOutput] = await Promise.all([
            runNetBirdCommand(['status', '--json']),
            runNetBirdCommand(['networks', 'list']),
        ]);
        const status = parseStatus(statusOutput.stdout);
        state.peers = status.peers;
        state.resources = mergeResources(status.resources, parseNetworksList(networksOutput.stdout));
        renderPeers(state);
        renderResources(state);
    } catch (error) {
        console.warn(`NetBird resource action failed: ${error}`);
        showToast(state.window, formatError(error));
    } finally {
        setBusy(state, false);
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
    const details = JSON.parse(output);
    const peerDetails = arrayValue(details?.peers?.details);
    const peers = peerDetails.map(peer => ({
        ip: firstString(peer?.netbirdIp, peer?.netbirdIP, peer?.IP),
        name: firstString(peer?.fqdn, peer?.FQDN, peer?.name, peer?.hostname),
        status: firstString(peer?.status, peer?.connStatus),
    }));

    return {
        peers,
        profileName: firstString(details?.profileName),
        resources: [
            ...collectResources(details),
            ...peerDetails.flatMap(peer => collectResources(peer, peer)),
        ],
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

function addRow(page, row) {
    page.listGroup.add(row);
    page.rows.push(row);
}

function setBusy(state, busy) {
    state.busy = busy;
    for (const button of state.refreshButtons)
        button.sensitive = !busy;
    for (const button of state.resourceActionButtons)
        button.sensitive = !busy;
}

function stripAnsi(value) {
    return String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

function isConnectedStatus(status) {
    return String(status ?? '').toLowerCase() === 'connected';
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
    application_id: APPLICATION_ID,
    flags: Gio.ApplicationFlags.FLAGS_NONE,
});

application.connect('activate', app => {
    createNetworksWindow(app).present();
});

application.run([]);
