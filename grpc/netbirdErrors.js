export class NetBirdGrpcError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'NetBirdGrpcError';
        Object.assign(this, details);
    }
}
