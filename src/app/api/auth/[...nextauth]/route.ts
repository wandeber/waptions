import { handlers } from "@/auth";
import { isAuthEnabled } from "@/lib/config/feature-flags";

const authDisabled = () => new Response("Authentication is disabled.", { status: 404 });

export const GET = isAuthEnabled() ? handlers.GET : authDisabled;
export const POST = isAuthEnabled() ? handlers.POST : authDisabled;
