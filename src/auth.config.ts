import type { NextAuthConfig } from "next-auth";
import { isAuthEnabled } from "@/lib/config/feature-flags";

export const authConfig = {
    pages: {
        signIn: "/login",
        error: "/login",
    },
    callbacks: {
        authorized({ auth, request: { nextUrl } }) {
            if (!isAuthEnabled()) {
                if (nextUrl.pathname.startsWith("/login")) {
                    return Response.redirect(new URL("/", nextUrl));
                }

                return true;
            }

            const isLoggedIn = !!auth?.user;
            const isLoginPage = nextUrl.pathname.startsWith("/login");
            const isApiAuth = nextUrl.pathname.startsWith("/api/auth");

            if (isApiAuth) return true;

            if (isLoggedIn) {
                const authorizedEmails = process.env.AUTHORIZED_EMAILS?.split(",").map(e => e.trim()) || [];
                const isEmailAuthorized = auth.user?.email && authorizedEmails.includes(auth.user.email);

                if (!isEmailAuthorized) return false; // Force logout/redirect if not authorized

                if (isLoginPage) {
                    return Response.redirect(new URL("/", nextUrl));
                }
            }

            return isLoggedIn || isLoginPage;
        },
    },
    secret: process.env.AUTH_SECRET,
    providers: [], // Configured in auth.ts
} satisfies NextAuthConfig;
