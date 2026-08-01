/**
 * @name WhoReacted
 * @author Fokiiiiiii (modernized rewrite), jaimeadf (original)
 * @authorId 0
 * @description Shows the avatars of the users who reacted next to each reaction pill on messages. Modernized rewrite of the original WhoReacted plugin (webpack+JSX build) to work with current Discord using resilient module discovery and DOM/MutationObserver injection, in a self-contained plain-JS build (no bundler, no ZeresPluginLibrary).
 * @version 1.0.4
 * @authorLink https://github.com/Fokiiiiiii
 * @source https://github.com/Fokiiiiiii/WhoReacted
 * @website https://github.com/Fokiiiiiii/WhoReacted
 * @updateUrl https://raw.githubusercontent.com/Fokiiiiiii/WhoReacted/main/WhoReacted.plugin.js
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

        this.strategy = null; // always "B" (DOM/MutationObserver injection)
        this.observer = null;
        this.domRoots = new Map(); // element -> {root, container}
        this.scanFrameId = null;
        this.pendingScanRoots = new Set();
        this.pendingCleanupRoots = new Set();
        this.pillRetryFrames = new Map(); // element -> requestAnimationFrame id
        this.maxPillRetries = 2;
        this.reactionUsersCache = new Map(); // reaction key -> {users, timestamp}
        this.reactionUsersCacheTtl = 60 * 1000;
        this.reactionUsersCacheMax = 100;
        this.reactionUsersCacheUserMax = 12;

        this.started = false;

        // On-disk diagnostics. Persisted (throttled) to
        // plugins/WhoReacted.config.json under the "diagnostics" key so it
        // can be inspected from the filesystem without console access.
        this.diag = {
            pluginVersion: this.meta.version || null,
            bdVersion: null,
            updates: 0,
            lastUpdate: null,
            strategy: null,
            fallbacksUsed: [],
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
        if (this.started) return;

        const showFailure = (message) => {
            try {
                if (typeof BdApi !== "undefined" && BdApi.UI && typeof BdApi.UI.showToast === "function") {
                    BdApi.UI.showToast(message, { type: "error" });
                }
            } catch (err) {
                this._logError("Failed to show startup error:", err);
            }
        };

        try {
            this._loadSettings();
            this._injectStyles();

            if (!this._resolveModules()) {
                this._removeStyles();
                this._logError("Aborting start(): one or more critical modules could not be resolved.");
                showFailure("WhoReacted: failed to initialize (missing modules). See console for details.");
                return;
            }

            this.started = true;
            this.strategy = "B";

            if (!this._startStrategyB()) {
                this.started = false;
                this.strategy = null;
                this._removeStyles();
                this._logError("Aborting start(): DOM/Fiber injection could not be initialized.");
                showFailure("WhoReacted: failed to initialize the reaction view.");
                return;
            }

            try {
                this.diag.bdVersion = (typeof BdApi !== "undefined" && BdApi.version) || null;
                this.diag.strategy = this.strategy;
                this._logStartupSummary();
                this._saveDiag(true);
            } catch (err) {
                this._logError("Failed to record startup diagnostics:", err);
            }
        } catch (err) {
            this.started = false;
            this._logError("Unexpected error during start():", err);
            this._removeStyles();
            showFailure(`WhoReacted: failed to start (${err && err.message ? err.message : err})`);
        }
    }

    stop() {
        this.started = false;

        try {
            if (typeof BdApi !== "undefined" && BdApi.Patcher && typeof BdApi.Patcher.unpatchAll === "function") {
                BdApi.Patcher.unpatchAll(this.name);
            }
        } catch (err) {
            this._logError("Error while unpatching:", err);
        }

        try {
            if (this.observer) this.observer.disconnect();
        } catch (err) {
            this._logError("Error disconnecting observer:", err);
        }
        this.observer = null;
        this.observedRoot = null;

        try {
            if (this.scanFrameId !== null && typeof cancelAnimationFrame === "function") {
                cancelAnimationFrame(this.scanFrameId);
            }
        } catch (err) {
            this._logError("Error cancelling scan frame:", err);
        }
        this.scanFrameId = null;
        this.pendingScanRoots.clear();
        this.pendingCleanupRoots.clear();

        for (const [, entry] of Array.from(this.domRoots.entries())) {
            this._teardownDomEntry(entry);
        }
        this.domRoots.clear();

        for (const frameId of this.pillRetryFrames.values()) {
            try {
                if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
            } catch (err) {
                this._logError("Error cancelling pill retry:", err);
            }
        }
        this.pillRetryFrames.clear();

        try {
            this._removeStyles();
        } catch (err) {
            this._logError("Error removing styles:", err);
        }

        if (this._diagSaveTimer) {
            clearTimeout(this._diagSaveTimer);
            this._diagSaveTimer = null;
        }

        this.reactionUsersCache.clear();
        this.mods = {};
        this.strategy = null;
        try { this._saveDiag(true); } catch (err) { /* best effort */ }
    }

    getSettingsPanel() {
        if (!this.settings) this._loadSettings();

        try {
            if (typeof BdApi !== "undefined" && BdApi.UI && typeof BdApi.UI.buildSettingsPanel === "function") {
                return this._buildSettingsPanelViaBdApi();
            }
        } catch (err) {
            this._logError("buildSettingsPanel failed, falling back to manual panel:", err);
        }

        try {
            return this._buildFallbackSettingsPanel();
        } catch (err) {
            this._logError("Fallback settings panel failed:", err);
            return null;
        }
    }

    /* ------------------------------------------------------------------ *
     *  Settings persistence + pub/sub
     * ------------------------------------------------------------------ */

    // Clamps/coerces settings loaded from disk to the ranges the settings
    // panel actually allows, so a corrupted or hand-edited settings file
    // can't push out-of-range values into rendering.
    _normalizeSettings(raw) {
        const s = Object.assign({}, this.defaults, raw && typeof raw === "object" ? raw : {});
        const clamp = (value, min, max, fallback) => {
            const n = Number(value);
            return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
        };
        const booleanValue = (value, fallback) => {
            if (value === true || value === 1 || value === "1" || value === "true") return true;
            if (value === false || value === 0 || value === "0" || value === "false" || value == null) return false;
            return fallback;
        };

        s.max = clamp(s.max, 1, 20, this.defaults.max);
        s.avatarSize = clamp(s.avatarSize, 8, 48, this.defaults.avatarSize);
        s.avatarOverlap = clamp(s.avatarOverlap, 0, 100, this.defaults.avatarOverlap);
        s.avatarSpacing = clamp(s.avatarSpacing, 0, 50, this.defaults.avatarSpacing);
        s.emojiThreshold = clamp(s.emojiThreshold, 0, 20, this.defaults.emojiThreshold);
        s.reactionsTotalThreshold = clamp(s.reactionsTotalThreshold, 0, 10000, this.defaults.reactionsTotalThreshold);
        s.reactionsPerEmojiThreshold = clamp(s.reactionsPerEmojiThreshold, 0, 500, this.defaults.reactionsPerEmojiThreshold);
        s.hideSelf = booleanValue(s.hideSelf, this.defaults.hideSelf);
        s.hideBots = booleanValue(s.hideBots, this.defaults.hideBots);
        s.hideBlocked = booleanValue(s.hideBlocked, this.defaults.hideBlocked);

        return s;
    }

    _loadSettings() {
        let saved = null;
        try {
            if (typeof BdApi !== "undefined" && BdApi.Data && typeof BdApi.Data.load === "function") {
                saved = BdApi.Data.load(this.name, "settings");
            }
        } catch (err) {
            this._logError("Failed to load settings:", err);
        }
        this.settings = this._normalizeSettings(saved);
    }

    _saveSettings() {
        try {
            if (typeof BdApi !== "undefined" && BdApi.Data && typeof BdApi.Data.save === "function") {
                BdApi.Data.save(this.name, "settings", this.settings);
            }
        } catch (err) {
            this._logError("Failed to save settings:", err);
        }
    }

    updateSetting(name, value) {
        if (!Object.prototype.hasOwnProperty.call(this.defaults, name)) return;
        const next = Object.assign({}, this.settings || this.defaults, { [name]: value });
        this.settings = this._normalizeSettings(next);
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
     *  Module resolution
     * ------------------------------------------------------------------ */

    _resolveModules() {
        const api = typeof BdApi !== "undefined" ? BdApi : null;
        const Webpack = api && api.Webpack;
        const Filters = Webpack && Webpack.Filters;

        if (!Webpack || !Filters || typeof Webpack.getModule !== "function") {
            this._logError("Discord Webpack API is unavailable.");
            return false;
        }

        const fallbacksUsed = [];
        let criticalMissing = false;

        const getFilterByKeys = keys => {
            try {
                if (typeof Filters.byKeys === "function") return Filters.byKeys(...keys);
                if (typeof Filters.byProps === "function") return Filters.byProps(...keys);
            } catch (err) {
                this._logError("Module filter failed:", err);
            }
            return null;
        };

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
                    const filter = getFilterByKeys(fallbackKeys);
                    if (filter) {
                        mod = Webpack.getModule(filter);
                        if (mod) via = `key fallback (${fallbackKeys.join(",")})`;
                    }
                } catch (err) {
                    this._logError(`Module lookup for ${label} threw:`, err);
                }
            }

            const valid = mod && fallbackKeys.some(key => typeof mod[key] === "function");
            if (!valid) {
                this._logError(`Failed to resolve ${label}.`);
                if (critical) criticalMissing = true;
                return null;
            }

            if (via && via !== "getStore") fallbacksUsed.push(`${label} via ${via}`);
            return mod;
        };

        this.mods.ReactionStore = resolveStore("ReactionStore", "MessageReactionsStore", ["getReactions"], true);
        this.mods.UserStore = resolveStore("UserStore", "UserStore", ["getUser", "getCurrentUser"], true);
        this.mods.ChannelStore = resolveStore("ChannelStore", "ChannelStore", ["getChannel"], true);
        this.mods.RelationshipStore = resolveStore("RelationshipStore", "RelationshipStore", ["isBlocked"], false);

        try {
            const filter = typeof Filters.byStrings === "function"
                ? Filters.byStrings("useStateFromStores")
                : null;
            const candidate = filter
                ? Webpack.getModule(filter, { searchExports: true })
                : null;
            this.mods.useStateFromStores = typeof candidate === "function"
                ? candidate
                : (candidate && typeof candidate.default === "function" ? candidate.default : null);
        } catch (err) {
            this._logError("Lookup of useStateFromStores threw:", err);
            this.mods.useStateFromStores = null;
        }

        if (!this.mods.useStateFromStores) {
            fallbacksUsed.push("useStateFromStores via manual Flux subscription hook");
            this.mods.useStateFromStores = this._manualUseStateFromStores.bind(this);
        }

        this._fallbacksUsed = fallbacksUsed;
        this.diag.fallbacksUsed = fallbacksUsed;
        return !criticalMissing;
    }

    _manualUseStateFromStores(stores, getState, deps) {
        const React = BdApi.React;
        const [state, setState] = React.useState(() => {
            try { return getState(); } catch (err) { return null; }
        });

        React.useEffect(() => {
            let disposed = false;
            const onChange = () => {
                if (disposed) return;
                try {
                    setState(getState());
                } catch (err) {
                    this._logError("Store selector threw:", err);
                }
            };

            const cleanups = [];
            for (const store of Array.isArray(stores) ? stores : []) {
                if (!store) continue;

                const pairs = [
                    ["addChangeListener", "removeChangeListener"],
                    ["addReactChangeListener", "removeReactChangeListener"]
                ];
                for (const [addName, removeName] of pairs) {
                    if (typeof store[addName] !== "function" || typeof store[removeName] !== "function") continue;
                    try {
                        store[addName](onChange);
                        cleanups.push(() => store[removeName](onChange));
                    } catch (err) {
                        this._logError(`Failed to subscribe to ${addName}:`, err);
                    }
                    break;
                }
            }

            onChange();
            return () => {
                disposed = true;
                for (const cleanup of cleanups) {
                    try { cleanup(); } catch (err) { this._logError("Failed to unsubscribe store:", err); }
                }
            };
        }, Array.isArray(deps) ? deps : []);

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

    _removeStyles() {
        try {
            if (typeof BdApi !== "undefined" && BdApi.DOM && typeof BdApi.DOM.removeStyle === "function") {
                BdApi.DOM.removeStyle(this.name);
            }
        } catch (err) {
            this._logError("Failed to remove styles:", err);
        }
    }

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
    margin-left: 4px;
    padding: 0;
    border-radius: 0;
    background: transparent;
    border: 0;
    box-shadow: none;
    max-height: 100%;
    pointer-events: auto;
    cursor: default;
}

.bd-who-reacted__pill {
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center !important;
    width: auto !important;
    max-width: none !important;
    overflow: visible !important;
}


`;
        if (typeof BdApi !== "undefined" && BdApi.DOM && typeof BdApi.DOM.addStyle === "function") {
            BdApi.DOM.addStyle(this.name, css);
        }
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

    // message.reactions is a plain array on most builds, but some Discord
    // versions expose a Collection-like object instead — normalize both
    // shapes so callers never have to special-case it.
    _reactionsArray(message) {
        if (!message || !message.reactions) return [];
        if (Array.isArray(message.reactions)) return message.reactions;
        if (typeof message.reactions.toArray === "function") return message.reactions.toArray();
        return [];
    }

    _exceedsReactionThresholds(message) {
        const settings = this.settings || this.defaults;
        const reactions = this._reactionsArray(message);

        if (settings.emojiThreshold && reactions.length > settings.emojiThreshold) {
            return true;
        }

        if (settings.reactionsTotalThreshold) {
            const total = reactions.reduce((sum, reaction) => sum + (reaction && reaction.count ? reaction.count : 0), 0);
            if (total > settings.reactionsTotalThreshold) return true;
        }

        if (settings.reactionsPerEmojiThreshold) {
            for (const reaction of reactions) {
                if (reaction && reaction.count > settings.reactionsPerEmojiThreshold) return true;
            }
        }

        return false;
    }

    _effectiveReactionCount(message, emoji, type, suppliedCount, knownUsersCount) {
        const direct = Number(suppliedCount);
        if (Number.isFinite(direct) && direct > 0) return direct;

        try {
            const reactions = this._reactionsArray(message);
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
        const userLimit = Math.max(1, Math.min(
            this.reactionUsersCacheUserMax,
            Number(this.settings?.max) || this.defaults.max
        ));
        this.reactionUsersCache.set(key, { users: users.slice(0, userLimit), timestamp: Date.now() });
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
    _readReactionUsers(channelId, messageId, emoji, type) {
        const ReactionStore = this.mods.ReactionStore;
        const UserStore = this.mods.UserStore;
        if (
            !ReactionStore ||
            typeof ReactionStore.getReactions !== "function" ||
            !UserStore ||
            typeof UserStore.getUser !== "function" ||
            !channelId ||
            !messageId ||
            !emoji
        ) return [];

        let reactions = null;
        try {
            reactions = ReactionStore.getReactions(channelId, messageId, emoji, 100, type) || {};
        } catch (err) {
            this._logError("ReactionStore.getReactions threw:", err);
            return [];
        }

        const users = [];
        const seen = new Set();
        const addUser = (id, value) => {
            let user = value && typeof value === "object" && value.id ? value : null;
            if (!user) {
                try { user = UserStore.getUser(id); } catch (err) { user = null; }
            }
            if (!user || !user.id || seen.has(user.id)) return;
            seen.add(user.id);
            users.push(user);
        };

        try {
            if (reactions instanceof Map) {
                for (const [id, value] of reactions.entries()) addUser(id, value);
            } else if (Array.isArray(reactions)) {
                for (const value of reactions) addUser(typeof value === "string" ? value : value && value.id, value);
            } else if (reactions && typeof reactions === "object") {
                for (const [id, value] of Object.entries(reactions)) addUser(id, value);
            }
        } catch (err) {
            this._logError("Failed to normalize reaction users:", err);
        }

        const maxUsers = Math.max(
            1,
            Math.min(50, Number(this.settings?.max) || this.defaults.max)
        );
        const result = users.slice(0, maxUsers);
        this.diag.data.getReactionsCalls++;
        this.diag.data.lastReactionsCount = result.length;
        this._saveDiag(false);
        return result;
    }

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
        const hideByThreshold = self._exceedsReactionThresholds(message);

        const channel = useStateFromStores(
            [ChannelStore],
            () => {
                try { return channelId ? ChannelStore.getChannel(channelId) : null; } catch (err) { return null; }
            },
            [channelId]
        );

        const rawUsersState = useStateFromStores(
            [ReactionStore],
            () => hideByThreshold ? [] : self._readReactionUsers(channelId, messageId, emoji, type),
            [hideByThreshold, channelId, messageId, emoji && emoji.name, emoji && emoji.id, type]
        );
        const rawUsers = Array.isArray(rawUsersState) ? rawUsersState : [];

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
        // tooltip). No internal module could be identified that reliably
        // triggers this fetch without risking a crash (see _resolveModules
        // history), so until then this shows a "+N" count badge instead of
        // avatars for reactions the store hasn't been asked about yet.

        // ---- all hooks are done; conditions may return early from here ----

        if (!message || !emoji || hideByThreshold) {
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
     *  Strategy B: DOM injection via MutationObserver + fiber walk
     * ------------------------------------------------------------------ */

    _startStrategyB() {
        if (typeof document === "undefined" || typeof MutationObserver !== "function") {
            this._logError("Strategy B: DOM APIs are unavailable.");
            return false;
        }

        const root = document.querySelector("#app-mount") || document.body;
        if (!root) {
            this._logError("Strategy B: could not find an app root to observe.");
            return false;
        }

        try {
            this.observer = new MutationObserver(this._onMutations);
            this.observer.observe(root, { childList: true, subtree: true });
            this.observedRoot = root;
            this._queueScanRoot(root);
            return true;
        } catch (err) {
            this._logError("Strategy B: failed to observe app root:", err);
            this.observer = null;
            this.observedRoot = null;
            return false;
        }
    }

    _queueScanRoot(root) {
        if (!root || root.nodeType !== 1) return;

        for (const queuedRoot of this.pendingScanRoots) {
            if (queuedRoot === root || (queuedRoot.contains && queuedRoot.contains(root))) return;
            if (root.contains && root.contains(queuedRoot)) {
                this.pendingScanRoots.delete(queuedRoot);
            }
        }

        this.pendingScanRoots.add(root);
        this._scheduleScan();
    }

    _queueCleanupRoot(root) {
        if (!root || root.nodeType !== 1) return;

        for (const queuedRoot of this.pendingCleanupRoots) {
            if (queuedRoot === root || (queuedRoot.contains && queuedRoot.contains(root))) return;
            if (root.contains && root.contains(queuedRoot)) {
                this.pendingCleanupRoots.delete(queuedRoot);
            }
        }

        this.pendingCleanupRoots.add(root);
        this._scheduleScan();
    }

    _scheduleScan() {
        if (this.scanFrameId !== null || typeof requestAnimationFrame !== "function") return;

        this.scanFrameId = requestAnimationFrame(() => {
            this.scanFrameId = null;
            const roots = Array.from(this.pendingScanRoots);
            const cleanupRoots = Array.from(this.pendingCleanupRoots);
            this.pendingScanRoots.clear();
            this.pendingCleanupRoots.clear();

            if (!this.started) return;

            for (const root of cleanupRoots) {
                if (!root.isConnected) this._cleanupRemovedPills(root);
            }
            this._pruneDomRoots();

            for (const root of roots) {
                if (root.isConnected) this._scanForPills(root);
            }
        });
    }

    _pruneDomRoots() {
        for (const [pillEl, entry] of Array.from(this.domRoots.entries())) {
            if (pillEl.isConnected && entry.container && entry.container.isConnected) continue;
            this._teardownDomEntry(entry);
            this.domRoots.delete(pillEl);
        }
    }

    _onMutations(mutations) {
        if (!this.started) return;

        for (const mutation of mutations || []) {
            for (const node of mutation.addedNodes || []) {
                if (node && node.nodeType === 1) this._queueScanRoot(node);
            }
            for (const node of mutation.removedNodes || []) {
                if (node && node.nodeType === 1) this._queueCleanupRoot(node);
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
        if (
            !this.started ||
            !pillEl ||
            !pillEl.isConnected ||
            attempt > this.maxPillRetries ||
            typeof requestAnimationFrame !== "function"
        ) return;
        if (this.pillRetryFrames.has(pillEl)) return;

        const frameId = requestAnimationFrame(() => {
            this.pillRetryFrames.delete(pillEl);
            if (this.started && pillEl.isConnected) this._injectIntoPill(pillEl, attempt);
        });
        this.pillRetryFrames.set(pillEl, frameId);
    }

    _teardownDomEntry(entry) {
        if (!entry) return;

        try {
            if (entry.root && typeof entry.root.unmount === "function") {
                entry.root.unmount();
            } else if (
                typeof BdApi !== "undefined" &&
                BdApi.ReactDOM &&
                typeof BdApi.ReactDOM.unmountComponentAtNode === "function"
            ) {
                BdApi.ReactDOM.unmountComponentAtNode(entry.container);
            }
        } catch (err) {
            this._logError("Error unmounting DOM root:", err);
        }

        try {
            if (entry.container && entry.container.parentNode) {
                entry.container.parentNode.removeChild(entry.container);
            }
        } catch (err) {
            this._logError("Error removing DOM root:", err);
        }

        try {
            if (entry.pillEl && entry.pillEl.classList) {
                entry.pillEl.classList.remove("bd-who-reacted__pill");
            }
        } catch (err) {
            this._logError("Error restoring reaction pill class:", err);
        }
    }

    _injectIntoPill(pillEl, retryAttempt = 0) {
        if (!pillEl || pillEl.isConnected === false) return;
        if (retryAttempt === 0 && this.pillRetryFrames.has(pillEl)) return;
        if (retryAttempt === 0) this.diag.strategyB.pillsSeen++;

        let props = null;
        let internalInstance = null;
        try {
            if (
                typeof BdApi === "undefined" ||
                !BdApi.ReactUtils ||
                typeof BdApi.ReactUtils.getInternalInstance !== "function"
            ) return;

            internalInstance = BdApi.ReactUtils.getInternalInstance(pillEl);
            props = this._findReactionPropsInFiber(internalInstance, 25);
        } catch (err) {
            this._logError("Strategy B: fiber walk failed:", err);
        }

        if (!props || !props.message || !props.emoji) {
            this.diag.strategyB.fiberPropsMissing++;
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
        } catch (err) {
            channelId = null;
        }

        const reactionKey = this._reactionKey(channelId, props.message.id, props.emoji, props.type);
        const existing = this.domRoots.get(pillEl);

        if (existing && existing.reactionKey === reactionKey && existing.container && existing.container.isConnected !== false) {
            return;
        }

        if (this._exceedsReactionThresholds(props.message)) {
            if (existing) {
                this._teardownDomEntry(existing);
                this.domRoots.delete(pillEl);
            }
            return;
        }

        if (existing) {
            this._teardownDomEntry(existing);
            this.domRoots.delete(pillEl);
        }

        try {
            const staleContainer = pillEl.querySelector && pillEl.querySelector(".bd-who-reacted__container");
            if (staleContainer) this._teardownDomEntry({ container: staleContainer, pillEl });
        } catch (err) {
            this._logError("Strategy B: failed to remove stale container:", err);
        }

        let container = null;
        try {
            if (typeof document === "undefined" || typeof document.createElement !== "function") {
                return;
            }

            container = document.createElement("span");
            container.className = "bd-who-reacted__container";
            pillEl.classList.add("bd-who-reacted__pill");
            pillEl.appendChild(container);

            const element = this._renderReactorsElement(props.message, props.emoji, props.count, props.type);
            const ReactDOM = typeof BdApi !== "undefined" ? BdApi.ReactDOM : null;
            let root = null;

            if (ReactDOM && typeof ReactDOM.createRoot === "function") {
                root = ReactDOM.createRoot(container);
                root.render(element);
            } else if (ReactDOM && typeof ReactDOM.render === "function") {
                ReactDOM.render(element, container);
            } else {
                throw new Error("No usable ReactDOM render API found.");
            }

            this.diag.strategyB.rendersOk++;
            this._saveDiag(false);
            this.domRoots.set(pillEl, { root, container, pillEl, reactionKey });
        } catch (err) {
            this.diag.strategyB.renderErrors++;
            this._logError("Strategy B: failed to render into pill:", err);
            if (container) {
                try { container.remove(); } catch (removeErr) { /* best effort */ }
            }
            try { pillEl.classList.remove("bd-who-reacted__pill"); } catch (classErr) { /* best effort */ }
        }
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
        const limit = Math.max(1, Number(maxDepth) || 25);
        const visited = new Set();

        while (node && depth < limit) {
            if (visited.has(node)) break;
            visited.add(node);

            let props = null;
            try {
                props = node.memoizedProps || node.pendingProps;
            } catch (err) {
                props = null;
            }

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

            try {
                node = node.return;
            } catch (err) {
                node = null;
            }
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
