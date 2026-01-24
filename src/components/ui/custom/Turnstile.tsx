"use client";

import { useEffect, useRef, useState } from "react";
import type { Control, FieldValues, Path } from "react-hook-form";
import { useController } from "react-hook-form";

const TURNSTILE_SCRIPT_ID = "cf-turnstile-script";
const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileProps<T extends FieldValues> = {
    control: Control<T>;
    name: Path<T>;
    siteKey?: string;
    className?: string;
    theme?: "light" | "dark" | "auto";
    size?: "normal" | "flexible" | "compact";
};

declare global {
    interface Window {
        turnstile?: {
            render: (
                container: HTMLElement,
                options: {
                    sitekey: string;
                    callback: (token: string) => void;
                    "error-callback": () => void;
                    "expired-callback": () => void;
                    theme?: string;
                    size?: string;
                },
            ) => string;
            reset: (widgetId: string) => void;
            remove: (widgetId: string) => void;
        };
    }
}

export default function Turnstile<T extends FieldValues>({
    control,
    name,
    siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    className,
    theme = "auto",
    size = "flexible",
}: TurnstileProps<T>) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetIdRef = useRef<string | null>(null);
    const [scriptLoaded, setScriptLoaded] = useState(false);

    const {
        field: { onChange, value },
        fieldState: { error },
    } = useController({
        control,
        name,
    });

    useEffect(() => {
        if (typeof window === "undefined") return;

        const existingScript = document.getElementById(TURNSTILE_SCRIPT_ID);

        if (existingScript) {
            if ((existingScript as HTMLScriptElement).dataset.loaded === "true") {
                setScriptLoaded(true);
            }
            else {
                existingScript.addEventListener("load", () => setScriptLoaded(true), {
                    once: true,
                });
            }
            return;
        }

        const script = document.createElement("script");
        script.id = TURNSTILE_SCRIPT_ID;
        script.src = TURNSTILE_SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        (script as HTMLScriptElement).dataset.turnstile = "true";

        script.addEventListener(
            "load",
            () => {
                (script as HTMLScriptElement).dataset.loaded = "true";
                setScriptLoaded(true);
            },
            { once: true }
        );

        document.head.appendChild(script);
    }, []);

    useEffect(() => {
        if (!scriptLoaded || !siteKey || !containerRef.current || !window.turnstile) {
            return;
        }

        // If widget is already rendered, don't re-render
        if (widgetIdRef.current) {
            return;
        }

        const id = window.turnstile.render(containerRef.current, {
            sitekey: siteKey,
            callback: (token: string) => {
                onChange(token);
            },
            "error-callback": () => {
                onChange("");
            },
            "expired-callback": () => {
                onChange("");
            },
            theme,
            size,
        });

        widgetIdRef.current = id;

        return () => {
            if (widgetIdRef.current && window.turnstile) {
                window.turnstile.remove(widgetIdRef.current);
                widgetIdRef.current = null;
            }
        };
    }, [scriptLoaded, siteKey, theme, size, onChange]);

    // Reset widget when value is cleared externally (e.g. form reset)
    useEffect(() => {
        if (!value && widgetIdRef.current && window.turnstile) {
            window.turnstile.reset(widgetIdRef.current);
        }
    }, [value]);

    if (!siteKey) {
        return (
            <div className="text-red-500 text-sm p-2 border border-red-500/20 rounded bg-red-500/5">
                Turnstile is not configured.
            </div>
        );
    }

    return (
        <div className={className}>
            <div ref={containerRef} className="min-h-[65px]" />
            {error && (
                <p className="text-xs text-red-500 mt-1">{error.message}</p>
            )}
        </div>
    );
}
