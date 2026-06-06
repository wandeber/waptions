import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { ActionContext } from "@/lib/actions/base.action";
import { isAuthEnabled } from "@/lib/config/feature-flags";
import { handleControllerError } from "./api-error-handler";
import { RequestContext } from "@/types/api";

type Handler<P = unknown> = (
    request: NextRequest,
    context: { params: P; actionContext: ActionContext }
) => Promise<NextResponse | Response>;

export function restRoute<P = unknown>(handler: Handler<P>) {
    return async (request: NextRequest, context: RequestContext<P>) => {
        try {
            const session = isAuthEnabled() ? await auth() : null;
            const params = await context.params;

            const actionContext: ActionContext = {
                user: session?.user ? {
                    id: session.user.id as string,
                    email: session.user.email!,
                    name: session.user.name!,
                    image: session.user.image,
                } : null,
            };

            return await handler(request, { params, actionContext });
        }
        catch (error) {
            const contextName = `${request.method} ${request.nextUrl.pathname}`;
            return handleControllerError(error, contextName);
        }
    };
}
