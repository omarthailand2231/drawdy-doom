/**
 * Context menus.
 *
 * A menu is declared as a tree in one `command:context-menu:add`, but clicks
 * arrive per leaf: each one needs its own `subscription:context-menu:clicked`.
 * This keeps the tree and its handlers in one place so they cannot drift.
 */
import type { ContextMenu } from "@drawdy/driver-protocol";
import { call, subscribe, unsubscribe } from "../protocol";

export interface MenuNode {
    id: string;
    title: string;
    children?: MenuNode[];
    onClick?: () => void | Promise<void>;
}

export class MenuTree {
    private readonly handlers = new Map<string, () => void | Promise<void>>();
    private readonly subscriptions: string[] = [];
    private rootId: string | null = null;

    /** Install the tree and subscribe to every leaf that has a handler. */
    async install(root: MenuNode): Promise<boolean> {
        await this.remove();
        this.rootId = root.id;

        const collect = (node: MenuNode): ContextMenu => {
            if (node.onClick) this.handlers.set(node.id, node.onClick);
            return {
                menuId: node.id,
                menuTitle: node.title,
                ...(node.children?.length ? { children: node.children.map(collect) } : {}),
            };
        };
        const menu = collect(root);

        const added = await call("command:context-menu:add", menu);
        if (added.error) return false;

        for (const menuId of this.handlers.keys()) {
            const subscriptionId = await subscribe("subscription:context-menu:clicked", { menuId });
            if (subscriptionId) this.subscriptions.push(subscriptionId);
        }
        return true;
    }

    /** Dispatch a `subscription:context-menu:clicked` event; true if we owned it. */
    dispatch(menuId: string): boolean {
        const handler = this.handlers.get(menuId);
        if (!handler) return false;
        void handler();
        return true;
    }

    async remove(): Promise<void> {
        for (const subscriptionId of this.subscriptions.splice(0)) await unsubscribe(subscriptionId);
        this.handlers.clear();
        if (this.rootId) {
            await call("command:context-menu:remove", { menuId: this.rootId });
            this.rootId = null;
        }
    }
}
