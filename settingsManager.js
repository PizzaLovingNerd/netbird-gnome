import {SETTINGS_PAGES} from './settings.js';
import {netbird_status, runNetBird} from './api/index.js';


export const GENERAL_PAGE_TITLE = 'General';
const NETBIRD_SETTINGS_QUERY_TIMEOUT_MS = 5000;
const NETBIRD_SETTINGS_TIMEOUT_MS = 30000;

const GENERAL_NETBIRD_SETTINGS = {
    allowSsh: {
        flag: 'allow-server-ssh',
        statusKeys: ['allowServerSSH', 'allowServerSsh', 'allowSSH', 'allowSsh'],
    },
    connectOnStartup: {
        flag: 'disable-auto-connect',
        inverted: true,
        statusKeys: ['disableAutoConnect'],
    },
    quantumResistance: {
        flag: 'enable-rosenpass',
        statusKeys: ['enableRosenpass', 'rosenpassEnabled', 'quantumResistance'],
    },
    lazyConnections: {
        flag: 'enable-lazy-connection',
        statusKeys: ['enableLazyConnection', 'lazyConnectionEnabled', 'lazyConnections'],
    },
    blockInboundConnections: {
        flag: 'block-inbound',
        statusKeys: ['blockInbound', 'blockInboundConnections'],
    },
};

const ACTION_HANDLERS = {
    createDebugBundle: {
        args: ['debug', 'bundle'],
    },
};


export class SettingsManager {
    constructor(pages = SETTINGS_PAGES) {
        this._pages = pages;
        this._values = new Map();
        this._definitions = new Map();
        this._buildIndex();
        this.reset();
    }

    get pages() {
        return this._pages;
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

    async activate(key) {
        this.getDefinition(key);

        const handler = ACTION_HANDLERS[key];
        if (!handler)
            return;

        await runNetBird(handler.args, {
            timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS,
        });
    }

    async loadGeneralSettings() {
        let status;
        try {
            status = await netbird_status({
                timeoutMs: NETBIRD_SETTINGS_QUERY_TIMEOUT_MS,
            });
        } catch (error) {
            console.warn(`Failed to load NetBird settings: ${error}`);
            return;
        }

        Object.entries(GENERAL_NETBIRD_SETTINGS).forEach(([key, handler]) => {
            const value = this._readStatusValue(status.details, handler);
            if (value !== null)
                this._values.set(key, value);
        });
    }

    supportsWrite(key) {
        return Boolean(GENERAL_NETBIRD_SETTINGS[key]);
    }

    supportsAction(key) {
        return Boolean(ACTION_HANDLERS[key]);
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
        const handler = GENERAL_NETBIRD_SETTINGS[key];
        if (!handler)
            return;

        const netbirdValue = handler.inverted ? !value : value;
        await runNetBird(['up', `--${handler.flag}=${netbirdValue}`], {
            timeoutMs: NETBIRD_SETTINGS_TIMEOUT_MS,
        });
    }

    _readStatusValue(details, handler) {
        for (const statusKey of handler.statusKeys) {
            const value = findValue(details, statusKey);
            if (typeof value === 'boolean')
                return handler.inverted ? !value : value;
        }

        return null;
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

function findValue(value, key) {
    if (!value || typeof value !== 'object')
        return null;

    if (Object.prototype.hasOwnProperty.call(value, key))
        return value[key];

    for (const childValue of Object.values(value)) {
        const result = findValue(childValue, key);
        if (result !== null)
            return result;
    }

    return null;
}
