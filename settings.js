export const SETTINGS_PAGES = [
    {
        title: 'General',
        iconName: 'preferences-system-symbolic',
        groups: [
            {
                title: 'General',
                rows: [
                    {
                        key: 'allowSsh',
                        type: 'switch',
                        title: 'Allow SSH',
                        subtitle: 'Allow NetBird SSH access for this peer',
                        defaultValue: false,
                    },
                    {
                        key: 'connectOnStartup',
                        type: 'switch',
                        title: 'Connect on Startup',
                        subtitle: 'Start NetBird automatically when you sign in',
                        defaultValue: true,
                    },
                    {
                        key: 'quantumResistance',
                        type: 'switch',
                        title: 'Enable Quantum-Resistance',
                        subtitle: 'Enable Rosenpass permissive mode',
                        defaultValue: false,
                    },
                    {
                        key: 'lazyConnections',
                        type: 'switch',
                        title: 'Enable Lazy Connections',
                        subtitle: 'Only establish peer connections when needed',
                        defaultValue: false,
                    },
                    {
                        key: 'blockInboundConnections',
                        type: 'switch',
                        title: 'Block Inbound Connections',
                        subtitle: 'Block inbound peer connections',
                        defaultValue: false,
                    },
                    {
                        key: 'notifications',
                        type: 'switch',
                        title: 'Notifications',
                        subtitle: 'Show NetBird desktop notifications',
                        defaultValue: true,
                    },
                ],
            },
            {
                title: 'Diagnostics',
                rows: [
                    {
                        key: 'createDebugBundle',
                        type: 'action',
                        title: 'Create Debug Bundle',
                        subtitle: 'Collect logs and diagnostics for troubleshooting',
                    },
                ],
            },
        ],
    },
    {
        title: 'Profiles',
        iconName: 'avatar-default-symbolic',
        type: 'profiles',
        groups: [],
    },
    {
        title: 'Connection',
        iconName: 'network-vpn-symbolic',
        groups: [
            {
                title: 'Profile',
                rows: [
                    {
                        key: 'profile',
                        type: 'action',
                        title: 'Profile',
                        subtitle: 'Open profile management',
                    },
                ],
            },
            {
                title: 'Connection',
                rows: [
                    {
                        key: 'managementUrl',
                        type: 'entry',
                        title: 'Management URL',
                        defaultValue: '',
                    },
                    {
                        key: 'preSharedKey',
                        type: 'password',
                        title: 'Pre-shared Key',
                        defaultValue: '',
                    },
                    {
                        key: 'connectionQuantumResistance',
                        type: 'switch',
                        title: 'Quantum-Resistance',
                        subtitle: 'Enable Rosenpass permissive mode',
                        defaultValue: false,
                    },
                    {
                        key: 'interfaceName',
                        type: 'entry',
                        title: 'Interface Name',
                        defaultValue: 'wt0',
                    },
                    {
                        key: 'interfacePort',
                        type: 'spin',
                        title: 'Interface Port',
                        defaultValue: 51820,
                        lower: 0,
                        upper: 65535,
                    },
                    {
                        key: 'mtu',
                        type: 'spin',
                        title: 'MTU',
                        defaultValue: 1280,
                        lower: 576,
                        upper: 9000,
                    },
                    {
                        key: 'logFile',
                        type: 'entry',
                        title: 'Log File',
                        defaultValue: '',
                    },
                ],
            },
        ],
    },
    {
        title: 'Network',
        iconName: 'network-workgroup-symbolic',
        groups: [
            {
                title: 'Network',
                rows: [
                    {
                        key: 'networkMonitor',
                        type: 'switch',
                        title: 'Network Monitor',
                        subtitle: 'Restarts NetBird when the network changes',
                        defaultValue: false,
                    },
                    {
                        key: 'disableDns',
                        type: 'switch',
                        title: 'Disable DNS',
                        subtitle: 'Keeps system DNS settings unchanged',
                        defaultValue: false,
                    },
                    {
                        key: 'disableClientRoutes',
                        type: 'switch',
                        title: 'Disable Client Routes',
                        subtitle: 'This peer won\'t route traffic to other peers',
                        defaultValue: false,
                    },
                    {
                        key: 'disableServerRoutes',
                        type: 'switch',
                        title: 'Disable Server Routes',
                        subtitle: 'This peer won\'t act as router for others',
                        defaultValue: false,
                    },
                    {
                        key: 'disableLanAccess',
                        type: 'switch',
                        title: 'Disable LAN Access',
                        subtitle: 'Blocks local network access when used as exit node',
                        defaultValue: false,
                    },
                ],
            },
        ],
    },
    {
        title: 'SSH',
        iconName: 'dialog-password-symbolic',
        groups: [
            {
                title: 'SSH',
                rows: [
                    {
                        key: 'sshRootLogin',
                        type: 'switch',
                        title: 'Enable SSH Root Login',
                        defaultValue: false,
                    },
                    {
                        key: 'sshSftp',
                        type: 'switch',
                        title: 'Enable SSH SFTP',
                        defaultValue: false,
                    },
                    {
                        key: 'sshLocalPortForwarding',
                        type: 'switch',
                        title: 'Enable SSH Local Port Forwarding',
                        defaultValue: false,
                    },
                    {
                        key: 'sshRemotePortForwarding',
                        type: 'switch',
                        title: 'Enable SSH Remote Port Forwarding',
                        defaultValue: false,
                    },
                    {
                        key: 'disableSshAuthentication',
                        type: 'switch',
                        title: 'Disable SSH Authentication',
                        defaultValue: false,
                    },
                    {
                        key: 'jwtCacheTtl',
                        type: 'spin',
                        title: 'JWT Cache TTL',
                        subtitle: 'seconds, 0=disabled',
                        defaultValue: 0,
                        lower: 0,
                        upper: 86400,
                    },
                ],
            },
        ],
    },
];
