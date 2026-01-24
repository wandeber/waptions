"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useState, useMemo } from "react";
import Turnstile from "@/components/ui/custom/Turnstile";
import { Button } from "@/components/design-system/Button";
import { loginWithGoogle } from "@/lib/server-actions/auth-actions";
import { useSearchParams } from "next/navigation";
import { AlertCircle, Lock } from "lucide-react";

const loginSchema = z.object({
    turnstileToken: z.string().min(1, "Verify you are not a robot"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function LoginForm() {
    const searchParams = useSearchParams();
    const authError = searchParams.get("error");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const displayError = useMemo(() => {
        if (error) return error;
        if (authError === "AccessDenied") {
            return "Your email is not on the authorized list. Please contact the administrator.";
        }
        if (authError) {
            return "An authentication error occurred. Please try again.";
        }
        return null;
    }, [error, authError]);

    const { control, handleSubmit, formState: { isSubmitting } } = useForm<LoginFormValues>({
        resolver: zodResolver(loginSchema),
        defaultValues: {
            turnstileToken: "",
        },
    });

    const onSubmit = async (data: LoginFormValues) => {
        setLoading(true);
        setError(null);
        try {
            const formData = new FormData();
            formData.append("turnstileToken", data.turnstileToken);
            await loginWithGoogle(formData);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Something went wrong during login");
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex flex-col gap-6 w-full max-w-sm">
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
                <div className="flex flex-col gap-4">
                    <h1 className="text-2xl font-bold text-center">Login to Waptions</h1>
                    <p className="text-gray-400 text-center text-sm">
                        Please verify you are human to continue with Google login.
                    </p>
                </div>

                {displayError && (
                    <div className="flex gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 animate-in fade-in slide-in-from-top-2 duration-300">
                        <AlertCircle className="w-5 h-5 shrink-0" />
                        <div className="space-y-1">
                            <p className="text-sm font-medium leading-tight">Access Denied</p>
                            <p className="text-xs opacity-80 leading-normal">{displayError}</p>
                        </div>
                    </div>
                )}

                <Turnstile
                    control={control}
                    name="turnstileToken"
                    className="w-full"
                    size="flexible"
                />

                <Button
                    type="submit"
                    className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-medium h-11 rounded-xl transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
                    disabled={loading || isSubmitting}
                >
                    {loading ? (
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                        <>
                            <Lock className="w-4 h-4" />
                            <span>Continue with Google</span>
                        </>
                    )}
                </Button>
            </form>
        </div>
    );
}
