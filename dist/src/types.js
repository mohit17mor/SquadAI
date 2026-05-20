export class CodexControlError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "CodexControlError";
    }
}
export class CodexTurnTimeoutError extends CodexControlError {
    constructor(message) {
        super(message);
        this.name = "CodexTurnTimeoutError";
    }
}
//# sourceMappingURL=types.js.map