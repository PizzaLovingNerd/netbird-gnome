import GLib from 'gi://GLib';

import {NetBirdGrpcClient} from './grpc/netbirdGrpc.js';
import {
    ProtoReader,
    ProtoWriter,
} from './grpc/netbirdProto.js';


const DAEMON_SERVICE = 'daemon.DaemonService';
const DEFAULT_TIMEOUT_MS = 5000;
const LOGIN_TIMEOUT_MS = 300000;
const NETBIRD_DEFAULT_PROFILE = 'default';
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;


export class NetBirdProfileClient {
    constructor({grpcClient = null, socketPath = null, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
        this._grpc = grpcClient ?? new NetBirdGrpcClient({socketPath});
        this._timeoutMs = timeoutMs;
    }

    listProfiles(username = '', cancellable = null) {
        const request = new ProtoWriter();
        request.writeString(1, username);

        const response = this._grpc.unary(
            DAEMON_SERVICE,
            'ListProfiles',
            request.finish(),
            cancellable);

        return decodeListProfilesResponse(response);
    }

    async listProfilesAsync(username = '', {
        cancellable = null,
        timeoutMs = this._timeoutMs,
    } = {}) {
        // Prefer these async methods from GNOME Shell UI code so daemon stalls
        // do not block the compositor's main thread.
        const request = new ProtoWriter();
        request.writeString(1, username);

        const response = await retryGrpcAsync(
            () => this._grpc.unaryAsync(
                DAEMON_SERVICE,
                'ListProfiles',
                request.finish(),
                {cancellable, timeoutMs}),
            {cancellable});

        return decodeListProfilesResponse(response);
    }

    async getProfilesAsync(username = '', {
        cancellable = null,
        timeoutMs = this._timeoutMs,
    } = {}) {
        const activeProfile = await this.getActiveProfileAsync({cancellable, timeoutMs});
        const profileUsername = username || activeProfile.username;
        const profiles = await this.listProfilesAsync(profileUsername, {cancellable, timeoutMs});

        return {
            activeProfile,
            profiles: profiles.map(profile => ({
                ...profile,
                selected: profile.selected || profile.name === activeProfile.profileName,
                username: profile.name === NETBIRD_DEFAULT_PROFILE ? '' : profileUsername,
            })),
        };
    }

    getActiveProfile(cancellable = null) {
        const response = this._grpc.unary(
            DAEMON_SERVICE,
            'GetActiveProfile',
            new Uint8Array(),
            cancellable);

        return decodeGetActiveProfileResponse(response);
    }

    async getActiveProfileAsync({
        cancellable = null,
        timeoutMs = this._timeoutMs,
    } = {}) {
        const response = await retryGrpcAsync(
            () => this._grpc.unaryAsync(
                DAEMON_SERVICE,
                'GetActiveProfile',
                new Uint8Array(),
                {cancellable, timeoutMs}),
            {cancellable});

        return decodeGetActiveProfileResponse(response);
    }

    switchProfile(profileName, username = '', cancellable = null) {
        const request = new ProtoWriter();
        request.writeString(1, profileName);
        request.writeString(2, username);

        this._grpc.unary(
            DAEMON_SERVICE,
            'SwitchProfile',
            request.finish(),
            cancellable);
    }

    async switchProfileAsync(profileName, username = '', {
        cancellable = null,
        timeoutMs = this._timeoutMs,
    } = {}) {
        const request = new ProtoWriter();
        request.writeString(1, profileName);
        request.writeString(2, username);

        await retryGrpcAsync(
            () => this._grpc.unaryAsync(
                DAEMON_SERVICE,
                'SwitchProfile',
                request.finish(),
                {cancellable, timeoutMs}),
            {cancellable});
    }

    up(profileName = '', username = '', cancellable = null) {
        const request = new ProtoWriter();
        request.writeString(1, profileName);
        request.writeString(2, username);

        this._grpc.unary(
            DAEMON_SERVICE,
            'Up',
            request.finish(),
            cancellable);
    }

    async upAsync(profileName = '', username = '', {
        cancellable = null,
        timeoutMs = this._timeoutMs,
    } = {}) {
        const request = new ProtoWriter();
        request.writeString(1, profileName);
        request.writeString(2, username);

        await retryGrpcAsync(
            () => this._grpc.unaryAsync(
                DAEMON_SERVICE,
                'Up',
                request.finish(),
                {cancellable, timeoutMs}),
            {cancellable});
    }

    down(cancellable = null) {
        this._grpc.unary(
            DAEMON_SERVICE,
            'Down',
            new Uint8Array(),
            cancellable);
    }

    async downAsync({
        cancellable = null,
        timeoutMs = this._timeoutMs,
    } = {}) {
        try {
            await retryGrpcAsync(
                () => this._grpc.unaryAsync(
                    DAEMON_SERVICE,
                    'Down',
                    new Uint8Array(),
                    {cancellable, timeoutMs}),
                {cancellable});
        } catch (error) {
            if (!isServiceNotUpError(error))
                throw error;
        }
    }

    async statusAsync({
        cancellable = null,
        timeoutMs = this._timeoutMs,
        waitForReady = false,
    } = {}) {
        const request = new ProtoWriter();
        if (waitForReady)
            request.writeBool(3, true);

        const response = await retryGrpcAsync(
            () => this._grpc.unaryAsync(
                DAEMON_SERVICE,
                'Status',
                request.finish(),
                {cancellable, timeoutMs}),
            {cancellable});

        return decodeStatusResponse(response);
    }

    async loginAsync({
        cancellable = null,
        hostname = GLib.get_host_name(),
        profileName = '',
        timeoutMs = this._timeoutMs,
        username = '',
    } = {}) {
        const request = new ProtoWriter();
        request.writeBool(8, true);
        request.writeString(9, hostname);
        request.writeString(30, profileName);
        request.writeString(31, profileUsername(profileName, username));

        const response = await retryGrpcAsync(
            () => this._grpc.unaryAsync(
                DAEMON_SERVICE,
                'Login',
                request.finish(),
                {cancellable, timeoutMs}),
            {cancellable});

        return decodeLoginResponse(response);
    }

    async waitSSOLoginAsync(userCode, {
        cancellable = null,
        hostname = GLib.get_host_name(),
        timeoutMs = LOGIN_TIMEOUT_MS,
    } = {}) {
        const request = new ProtoWriter();
        request.writeString(1, userCode);
        request.writeString(2, hostname);

        const response = await this._grpc.unaryAsync(
            DAEMON_SERVICE,
            'WaitSSOLogin',
            request.finish(),
            {cancellable, timeoutMs});

        return decodeWaitSSOLoginResponse(response);
    }
}

export function decodeListProfilesResponse(bytes) {
    const reader = new ProtoReader(bytes);
    const profiles = [];

    while (!reader.done) {
        const tag = reader.readTag();
        if (!tag)
            break;

        if (tag.field === 1 && tag.wireType === 2)
            profiles.push(decodeProfile(reader.readBytes()));
        else
            reader.skip(tag.wireType);
    }

    return profiles;
}

export function decodeGetActiveProfileResponse(bytes) {
    const reader = new ProtoReader(bytes);
    const activeProfile = {
        profileName: '',
        username: '',
    };

    while (!reader.done) {
        const tag = reader.readTag();
        if (!tag)
            break;

        if (tag.field === 1 && tag.wireType === 2)
            activeProfile.profileName = reader.readString();
        else if (tag.field === 2 && tag.wireType === 2)
            activeProfile.username = reader.readString();
        else
            reader.skip(tag.wireType);
    }

    return activeProfile;
}

export function decodeStatusResponse(bytes) {
    const reader = new ProtoReader(bytes);
    const status = {
        status: '',
        daemonVersion: '',
    };

    while (!reader.done) {
        const tag = reader.readTag();
        if (!tag)
            break;

        if (tag.field === 1 && tag.wireType === 2)
            status.status = reader.readString();
        else if (tag.field === 3 && tag.wireType === 2)
            status.daemonVersion = reader.readString();
        else
            reader.skip(tag.wireType);
    }

    return status;
}

export function decodeLoginResponse(bytes) {
    const reader = new ProtoReader(bytes);
    const login = {
        needsSSOLogin: false,
        userCode: '',
        verificationURI: '',
        verificationURIComplete: '',
    };

    while (!reader.done) {
        const tag = reader.readTag();
        if (!tag)
            break;

        if (tag.field === 1 && tag.wireType === 0)
            login.needsSSOLogin = reader.readBool();
        else if (tag.field === 2 && tag.wireType === 2)
            login.userCode = reader.readString();
        else if (tag.field === 3 && tag.wireType === 2)
            login.verificationURI = reader.readString();
        else if (tag.field === 4 && tag.wireType === 2)
            login.verificationURIComplete = reader.readString();
        else
            reader.skip(tag.wireType);
    }

    return login;
}

export function decodeWaitSSOLoginResponse(bytes) {
    const reader = new ProtoReader(bytes);
    const login = {
        email: '',
    };

    while (!reader.done) {
        const tag = reader.readTag();
        if (!tag)
            break;

        if (tag.field === 1 && tag.wireType === 2)
            login.email = reader.readString();
        else
            reader.skip(tag.wireType);
    }

    return login;
}

function decodeProfile(bytes) {
    const reader = new ProtoReader(bytes);
    const profile = {
        name: '',
        selected: false,
    };

    while (!reader.done) {
        const tag = reader.readTag();
        if (!tag)
            break;

        if (tag.field === 1 && tag.wireType === 2)
            profile.name = reader.readString();
        else if (tag.field === 2 && tag.wireType === 0)
            profile.selected = reader.readBool();
        else
            reader.skip(tag.wireType);
    }

    return profile;
}

export function profileUsername(profileName, username) {
    return profileName === NETBIRD_DEFAULT_PROFILE ? '' : username;
}

async function retryGrpcAsync(operation, {
    attempts = DEFAULT_RETRY_ATTEMPTS,
    cancellable = null,
    delayMs = DEFAULT_RETRY_DELAY_MS,
} = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (cancellable?.is_cancelled())
            throw lastError ?? new Error('NetBird operation cancelled');

        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt >= attempts || !isRetryableGrpcError(error))
                throw error;

            await delayAsync(delayMs * attempt, cancellable);
        }
    }

    throw lastError;
}

function isRetryableGrpcError(error) {
    const grpcStatus = error?.grpcStatus;
    if (grpcStatus === '2' || grpcStatus === '4' || grpcStatus === '14')
        return true;

    const message = String(error?.message ?? error).toLowerCase();
    return message.includes('timed out') ||
        message.includes('unexpected end of socket stream') ||
        message.includes('closed the http/2 connection') ||
        message.includes('unable to connect to the netbird daemon socket');
}

function isServiceNotUpError(error) {
    return String(error?.message ?? error).toLowerCase().includes('service is not up');
}

function delayAsync(delayMs, cancellable = null) {
    return new Promise((resolve, reject) => {
        let signalId = 0;
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            if (signalId)
                cancellable.disconnect(signalId);

            resolve();
            return GLib.SOURCE_REMOVE;
        });

        if (cancellable) {
            signalId = cancellable.connect(() => {
                GLib.source_remove(timeoutId);
                reject(new Error('NetBird operation cancelled'));
            });
        }
    });
}
