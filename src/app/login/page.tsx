import { Suspense } from "react";
import LoginForm from "./LoginForm";

export default function LoginPage() {
    return (
        <main className="min-h-screen flex items-center justify-center p-4 bg-[#0a0a0a] text-white">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-blue-900/10 via-transparent to-transparent pointer-events-none" />
            <Suspense fallback={<div className="w-full max-w-sm h-64 animate-pulse bg-white/5 rounded-2xl" />}>
                <LoginForm />
            </Suspense>
        </main>
    );
}
