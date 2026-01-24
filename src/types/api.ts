export type RequestContext<P = unknown> = {
    params: Promise<P>;
};
