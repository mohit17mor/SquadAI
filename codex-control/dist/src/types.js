export class CodexControlError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "CodexControlError";
    }
}
export class CodexAppServerError extends CodexControlError {
    code;
    data;
    rpcError;
    constructor(value) {
        const rpcError = isErrorRecord(value)
            ? { ...value }
            : { message: String(value) };
        const message = typeof rpcError.message === "string"
            ? rpcError.message
            : JSON.stringify(rpcError);
        super(message);
        this.name = "CodexAppServerError";
        this.code = typeof rpcError.code === "number" || typeof rpcError.code === "string"
            ? rpcError.code
            : null;
        this.data = rpcError.data;
        this.rpcError = rpcError;
    }
}
export class CodexTurnTimeoutError extends CodexControlError {
    constructor(message) {
        super(message);
        this.name = "CodexTurnTimeoutError";
    }
}
function isErrorRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=types.js.map