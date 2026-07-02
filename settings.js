import {_} from './i18n.js';


export const SETTINGS_PAGES = [
    {
        title: _('General'),
        iconName: 'preferences-system-symbolic',
        groups: [
            {
                title: _('General'),
                rows: [
                    {
                        key: 'allowSsh',
                        type: 'switch',
                        title: _('Allow SSH'),
                        subtitle: _('Allow NetBird SSH access for this peer'),
                        defaultValue: false,
                    },
                    {
                        key: 'connectOnStartup',
                        type: 'switch',
                        title: _('Connect on Startup'),
                        subtitle: _('Start NetBird automatically when you sign in'),
                        defaultValue: true,
                    },
                    {
                        key: 'quantumResistance',
                        type: 'switch',
                        title: _('Enable Quantum-Resistance'),
                        subtitle: _('Enable Rosenpass permissive mode'),
                        defaultValue: false,
                    },
                    {
                        key: 'lazyConnections',
                        type: 'switch',
                        title: _('Enable Lazy Connections'),
                        subtitle: _('Only establish peer connections when needed'),
                        defaultValue: false,
                    },
                    {
                        key: 'blockInboundConnections',
                        type: 'switch',
                        title: _('Block Inbound Connections'),
                        subtitle: _('Block inbound peer connections'),
                        defaultValue: false,
                    },
                    {
                        key: 'notifications',
                        type: 'switch',
                        title: _('Notifications'),
                        subtitle: _('Show NetBird desktop notifications'),
                        defaultValue: true,
                    },
                ],
            },
            {
                title: _('Diagnostics'),
                rows: [
                    {
                        key: 'createDebugBundle',
                        type: 'action',
                        title: _('Create Debug Bundle'),
                        subtitle: _('Collect logs and diagnostics for troubleshooting'),
                    },
                    {
                        key: 'updateDaemon',
                        type: 'action',
                        title: _('Update Daemon'),
                        subtitle: _('Install a pending NetBird daemon update'),
                    },
                ],
            },
        ],
    },
    {
        title: _('Profiles'),
        iconName: 'avatar-default-symbolic',
        type: 'profiles',
        groups: [],
    },
    {
        title: _('Connection'),
        iconName: 'network-vpn-symbolic',
        groups: [
            {
                title: _('Profile'),
                rows: [
                    {
                        key: 'profile',
                        type: 'action',
                        title: _('Profile'),
                        subtitle: _('Open profile management'),
                    },
                ],
            },
            {
                title: _('Connection'),
                rows: [
                    {
                        key: 'managementUrl',
                        type: 'entry',
                        title: _('Management URL'),
                        defaultValue: '',
                    },
                    {
                        key: 'preSharedKey',
                        type: 'password',
                        title: _('Pre-shared Key'),
                        defaultValue: '',
                    },
                    {
                        key: 'connectionQuantumResistance',
                        type: 'switch',
                        title: _('Quantum-Resistance'),
                        subtitle: _('Enable Rosenpass permissive mode'),
                        defaultValue: false,
                    },
                    {
                        key: 'interfaceName',
                        type: 'entry',
                        title: _('Interface Name'),
                        defaultValue: 'wt0',
                    },
                    {
                        key: 'interfacePort',
                        type: 'spin',
                        title: _('Interface Port'),
                        defaultValue: 51820,
                        lower: 0,
                        upper: 65535,
                    },
                    {
                        key: 'mtu',
                        type: 'spin',
                        title: _('MTU'),
                        defaultValue: 1280,
                        lower: 576,
                        upper: 9000,
                    },
                ],
            },
        ],
    },
    {
        title: _('Network'),
        iconName: 'network-workgroup-symbolic',
        groups: [
            {
                title: _('Network'),
                rows: [
                    {
                        key: 'networkMonitor',
                        type: 'switch',
                        title: _('Network Monitor'),
                        subtitle: _('Restarts NetBird when the network changes'),
                        defaultValue: false,
                    },
                    {
                        key: 'disableDns',
                        type: 'switch',
                        title: _('Disable DNS'),
                        subtitle: _('Keeps system DNS settings unchanged'),
                        defaultValue: false,
                    },
                    {
                        key: 'disableClientRoutes',
                        type: 'switch',
                        title: _('Disable Client Routes'),
                        subtitle: _('This peer won\'t route traffic to other peers'),
                        defaultValue: false,
                    },
                    {
                        key: 'disableServerRoutes',
                        type: 'switch',
                        title: _('Disable Server Routes'),
                        subtitle: _('This peer won\'t act as router for others'),
                        defaultValue: false,
                    },
                    {
                        key: 'disableLanAccess',
                        type: 'switch',
                        title: _('Disable LAN Access'),
                        subtitle: _('Blocks local network access when used as exit node'),
                        defaultValue: false,
                    },
                ],
            },
        ],
    },
    {
        title: _('SSH'),
        iconName: 'dialog-password-symbolic',
        groups: [
            {
                title: _('SSH'),
                rows: [
                    {
                        key: 'sshRootLogin',
                        type: 'switch',
                        title: _('Enable SSH Root Login'),
                        defaultValue: false,
                    },
                    {
                        key: 'sshSftp',
                        type: 'switch',
                        title: _('Enable SSH SFTP'),
                        defaultValue: false,
                    },
                    {
                        key: 'sshLocalPortForwarding',
                        type: 'switch',
                        title: _('Enable SSH Local Port Forwarding'),
                        defaultValue: false,
                    },
                    {
                        key: 'sshRemotePortForwarding',
                        type: 'switch',
                        title: _('Enable SSH Remote Port Forwarding'),
                        defaultValue: false,
                    },
                    {
                        key: 'disableSshAuthentication',
                        type: 'switch',
                        title: _('Disable SSH Authentication'),
                        defaultValue: false,
                    },
                    {
                        key: 'jwtCacheTtl',
                        type: 'spin',
                        title: _('JWT Cache TTL'),
                        subtitle: _('seconds, 0=disabled'),
                        defaultValue: 0,
                        lower: 0,
                        upper: 86400,
                    },
                ],
            },
        ],
    },
];
