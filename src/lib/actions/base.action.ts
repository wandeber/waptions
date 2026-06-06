import { AuthUser } from "@/types/auth";
import { isAuthEnabled } from "@/lib/config/feature-flags";
import { ForbiddenError, UnauthorizedError } from "@/lib/utils/errors";

export interface ActionContext {
    user: AuthUser | null;
}

export abstract class BaseAction<I = unknown, O = unknown> {
    /**
     * Main static entry point for the action.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public static async run<T extends new () => BaseAction<any, any>>(
        this: T,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input: T extends new () => BaseAction<infer Req, any> ? Req : any,
        ctx: ActionContext
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<T extends new () => BaseAction<any, infer Res> ? Res : any> {
        const instance = new this();

        // 1. Authorization check
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (instance as any).authorize(input, ctx);

        // 2. Logic execution
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (instance as any).execute(input, ctx);
    }

    /**
     * Authorization logic. Checks if the user is authenticated and authorized (whitelist).
     */
    protected async authorize(_input: I, ctx: ActionContext): Promise<void> {
        if (!isAuthEnabled()) {
            return;
        }

        if (!ctx.user) {
            throw new UnauthorizedError();
        }

        const authorizedEmails = process.env.AUTHORIZED_EMAILS?.split(",").map(e => e.trim()) || [];
        if (!authorizedEmails.includes(ctx.user.email)) {
            throw new ForbiddenError("Your account is not authorized to perform this action.");
        }
    }

    protected abstract execute(input: I, ctx: ActionContext): Promise<O>;
}
