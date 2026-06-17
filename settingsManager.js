import {SETTINGS_PAGES} from './settings.js';
import {
    netbird_daemon_update,
    netbird_debug_bundle,
    netbird_down,
    netbird_profile_select,
    netbird_status,
    netbird_up,
} from './api/index.js';
import {
    getActiveProfileName,
    MASKED_PRESHARED_KEY,
    readBoolPtr,
    readProfileConfig,
    readServiceParams,
    readUrlValue,
    writeBoolPtr,
    writeProfileConfig,
    writeServiceParams,
    writeUrlValue,
} from './profileConfig.js';


export const GENERAL_PAGE_TITLE = 'General';
const NETBIRD_SETTINGS_TIMEOUT_MS = 30000;
const NETBIRD_SETTINGS_QUERY_TIMEOUT_MS = 5000;

const ACTION_HANDLERS = {
    createDebugBundle: netbird_debug_bundle,
    updateDaemon: netbird_daemon_update,
};

const NETBIRD_SETTINGS = {
    allowSsh: {
        configKey: 'ServerSSHAllowed',
        boolPtr: true,
    },
    connectOnStartup: {
        configKey: 'DisableAutoConnect',
        inverted: true,
    },
    quantumResistance: {
        configKey: 'RosenpassEnabled',
    },
    lazyConnections: {
        configKey: 'LazyConnectionEnabled',
    },
    blockInboundConnections: {
        configKey: 'BlockInbound',
    },
    notifications: {
        configKey: 'DisableNotifications',
        inverted: true,
        boolPtr: true,
    },
    managementUrl: {
        configKey: 'ManagementURL',
        type: 'url',
    },
    preSharedKey: {
        configKey: 'PreSharedKey',
        type: 'preSharedKey',
    },
    connectionQuantumResistance: {
        configKey: 'RosenpassPermissive',
    },
    interfaceName: {
        configKey: 'WgIface',
    },
    interfacePort: {
        configKey: 'WgPort',
    },
    mtu: {
        configKey: 'MTU',
    },
    logFile: {
        type: 'serviceLogFile',
    },
    networkMonitor: {
        configKey: 'NetworkMonitor',
        boolPtr: true,
    },
    disableDns: {
        configKey: 'DisableDNS',
    },
    disableClientRoutes: {
        configKey: 'DisableClientRoutes',
    },
    disableServerRoutes: {
        configKey: 'DisableServerRoutes',
    },
    disableLanAccess: {
        configKey: 'BlockLANAccess',
    },
    sshRootLogin: {
        configKey: 'EnableSSHRoot',
        boolPtr: true,
    },
    sshSftp: {
        configKey: 'EnableSSHSFTP',
        boolPtr: true,
    },
    sshLocalPortForwarding: {
        configKey: 'EnableSSHLocalPortForwarding',
        boolPtr: true,
    },
    sshRemotePortForwarding: {
        configKey: 'EnableSSHRemotePortForwarding',
        boolPtr: true,
    },
    disableSshAuthentication: {
        configKey: 'DisableSSHAuth',
        boolPtr: true,
    },
    jwtCacheTtl: {
        configKey: 'SSHJWTCacheTTL',
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
        const profileConfig = readProfileConfig(profileName);
        let serviceParams = null;
        let serviceDirty = false;

        for (const [key, value] of changes) {
            const handler = NETBIRD_SETTINGS[key];
            if (!handler)
                continue;

            if (handler.type === 'serviceLogFile') {
                serviceParams ??= readServiceParams();
                applyServiceLogFile(serviceParams, value);
                serviceDirty = true;
                this._values.set(key, value);
                continue;
            }

            applyProfileConfigValue(profileConfig, handler, value);
            this._values.set(key, value);
        }

        await writeProfileConfig(profileName, profileConfig);

        if (serviceDirty)
            await writeServiceParams(serviceParams);

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

    async loadSettings(profileName = getActiveProfileName()) {
        this._activeProfileName = profileName;

        let profileConfig;
        try {
            profileConfig = readProfileConfig(profileName);
        } catch (error) {
            console.warn(`Failed to load NetBird profile config for ${profileName}: ${error}`);
            return;
        }

        let serviceParams = {};
        try {
            serviceParams = readServiceParams();
        } catch (error) {
            console.warn(`Failed to load NetBird service params: ${error}`);
        }

        Object.entries(NETBIRD_SETTINGS).forEach(([key, handler]) => {
            const value = readSettingValue(profileConfig, serviceParams, handler);
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

function readSettingValue(profileConfig, serviceParams, handler) {
    if (handler.type === 'serviceLogFile')
        return readServiceLogFile(serviceParams);

    const rawValue = readProfileConfigValue(profileConfig, handler);
    if (rawValue === null)
        return null;

    if (handler.type === 'preSharedKey')
        return rawValue ? MASKED_PRESHARED_KEY : '';

    return rawValue;
}

function readProfileConfigValue(config, handler) {
    const {configKey, inverted = false, boolPtr = false, intPtr = false, type} = handler;

    if (type === 'url')
        return readUrlValue(config[configKey]) || null;

    if (type === 'preSharedKey')
        return config[configKey] ? String(config[configKey]) : '';

    if (intPtr) {
        if (!Object.hasOwn(config, configKey) || config[configKey] === null)
            return null;

        return Number(config[configKey]);
    }

    let value;
    if (boolPtr)
        value = readBoolPtr(config, configKey, false);
    else if (Object.hasOwn(config, configKey))
        value = Boolean(config[configKey]);
    else
        return null;

    return inverted ? !value : value;
}

function applyProfileConfigValue(config, handler, value) {
    const {configKey, inverted = false, boolPtr = false, intPtr = false, type} = handler;
    const storedValue = inverted ? !value : value;

    if (type === 'url') {
        config[configKey] = writeUrlValue(String(storedValue ?? ''));
        return;
    }

    if (type === 'preSharedKey') {
        const nextValue = String(value ?? '').trim();
        if (!nextValue || nextValue === MASKED_PRESHARED_KEY)
            return;

        config[configKey] = nextValue;
        return;
    }

    if (intPtr) {
        config[configKey] = Number(storedValue);
        return;
    }

    if (boolPtr) {
        writeBoolPtr(config, configKey, storedValue);
        return;
    }

    config[configKey] = Boolean(storedValue);
}

function readServiceLogFile(serviceParams) {
    const logFiles = serviceParams.log_files;
    if (!Array.isArray(logFiles) || logFiles.length === 0)
        return '';

    return String(logFiles[0] ?? '');
}

function applyServiceLogFile(serviceParams, value) {
    const logFile = String(value ?? '').trim();
    if (!logFile) {
        delete serviceParams.log_files;
        return;
    }

    serviceParams.log_files = [logFile];
}
