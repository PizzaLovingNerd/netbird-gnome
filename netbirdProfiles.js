import {NetBirdGrpcClient} from './grpc/netbirdGrpc.js';
import {
    ProtoReader,
    ProtoWriter,
} from './grpc/netbirdProto.js';


const DAEMON_SERVICE = 'daemon.DaemonService';
const DEFAULT_TIMEOUT_MS = 5000;


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

        const response = await this._grpc.unaryAsync(
            DAEMON_SERVICE,
            'ListProfiles',
            request.finish(),
            {cancellable, timeoutMs});

        return decodeListProfilesResponse(response);
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
        const response = await this._grpc.unaryAsync(
            DAEMON_SERVICE,
            'GetActiveProfile',
            new Uint8Array(),
            {cancellable, timeoutMs});

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

        await this._grpc.unaryAsync(
            DAEMON_SERVICE,
            'SwitchProfile',
            request.finish(),
            {cancellable, timeoutMs});
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

        await this._grpc.unaryAsync(
            DAEMON_SERVICE,
            'Up',
            request.finish(),
            {cancellable, timeoutMs});
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
        await this._grpc.unaryAsync(
            DAEMON_SERVICE,
            'Down',
            new Uint8Array(),
            {cancellable, timeoutMs});
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
