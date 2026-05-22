const UP_FLAG_SPECS = {
    allowSsh: {flag: 'allow-server-ssh', type: 'bool'},
    connectOnStartup: {flag: 'disable-auto-connect', type: 'bool', inverted: true},
    quantumResistance: {flag: 'enable-rosenpass', type: 'bool'},
    lazyConnections: {flag: 'enable-lazy-connection', type: 'bool'},
    blockInboundConnections: {flag: 'block-inbound', type: 'bool'},
    connectionQuantumResistance: {flag: 'rosenpass-permissive', type: 'bool'},
    managementUrl: {flag: 'management-url', type: 'string'},
    preSharedKey: {flag: 'preshared-key', type: 'string'},
    interfaceName: {flag: 'interface-name', type: 'string'},
    interfacePort: {flag: 'wireguard-port', type: 'number'},
    mtu: {flag: 'mtu', type: 'number'},
    networkMonitor: {flag: 'network-monitor', type: 'bool'},
    disableDns: {flag: 'disable-dns', type: 'bool'},
    disableClientRoutes: {flag: 'disable-client-routes', type: 'bool'},
    disableServerRoutes: {flag: 'disable-server-routes', type: 'bool'},
    disableLanAccess: {flag: 'block-lan-access', type: 'bool'},
    sshRootLogin: {flag: 'enable-ssh-root', type: 'bool'},
    sshSftp: {flag: 'enable-ssh-sftp', type: 'bool'},
    sshLocalPortForwarding: {flag: 'enable-ssh-local-port-forwarding', type: 'bool'},
    sshRemotePortForwarding: {flag: 'enable-ssh-remote-port-forwarding', type: 'bool'},
    disableSshAuthentication: {flag: 'disable-ssh-auth', type: 'bool'},
    jwtCacheTtl: {flag: 'ssh-jwt-cache-ttl', type: 'number'},
};


export function buildUpArgsForChanges(changes) {
    const args = [];

    for (const [key, value] of changes) {
        const spec = UP_FLAG_SPECS[key];
        if (!spec)
            continue;

        switch (spec.type) {
        case 'bool': {
            const cliValue = spec.inverted ? !value : Boolean(value);
            args.push(`--${spec.flag}=${cliValue}`);
            break;
        }
        case 'string': {
            const text = String(value ?? '').trim();
            if (!text)
                break;

            args.push(`--${spec.flag}=${text}`);
            break;
        }
        case 'number':
            args.push(`--${spec.flag}=${Number(value)}`);
            break;
        }
    }

    return args;
}
