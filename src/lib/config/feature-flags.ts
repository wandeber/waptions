const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isAuthEnabled(): boolean {
    return readBooleanFlag(process.env.AUTH_ENABLED ?? process.env.NEXT_PUBLIC_AUTH_ENABLED, false);
}

export function shouldShowPaidTranscriptionModels(): boolean {
    return readBooleanFlag(
        process.env.SHOW_PAID_TRANSCRIPTION_MODELS ?? process.env.NEXT_PUBLIC_SHOW_PAID_TRANSCRIPTION_MODELS,
        false
    );
}

function readBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined) {
        return defaultValue;
    }

    return TRUE_VALUES.has(value.trim().toLowerCase());
}
