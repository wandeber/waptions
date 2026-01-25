import NextAuth from "next-auth";
import Google, { GoogleProfile } from "next-auth/providers/google";
import { authConfig } from "./auth.config";

export const { handlers, signIn, signOut, auth } = NextAuth({
    ...authConfig,
    secret: process.env.AUTH_SECRET,
    session: { strategy: "jwt" },
    providers: [
        Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
            authorization: {
                params: {
                    scope: "openid email profile"
                }
            }
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
        async jwt({ token, user, profile }) {
            if (user) {
                token.id = user.id;
                token.image = user.image;
            }
            if (profile) {
                const googleProfile = profile as GoogleProfile;
                token.image = googleProfile.picture || user?.image;
            }
            return token;
        },
        async session({ session, token }) {
            if (session.user) {
                if (token.id) session.user.id = token.id as string;
                if (token.image) session.user.image = token.image as string;
            }
            return session;
        },
    },
});
