/**
 * A thin, fully typed wrapper around the DDP command issuer.
 *
 * The protocol wants `{ type, driverId, requestId, req }` on every call and
 * answers with `{ res: { value } | { error } }`. This module keeps the
 * boilerplate in one place and gives call sites inference straight from the
 * command's string literal:
 *
 *     const cam = await call("command:camera:get-info");     // cam.value?.zoom
 *     await call("command:scene:set-selection", { drawdyElementIds: ids });
 */
import type {
    DriverCommandIssuer,
    DriverCommandRequest,
    DriverCommandResponseFor,
    ProtocolCommandError,
} from "@drawdy/driver-protocol";

export type CommandType = DriverCommandRequest["type"];

type CommandOf<T extends CommandType> = Extract<DriverCommandRequest, { type: T }>;

/** The `req` payload a command takes, or `undefined` when it takes none. */
export type RequestOf<T extends CommandType> = CommandOf<T> extends { req: infer Q } ? Q : undefined;

/** The `res.value` a command answers with. */
export type ValueOf<T extends CommandType> = Extract<
    DriverCommandResponseFor<CommandOf<T>>["res"],
    { value: unknown }
>["value"];

export type Outcome<T extends CommandType> =
    | { value: ValueOf<T>; error?: undefined }
    | { value?: undefined; error: ProtocolCommandError };

type Args<T extends CommandType> = [RequestOf<T>] extends [undefined] ? [] : [req: RequestOf<T>];

let issue: DriverCommandIssuer | null = null;
let driverId = "";
let sequence = 0;

/** Number of commands issued so far — surfaced in the console's stats panel. */
export const stats = { issued: 0, failed: 0 };

export function initProtocol(issuer: DriverCommandIssuer, id: string): void {
    issue = issuer;
    driverId = id;
}

export function currentDriverId(): string {
    return driverId;
}

/** Issue a command and hand back `{ value }` or `{ error }` — never throws. */
export async function call<T extends CommandType>(type: T, ...args: Args<T>): Promise<Outcome<T>> {
    if (!issue) return { error: { type: "runtime", message: "protocol not initialised" } };
    const request = { type, driverId, requestId: `${sequence++}` } as Record<string, unknown>;
    if (args.length > 0) request.req = args[0];
    stats.issued++;
    try {
        // The generic request union is wider than what a single literal proves;
        // the public signature above is what keeps call sites honest.
        const response = await issue(request as never);
        const res = (response as { res: Outcome<T> }).res;
        if (res.error) stats.failed++;
        return res;
    } catch (cause) {
        stats.failed++;
        return { error: { type: "runtime", message: cause instanceof Error ? cause.message : String(cause) } };
    }
}

/** Issue a command, returning the value or `undefined` if it failed. */
export async function value<T extends CommandType>(type: T, ...args: Args<T>): Promise<ValueOf<T> | undefined> {
    const outcome = await call(type, ...args);
    return outcome.error ? undefined : outcome.value;
}

/** Register a subscription and hand back its id (or `null` if refused). */
export async function subscribe<T extends CommandType & `subscription:${string}`>(
    type: T,
    ...args: Args<T>
): Promise<string | null> {
    const outcome = await call(type, ...args);
    if (outcome.error) return null;
    return (outcome.value as { subscriptionId: string }).subscriptionId;
}

export async function unsubscribe(subscriptionId: string | null): Promise<void> {
    if (!subscriptionId) return;
    await call("command:subscription:remove", { subscriptionId });
}

/** True when a command failed only because the user withheld a permission. */
export function isDenied(error: ProtocolCommandError | undefined): boolean {
    return error?.type === "unauthorized";
}
