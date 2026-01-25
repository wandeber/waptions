import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { authConfig } from "./auth.config";

export const { handlers, signIn, signOut, auth } = NextAuth({
    ...authConfig,
    secret: process.env.AUTH_SECRET,
    session: { strategy: "jwt" },
    providers: [
        Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
        }),
    ],
    debug: process.env.NEXTAUTH_DEBUG === 'true',
    callbacks: {
        ...authConfig.callbacks,
        async signIn({ user }) {
            const authorizedEmails = process.env.AUTHORIZED_EMAILS?.split(",").map(e => e.trim()) || [];

            if (!user.email) {
                console.error("Login attempt missing email");
                return false;
            }

            if (authorizedEmails.includes(user.email)) {
                return true;
            }

            console.warn(`Unauthorized login attempt from: ${user.email}`);
            return false;
        },
    },
});
