import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextMiddleware, NextRequest } from "next/server";
import { authConfig } from "./auth.config";
import { isAuthEnabled } from "@/lib/config/feature-flags";

const authMiddleware = NextAuth(authConfig).auth as unknown as NextMiddleware;

export default function middleware(request: NextRequest, event: NextFetchEvent) {
    if (!isAuthEnabled()) {
        return NextResponse.next();
    }

    return authMiddleware(request, event);
}

export const config = {
    // https://nextjs.org/docs/app/building-your-application/routing/middleware#matcher
    matcher: ["/((?!api|_next/static|_next/image|.*\\.png$).*)"],
};
