/**
 * @name WhoReacted
 * @author jaimeadf (original), modernized rewrite maintained via community contribution
 * @authorId 0
 * @description Shows the avatars of the users who reacted next to each reaction pill on messages. Modernized rewrite of the original WhoReacted plugin (webpack+JSX build) to work with current Discord using resilient module discovery, function-component patching with a DOM-injection fallback, and a self-contained plain-JS build (no bundler, no ZeresPluginLibrary).
 * @version 1.0.0
 * @source https://github.com/Fokiiiiiii/WhoReacted
 * @website https://github.com/Fokiiiiiii/WhoReacted
 */

module.exports = class WhoReacted {
    constructor(meta) {
        this.meta = meta || {};
        this.name = "WhoReacted";

        // ---- runtime state ----
        this.mods = {};
        this.settings = null;
        this.defaults = {
            max: 6,
            avatarSize: 20,
            avatarOverlap: 100 / 3,
            avatarSpacing: 100 / 12,
            emojiThreshold: 10,
            reactionsTotalThreshold: 500,
            reactionsPerEmojiThreshold: 100,
            hideSelf: false,
            hideBots: false,
            hideBlocked: false
        };

        this.listeners = new Set();
        this.maskIdCounter = 0;

        this.strategy = null; // "A" or "B"
        this.unpatchFns = [];
        this.observer = null;
        this.domRoots = new Map(); // element -> {root, container}
        this.pillRetryFrames = new Map(); // element -> requestAnimationFrame id
        this.requestedFetches = new Set(); // `${channelId}:${messageId}:${emoji}` dedupe
        this.reactionUsersCache = new Map(); // reaction key -> {users, timestamp}
        this.reactionUsersCacheTtl = 5 * 60 * 1000;
        this.reactionUsersCacheMax = 500;

        this.started = false;

        // Strategy A health tracking: incremented every time a patched render
        // actually injected our element. Used by the watchdog to detect a
        // "false positive" patch (wrong component / never fires) and switch
        // to Strategy B.
        this.injectionSuccessCount = 0;
        this.watchdogTimer = null;
        this.watchdogChecks = 0;

        // Manual REST fetch queue (rate-limit friendly, sequential).
        this.fetchQueue = [];
        this.fetchQueueTimer = null;
        this._restUnavailableLogged = false;
        this._emojiPathNullLogged = false;

        // On-disk diagnostics. Persisted (throttled) to
        // plugins/WhoReacted.config.json under the "diagnostics" key so it
        // can be inspected from the filesystem without console access.
        this.diag = {
            pluginVersion: "1.0.0",
            bdVersion: null,
            updates: 0,
            lastUpdate: null,
            strategy: null,
            fallbacksUsed: [],
            strategyA: {
                candidateMatched: null,
                handlerFires: 0,
                injectionSuccesses: 0,
                injectionFailures: 0
            },
            strategyB: {
                pillsSeen: 0,
                fiberPropsFound: 0,
                fiberPropsMissing: 0,
                rendersOk: 0,
                renderErrors: 0,
                sampleFiberPropKeys: null
            },
            data: {
                getReactionsCalls: 0,
                lastReactionsCount: -1,
                restFetchesQueued: 0,
                restFetchesOk: 0,
                restFetchesFailed: 0,
                lastRestError: null,
                restApiFound: false,
                dispatcherFound: false,
                dispatcherVia: null,
                fetchReactionsActionFound: false,
                reactionCacheHits: 0,
                reactionCacheEntries: 0,
                lastEffectiveCount: 0,
                invalidUsersSkipped: 0
            },
            errors: []
        };
        this._lastDiagSave = 0;
        this._diagSaveTimer = null;

        // Bind so they can be used as stable references for patches/listeners.
        this._onMutations = this._onMutations.bind(this);

        // Stable component references, created ONCE so React sees the same
        // component identity across renders (no remounting) and so hooks run
        // inside real component boundaries — these must NEVER be invoked as
        // plain function calls, always via createElement.
        this.ReactorC = (props) => this._Reactor(props);
        this.MaskedReactorC = (props) => this._MaskedReactor(props);
        this.ReactorsC = (props) => this._Reactors(props);
        this.RootC = (props) => this._WhoReactedReactors(props);
    }

    /* ------------------------------------------------------------------ *
     *  Lifecycle
     * ------------------------------------------------------------------ */

    start() {
        try {
            try { this.diag.bdVersion = (typeof BdApi !== "undefined" && BdApi.version) || null; } catch (e) { /* ignore */ }
            this._loadSettings();
            this._injectStyles();

            const ok = this._resolveModules();
            if (!ok) {
                this._logError("Aborting start(): one or more critical modules could not be resolved.");
                BdApi.UI.showToast(`${this.name}: failed to initialize (missing modules). See console for details.`, { type: "error" });
                this._saveDiag(true);
                return;
            }

            this.started = true;

            // Current Discord reaction components are frequently returned as
            // bare minified exports. Finding a source-string match does not
            // prove that BetterDiscord can patch the live call site, which
            // made Strategy A report success while its handler never fired.
            // Strategy B works from the rendered pill and remains valid when
            // pills appear long after startup, so use it as the primary path.
            this.strategy = "B";
            BdApi.Logger.info(this.name, "Using strategy B (DOM/MutationObserver injection).");
            this._startStrategyB();

            this.diag.strategy = this.strategy;
            this._logStartupSummary();
            this._saveDiag(true);
        } catch (err) {
            this._logError("Unexpected error during start():", err);
            BdApi.UI.showToast(`${this.name}: failed to start (${err && err.message ? err.message : err})`, { type: "error" });
            this._saveDiag(true);
        }
    }

    stop() {
        try {
            BdApi.Patcher.unpatchAll(this.name);
        } catch (err) {
            this._logError("Error while unpatching:", err);
        }

        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        this.watchdogChecks = 0;
        this.injectionSuccessCount = 0;

        try {
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }
        } catch (err) {
            this._logError("Error disconnecting observer:", err);
        }

        try {
            for (const [, entry] of this.domRoots) {
                this._teardownDomEntry(entry);
            }
            this.domRoots.clear();
            for (const frameId of this.pillRetryFrames.values()) {
                cancelAnimationFrame(frameId);
            }
            this.pillRetryFrames.clear();
        } catch (err) {
            this._logError("Error tearing down DOM roots:", err);
        }

        try {
            BdApi.DOM.removeStyle(this.name);
        } catch (err) {
            this._logError("Error removing style:", err);
        }

        if (this.fetchQueueTimer) {
            clearTimeout(this.fetchQueueTimer);
            this.fetchQueueTimer = null;
        }
        this.fetchQueue = [];

        if (this._diagSaveTimer) {
            clearTimeout(this._diagSaveTimer);
            this._diagSaveTimer = null;
        }

        this.requestedFetches.clear();
        this.reactionUsersCache.clear();
        this.strategy = null;
        this.started = false;
        this._saveDiag(true);
    }

    getSettingsPanel() {
        try {
            if (BdApi.UI && typeof BdApi.UI.buildSettingsPanel === "function") {
                return this._buildSettingsPanelViaBdApi();
            }
        } catch (err) {
            this._logError("buildSettingsPanel failed, falling back to manual panel:", err);
        }

        return this._buildFallbackSettingsPanel();
    }

    /* ------------------------------------------------------------------ *
     *  Settings persistence + pub/sub
     * ------------------------------------------------------------------ */

    _loadSettings() {
        let saved = null;
        try {
            saved = BdApi.Data.load(this.name, "settings");
        } catch (err) {
            this._logError("Failed to load settings:", err);
        }
        this.settings = Object.assign({}, this.defaults, saved || {});
    }

    _saveSettings() {
        try {
            BdApi.Data.save(this.name, "settings", this.settings);
        } catch (err) {
            this._logError("Failed to save settings:", err);
        }
    }

    updateSetting(name, value) {
        this.settings[name] = value;
        this._saveSettings();
        this._notifyListeners();
    }

    _notifyListeners() {
        for (const listener of this.listeners) {
            try { listener(); } catch (err) { this._logError("Settings listener threw:", err); }
        }
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /* ------------------------------------------------------------------ *
     *  Diagnostics (persisted to WhoReacted.config.json)
     * ------------------------------------------------------------------ */

    // Logs to the console AND appends to diag.errors (last 10) so failures
    // can be inspected from disk without console access.
    _logError(...parts) {
        try {
            BdApi.Logger.error(this.name, ...parts);
        } catch (e) { /* never throw */ }
        try {
            const msg = parts.map(p => {
                if (p instanceof Error) return p.message || String(p);
                if (typeof p === "string") return p;
                try { return JSON.stringify(p); } catch (e) { return String(p); }
            }).join(" ").slice(0, 400);
            this.diag.errors.push(msg);
            if (this.diag.errors.length > 10) {
                this.diag.errors.splice(0, this.diag.errors.length - 10);
            }
            this._saveDiag(false);
        } catch (e) { /* never throw */ }
    }

    // Throttled persist: at most one write every 2s; a trailing write is
    // scheduled so the final state always lands on disk.
    _saveDiag(force) {
        try {
            const now = Date.now();
            if (!force && now - this._lastDiagSave < 2000) {
                if (!this._diagSaveTimer) {
                    this._diagSaveTimer = setTimeout(() => {
                        this._diagSaveTimer = null;
                        this._saveDiag(true);
                    }, 2100);
                }
                return;
            }
            this._lastDiagSave = now;
            this.diag.updates++;
            this.diag.lastUpdate = new Date().toISOString();
            BdApi.Data.save(this.name, "diagnostics", this.diag);
        } catch (e) { /* never throw, never recurse into _logError */ }
    }

    /* ------------------------------------------------------------------ *
     *  Manual reactor fetch (REST + Flux dispatch)
     * ------------------------------------------------------------------ */

    _emojiApiPath(emoji) {
        if (!emoji) return null;
        try {
            if (typeof emoji === "string") return emoji;
            if (typeof emoji !== "object" || typeof emoji.name !== "string") return null;
            return emoji.name + (emoji.id ? `:${emoji.id}` : "");
        } catch (err) {
            this._logError("_emojiApiPath threw:", err);
            return null;
        }
    }

    _enqueueRestFetch(channelId, messageId, emoji, type) {
        if (!this.mods.RestAPI || !this.mods.FluxDispatcher) {
            // The reaction store may already contain the users (and usually
            // does on current Discord). Do not turn an optional fallback into
            // a persistent error when no verified internal REST module exists.
            return;
        }
        // Cap pending work so a huge scrollback can't build an endless queue.
        if (this.fetchQueue.length > 100) return;

        const dedupeKey = `${channelId}:${messageId}:${emoji && (emoji.id || emoji.name)}:${type || 0}`;
        this.fetchQueue.push({ channelId, messageId, emoji, type, dedupeKey });
        this.diag.data.restFetchesQueued++;
        this._saveDiag(false);
        this._pumpFetchQueue();
    }

    // Sequential queue with ~300ms between requests for rate-limit safety.
    _pumpFetchQueue() {
        if (this.fetchQueueTimer || this.fetchQueue.length === 0) return;

        this.fetchQueueTimer = setTimeout(async () => {
            this.fetchQueueTimer = null;
            const job = this.fetchQueue.shift();
            if (job && this.started) {
                try {
                    await this._doRestFetch(job);
                } catch (err) {
                    this._logError("REST fetch job failed:", err);
                }
            }
            if (this.started && this.fetchQueue.length > 0) {
                this._pumpFetchQueue();
            }
        }, 300);
    }

    async _doRestFetch(job) {
        const { channelId, messageId, emoji, type } = job;
        const RestAPI = this.mods.RestAPI;
        const FluxDispatcher = this.mods.FluxDispatcher;
        if (!RestAPI || !FluxDispatcher || !channelId || !messageId) return;

        const emojiPath = this._emojiApiPath(emoji);

        if (!emojiPath) {
            if (!this._emojiPathNullLogged) {
                this._emojiPathNullLogged = true;
                this._logError("WARNING: _doRestFetch got null emojiPath, skipping REST fetch");
            }
            return;
        }

        let url = null;
        try {
            const reactionsEndpoint = this.mods.Endpoints && this.mods.Endpoints.REACTIONS;
            url = typeof reactionsEndpoint === "function"
                ? reactionsEndpoint(channelId, messageId, emojiPath)
                : `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emojiPath)}`;
        } catch (err) {
            url = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emojiPath)}`;
        }

        try {
            const response = await RestAPI.get({
                url,
                query: { limit: 100, type: type || 0 },
                oldFormErrors: true
            });
            const users = response && response.body;

            if (Array.isArray(users)) {
                for (const user of users) {
                    FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
                }
                FluxDispatcher.dispatch({
                    type: "MESSAGE_REACTION_ADD_USERS",
                    channelId,
                    messageId,
                    users,
                    emoji,
                    reactionType: type || 0
                });
                this.diag.data.restFetchesOk++;
            } else {
                this.diag.data.restFetchesFailed++;
                this.diag.data.lastRestError = `Unexpected response body: ${typeof users}`;
                if (job.dedupeKey) this.requestedFetches.delete(job.dedupeKey);
            }
        } catch (err) {
            this.diag.data.restFetchesFailed++;
            this.diag.data.lastRestError = err && err.message ? String(err.message) : String(err);
            if (job.dedupeKey) this.requestedFetches.delete(job.dedupeKey);
            this._logError("_doRestFetch failed:", err);
        }
        this._saveDiag(false);
    }

    /* ------------------------------------------------------------------ *
     *  Module resolution
     * ------------------------------------------------------------------ */

    _resolveModules() {
        const Webpack = BdApi.Webpack;
        const Filters = Webpack.Filters;
        const fallbacksUsed = [];
        let criticalMissing = false;

        const resolveStore = (label, storeName, fallbackKeys, critical) => {
            let mod = null;
            let via = null;

            try {
                if (typeof Webpack.getStore === "function") {
                    mod = Webpack.getStore(storeName);
                    if (mod) via = "getStore";
                }
            } catch (err) {
                this._logError(`getStore("${storeName}") threw:`, err);
            }

            if (!mod) {
                try {
                    mod = Webpack.getModule(Filters.byKeys.apply(Filters, fallbackKeys));
                    if (mod) via = "byKeys fallback (" + fallbackKeys.join(",") + ")";
                } catch (err) {
                    this._logError(`byKeys fallback for ${label} threw:`, err);
                }
            }

            if (!mod) {
                this._logError(`Failed to resolve ${label} (tried getStore("${storeName}") and byKeys fallback).`);
                if (critical) criticalMissing = true;
            } else if (via && via !== "getStore") {
                fallbacksUsed.push(`${label} via ${via}`);
            }

            return mod;
        };

        this.mods.ReactionStore = resolveStore("ReactionStore", "MessageReactionsStore", ["getReactions"], true);
        this.mods.UserStore = resolveStore("UserStore", "UserStore", ["getUser", "getCurrentUser"], true);
        this.mods.ChannelStore = resolveStore("ChannelStore", "ChannelStore", ["getChannel", "hasChannel"], true);
        this.mods.RelationshipStore = resolveStore("RelationshipStore", "RelationshipStore", ["isBlocked"], false);

        // useStateFromStores
        try {
            this.mods.useStateFromStores = Webpack.getModule(Filters.byStrings("useStateFromStores"), { searchExports: true });
        } catch (err) {
            this._logError("Lookup of useStateFromStores threw:", err);
        }
        if (typeof this.mods.useStateFromStores !== "function") {
            fallbacksUsed.push("useStateFromStores via manual Flux subscription hook");
            this.mods.useStateFromStores = this._manualUseStateFromStores.bind(this);
        }

        // Optional: fetchReactions action, used as the primary nudge.
        // NOTE: byKeys returns the MODULE that HAS the key — extract and
        // bind the actual function off it.
        try {
            const actionModule = Webpack.getModule(Filters.byKeys("fetchReactions"));
            this.mods.fetchReactions = actionModule && typeof actionModule.fetchReactions === "function"
                ? actionModule.fetchReactions.bind(actionModule)
                : null;
        } catch (err) {
            this.mods.fetchReactions = null;
        }
        this.diag.data.fetchReactionsActionFound = typeof this.mods.fetchReactions === "function";

        // Optional: RestAPI + FluxDispatcher, used for the manual reactor
        // fetch fallback (Discord does not populate MessageReactionsStore
        // until something requests the reactor list).
        // Do not select RestAPI by generic method names. Current Discord has
        // unrelated modules with get/post/put/patch/del whose get() accepts a
        // URL string; calling one with Discord's {url, query} request object
        // reaches XMLHttpRequest.open with a non-string URL and throws
        // "t[1].toLowerCase is not a function". Until an internal module can
        // be identified by a stable source marker, rely on the reaction store.
        const RestAPI = null;
        this.mods.RestAPI = RestAPI;
        this.diag.data.restApiFound = !!RestAPI;
        if (!RestAPI) fallbacksUsed.push("RestAPI not found (manual reactor fetch disabled)");

        try {
            const constants = Webpack.getModule(Filters.byKeys("Endpoints"));
            this.mods.Endpoints = constants && constants.Endpoints;
        } catch (err) {
            this.mods.Endpoints = null;
        }

        // FluxDispatcher. On current builds the dispatcher is a class
        // instance whose methods live on the PROTOTYPE, so key-based filters
        // (Object.keys) miss it — function-shape checks via property access
        // reach prototype methods. Most reliable of all: grab the dispatcher
        // off an already-resolved Flux store.
        let dispatcher = null;
        let dispatcherVia = null;

        const isDispatcher = d => d && typeof d.dispatch === "function";

        // 1. From an already-resolved store's internals.
        for (const store of [this.mods.UserStore, this.mods.ChannelStore, this.mods.ReactionStore, this.mods.RelationshipStore]) {
            if (!store) continue;
            try {
                if (isDispatcher(store._dispatcher)) {
                    dispatcher = store._dispatcher;
                    dispatcherVia = "store._dispatcher";
                    break;
                }
                const viaGetter = typeof store.getDispatcher === "function" ? store.getDispatcher() : null;
                if (isDispatcher(viaGetter)) {
                    dispatcher = viaGetter;
                    dispatcherVia = "store.getDispatcher()";
                    break;
                }
            } catch (err) { /* try next store */ }
        }

        // 2. Function-shape module filter (reaches prototype methods).
        if (!dispatcher) {
            try {
                const found = Webpack.getModule(m => m && typeof m.dispatch === "function" && typeof m.subscribe === "function");
                if (isDispatcher(found)) {
                    dispatcher = found;
                    dispatcherVia = "shape filter";
                }
            } catch (err) { /* try next */ }
        }

        // 3. Same filter over exports.
        if (!dispatcher) {
            try {
                const found = Webpack.getModule(
                    m => m && typeof m.dispatch === "function" && typeof m.subscribe === "function",
                    { searchExports: true }
                );
                if (isDispatcher(found)) {
                    dispatcher = found;
                    dispatcherVia = "shape filter (searchExports)";
                }
            } catch (err) { /* optional */ }
        }

        this.mods.FluxDispatcher = dispatcher;
        this.diag.data.dispatcherFound = !!dispatcher;
        this.diag.data.dispatcherVia = dispatcherVia;
        if (dispatcher) {
            if (dispatcherVia !== "shape filter") fallbacksUsed.push(`FluxDispatcher via ${dispatcherVia}`);
        } else {
            fallbacksUsed.push("FluxDispatcher not found (manual reactor fetch disabled)");
        }

        this._fallbacksUsed = fallbacksUsed;
        this.diag.fallbacksUsed = fallbacksUsed;

        if (criticalMissing) return false;
        return true;
    }

    _manualUseStateFromStores(stores, getState, deps) {
        const React = BdApi.React;
        const [state, setState] = React.useState(getState);

        React.useEffect(() => {
            let disposed = false;
            const onChange = () => {
                if (!disposed) setState(getState());
            };
            for (const store of stores) {
                if (store && typeof store.addChangeListener === "function") {
                    store.addChangeListener(onChange);
                }
            }
            // Sync immediately in case something changed between render and effect.
            onChange();
            return () => {
                disposed = true;
                for (const store of stores) {
                    if (store && typeof store.removeChangeListener === "function") {
                        store.removeChangeListener(onChange);
                    }
                }
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, deps || stores);

        return state;
    }

    _logStartupSummary() {
        const fb = this._fallbacksUsed && this._fallbacksUsed.length
            ? this._fallbacksUsed.join("; ")
            : "none";
        BdApi.Logger.info(
            this.name,
            `Startup summary — injection strategy: ${this.strategy}; module fallbacks used: ${fb}`
        );
    }

    /* ------------------------------------------------------------------ *
     *  Styles
     * ------------------------------------------------------------------ */

    _injectStyles() {
        const css = `
.bd-who-reacted__reactors {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
    line-height: 1;
}

.bd-who-reacted__reactors:not(:empty) {
    margin-left: 4px;
}

.bd-who-reacted__reactors > svg,
.bd-who-reacted__reactors > img {
    display: block;
}

.bd-who-reacted__reactor-avatar {
    box-sizing: border-box;
    border-radius: 50%;
    border: 1.5px solid var(--background-secondary);
    background-color: #2b2d31;
    display: block;
    opacity: 1 !important;
    object-fit: cover;
}

.bd-who-reacted__more-reactors {
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    align-items: center;
    color: #f2f3f5 !important;
    font-weight: 600;
    background-color: rgba(63, 65, 71, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.16);
    opacity: 1 !important;
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.45);
}

.bd-who-reacted__container {
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
    flex-shrink: 0;
    margin-left: 5px;
    padding: 2px 3px;
    border-radius: 999px;
    background-color: rgba(43, 45, 49, 0.94);
    background-color: color-mix(in srgb, #2b2d31 92%, var(--background-secondary, #2b2d31));
    border: 1px solid var(--background-modifier-accent);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
    max-height: 100%;
    pointer-events: auto;
    cursor: default;
    transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
}

.bd-who-reacted__pill {
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center !important;
    width: auto !important;
    max-width: none !important;
    overflow: visible !important;
}

.bd-who-reacted__pill:hover .bd-who-reacted__container,
.bd-who-reacted__container:hover {
    background-color: rgba(63, 65, 71, 0.96);
    background-color: color-mix(in srgb, #3f4147 94%, var(--background-tertiary, #3f4147));
    border-color: var(--interactive-muted);
    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.24);
}
`;
        BdApi.DOM.addStyle(this.name, css);
    }

    /* ------------------------------------------------------------------ *
     *  React component tree (shared by both injection strategies)
     * ------------------------------------------------------------------ */

    _h() {
        return BdApi.React.createElement.apply(BdApi.React, arguments);
    }

    _avatarSize(size) {
        const requested = Math.max(16, Number(size) || 20);
        const powers = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
        return powers.find(value => value >= requested) || 4096;
    }

    _defaultAvatarUrl(user) {
        let defaultIndex = 0;
        try {
            if (user && user.discriminator && user.discriminator !== "0") {
                defaultIndex = Number(user.discriminator) % 5;
            } else if (user && user.id) {
                defaultIndex = Number((BigInt(user.id) >> 22n) % 6n);
            }
        } catch (err) { /* keep index 0 */ }
        return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
    }

    _normalizeAvatarUrl(user, guildId, size) {
        if (!user) return null;
        const cdnSize = this._avatarSize(size);
        let candidate = null;

        try {
            if (typeof user.getAvatarURL === "function") {
                candidate = user.getAvatarURL(guildId, cdnSize, true);
            }
        } catch (err) { /* try plain-user fallbacks */ }

        try {
            if (!candidate && typeof user.avatarURL === "function") {
                candidate = user.avatarURL({ size: cdnSize, extension: "webp" });
            } else if (!candidate && typeof user.avatarURL === "string") {
                candidate = user.avatarURL;
            }
        } catch (err) { /* try hash fallback */ }

        if (!candidate && user.id && typeof user.avatar === "string" && user.avatar) {
            const extension = user.avatar.startsWith("a_") ? "gif" : "webp";
            candidate = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=${cdnSize}`;
        }

        if (!candidate) {
            candidate = this._defaultAvatarUrl(user);
        }

        try {
            const url = String(candidate);
            if (url.startsWith("//")) return `https:${url}`;
            if (url.startsWith("/")) return `https://cdn.discordapp.com${url}`;
            return url;
        } catch (err) {
            return null;
        }
    }

    _userLabel(user) {
        if (!user) return "Unknown user";
        return String(user.globalName || user.global_name || user.displayName || user.username || user.tag || user.id || "Unknown user");
    }

    _Reactor(props) {
        const h = this._h.bind(this);
        const user = props.user;
        const size = props.size;
        const guildId = props.guildId;

        const src = this._normalizeAvatarUrl(user, guildId, size);
        const fallbackSrc = this._defaultAvatarUrl(user);
        const label = this._userLabel(user);

        return h("img", {
            className: "bd-who-reacted__reactor-avatar",
            width: size,
            height: size,
            src: src || undefined,
            title: label,
            "aria-label": label,
            alt: "",
            draggable: false,
            onError: event => {
                const img = event.currentTarget;
                if (img && img.src !== fallbackSrc) img.src = fallbackSrc;
            }
        });
    }

    _useUniqueMaskId() {
        const React = BdApi.React;
        if (typeof React.useId === "function") {
            return "bd-who-reacted-mask-" + String(React.useId()).replace(/[^a-zA-Z0-9_-]/g, "");
        }
        const ref = React.useRef(null);
        if (ref.current === null) {
            ref.current = "bd-who-reacted-mask-" + (this.maskIdCounter++);
        }
        return ref.current;
    }

    _MaskedReactor(props) {
        const h = this._h.bind(this);
        const size = props.size;
        const overlap = props.overlap;
        const spacing = props.spacing;

        const proportionalInnerRadius = 1 / 2;
        const proportionalOuterRadius = proportionalInnerRadius + spacing;
        const absoluteOffset = (overlap - spacing) * size;

        const maskId = this._useUniqueMaskId();

        return h(
            "svg",
            { style: { marginRight: `${-absoluteOffset}px` }, width: size, height: size },
            h(
                "defs",
                null,
                h(
                    "mask",
                    { id: maskId, maskContentUnits: "objectBoundingBox", viewBox: "0 0 1 1" },
                    h("rect", { fill: "white", width: "1", height: "1" }),
                    h("circle", {
                        fill: "black",
                        cx: 2 * proportionalInnerRadius + proportionalOuterRadius - overlap,
                        cy: "0.5",
                        r: proportionalOuterRadius
                    })
                )
            ),
            h(
                "foreignObject",
                { width: "100%", height: "100%", mask: `url(#${maskId})` },
                h(this.ReactorC, { size, user: props.user, guildId: props.guildId })
            )
        );
    }

    _Reactors(props) {
        const h = this._h.bind(this);
        const count = props.count;
        const users = props.users || [];
        const max = props.max;
        const size = props.size;
        const overlap = props.overlap;
        const spacing = props.spacing;
        const channel = props.channel;
        const guildId = channel && channel.guild_id;

        const validUsers = users.filter(user => user && typeof user === "object" && (
            user.id || user.username || user.globalName || user.global_name || user.avatar || user.avatarURL || user.getAvatarURL
        ));
        this.diag.data.invalidUsersSkipped += users.length - validUsers.length;
        const totalCount = Math.max(0, Number(count) || 0);
        const usersShown = Math.min(max, validUsers.length, totalCount || validUsers.length);
        const hasMoreUsers = totalCount > usersShown;
        const userSummary = validUsers.slice(0, usersShown);

        const makeMoreBadge = remaining => h(
            "div",
            {
                key: "more",
                className: "bd-who-reacted__more-reactors",
                title: `${remaining} more reactor${remaining === 1 ? "" : "s"}`,
                "aria-label": `${remaining} more reactor${remaining === 1 ? "" : "s"}`,
                style: {
                    height: `${size}px`,
                    minWidth: `${size}px`,
                    padding: `0 ${Math.max(3, size * 0.22)}px`,
                    borderRadius: `${size / 2}px`,
                    fontSize: `${Math.max(9, size * 0.44)}px`
                }
            },
            `+${remaining}`
        );

        // Store/user resolution can be temporarily empty even while the
        // native pill still has a positive count. Never render an empty img
        // placeholder in that state; keep the information as a count badge.
        if (userSummary.length === 0 && totalCount > 0) {
            return h("div", { className: "bd-who-reacted__reactors" }, [makeMoreBadge(totalCount)]);
        }

        const children = userSummary.map((user, index) => {
            const isLast = index === usersShown - 1;
            return isLast
                ? h(this.ReactorC, { key: user.id || index, size, user, guildId })
                : h(this.MaskedReactorC, { key: user.id || index, size, user, guildId, overlap, spacing });
        });

        if (hasMoreUsers) {
            children.push(makeMoreBadge(totalCount - usersShown));
        }

        if (children.length === 0) return null;

        return h("div", { className: "bd-who-reacted__reactors" }, children);
    }

    _useSettings() {
        const self = this;
        // Faux "store" for our settings emitter. IMPORTANT: always consumed
        // via our OWN _manualUseStateFromStores — Discord's real
        // useStateFromStores expects Flux stores (addReactChangeListener,
        // getDispatchToken, ...) and would throw on this object. The alias
        // methods below are defense in depth only.
        const fauxStore = this._settingsFauxStore || (this._settingsFauxStore = {
            addChangeListener: (cb) => self.listeners.add(cb),
            removeChangeListener: (cb) => self.listeners.delete(cb),
            addReactChangeListener: (cb) => self.listeners.add(cb),
            removeReactChangeListener: (cb) => self.listeners.delete(cb)
        });

        return this._manualUseStateFromStores([fauxStore], () => ({
            settings: self.settings,
            defaults: self.defaults
        }), []);
    }

    _reactionKey(channelId, messageId, emoji, type) {
        return `${channelId || ""}:${messageId || ""}:${emoji && (emoji.id || emoji.name) || ""}:${type || 0}`;
    }

    _effectiveReactionCount(message, emoji, type, suppliedCount, knownUsersCount) {
        const direct = Number(suppliedCount);
        if (Number.isFinite(direct) && direct > 0) return direct;

        try {
            const reactions = Array.isArray(message && message.reactions)
                ? message.reactions
                : message && message.reactions && typeof message.reactions.toArray === "function"
                    ? message.reactions.toArray()
                    : [];
            const match = reactions.find(reaction => {
                const reactionEmoji = reaction && reaction.emoji;
                if (!reactionEmoji || !emoji) return false;
                if (emoji.id || reactionEmoji.id) return String(emoji.id || "") === String(reactionEmoji.id || "");
                return String(emoji.name || "") === String(reactionEmoji.name || "");
            });
            if (match) {
                const details = match.count_details || match.countDetails;
                const typed = Number(type) === 1
                    ? Number(details && (details.burst ?? details.super))
                    : Number(details && details.normal);
                if (Number.isFinite(typed) && typed > 0) return typed;
                const total = Number(match.count);
                if (Number.isFinite(total) && total > 0) return total;
            }
        } catch (err) { /* fall back to known user count */ }

        return Math.max(0, Number(knownUsersCount) || 0);
    }

    _cacheReactionUsers(key, users) {
        if (!key || !Array.isArray(users) || users.length === 0) return;
        this.reactionUsersCache.delete(key);
        this.reactionUsersCache.set(key, { users: users.slice(), timestamp: Date.now() });
        while (this.reactionUsersCache.size > this.reactionUsersCacheMax) {
            this.reactionUsersCache.delete(this.reactionUsersCache.keys().next().value);
        }
        this.diag.data.reactionCacheEntries = this.reactionUsersCache.size;
    }

    _getCachedReactionUsers(key) {
        const entry = this.reactionUsersCache.get(key);
        if (!entry) return [];
        if (Date.now() - entry.timestamp > this.reactionUsersCacheTtl) {
            this.reactionUsersCache.delete(key);
            this.diag.data.reactionCacheEntries = this.reactionUsersCache.size;
            return [];
        }
        this.diag.data.reactionCacheHits++;
        return entry.users;
    }

    // Top level component rendered for every reaction pill, regardless of
    // which injection strategy placed it. Encapsulates threshold logic,
    // filters, live store subscriptions, and rendering.
    _WhoReactedReactors(props) {
        const self = this;
        const h = this._h.bind(this);
        const message = props.message;
        const emoji = props.emoji;
        const count = props.count;
        const type = props.type;

        // RULES OF HOOKS: every hook below runs unconditionally, in the same
        // order, on every render. All early-return conditions are evaluated
        // only AFTER the last hook call.

        const { settings } = this._useSettings();

        const ChannelStore = this.mods.ChannelStore;
        const ReactionStore = this.mods.ReactionStore;
        const UserStore = this.mods.UserStore;
        const RelationshipStore = this.mods.RelationshipStore;
        const useStateFromStores = this.mods.useStateFromStores;

        let channelId = null;
        try {
            if (message) {
                channelId = typeof message.getChannelId === "function" ? message.getChannelId() : message.channel_id;
            }
        } catch (err) { /* ignore */ }

        const messageId = message ? message.id : null;

        const channel = useStateFromStores(
            [ChannelStore],
            () => {
                try { return channelId ? ChannelStore.getChannel(channelId) : null; } catch (err) { return null; }
            },
            [channelId]
        );

        const rawUsers = useStateFromStores(
            [ReactionStore],
            () => {
                if (!channelId || !messageId || !emoji) return [];
                let reactions = {};
                try {
                    // Historical signature: (channelId, messageId, emoji, limit, type)
                    // Call defensively with all args; extras are harmless if unused.
                    reactions = ReactionStore.getReactions(channelId, messageId, emoji, 100, type) || {};
                } catch (err) {
                    self._logError("ReactionStore.getReactions threw:", err);
                }
                let list = [];
                if (reactions instanceof Map) {
                    list = Array.from(reactions.entries(), ([id, value]) => {
                        if (value && typeof value === "object" && value.id) return value;
                        return UserStore.getUser(id);
                    }).filter(Boolean);
                } else if (Array.isArray(reactions)) {
                    list = reactions.map(value => typeof value === "string" ? UserStore.getUser(value) : value).filter(Boolean);
                } else if (reactions && typeof reactions === "object") {
                    list = Object.entries(reactions).map(([id, value]) => {
                        if (value && typeof value === "object" && value.id) return value;
                        return UserStore.getUser(id);
                    }).filter(Boolean);
                }
                self.diag.data.getReactionsCalls++;
                self.diag.data.lastReactionsCount = list.length;
                self._saveDiag(false);
                return list;
            },
            [channelId, messageId, emoji && emoji.name, emoji && emoji.id, type]
        );

        // Keep the last confirmed result beyond a single React root's
        // lifetime so Discord's virtualized pill replacement cannot flash
        // the avatars away while MessageReactionsStore briefly reports empty.
        const reactionKey = self._reactionKey(channelId, messageId, emoji, type);
        if (rawUsers.length > 0) self._cacheReactionUsers(reactionKey, rawUsers);
        const stableRawUsers = rawUsers.length > 0 ? rawUsers : self._getCachedReactionUsers(reactionKey);
        const effectiveCount = self._effectiveReactionCount(message, emoji, type, count, stableRawUsers.length);
        self.diag.data.lastEffectiveCount = effectiveCount;

        // Discord does NOT populate MessageReactionsStore until something
        // requests the reactor list (normally hovering the reaction
        // tooltip). If the store came back empty, actively request it:
        // prefer Discord's own fetchReactions action; else fall back to a
        // manual REST fetch + MESSAGE_REACTION_ADD_USERS dispatch (the
        // approach proven by Vencord's whoReacted). Deduped per reaction.
        BdApi.React.useEffect(() => {
            if (!message || !emoji) return;
            if (rawUsers.length > 0) return;
            if (!channelId || !messageId) return;

            const dedupeKey = `${channelId}:${messageId}:${emoji && (emoji.id || emoji.name)}:${type || 0}`;
            if (self.requestedFetches.has(dedupeKey)) return;
            self.requestedFetches.add(dedupeKey);

            self._enqueueRestFetch(channelId, messageId, emoji, type);
        }, [channelId, messageId, rawUsers.length]);

        // ---- all hooks are done; conditions may return early from here ----

        function isThresholdDisabled(threshold) {
            return threshold === 0 || threshold == null;
        }

        function shouldHide() {
            try {
                if (!isThresholdDisabled(settings.emojiThreshold)) {
                    if (message && Array.isArray(message.reactions) && message.reactions.length > settings.emojiThreshold) {
                        return true;
                    }
                }
                if (!isThresholdDisabled(settings.reactionsTotalThreshold)) {
                    if (message && Array.isArray(message.reactions)) {
                        const total = message.reactions.reduce((sum, r) => sum + (r && r.count ? r.count : 0), 0);
                        if (total > settings.reactionsTotalThreshold) return true;
                    }
                }
                if (!isThresholdDisabled(settings.reactionsPerEmojiThreshold)) {
                    if (message && Array.isArray(message.reactions)) {
                        for (const r of message.reactions) {
                            if (r && r.count > settings.reactionsPerEmojiThreshold) return true;
                        }
                    }
                }
            } catch (err) {
                self._logError("Error evaluating hide thresholds:", err);
            }
            return false;
        }

        if (!message || !emoji || shouldHide()) {
            return null;
        }

        let users = stableRawUsers;

        if (settings.hideSelf && UserStore) {
            try {
                const currentUser = UserStore.getCurrentUser();
                if (currentUser) users = users.filter(u => u && u.id !== currentUser.id);
            } catch (err) { /* ignore */ }
        }

        if (settings.hideBots) {
            users = users.filter(u => u && !u.bot);
        }

        if (settings.hideBlocked && RelationshipStore) {
            try {
                users = users.filter(u => u && !RelationshipStore.isBlocked(u.id));
            } catch (err) { /* ignore */ }
        }

        return h(this.ReactorsC, {
            count: effectiveCount,
            channel: channel || {},
            users,
            max: settings.max,
            size: settings.avatarSize,
            overlap: settings.avatarOverlap / 100,
            spacing: settings.avatarSpacing / 100
        });
    }

    _renderReactorsElement(message, emoji, count, type) {
        // this.RootC is a stable reference created once in the constructor,
        // so React preserves component state across re-renders instead of
        // remounting a fresh anonymous component every time.
        return this._h(this.RootC, { message, emoji, count, type });
    }

    /* ------------------------------------------------------------------ *
     *  Strategy A: patch the Reaction component
     * ------------------------------------------------------------------ */

    _tryStrategyA() {
        const candidates = this._getStrategyACandidates();

        for (const candidate of candidates) {
            let located = null;
            try {
                located = candidate();
            } catch (err) {
                this._logError(`Strategy A candidate "${candidate.label || "?"}" threw during lookup:`, err);
            }

            if (!located) continue;

            const patched = this._patchLocatedComponent(located);
            if (patched) {
                BdApi.Logger.info(this.name, `Strategy A: patched via candidate "${located.label}".`);
                this.diag.strategyA.candidateMatched = located.label;
                return true;
            }
        }

        return false;
    }

    _getStrategyACandidates() {
        const Webpack = BdApi.Webpack;
        const Filters = Webpack.Filters;
        const self = this;

        const candidates = [];

        // 1. Original heuristic: component whose .type stringifies with a
        // recognizable prop name. May still work on some builds.
        candidates.push(() => {
            const mod = Webpack.getModule(
                m => m && m.type && typeof m.type.toString === "function" && m.type.toString().includes("burstReactionsEnabled"),
                { searchExports: true }
            );
            if (!mod) return null;
            return self._describeLocated(mod, "burstReactionsEnabled heuristic (legacy)");
        });

        // 2. Data-driven list of source-string candidates for the reaction
        // pill component. Each is tried via byStrings + searchExports.
        const sourceStringSets = [
            ["useReactionTooltip"],
            ["reactionTooltip"],
            ["isBurstReaction"],
            ["reaction.emoji", "onContextMenu"],
            [".burst", "reaction"]
        ];

        for (const strings of sourceStringSets) {
            candidates.push(() => {
                let mod = null;
                try {
                    mod = Webpack.getModule(Filters.byStrings.apply(Filters, strings), { searchExports: true });
                } catch (err) {
                    return null;
                }
                if (!mod) return null;
                return self._describeLocated(mod, `byStrings(${strings.join(",")})`);
            });

            // Also try getBySource / getWithKey if the harness exposes them.
            candidates.push(() => {
                if (typeof Webpack.getBySource !== "function") return null;
                let mod = null;
                try {
                    mod = Webpack.getBySource(strings[0]);
                } catch (err) {
                    return null;
                }
                if (!mod) return null;
                return self._describeLocated(mod, `getBySource(${strings[0]})`);
            });
        }

        return candidates;
    }

    // Normalizes a located module value into {value, container, key, label}
    // where `container[key] === value` when we have enough information to
    // patch it directly, otherwise we patch `value` (or `value.type`) itself.
    _describeLocated(value, label) {
        return { value, label };
    }

    _patchLocatedComponent(located) {
        const value = located.value;
        const label = located.label;
        const self = this;

        const afterHandler = (thisObj, args, returnValue) => {
            return self._handlePatchedRender(thisObj, args, returnValue);
        };

        try {
            if (typeof value === "function") {
                // A bare function export (resolved via searchExports) can only
                // be intercepted by patching the property on its owning
                // module's exports object — patching a throwaway wrapper
                // object would never fire since nothing calls through it.
                // Succeed ONLY if we can locate and patch the real export
                // slot; otherwise report failure so the next candidate (or
                // Strategy B) gets a chance.
                const ownerPatched = this._patchOwningModuleExport(value, afterHandler);
                if (ownerPatched) {
                    this.unpatchFns.push(ownerPatched);
                    return true;
                }
                return false;
            }

            if (value && typeof value === "object" && typeof value.type === "function") {
                const unpatch = BdApi.Patcher.after(this.name, value, "type", afterHandler);
                this.unpatchFns.push(unpatch);
                return true;
            }

            if (value && typeof value === "object" && typeof value.render === "function") {
                const unpatch = BdApi.Patcher.after(this.name, value, "render", afterHandler);
                this.unpatchFns.push(unpatch);
                return true;
            }
        } catch (err) {
            this._logError(`Failed to patch candidate "${label}":`, err);
        }

        return false;
    }

    // Best-effort: re-resolve the raw module wrapper so we can patch the
    // actual exports object property (needed for Patcher.after to intercept
    // calls made via `exports.X(...)` from other modules).
    _patchOwningModuleExport(fnValue, afterHandler) {
        try {
            const Webpack = BdApi.Webpack;
            const raw = Webpack.getModule(m => {
                if (!m) return false;
                for (const key of Object.keys(m)) {
                    if (m[key] === fnValue) return true;
                }
                return false;
            }, { raw: true });

            if (!raw || !raw.exports) return null;

            for (const key of Object.keys(raw.exports)) {
                if (raw.exports[key] === fnValue) {
                    return BdApi.Patcher.after(this.name, raw.exports, key, afterHandler);
                }
            }
        } catch (err) {
            // Non-fatal; returning null makes the caller treat this
            // candidate as failed so other candidates / Strategy B can run.
        }
        return null;
    }

    _handlePatchedRender(thisObj, args, returnValue) {
        try {
            this.diag.strategyA.handlerFires++;
            const props = (args && args[0]) || (thisObj && thisObj.props) || null;
            let message, emoji, count, type;

            if (props && props.message && props.emoji) {
                ({ message, emoji, count, type } = props);
            } else {
                // Try to find reaction-shaped props deeper in the arguments.
                const found = BdApi.Utils.findInTree(args, n => n && n.message && n.emoji, {
                    walkable: ["props", "children"],
                    maxProperties: 50
                });
                if (found) {
                    ({ message, emoji, count, type } = found);
                }
            }

            if (!message || !emoji) {
                // Can't identify what reaction this is; leave render untouched.
                return returnValue;
            }

            const reactorsElement = this._renderReactorsElement(message, emoji, count, type);
            const injected = this._instrumentTree(returnValue, reactorsElement, 10);

            if (injected) {
                this.injectionSuccessCount++;
                this.diag.strategyA.injectionSuccesses++;
                this._saveDiag(false);
            } else {
                this.diag.strategyA.injectionFailures++;
                this._logError("Strategy A: located component but could not find an injection point in its render tree.");
            }
        } catch (err) {
            this._logError("Error while handling patched render:", err);
        }

        return returnValue;
    }

    // Generic, non-fixed-index tree walker that finds a place to append our
    // element. Mirrors the *shape* of the original's manual traversal
    // (tooltip render-prop -> popout render-prop -> children array) but
    // discovers each step dynamically instead of hardcoding indices.
    _instrumentTree(node, element, depth) {
        if (depth <= 0 || node == null || typeof node !== "object") return false;

        if (Array.isArray(node)) {
            for (const child of node) {
                if (this._instrumentTree(child, element, depth - 1)) return true;
            }
            return false;
        }

        if (!node.props) return false;

        const children = node.props.children;

        if (typeof children === "function") {
            const original = children;
            const self = this;
            node.props.children = function (...cbArgs) {
                const result = original.apply(this, cbArgs);
                const injected = self._instrumentTree(result, element, depth - 1);
                if (!injected) {
                    self._appendFallback(result, element);
                }
                return result;
            };
            return true; // handled lazily when the render-prop is invoked
        }

        if (Array.isArray(children)) {
            children.push(element);
            return true;
        }

        if (children && typeof children === "object") {
            return this._instrumentTree(children, element, depth - 1);
        }

        return false;
    }

    _appendFallback(result, element) {
        try {
            if (Array.isArray(result)) {
                result.push(element);
                return true;
            }
            if (result && result.props) {
                if (Array.isArray(result.props.children)) {
                    result.props.children.push(element);
                    return true;
                }
                if (result.props.children != null && typeof result.props.children !== "function") {
                    result.props.children = [result.props.children, element];
                    return true;
                }
            }
        } catch (err) {
            this._logError("Fallback append failed:", err);
        }
        return false;
    }

    // Watchdog for Strategy A false positives: a candidate may patch a
    // component that never renders (or that we can't inject into). If
    // reaction pills are visibly on screen but our patch has never
    // successfully injected, abandon Strategy A and switch to Strategy B.
    _startStrategyAWatchdog() {
        this.watchdogChecks = 0;
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
        }

        this.watchdogTimer = setInterval(() => {
            try {
                this.watchdogChecks++;

                if (!this.started || this.strategy !== "A") {
                    clearInterval(this.watchdogTimer);
                    this.watchdogTimer = null;
                    return;
                }

                if (this.injectionSuccessCount > 0) {
                    // Strategy A is demonstrably working; stop checking.
                    clearInterval(this.watchdogTimer);
                    this.watchdogTimer = null;
                    return;
                }

                const pillOnScreen = document.querySelector('[class*="reactions_"] [class*="reaction_"]');

                if (pillOnScreen) {
                    // Pills exist but our patch never injected: false positive.
                    BdApi.Logger.warn(
                        this.name,
                        "Strategy A watchdog: reaction pills are on screen but the patched component never injected; switching to strategy B."
                    );
                    clearInterval(this.watchdogTimer);
                    this.watchdogTimer = null;
                    // Our patches only target the (mis-identified) reaction
                    // component, so removing them all is safe.
                    try { BdApi.Patcher.unpatchAll(this.name); } catch (err) { /* ignore */ }
                    this.strategy = "B";
                    this.diag.strategy = "B (watchdog fallback)";
                    this._saveDiag(true);
                    this._startStrategyB();
                    return;
                }

                if (this.watchdogChecks >= 3) {
                    // No pills ever appeared while we were watching; nothing
                    // to conclude. Stop the watchdog and leave Strategy A in
                    // place (it may still work when pills first render).
                    clearInterval(this.watchdogTimer);
                    this.watchdogTimer = null;
                }
            } catch (err) {
                this._logError("Strategy A watchdog check failed:", err);
            }
        }, 10000);
    }

    /* ------------------------------------------------------------------ *
     *  Strategy B: DOM injection via MutationObserver + fiber walk
     * ------------------------------------------------------------------ */

    _startStrategyB() {
        const root = document.querySelector("#app-mount") || document.body;
        if (!root) {
            this._logError("Strategy B: could not find an app root to observe.");
            return;
        }

        this.observer = new MutationObserver(this._onMutations);
        this.observer.observe(root, { childList: true, subtree: true });

        // Initial sweep of anything already on screen.
        this._scanForPills(root);
    }

    _onMutations(mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                this._scanForPills(node);
            }
            for (const node of mutation.removedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                this._cleanupRemovedPills(node);
            }
        }
    }

    _scanForPills(root) {
        try {
            const pills = new Set();
            if (root.matches && this._isReactionPillCandidate(root)) pills.add(root);
            if (root.querySelectorAll) {
                root.querySelectorAll('button[class*="reaction"], [role="button"][class*="reaction"]').forEach(el => pills.add(el));
            }
            for (const pill of pills) {
                this._injectIntoPill(pill);
            }
        } catch (err) {
            this._logError("Error scanning for reaction pills:", err);
        }
    }

    _isReactionPillCandidate(element) {
        if (!(element instanceof HTMLElement)) return false;
        if (element.classList.contains("bd-who-reacted__container")) return false;
        const className = typeof element.className === "string" ? element.className : "";
        const isButton = element.tagName === "BUTTON" || element.getAttribute("role") === "button";
        return isButton && className.toLowerCase().includes("reaction");
    }

    _cleanupRemovedPills(root) {
        try {
            for (const [el, frameId] of Array.from(this.pillRetryFrames.entries())) {
                if (root === el || (root.contains && root.contains(el))) {
                    cancelAnimationFrame(frameId);
                    this.pillRetryFrames.delete(el);
                }
            }
            for (const [el, entry] of Array.from(this.domRoots.entries())) {
                if (root === el || (root.contains && root.contains(el))) {
                    this._teardownDomEntry(entry);
                    this.domRoots.delete(el);
                }
            }
        } catch (err) {
            this._logError("Error cleaning up removed pills:", err);
        }
    }

    _schedulePillRetry(pillEl, attempt) {
        if (!this.started || !pillEl || !pillEl.isConnected || attempt > 8) return;
        if (this.pillRetryFrames.has(pillEl)) return;
        const frameId = requestAnimationFrame(() => {
            this.pillRetryFrames.delete(pillEl);
            if (this.started && pillEl.isConnected) this._injectIntoPill(pillEl, attempt);
        });
        this.pillRetryFrames.set(pillEl, frameId);
    }

    _teardownDomEntry(entry) {
        try {
            if (entry.root && typeof entry.root.unmount === "function") {
                entry.root.unmount();
            } else if (BdApi.ReactDOM && typeof BdApi.ReactDOM.unmountComponentAtNode === "function") {
                BdApi.ReactDOM.unmountComponentAtNode(entry.container);
            }
        } catch (err) {
            this._logError("Error unmounting DOM root:", err);
        }
        try {
            if (entry.container && entry.container.parentNode) {
                entry.container.parentNode.removeChild(entry.container);
            }
            if (entry.pillEl) entry.pillEl.classList.remove("bd-who-reacted__pill");
        } catch (err) {
            /* ignore */
        }
    }

    _injectIntoPill(pillEl, retryAttempt = 0) {
        if (!pillEl) return;

        if (retryAttempt === 0 && this.pillRetryFrames.has(pillEl)) {
            cancelAnimationFrame(this.pillRetryFrames.get(pillEl));
            this.pillRetryFrames.delete(pillEl);
        }

        if (retryAttempt === 0) this.diag.strategyB.pillsSeen++;

        let props = null;
        let internalInstance = null;
        try {
            internalInstance = BdApi.ReactUtils.getInternalInstance(pillEl);
            props = this._findReactionPropsInFiber(internalInstance, 25);
        } catch (err) {
            this._logError("Strategy B: fiber walk failed:", err);
        }

        if (!props || !props.message || !props.emoji) {
            this.diag.strategyB.fiberPropsMissing++;
            // Capture the actual props shape ONCE for a sample pill so the
            // on-disk diagnostics reveal what the fiber really contains.
            if (!this.diag.strategyB.sampleFiberPropKeys && internalInstance) {
                this.diag.strategyB.sampleFiberPropKeys = this._sampleFiberPropKeys(internalInstance);
            }
            this._saveDiag(false);
            this._schedulePillRetry(pillEl, retryAttempt + 1);
            return;
        }

        this.diag.strategyB.fiberPropsFound++;

        let channelId = null;
        try {
            channelId = typeof props.message.getChannelId === "function"
                ? props.message.getChannelId()
                : props.message.channel_id;
        } catch (err) { /* keep null */ }
        const reactionKey = this._reactionKey(channelId, props.message.id, props.emoji, props.type);
        const existing = this.domRoots.get(pillEl);
        if (existing && existing.reactionKey === reactionKey) return;
        if (existing) {
            this._teardownDomEntry(existing);
            this.domRoots.delete(pillEl);
        }

        // A previous hot-reload may have left a container outside this
        // instance's bookkeeping. Remove it before mounting the fresh root.
        const staleContainer = pillEl.querySelector(".bd-who-reacted__container");
        if (staleContainer) staleContainer.remove();

        const container = document.createElement("span");
        container.className = "bd-who-reacted__container";
        // Keep the avatars in the pill's horizontal flex row. The companion
        // class removes Discord's compact-width/overflow constraints so the
        // avatars stay to the right instead of wrapping onto the next line.
        pillEl.classList.add("bd-who-reacted__pill");
        pillEl.appendChild(container);

        const element = this._renderReactorsElement(props.message, props.emoji, props.count, props.type);

        let root = null;
        try {
            if (BdApi.ReactDOM && typeof BdApi.ReactDOM.createRoot === "function") {
                root = BdApi.ReactDOM.createRoot(container);
                root.render(element);
            } else if (BdApi.ReactDOM && typeof BdApi.ReactDOM.render === "function") {
                BdApi.ReactDOM.render(element, container);
            } else {
                this._logError("Strategy B: no usable ReactDOM render API found.");
                container.remove();
                return;
            }
            this.diag.strategyB.rendersOk++;
            this._saveDiag(false);
        } catch (err) {
            this.diag.strategyB.renderErrors++;
            this._logError("Strategy B: failed to render into pill:", err);
            container.remove();
            return;
        }

        this.domRoots.set(pillEl, { root, container, pillEl, reactionKey });
    }

    // Locates the pill's inner flex-row wrapper (emoji + count row) so the
    // injected avatars sit horizontally next to the count. Fallback chain:
    // 1. [class*="reactionInner"]
    // 2. first child element containing both an emoji image (img/picture)
    //    and some text (the count)
    // 3. the deepest single-wrapper chain child of the pill
    // 4. the pill itself
    _findPillInnerWrapper(pillEl) {
        try {
            const byClass = pillEl.querySelector('[class*="reactionInner"]');
            if (byClass) return byClass;

            for (const child of pillEl.children) {
                const hasEmoji = !!child.querySelector("img, picture");
                const hasText = (child.textContent || "").trim().length > 0;
                if (hasEmoji && hasText) return child;
            }

            // Deepest single-wrapper chain: pill > wrapper > wrapper > ...
            let node = pillEl;
            let depth = 0;
            while (node.children.length === 1 && depth < 5) {
                node = node.children[0];
                depth++;
            }
            if (node !== pillEl) return node;
        } catch (err) { /* fall through */ }

        return pillEl;
    }

    // Walks up from the pill's fiber collecting the prop KEYS at each level
    // (values omitted) — enough to see the actual component prop shape from
    // the saved diagnostics without console access.
    _sampleFiberPropKeys(fiber) {
        const samples = [];
        try {
            let node = fiber;
            let depth = 0;
            while (node && depth < 12 && samples.length < 6) {
                const props = node.memoizedProps || node.pendingProps;
                if (props && typeof props === "object" && !Array.isArray(props)) {
                    const keys = Object.keys(props).slice(0, 15);
                    if (keys.length) samples.push({ depth, keys });
                }
                node = node.return;
                depth++;
            }
        } catch (err) { /* best effort */ }
        return samples;
    }

    _findReactionPropsInFiber(fiber, maxDepth) {
        let node = fiber;
        let depth = 0;

        while (node && depth < maxDepth) {
            const props = node.memoizedProps || node.pendingProps;
            if (props && props.message && props.emoji) {
                return {
                    message: props.message,
                    emoji: props.emoji,
                    count: props.count == null ? 0 : props.count,
                    type: props.type == null ? 0 : props.type
                };
            }
            if (props && props.message && props.reaction && props.reaction.emoji) {
                return {
                    message: props.message,
                    emoji: props.reaction.emoji,
                    count: props.reaction.count == null ? 0 : props.reaction.count,
                    type: props.type == null ? (props.reaction.type || 0) : props.type
                };
            }
            node = node.return;
            depth++;
        }

        return null;
    }

    /* ------------------------------------------------------------------ *
     *  Settings panel
     * ------------------------------------------------------------------ */

    _buildSettingsPanelViaBdApi() {
        const self = this;

        const pctMarker = v => `${Number(v).toFixed(2)}%`;
        const pxMarker = v => `${v}px`;
        const thresholdMarker = v => {
            if (v === 0) return "Off";
            if (v >= 1000) return `${v / 1000}k`;
            return `${v}`;
        };

        const settingsSchema = [
            {
                type: "category",
                id: "appearance",
                name: "Appearance",
                collapsible: false,
                settings: [
                    {
                        type: "slider",
                        id: "max",
                        name: "Maximum Avatars",
                        note: "Sets the maximum number of avatars shown per emoji.",
                        value: self.settings.max,
                        min: 1,
                        max: 20,
                        step: 1,
                        onChange: v => self.updateSetting("max", v)
                    },
                    {
                        type: "slider",
                        id: "avatarSize",
                        name: "Avatar Size",
                        note: "Sets the size of the avatars.",
                        value: self.settings.avatarSize,
                        min: 8,
                        max: 48,
                        step: 1,
                        markers: [8, 12, 16, 20, 24, 32, 40, 48],
                        onMarkerRender: pxMarker,
                        onChange: v => self.updateSetting("avatarSize", v)
                    },
                    {
                        type: "slider",
                        id: "avatarOverlap",
                        name: "Avatar Overlap",
                        note: "Sets how much an avatar covers the previous one.",
                        value: self.settings.avatarOverlap,
                        min: 0,
                        max: 100,
                        step: 1,
                        onMarkerRender: pctMarker,
                        onChange: v => self.updateSetting("avatarOverlap", v)
                    },
                    {
                        type: "slider",
                        id: "avatarSpacing",
                        name: "Avatar Spacing",
                        note: "Sets the gap between two avatars.",
                        value: self.settings.avatarSpacing,
                        min: 0,
                        max: 50,
                        step: 1,
                        onMarkerRender: pctMarker,
                        onChange: v => self.updateSetting("avatarSpacing", v)
                    }
                ]
            },
            {
                type: "category",
                id: "thresholds",
                name: "Thresholds",
                collapsible: false,
                settings: [
                    {
                        type: "slider",
                        id: "emojiThreshold",
                        name: "Emoji Threshold",
                        note: "Hides the reactors when the number of distinct emoji reactions exceeds the threshold. 0 disables this.",
                        value: self.settings.emojiThreshold,
                        min: 0,
                        max: 20,
                        step: 1,
                        onMarkerRender: thresholdMarker,
                        onChange: v => self.updateSetting("emojiThreshold", v)
                    },
                    {
                        type: "slider",
                        id: "reactionsTotalThreshold",
                        name: "Reactions Total Threshold",
                        note: "Hides the reactors when the sum of all reaction counts exceeds the threshold. 0 disables this.",
                        value: self.settings.reactionsTotalThreshold,
                        min: 0,
                        max: 10000,
                        step: 10,
                        onMarkerRender: thresholdMarker,
                        onChange: v => self.updateSetting("reactionsTotalThreshold", v)
                    },
                    {
                        type: "slider",
                        id: "reactionsPerEmojiThreshold",
                        name: "Reactions per Emoji Threshold",
                        note: "Hides the reactors when a single emoji's reaction count exceeds the threshold. 0 disables this.",
                        value: self.settings.reactionsPerEmojiThreshold,
                        min: 0,
                        max: 500,
                        step: 5,
                        onMarkerRender: thresholdMarker,
                        onChange: v => self.updateSetting("reactionsPerEmojiThreshold", v)
                    }
                ]
            },
            {
                type: "category",
                id: "filters",
                name: "Filters",
                collapsible: false,
                settings: [
                    {
                        type: "switch",
                        id: "hideSelf",
                        name: "Hide Self",
                        value: self.settings.hideSelf,
                        onChange: v => self.updateSetting("hideSelf", v)
                    },
                    {
                        type: "switch",
                        id: "hideBots",
                        name: "Hide Bots",
                        value: self.settings.hideBots,
                        onChange: v => self.updateSetting("hideBots", v)
                    },
                    {
                        type: "switch",
                        id: "hideBlocked",
                        name: "Hide Blocked Users",
                        value: self.settings.hideBlocked,
                        onChange: v => self.updateSetting("hideBlocked", v)
                    }
                ]
            }
        ];

        return BdApi.UI.buildSettingsPanel({
            settings: settingsSchema,
            onChange: (categoryOrId, idOrValue, maybeValue) => {
                // Different BD versions call onChange with slightly different
                // arities; handle both (id, value) and (category, id, value).
                try {
                    if (maybeValue !== undefined) {
                        self.updateSetting(idOrValue, maybeValue);
                    } else {
                        self.updateSetting(categoryOrId, idOrValue);
                    }
                } catch (err) {
                    self._logError("Settings onChange handler failed:", err);
                }
            }
        });
    }

    _buildFallbackSettingsPanel() {
        const self = this;
        const panel = document.createElement("div");
        panel.style.display = "flex";
        panel.style.flexDirection = "column";
        panel.style.gap = "16px";
        panel.style.color = "var(--text-normal)";

        const addSlider = (label, id, min, max, step) => {
            const wrap = document.createElement("div");
            const title = document.createElement("div");
            title.textContent = `${label}: `;
            title.style.fontWeight = "600";
            title.style.marginBottom = "4px";

            const valueSpan = document.createElement("span");
            valueSpan.textContent = String(self.settings[id]);
            title.appendChild(valueSpan);

            const input = document.createElement("input");
            input.type = "range";
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(self.settings[id]);
            input.style.width = "100%";
            input.addEventListener("input", () => {
                const value = Number(input.value);
                valueSpan.textContent = String(value);
                self.updateSetting(id, value);
            });

            wrap.appendChild(title);
            wrap.appendChild(input);
            panel.appendChild(wrap);
        };

        const addSwitch = (label, id) => {
            const wrap = document.createElement("label");
            wrap.style.display = "flex";
            wrap.style.alignItems = "center";
            wrap.style.gap = "8px";

            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = !!self.settings[id];
            input.addEventListener("change", () => {
                self.updateSetting(id, input.checked);
            });

            const span = document.createElement("span");
            span.textContent = label;

            wrap.appendChild(input);
            wrap.appendChild(span);
            panel.appendChild(wrap);
        };

        addSlider("Maximum Avatars", "max", 1, 20, 1);
        addSlider("Avatar Size", "avatarSize", 8, 48, 1);
        addSlider("Avatar Overlap (%)", "avatarOverlap", 0, 100, 1);
        addSlider("Avatar Spacing (%)", "avatarSpacing", 0, 50, 1);
        addSlider("Emoji Threshold (0 = off)", "emojiThreshold", 0, 20, 1);
        addSlider("Reactions Total Threshold (0 = off)", "reactionsTotalThreshold", 0, 10000, 10);
        addSlider("Reactions per Emoji Threshold (0 = off)", "reactionsPerEmojiThreshold", 0, 500, 5);
        addSwitch("Hide Self", "hideSelf");
        addSwitch("Hide Bots", "hideBots");
        addSwitch("Hide Blocked Users", "hideBlocked");

        return panel;
    }
};
