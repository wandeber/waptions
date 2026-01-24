"use server";

import { signIn } from "@/auth";
import { verifyTurnstileToken } from "@/lib/integrations/turnstile";

export async function loginWithGoogle(formData: FormData) {
    const turnstileToken = formData.get("turnstileToken") as string;

    if (!turnstileToken) {
        throw new Error("Turnstile token missing");
    }

    const verification = await verifyTurnstileToken(turnstileToken);

    if (!verification.success) {
        throw new Error(`Turnstile verification failed: ${verification.message}`);
    }

    await signIn("google", { redirectTo: "/" });
}
