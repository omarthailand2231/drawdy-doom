/**
 * DOOM, as a Drawdy driver.
 *
 *   engine   `doom.wasm` (doomgeneric) runs inside Drawdy's shared driver
 *            worker. It has no DOM and no WASI, so nothing has to be emulated.
 *   display  each frame is resampled onto a grid of *preview* shapes on the
 *            board. Preview elements render without committing, so playing
 *            DOOM never touches undo, sync or the saved document.
 *   input    the board's control keys (arrows + modifiers, press-only) drive a
 *            synthesised-hold scheme; the console webview adds real
 *            keydown/keyup for the full keyboard.
 *
 * Nothing starts until the player asks. Booting compiles 4.5 MB of wasm, and a
 * driver that does that on activate would tax every board it is installed on.
 */
import type { DriverModule, DriverSubscriptionEvent, ModuleStyling } from "@drawdy/driver-protocol";
import { DoomEngine, MS_PER_TIC } from "./doom/engine";
import { bindControlKey, isKeyName, type ControlKeyEvent, type KeyName } from "./doom/keys";
import { loadDoomModule } from "./doom/load";
import { KvSaveStore } from "./doom/saves";
import { InputRouter } from "./input";
import { call, initProtocol, subscribe, unsubscribe } from "./protocol";
import { ImageScreen, imageDisplaySupported } from "./render/image-screen";
import { CanvasScreen, RESOLUTIONS, type Rect, type ResolutionId, type ScreenStyle } from "./render/screen";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type DisplayMode, type DoomSettings } from "./settings";
import { consoleHtml } from "./ui/console-html";
import { DOOM_ICON_SVG } from "./ui/icon";
import { MenuTree, type MenuNode } from "./ui/menus";

const CONSOLE_ID = "doom-console";
const ACTION_BUTTON_ID = "doom-action-button";
const SCREEN_ASPECT = 640 / 400;
/** Fraction of the viewport left as breathing room when fitting the screen. */
const FIT_MARGIN = 0.055;
/** A canvas update slower than this means we are not keeping up. */
const SLOW_UPDATE_MS = 45;
/** Consecutive slow updates before auto-quality steps the grid down. */
const SLOW_STREAK_LIMIT = 24;
/** Always leave this much room for the rest of the worker between frames. */
const MIN_FRAME_DELAY_MS = 8;
/** Lag past this is abandoned rather than chased. */
const MAX_FRAME_LAG_MS = 250;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

const CONSOLE = "console";
const POINTER = "pointer";

class DoomDriver {
    private styling: ModuleStyling | null = null;
    private mintId: () => string = () => `doom-${Math.random().toString(36).slice(2)}`;
    private settings: DoomSettings = { ...DEFAULT_SETTINGS };

    private module: WebAssembly.Module | null = null;
    private engine: DoomEngine | null = null;
    private input: InputRouter | null = null;
    private readonly saves = new KvSaveStore();
    private customWad: { name: string; bytes: Uint8Array } | null = null;

    /** Exactly one of these is live, according to `settings.displayMode`. */
    private screen: CanvasScreen | null = null;
    private imageScreen: ImageScreen | null = null;
    private backdropId: string | null = null;
    private imageElementId: string | null = null;
    private previewId: string | null = null;

    private running = false;
    private starting = false;
    private booting = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private nextFrameAt = 0;
    private renderInFlight = false;

    private updateMs = 0;
    private slowStreak = 0;
    private framesShown = 0;
    /** `engine.frames` at the last resample, so we never redraw the same frame. */
    private shownFrame = -1;
    private fps = 0;
    private fpsWindowStart = 0;
    private lastBatch = 0;
    /** Loop diagnostics — surfaced in the console so a slow board can be explained. */
    private readonly diag = { loops: 0, ingests: 0, unchanged: 0, inFlight: 0, flushes: 0, stale: 0 };

    private consoleOpen = false;
    private stateTimer: ReturnType<typeof setInterval> | null = null;
    private readonly logLines: string[] = [];
    private status = "idle";

    private lastSteerAt = 0;
    private steering: KeyName | null = null;

    private readonly menus = new MenuTree();
    private readonly subscriptions: string[] = [];
    private pointerSubscription: string | null = null;
    private pointerPositionSubscription: string | null = null;

    // ---------------------------------------------------------------- lifecycle

    async activate(context: Parameters<DriverModule["activate"]>[0]): Promise<void> {
        initProtocol(context.issueCommand, context.manifest.driverId);
        this.styling = context.styling;
        this.mintId = context.generateId;
        this.settings = await loadSettings();

        await this.installMenus();

        const button = await call("command:dom:create-action-button", {
            domElementId: ACTION_BUTTON_ID,
            svg: DOOM_ICON_SVG,
        });
        if (!button.error) {
            await this.track(subscribe("subscription:dom:element-clicked", { domElementId: ACTION_BUTTON_ID }));
        }

        await this.track(subscribe("subscription:keyboard:control-keys"));
        await this.track(subscribe("subscription:webview:message", { webviewDomId: CONSOLE_ID }));
        await this.track(subscribe("subscription:dom:theme-changed"));
        await this.track(subscribe("subscription:dom:fullscreen-changed"));
        await this.track(subscribe("subscription:dom:screen-resized"));

        this.log("DOOM driver ready — open the console or right-click the board to start.");
    }

    private async track(pending: Promise<string | null>): Promise<void> {
        const id = await pending;
        if (id) this.subscriptions.push(id);
    }

    private async installMenus(): Promise<void> {
        const resolutionChildren: MenuNode[] = RESOLUTIONS.map((resolution) => ({
            id: `doom.res.${resolution.id}`,
            title: resolution.label,
            onClick: () => void this.setResolution(resolution.id),
        }));

        const root: MenuNode = {
            id: "doom.root",
            title: "DOOM",
            children: [
                { id: "doom.start", title: "Start / resume", onClick: () => void this.start() },
                { id: "doom.stop", title: "Stop", onClick: () => void this.stop() },
                { id: "doom.restart", title: "Restart from the title screen", onClick: () => void this.restart() },
                { id: "doom.console", title: "Console (keyboard + settings)", onClick: () => void this.toggleConsole() },
                { id: "doom.fit", title: "Fit screen to this view", onClick: () => void this.fitToView() },
                { id: "doom.frame", title: "Fly camera to the screen", onClick: () => void this.flyToScreen() },
                { id: "doom.resolution", title: "Grid resolution", children: resolutionChildren },
                {
                    id: "doom.display",
                    title: "Display",
                    children: [
                        { id: "doom.display.image", title: "Full resolution (640 x 400)", onClick: () => void this.setDisplayMode("image") },
                        { id: "doom.display.shapes", title: "Shape grid (one rectangle per pixel)", onClick: () => void this.setDisplayMode("shapes") },
                    ],
                },
                {
                    id: "doom.style",
                    title: "Grid look",
                    children: [
                        { id: "doom.style.pixel", title: "Pixels (crisp)", onClick: () => void this.setStyle("pixel") },
                        { id: "doom.style.sketch", title: "Hand-drawn (slow!)", onClick: () => void this.setStyle("sketch") },
                    ],
                },
                { id: "doom.mouse", title: "Toggle pointer steering", onClick: () => void this.setMouseLook(!this.settings.mouseLook) },
                { id: "doom.fullscreen", title: "Toggle fullscreen", onClick: () => void this.toggleFullscreen() },
            ],
        };
        await this.menus.install(root);
    }

    // -------------------------------------------------------------------- boot

    private async boot(): Promise<boolean> {
        if (this.engine) return true;
        if (this.booting) return false;
        this.booting = true;
        this.setStatus("loading engine…");
        try {
            this.module ??= await loadDoomModule();
            await this.saves.hydrate();

            const engine = await DoomEngine.instantiate(
                this.module,
                {
                    // No onFrame hook: the loop reads the newest frame straight
                    // out of wasm memory after advancing, so nothing is copied
                    // and no frame is ever resampled only to be thrown away.
                    onLog: (level, message) => this.onEngineLog(level, message),
                    saves: this.saves,
                },
                this.customWad ? [this.customWad.bytes] : []
            );
            engine.start();
            if (engine.crashed) {
                this.log(`engine failed to start: ${engine.crashed}`);
                this.setStatus("engine failed to start");
                return false;
            }
            this.engine = engine;
            this.input = new InputRouter(engine);
            this.input.timings = { firstMs: this.settings.holdFirstMs, repeatMs: this.settings.holdRepeatMs };
            this.log(
                `engine up — ${engine.width}x${engine.height}, ${this.customWad ? this.customWad.name : "shareware DOOM"}`
            );
            return true;
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            this.log(`engine failed to load: ${message}`);
            this.setStatus("engine failed to load");
            return false;
        } finally {
            this.booting = false;
        }
    }

    private disposeEngine(): void {
        this.input?.releaseAll();
        this.engine = null;
        this.input = null;
    }

    // ------------------------------------------------------------------ screen

    private resolution(): { cols: number; rows: number } {
        return RESOLUTIONS.find((r) => r.id === this.settings.resolution) ?? RESOLUTIONS[2];
    }

    private async viewportRect(): Promise<Rect | null> {
        const viewport = await call("command:camera:get-viewport-rect");
        return viewport.error ? null : viewport.value.rect;
    }

    /** Largest DOOM-shaped rectangle that fits the given view, centred. */
    private fitRectInto(view: Rect): Rect {
        const availableWidth = view.width * (1 - 2 * FIT_MARGIN);
        const availableHeight = view.height * (1 - 2 * FIT_MARGIN);
        let width = availableWidth;
        let height = width / SCREEN_ASPECT;
        if (height > availableHeight) {
            height = availableHeight;
            width = height * SCREEN_ASPECT;
        }
        return {
            x: view.x + (view.width - width) / 2,
            y: view.y + (view.height - height) / 2,
            width,
            height,
        };
    }

    private async resolveScreenRect(): Promise<Rect> {
        if (this.settings.screen) return this.settings.screen;
        const view = await this.viewportRect();
        return view ? this.fitRectInto(view) : { x: 0, y: 0, width: 1280, height: 800 };
    }

    private backdropElement(rect: Rect) {
        this.backdropId ??= this.mintId();
        return {
            type: "shape" as const,
            componentType: "rect" as const,
            drawdyElementId: this.backdropId,
            // A hair larger than the cells so no board colour peeks through the seams.
            x: rect.x - 2,
            y: rect.y - 2,
            width: rect.width + 4,
            height: rect.height + 4,
            strokeColor: this.styling?.border ?? "#000000",
            fillColor: "#000000",
            fillStyle: "solid" as const,
            strokeWidth: 2,
            cornerRadius: 0,
            roughness: 0,
            seed: 7,
            layer: 0,
        };
    }

    /** True when the image display is both wanted and possible here. */
    private useImageDisplay(): boolean {
        return this.settings.displayMode === "image" && imageDisplaySupported();
    }

    /** Put the screen on the board. Replaces any previous one. */
    private async mountScreen(rect: Rect): Promise<boolean> {
        await this.unmountScreen();

        let elements;
        if (this.useImageDisplay()) {
            this.imageElementId ??= this.mintId();
            this.imageScreen = new ImageScreen(rect, this.imageElementId, {
                format: this.settings.imageFormat,
                quality: this.settings.imageQuality,
            });
            elements = [this.backdropElement(rect), this.imageScreen.placeholder()];
        } else {
            if (this.settings.displayMode === "image") {
                this.log("this browser has no OffscreenCanvas in workers — using the shape grid");
            }
            const { cols, rows } = this.resolution();
            this.screen = new CanvasScreen(rect, this.mintId, {
                cols,
                rows,
                colorBits: this.settings.colorBits,
                samples: this.settings.samples,
                style: this.settings.style,
            });
            elements = [this.backdropElement(rect), ...this.screen.elements];
        }

        const created = await call("command:scene:create-drawdy-preview-elements", {
            elements,
            hitTestable: this.settings.mouseLook,
        });
        if (created.error) {
            this.screen = null;
            this.imageScreen = null;
            const reason =
                created.error.type === "unauthorized"
                    ? "scene permission denied — DOOM cannot draw on this board"
                    : (created.error.message ?? created.error.type);
            this.log(reason);
            this.setStatus(reason);
            return false;
        }
        this.previewId = created.value.previewId;
        this.settings.screen = rect;
        saveSettings(this.settings);
        return true;
    }

    private async unmountScreen(): Promise<void> {
        if (this.previewId) {
            await call("command:scene:delete-drawdy-preview-elements", { previewIds: [this.previewId] });
            this.previewId = null;
        }
        this.screen = null;
        this.imageScreen = null;
    }

    // -------------------------------------------------------------- run / stop

    async start(): Promise<void> {
        // Booting and mounting both await, so without this a double-click on
        // "Start" would run two game loops over one engine.
        if (this.running || this.starting) return;
        this.starting = true;
        try {
            if (!(await this.boot())) return;

            const rect = await this.resolveScreenRect();
            if (!(await this.mountScreen(rect))) return;

            this.engine?.resetPacing();
            this.running = true;
            this.framesShown = 0;
            this.fpsWindowStart = now();
            this.nextFrameAt = now();
            this.shownFrame = -1;
            this.slowStreak = 0;
            this.setStatus("running");
            await this.flyToScreen();
            await this.syncPointerSubscriptions();
            this.schedule();
        } finally {
            this.starting = false;
        }
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.input?.releaseAll();
        await this.unmountScreen();
        await this.syncPointerSubscriptions();
        this.setStatus("stopped");
    }

    /** Throw the instance away and boot a fresh one — new game, or a new WAD. */
    async restart(): Promise<void> {
        await this.stop();
        this.disposeEngine();
        await this.start();
    }

    /**
     * Schedule against a deadline, not "a tic from now". Sleeping a full tic
     * *after* each frame's work would make the real period `tic + work`, which
     * then feeds back into the catch-up logic and drags the game down further
     * the more expensive a frame is.
     *
     * The delay is clamped to one tic at the top — running the loop faster than
     * the game's own rate cannot make DOOM advance, it only starves the worker
     * we share — and to a few milliseconds at the bottom, so an overloaded
     * board degrades to a lower frame rate instead of a spin.
     */
    private schedule(): void {
        if (!this.running) return;
        const time = now();
        this.nextFrameAt += MS_PER_TIC;
        if (this.nextFrameAt < time - MAX_FRAME_LAG_MS) this.nextFrameAt = time;
        const delay = Math.min(MS_PER_TIC, Math.max(MIN_FRAME_DELAY_MS, this.nextFrameAt - time));
        this.timer = setTimeout(() => {
            this.timer = null;
            this.frame();
        }, delay);
    }

    /** One turn of the crank: age input holds, advance the game, push pixels. */
    private frame(): void {
        if (!this.running || !this.engine || !this.input) return;
        const time = now();

        this.diag.loops++;
        this.input.expire(time);
        this.engine.advance(time);

        if (this.engine.crashed) {
            this.log(`engine stopped: ${this.engine.crashed}`);
            this.setStatus(`crashed: ${this.engine.crashed}`);
            void this.stop();
            this.disposeEngine();
            return;
        }

        if (this.renderInFlight) this.diag.inFlight++;
        else if (this.engine.frames === this.shownFrame) this.diag.stale++;
        else {
            this.shownFrame = this.engine.frames;
            void this.flush();
        }

        if (time - this.fpsWindowStart >= 1000) {
            this.fps = (this.framesShown * 1000) / (time - this.fpsWindowStart);
            this.framesShown = 0;
            this.fpsWindowStart = time;
        }

        this.schedule();
    }

    /**
     * Turn the newest frame into a canvas update.
     *
     * Called synchronously from the loop, and everything that reads DOOM's
     * frame buffer happens before the first `await` — the buffer is a live
     * view into wasm memory and the next tic overwrites it.
     */
    private async flush(): Promise<void> {
        const engine = this.engine;
        if (!engine) return;
        const pixels = engine.latestFrame();
        if (!pixels) return;

        this.renderInFlight = true;
        let elapsed = 0;
        try {
            let elements;
            if (this.imageScreen) {
                // The BGRA -> RGBA pass runs before encode() awaits, so the
                // frame is safely consumed before DOOM can touch it again.
                const source = await this.imageScreen.encode(pixels, engine.width, engine.height);
                elements = [this.imageScreen.element(source)];
                this.lastBatch = 1;
            } else if (this.screen) {
                this.diag.ingests++;
                this.screen.ingest(pixels, engine.width, engine.height);
                if (this.screen.pendingCells === 0) {
                    this.diag.unchanged++;
                    return;
                }
                elements = this.screen.takeDirty();
                this.lastBatch = elements.length;
            } else {
                return;
            }

            this.diag.flushes++;
            const started = now();
            const outcome = await call("command:scene:update-drawdy-preview-elements", { elements });
            elapsed = now() - started;
            if (!this.handleDrawOutcome(outcome, elements.length)) return;
            this.framesShown++;
            this.updateMs = this.updateMs === 0 ? elapsed : this.updateMs * 0.85 + elapsed * 0.15;
        } finally {
            this.renderInFlight = false;
        }
        this.autoQuality(elapsed);
    }

    /** @returns false when the frame did not land and the caller should bail. */
    private handleDrawOutcome(
        outcome: Awaited<ReturnType<typeof call<"command:scene:update-drawdy-preview-elements">>>,
        sent: number
    ): boolean {
        if (outcome.error) {
            this.log(`draw failed: ${outcome.error.message ?? outcome.error.type}`);
            if (outcome.error.type === "unauthorized") void this.stop();
            return false;
        }
        // The preview batch can be dropped underneath us (board reload, another
        // driver clearing previews). Nothing landing means it is gone: remount.
        if (outcome.value.updated === 0 && sent > 0) {
            this.log("preview batch went missing — remounting the screen");
            const rect = this.screen?.rect ?? this.imageScreen?.rect;
            if (rect) void this.remount(rect);
            return false;
        }
        return true;
    }

    private async remount(rect: Rect): Promise<void> {
        if (await this.mountScreen(rect)) this.screen?.invalidate();
    }

    /** Step the grid down when the board plainly cannot draw it fast enough. */
    private autoQuality(elapsed: number): void {
        if (!this.settings.autoQuality || !this.screen) return;
        this.slowStreak = elapsed > SLOW_UPDATE_MS ? this.slowStreak + 1 : 0;
        if (this.slowStreak < SLOW_STREAK_LIMIT) return;
        this.slowStreak = 0;
        const index = RESOLUTIONS.findIndex((r) => r.id === this.settings.resolution);
        if (index <= 0) return;
        const next = RESOLUTIONS[index - 1]!;
        this.log(`drawing is taking ${elapsed.toFixed(0)} ms — dropping to ${next.label}`);
        void this.setResolution(next.id);
    }

    // ---------------------------------------------------------------- settings

    private async setResolution(id: ResolutionId): Promise<void> {
        if (this.settings.resolution === id && this.screen) return;
        this.settings.resolution = id;
        saveSettings(this.settings);
        if (!this.running) return;
        const rect = this.screen?.rect ?? this.imageScreen?.rect ?? (await this.resolveScreenRect());
        await this.mountScreen(rect);
        this.pushState();
    }

    private async setDisplayMode(mode: DisplayMode): Promise<void> {
        if (this.settings.displayMode === mode) return;
        this.settings.displayMode = mode;
        saveSettings(this.settings);
        this.log(mode === "image" ? "display: full resolution" : "display: shape grid");
        if (this.running) await this.mountScreen(this.screen?.rect ?? this.imageScreen?.rect ?? (await this.resolveScreenRect()));
        this.pushState();
    }

    private async setStyle(style: ScreenStyle): Promise<void> {
        this.settings.style = style;
        saveSettings(this.settings);
        if (!this.running) return;
        const rect = this.screen?.rect ?? this.imageScreen?.rect ?? (await this.resolveScreenRect());
        await this.mountScreen(rect);
    }

    private async setMouseLook(enabled: boolean): Promise<void> {
        this.settings.mouseLook = enabled;
        saveSettings(this.settings);
        this.log(`pointer steering ${enabled ? "on" : "off"}`);
        if (this.running) {
            // hit-testability is fixed when the batch is created, so remount.
            const rect = this.screen?.rect ?? this.imageScreen?.rect ?? (await this.resolveScreenRect());
            await this.mountScreen(rect);
        }
        await this.syncPointerSubscriptions();
        this.pushState();
    }

    private async syncPointerSubscriptions(): Promise<void> {
        const wanted = this.running && this.settings.mouseLook;
        if (wanted && !this.pointerSubscription) {
            this.pointerSubscription = await subscribe("subscription:scene:pointer", {});
            this.pointerPositionSubscription = await subscribe("subscription:scene:pointer-position");
        } else if (!wanted && this.pointerSubscription) {
            await unsubscribe(this.pointerSubscription);
            await unsubscribe(this.pointerPositionSubscription);
            this.pointerSubscription = null;
            this.pointerPositionSubscription = null;
            this.releaseSteering();
            this.input?.releaseOwner(POINTER);
        }
    }

    private async fitToView(): Promise<void> {
        const view = await this.viewportRect();
        if (!view) return;
        const rect = this.fitRectInto(view);
        this.settings.screen = rect;
        saveSettings(this.settings);
        if (!this.running) return;
        if (this.imageScreen) {
            this.imageScreen.setRect(rect);
            await call("command:scene:update-drawdy-preview-elements", {
                elements: [this.backdropElement(rect), this.imageScreen.element(this.imageScreen.placeholderSource)],
            });
            return;
        }
        if (!this.screen) return;
        this.screen.setRect(rect);
        this.screen.invalidate();
        // Geometry moved: repaint every cell, and move the backdrop with it.
        await call("command:scene:update-drawdy-preview-elements", {
            elements: [this.backdropElement(rect), ...this.screen.elements],
        });
    }

    private async flyToScreen(): Promise<void> {
        const rect = this.screen?.rect ?? this.imageScreen?.rect ?? this.settings.screen;
        if (!rect) return;
        await call("command:camera:fly-to-rect", { rect, flyDurationMs: 420, zoom: 4 });
    }

    private async toggleFullscreen(): Promise<void> {
        const entered = await call("command:dom:enter-fullscreen");
        if (!entered.error && entered.value.entered) return;
        await call("command:dom:exit-fullscreen");
    }

    // ----------------------------------------------------------------- console

    private async toggleConsole(): Promise<void> {
        if (this.consoleOpen) {
            await call("command:webview:hide", { webviewDomId: CONSOLE_ID });
            this.consoleOpen = false;
            this.input?.releaseOwner(CONSOLE);
            if (this.stateTimer) clearInterval(this.stateTimer);
            this.stateTimer = null;
            return;
        }
        const created = await call("command:webview:create", {
            webviewDomId: CONSOLE_ID,
            htmlContent: consoleHtml(this.styling ?? fallbackStyling()),
        });
        if (created.error) {
            this.log(`console unavailable: ${created.error.message ?? created.error.type}`);
            return;
        }
        this.consoleOpen = true;
        this.stateTimer ??= setInterval(() => this.pushState(), 500);
        this.pushState();
    }

    private pushState(): void {
        if (!this.consoleOpen) return;
        const { cols, rows } = this.resolution();
        void call("command:webview:post-message", {
            webviewDomId: CONSOLE_ID,
            message: {
                t: "state",
                running: this.running,
                crashed: !!this.engine?.crashed,
                status: this.status,
                fps: this.fps,
                tics: this.engine?.tics ?? 0,
                cells: this.lastBatch,
                grid: this.imageScreen ? `640 x 400 (${(this.imageScreen.lastBytes / 1024).toFixed(0)} KB ${(this.imageScreen.actualFormat ?? "").replace("image/", "")})` : `${cols} x ${rows}`,
                displayMode: this.settings.displayMode,
                encodeMs: this.imageScreen?.lastEncodeMs ?? 0,
                budgetMs: this.updateMs,
                keys: this.input?.heldCount ?? 0,
                resolution: this.settings.resolution,
                mouseLook: this.settings.mouseLook,
                autoQuality: this.settings.autoQuality,
                diag: { ...this.diag },
            },
        });
    }

    private setStatus(status: string): void {
        this.status = status;
        this.pushState();
    }

    private log(line: string): void {
        this.logLines.push(line);
        if (this.logLines.length > 200) this.logLines.shift();
        if (this.consoleOpen) {
            void call("command:webview:post-message", {
                webviewDomId: CONSOLE_ID,
                message: { t: "log", line },
            });
        }
    }

    private onEngineLog(level: "info" | "error", message: string): void {
        const trimmed = message.trim();
        if (!trimmed) return;
        // DOOM is chatty at boot; keep errors and the headline lines only.
        if (level === "error" || /^(W_|R_|P_|S_|I_|M_|Z_|HU_|ST_|D_|startskill|player |Emulating|=====|DOOM)/.test(trimmed)) {
            this.log(trimmed);
        }
    }

    // ------------------------------------------------------------------ events

    async onEvent(event: DriverSubscriptionEvent): Promise<void> {
        switch (event.type) {
            case "subscription:context-menu:clicked":
                this.menus.dispatch(event.body.menuId);
                return;
            case "subscription:dom:element-clicked":
                if (event.body.domElementId === ACTION_BUTTON_ID) await this.toggleConsole();
                return;
            case "subscription:keyboard:control-keys":
                this.onControlKey(event.body);
                return;
            case "subscription:webview:message":
                if (event.body.webviewDomId === CONSOLE_ID) await this.onConsoleMessage(event.body.message);
                return;
            case "subscription:dom:theme-changed":
                this.styling = event.body.styling;
                if (this.consoleOpen) {
                    // The panel's palette is baked into its HTML; rebuild it.
                    this.consoleOpen = false;
                    await call("command:webview:hide", { webviewDomId: CONSOLE_ID });
                    await this.toggleConsole();
                }
                return;
            case "subscription:dom:fullscreen-changed":
            case "subscription:dom:screen-resized":
                if (this.running) await this.fitToView();
                return;
            case "subscription:scene:pointer":
                this.onScenePointer(event.body);
                return;
            case "subscription:scene:pointer-position":
                this.onPointerPosition(event.body.position.canvasSpace);
                return;
            default:
                return;
        }
    }

    private onControlKey(body: ControlKeyEvent): void {
        if (!this.running || !this.input) return;
        const binding = bindControlKey(body);
        if (!binding) return;
        const time = now();

        if (binding.weaponStep) {
            this.input.cycleWeapon(binding.weaponStep, time);
            return;
        }
        // Keep the modifiers honest so letting go of Shift stops the run at once.
        this.input.syncModifier("SHIFT", body.shift, time);
        this.input.syncModifier("ALT", body.alt, time);
        this.input.press(
            binding.keys.filter((key) => key !== "SHIFT" && key !== "ALT"),
            time
        );
    }

    private resolveKey(message: { name?: unknown; ascii?: unknown }): number | null {
        if (isKeyName(message.name)) return this.engine?.keys[message.name] ?? null;
        if (typeof message.ascii === "number" && message.ascii >= 0 && message.ascii <= 255) return message.ascii;
        return null;
    }

    private async onConsoleMessage(raw: unknown): Promise<void> {
        if (!raw || typeof raw !== "object") return;
        const message = raw as Record<string, unknown>;
        const time = now();

        switch (message.t) {
            case "ready":
                for (const line of this.logLines.slice(-40)) {
                    void call("command:webview:post-message", {
                        webviewDomId: CONSOLE_ID,
                        message: { t: "log", line },
                    });
                }
                this.pushState();
                return;

            case "kd": {
                const key = this.resolveKey(message);
                if (key !== null) this.input?.holdExternal(CONSOLE, key);
                return;
            }
            case "ku": {
                const key = this.resolveKey(message);
                if (key !== null) this.input?.releaseExternal(CONSOLE, key);
                return;
            }
            case "tap": {
                const key = this.resolveKey(message);
                if (key !== null) this.input?.pressRaw(key, time);
                return;
            }
            case "weapon":
                if (typeof message.slot === "number") this.input?.selectWeapon(message.slot, time);
                return;
            case "focus":
                if (message.on !== true) this.input?.releaseOwner(CONSOLE);
                return;

            case "cmd":
                if (message.id === "start") await this.start();
                else if (message.id === "stop") await this.stop();
                else if (message.id === "fit") await this.fitToView();
                else if (message.id === "fullscreen") await this.toggleFullscreen();
                else if (message.id === "restart") await this.restart();
                return;

            case "set":
                if (message.key === "resolution" && typeof message.value === "string") {
                    await this.setResolution(message.value as ResolutionId);
                } else if (message.key === "mouseLook") {
                    await this.setMouseLook(message.value === true);
                } else if (message.key === "displayMode" && typeof message.value === "string") {
                    await this.setDisplayMode(message.value as DisplayMode);
                } else if (message.key === "imageQuality" && typeof message.value === "number") {
                    this.settings.imageQuality = Math.min(1, Math.max(0.3, message.value));
                    saveSettings(this.settings);
                    if (this.running) await this.mountScreen(this.imageScreen?.rect ?? (await this.resolveScreenRect()));
                } else if (message.key === "autoQuality") {
                    this.settings.autoQuality = message.value === true;
                    saveSettings(this.settings);
                }
                return;

            case "wad": {
                const bytes = message.bytes;
                if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 12) return;
                this.customWad = {
                    name: typeof message.name === "string" ? message.name : "custom.wad",
                    bytes: new Uint8Array(bytes),
                };
                this.log(`loading ${this.customWad.name} (${(bytes.byteLength / 1048576).toFixed(1)} MB)`);
                await this.restart();
                return;
            }
            default:
                return;
        }
    }

    // ---------------------------------------------------------- pointer steering

    private releaseSteering(): void {
        if (!this.steering || !this.input || !this.engine) return;
        this.input.releaseExternal(POINTER, this.engine.keys[this.steering]);
        this.steering = null;
    }

    private onPointerPosition(position: { x: number; y: number }): void {
        if (!this.running || !this.settings.mouseLook || !this.input || !this.engine) return;
        const rect = this.screen?.rect ?? this.imageScreen?.rect;
        if (!rect) return;
        const time = now();
        if (time - this.lastSteerAt < 16) return;
        this.lastSteerAt = time;

        const u = (position.x - rect.x) / rect.width;
        const v = (position.y - rect.y) / rect.height;
        const outside = u < 0 || u > 1 || v < 0 || v > 1;
        // A dead zone down the middle, so the pointer can rest without spinning.
        const wanted: KeyName | null = outside ? null : u < 0.38 ? "LEFTARROW" : u > 0.62 ? "RIGHTARROW" : null;
        if (wanted === this.steering) {
            if (wanted) this.input.holdExternal(POINTER, this.engine.keys[wanted]);
            return;
        }
        if (this.steering) this.input.releaseExternal(POINTER, this.engine.keys[this.steering]);
        this.steering = wanted;
        if (wanted) this.input.holdExternal(POINTER, this.engine.keys[wanted]);
    }

    private onScenePointer(body: { type: string; drawdyElementIds?: string[] }): void {
        if (!this.running || !this.settings.mouseLook || !this.input || !this.engine) return;
        if (body.type === "cancel") {
            this.input.releaseOwner(POINTER);
            this.steering = null;
            return;
        }
        const onScreen =
            body.drawdyElementIds?.some((id) => this.screen?.owns(id) || id === this.imageElementId) ?? false;
        if (body.type === "down" && onScreen) {
            this.input.holdExternal(POINTER, this.engine.keys.FIRE);
        } else if (body.type === "up") {
            this.input.releaseExternal(POINTER, this.engine.keys.FIRE);
        } else if (body.type === "out" && onScreen) {
            this.releaseSteering();
        }
    }
}

function fallbackStyling(): ModuleStyling {
    return {
        theme: "dark",
        background: "#111214",
        foreground: "#e8e8ea",
        surface: "#1a1c1f",
        surface2: "#232629",
        mutedForeground: "#9aa0a6",
        primary: "#c0392b",
        primaryForeground: "#ffffff",
        accent: "#e67e22",
        accentForeground: "#111214",
        border: "#33363b",
        input: "#33363b",
        ring: "#c0392b",
        destructive: "#e74c3c",
        success: "#2ecc71",
        warning: "#f1c40f",
        radiusSm: "4px",
        radiusMd: "8px",
        radiusLg: "12px",
    };
}

const driver = new DoomDriver();

export const activate: DriverModule["activate"] = (context) => driver.activate(context);
export const onEvent: DriverModule["onEvent"] = (event) => driver.onEvent(event);
