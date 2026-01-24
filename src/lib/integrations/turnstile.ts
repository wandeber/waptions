const TURNSTILE_SITEVERIFY_URL =
    "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const TURNSTILE_ERROR_MESSAGES: Record<string, string> = {
    "missing-input-secret": "Turnstile secret is not configured.",
    "invalid-input-secret": "Turnstile secret is invalid.",
    "missing-input-response": "Missing Turnstile token.",
    "invalid-input-response": "Invalid Turnstile token.",
    "bad-request": "Turnstile received a bad verification request.",
    "timeout-or-duplicate": "Turnstile token expired or already used.",
    "internal-error": "Turnstile service returned an internal error.",
};

type TurnstileSiteVerifyResponse = {
    success: boolean;
    challenge_ts?: string;
    hostname?: string;
    "error-codes"?: string[];
    action?: string;
    cData?: string;
};

export type TurnstileVerificationResult =
    | { success: true }
    | {
        success: false;
        message: string;
        codes: string[];
    };

function resolveErrorMessage(codes: string[]): string {
    for (const code of codes) {
        if (TURNSTILE_ERROR_MESSAGES[code]) {
            return TURNSTILE_ERROR_MESSAGES[code];
        }
    }

    return "Turnstile verification failed with unknown reasons.";
}

export async function verifyTurnstileToken(
    token: string,
    remoteIp?: string | null
): Promise<TurnstileVerificationResult> {
    const secretKey = process.env.TURNSTILE_SECRET_KEY;

    if (!secretKey) {
        console.error("TURNSTILE_SECRET_KEY environment variable is missing.");
        return {
            success: false,
            message: "Turnstile secret key is not configured.",
            codes: ["missing-input-secret"],
        };
    }

    if (!token) {
        return {
            success: false,
            message: "Turnstile token is missing.",
            codes: ["missing-input-response"],
        };
    }

    const formData = new URLSearchParams();
    formData.append("secret", secretKey);
    formData.append("response", token);

    if (remoteIp) {
        formData.append("remoteip", remoteIp);
    }

    try {
        const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: formData,
            cache: "no-store",
        });

        const payload =
            (await response.json()) as TurnstileSiteVerifyResponse;

        if (payload.success) {
            return { success: true };
        }

        const codes = payload["error-codes"] ?? ["unknown-error"];
        const message = resolveErrorMessage(codes);

        console.warn("Turnstile verification failed:", {
            codes,
            remoteIp,
        });

        return {
            success: false,
            message,
            codes,
        };
    }
    catch (error) {
        console.error("Error verifying Turnstile token:", error);
        return {
            success: false,
            message: "Unexpected error verifying Turnstile token.",
            codes: ["verification-failed"],
        };
    }
}

export class TurnstileError extends Error {
    constructor(
        message: string,
        public codes: string[] = []
    ) {
        super(message);
        this.name = "TurnstileError";
    }
}

type VerifyTurnstileOptions = {
    tokenPath?: string;
};

export async function verifyTurnstile(
    req: Request,
    options: VerifyTurnstileOptions = {}
): Promise<void> {
    const { tokenPath = "turnstileToken" } = options;

    let token: string | undefined;

    try {
        const clone = req.clone();
        const body = await clone.json();
        token = body[tokenPath];
    }
    catch {
        // Ignore error if body cannot be parsed, token will be undefined
    }

    const forwardedFor = req.headers.get("x-forwarded-for");
    const requestIp =
        req.headers.get("cf-connecting-ip")
        ?? req.headers.get("x-real-ip")
        ?? (forwardedFor ? forwardedFor.split(",")[0]?.trim() : null);

    const result = await verifyTurnstileToken(token || "", requestIp);

    if (!result.success) {
        throw new TurnstileError(result.message, result.codes);
    }
}
