import {SETTINGS_PAGES} from './settings.js';
import {
    netbird_daemon_update,
    netbird_debug_bundle,
    netbird_down,
    netbird_get_config,
    netbird_profile_select,
    netbird_set_config,
    netbird_status,
    netbird_up,
} from './api/index.js';


export const GENERAL_PAGE_TITLE = 'General';
const MASKED_PRESHARED_KEY = '**********';
const NETBIRD_SETTINGS_TIMEOUT_MS = 30000;
const NETBIRD_SETTINGS_QUERY_TIMEOUT_MS = 5000;

const ACTION_HANDLERS = {
    createDebugBundle: netbird_debug_bundle,
    updateDaemon: netbird_daemon_update,
};

const NETBIRD_SETTINGS = {
    allowSsh: {
        apiKey: 'serverSSHAllowed',
    },
    connectOnStartup: {
        apiKey: 'disableAutoConnect',
        inverted: true,
    },
    quantumResistance: {
        apiKey: 'rosenpassEnabled',
    },
    lazyConnections: {
        apiKey: 'lazyConnectionEnabled',
    },
    blockInboundConnections: {
        apiKey: 'blockInbound',
    },
    notifications: {
        apiKey: 'disableNotifications',
        inverted: true,
    },
    managementUrl: {
        apiKey: 'managementUrl',
        type: 'url',
    },
    preSharedKey: {
        apiKey: 'optionalPreSharedKey',
        readApiKey: 'preSharedKey',
        type: 'preSharedKey',
    },
    connectionQuantumResistance: {
        apiKey: 'rosenpassPermissive',
    },
    interfaceName: {
        apiKey: 'interfaceName',
    },
    interfacePort: {
        apiKey: 'wireguardPort',
    },
    mtu: {
        apiKey: 'mtu',
    },
    networkMonitor: {
        apiKey: 'networkMonitor',
    },
    disableDns: {
        apiKey: 'disableDns',
    },
    disableClientRoutes: {
        apiKey: 'disableClientRoutes',
    },
    disableServerRoutes: {
        apiKey: 'disableServerRoutes',
    },
    disableLanAccess: {
        apiKey: 'blockLanAccess',
    },
    sshRootLogin: {
        apiKey: 'enableSSHRoot',
    },
    sshSftp: {
        apiKey: 'enableSSHSFTP',
    },
    sshLocalPortForwarding: {
        apiKey: 'enableSSHLocalPortForwarding',
    },
    sshRemotePortForwarding: {
        apiKey: 'enableSSHRemotePortForwarding',
    },
    disableSshAuthentication: {
        apiKey: 'disableSSHAuth',
    },
    jwtCacheTtl: {
        apiKey: 'sshJWTCacheTTL',
        intPtr: true,
    },
};


export class SettingsManager {
    constructor(pages = SETTINGS_PAGES) {
        this._pages = pages;
        this._values = new Map();
        this._definitions = new Map();
        this._activeProfileName = 'default';
        this._buildIndex();
        this.reset();
    }

    get pages() {
        return this._pages;
    }

    get activeProfileName() {
        return this._activeProfileName;
    }

    getGeneralPage() {
        return this.getPage(GENERAL_PAGE_TITLE);
    }

    getPage(title) {
        const page = this._pages.find(pageDefinition => pageDefinition.title === title);
        if (!page)
            throw new Error(`Unknown settings page: ${title}`);

        return page;
    }

    getDefinition(key) {
        const definition = this._definitions.get(key);
        if (!definition)
            throw new Error(`Unknown setting: ${key}`);

        return definition;
    }

    getValue(key) {
        this.getDefinition(key);
        return this._values.get(key);
    }

    normalizeValue(key, value) {
        return this._normalizeValue(this.getDefinition(key), value);
    }

    async setValue(key, value) {
        const normalizedValue = this.normalizeValue(key, value);
        await this._writeNetBirdSetting(key, normalizedValue);
        this._values.set(key, normalizedValue);
    }

    async applyChanges(changes) {
        const profileName = this._activeProfileName;
        const setConfigRequest = {
            profileName,
        };
        const appliedValues = new Map();
        let profileDirty = false;

        for (const [key, value] of changes) {
            const handler = NETBIRD_SETTINGS[key];
            if (!handler)
                continue;

            const apiValue = toSetConfigValue(handler, value);
            if (apiValue === undefined)
                continue;

            setConfigRequest[handler.apiKey] = apiValue;
            profileDirty = true;
            appliedValues.set(key, value);
        }

        if (profileDirty) {
            await netbird_set_config(setConfigRequest, {
                timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS,
            });
            appliedValues.forEach((value, key) => {
                this._values.set(key, value);
            });
        }

        const status = await netbird_status({
            timeoutMs: NETBIRD_SETTINGS_QUERY_TIMEOUT_MS,
        });

        if (!status.connected)
            return;

        await netbird_down({timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS});
        await netbird_up({
            profileName,
            openLoginUrl: false,
            timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS,
        });
    }

    async switchProfile(profileName) {
        const nextProfile = String(profileName ?? '').trim();
        if (!nextProfile || nextProfile === this._activeProfileName)
            return;

        await netbird_profile_select(nextProfile, {
            timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS,
        });

        await this.loadSettings(nextProfile);
    }

    async activate(key) {
        this.getDefinition(key);

        const handler = ACTION_HANDLERS[key];
        if (!handler)
            return;

        return await handler({
            timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS,
        });
    }

    async loadSettings(profileName = this._activeProfileName) {
        const requestedProfile = profileName || 'default';
        const result = await netbird_get_config(requestedProfile, {
            timeoutMs: NETBIRD_SETTINGS_QUERY_TIMEOUT_MS,
        });
        this._activeProfileName = requestedProfile;

        Object.entries(NETBIRD_SETTINGS).forEach(([key, handler]) => {
            const value = readSettingValue(result.config, handler);
            if (value !== null)
                this._values.set(key, value);
        });
        this._values.set('profile', this._activeProfileName);
    }

    supportsWrite(key) {
        return Boolean(NETBIRD_SETTINGS[key]);
    }

    supportsAction(key) {
        return key === 'profile' || Boolean(ACTION_HANDLERS[key]);
    }

    reset() {
        this._values.clear();

        this._definitions.forEach((definition, key) => {
            this._values.set(key, definition.defaultValue ?? null);
        });
    }

    _buildIndex() {
        this._definitions.clear();

        this._pages.forEach(page => {
            page.groups.forEach(group => {
                group.rows.forEach(row => {
                    if (row.key)
                        this._definitions.set(row.key, row);
                });
            });
        });
    }

    async _writeNetBirdSetting(key, value) {
        await this.applyChanges([[key, value]]);
    }

    _normalizeValue(definition, value) {
        switch (definition.type) {
        case 'switch':
            return Boolean(value);
        case 'spin':
            return Number(value);
        case 'entry':
        case 'password':
            return String(value ?? '');
        default:
            return value;
        }
    }
}

function readSettingValue(config, handler) {
    const rawValue = readConfigValue(config, handler);
    if (rawValue === null)
        return null;

    if (handler.type === 'preSharedKey')
        return rawValue ? MASKED_PRESHARED_KEY : '';

    return rawValue;
}

function readConfigValue(config, handler) {
    const {
        apiKey,
        inverted = false,
        intPtr = false,
        readApiKey = apiKey,
        type,
    } = handler;

    if (type === 'url')
        return typeof config[readApiKey] === 'string' ? config[readApiKey] : null;

    if (type === 'preSharedKey')
        return config[readApiKey] ? String(config[readApiKey]) : '';

    if (intPtr) {
        if (!Object.hasOwn(config, readApiKey) || config[readApiKey] === null)
            return null;

        return Number(config[readApiKey]);
    }

    if (!Object.hasOwn(config, readApiKey))
        return null;

    const value = Boolean(config[readApiKey]);
    return inverted ? !value : value;
}

function toSetConfigValue(handler, value) {
    const {inverted = false, intPtr = false, type} = handler;
    const storedValue = inverted ? !value : value;

    if (!handler.apiKey)
        return undefined;

    if (type === 'url')
        return String(storedValue ?? '');

    if (type === 'preSharedKey') {
        const nextValue = String(value ?? '').trim();
        if (nextValue === MASKED_PRESHARED_KEY)
            return undefined;

        return nextValue;
    }

    if (intPtr)
        return Number(storedValue);

    if (typeof storedValue === 'string')
        return String(storedValue);

    if (typeof storedValue === 'number')
        return Number(storedValue);

    return Boolean(storedValue);
}
