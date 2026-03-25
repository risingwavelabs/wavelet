export class WaveletError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'WaveletError';
    }
}
