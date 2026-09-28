/**
 * @name WhoReacted
 * @author Fokiiiiiii (modernized rewrite), jaimeadf (original)
 * @description Shows the avatars of the people who reacted next to each reaction on a message.
 * @version 1.1.0
 * @authorLink https://github.com/Fokiiiiiii
 * @source https://github.com/Fokiiiiiii/WhoReacted
 * @website https://github.com/Fokiiiiiii/WhoReacted
 * @updateUrl https://raw.githubusercontent.com/Fokiiiiiii/WhoReacted/main/WhoReacted.plugin.js
 */

const PILL_SELECTOR = 'button[class*="reaction"], [role="button"][class*="reaction"]';
const CONTAINER_CLASS = "bd-who-reacted__container";
const PILL_CLASS = "bd-who-reacted__pill";
const EMPTY_USERS = Object.freeze([]);

const STRINGS = {
    en: {
        preview: "Preview",
        avatars: "Avatars",
        max: "Avatars per reaction",
        avatarSize: "Size",
        avatarOverlap: "Overlap",
        avatarSpacing: "Gap",
        people: "Hide",
        hideSelf: "Yourself",
        hideBots: "Bots",
        hideBlocked: "Blocked users",
        loading: "Loading",
        autoFetch: "Load reactors automatically",
        autoFetchNote: "Loads who reacted for the reactions on screen, one request at a time, so avatars show without hovering.",
        thresholds: "Messages with many reactions",
        emojiThreshold: "Kinds of emoji",
        emojiThresholdNote: "Hide avatars on messages with more kinds of emoji than this.",
        reactionsTotalThreshold: "Total reactions",
        reactionsTotalThresholdNote: "Hide avatars on messages with more reactions in total than this.",
        reactionsPerEmojiThreshold: "Reactions on one emoji",
        reactionsPerEmojiThresholdNote: "Hide avatars when a single emoji has more reactions than this.",
        off: "Off",
        more: "{n} more",
        startFailed: "WhoReacted could not start because Discord changed. See the console for details.",
        viewFailed: "WhoReacted could not attach to the reactions."
    },
    ja: {
        preview: "プレビュー",
        avatars: "アバター",
        max: "1つのリアクションに表示する数",
        avatarSize: "サイズ",
        avatarOverlap: "重なり",
        avatarSpacing: "すき間",
        people: "表示しない人",
        hideSelf: "自分",
        hideBots: "ボット",
        hideBlocked: "ブロック中のユーザー",
        loading: "読み込み",
        autoFetch: "リアクションした人を自動で読み込む",
        autoFetchNote: "画面に見えているリアクションだけを1件ずつ読み込み、マウスを乗せなくてもアバターを表示します。",
        thresholds: "リアクションが多いメッセージ",
        emojiThreshold: "絵文字の種類",
        emojiThresholdNote: "絵文字の種類がこの数を超えるメッセージではアバターを表示しません。",
        reactionsTotalThreshold: "リアクションの合計",
        reactionsTotalThresholdNote: "リアクションの合計がこの数を超えるメッセージではアバターを表示しません。",
        reactionsPerEmojiThreshold: "1つの絵文字のリアクション数",
        reactionsPerEmojiThresholdNote: "1つの絵文字のリアクションがこの数を超えるとアバターを表示しません。",
        off: "オフ",
        more: "ほか{n}人",
        startFailed: "Discordの変更によりWhoReactedを開始できませんでした。詳細はコンソールを確認してください。",
        viewFailed: "WhoReactedをリアクションに組み込めませんでした。"
    }
};

const sameUsers = (a, b) => a === b || (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((user, index) => user === b[index])
);

module.exports = class WhoReacted {
    constructor() {
        this.name = "WhoReacted";
        this.mods = {};
        this.settings = null;
        this.defaults = {
            max: 6,
            avatarSize: 20,
            avatarOverlap: 33,
            avatarSpacing: 8,
            emojiThreshold: 10,
            reactionsTotalThreshold: 500,
            reactionsPerEmojiThreshold: 100,
            hideSelf: false,
            hideBots: false,
            hideBlocked: false,
            autoFetch: true
        };

        this.started = false;
        this.listeners = new Set();
        this.persistTimer = null;

        this.observer = null;
        this.domRoots = new Map();
        this.scanFrameId = null;
        this.pendingScanRoots = new Set();
        this.pruneRequested = false;
        this.pillRetryFrames = new Map();
        this.ignoredPills = new WeakSet();
        this.maxPillRetries = 2;

        this.reactionUsersCache = new Map();
        this.reactionUsersCacheMax = 100;
        this.reactionUsersCacheUserMax = 20;

        this.fetchInterval = 300;
        this.fetchedKeysMax = 500;
        this.fetchedKeys = new Set();
        this.fetchRequests = new Map();
        this.fetchQueue = [];
        this.fetchBusy = false;
        this.fetchTimer = null;
        this.fetchPausedUntil = 0;
        this.fetchGeneration = 0;
        this.fetchDisabled = false;
        this.visibilityObserver = null;

        this._onMutations = this._onMutations.bind(this);
        this._onConnectionOpen = this._onConnectionOpen.bind(this);

        this.ReactorC = props => this._Reactor(props);
        this.ReactorsC = props => this._Reactors(props);
        this.RootC = props => this._WhoReactedReactors(props);
        this.PreviewC = () => this._SettingsPreview();
    }

    start() {
        if (this.started) return;

        try {
            this._loadSettings();
            this._clearLegacyDiagnostics();

            if (!this._resolveModules()) {
                this._showError(this._t("startFailed"));
                return;
            }

            this._injectStyles();
            this.started = true;

            if (!this._startObserver()) {
                this.stop();
                this._showError(this._t("viewFailed"));
                return;
            }

            this._subscribeConnectionOpen();
            BdApi.Logger.info(this.name, `Started. Automatic reactor loading is ${this._autoFetchAvailable() ? "available" : "unavailable"}.`);
        } catch (err) {
            this._logError("Unexpected error during start():", err);
            this.stop();
            this._showError(this._t("startFailed"));
        }
    }

    stop() {
        this.started = false;
        this.fetchGeneration++;

        if (this.observer) this.observer.disconnect();
        this.observer = null;
        if (this.visibilityObserver) this.visibilityObserver.disconnect();
        this.visibilityObserver = null;

        if (this.scanFrameId !== null) cancelAnimationFrame(this.scanFrameId);
        this.scanFrameId = null;
        this.pendingScanRoots.clear();
        this.pruneRequested = false;
        for (const frameId of this.pillRetryFrames.values()) cancelAnimationFrame(frameId);
        this.pillRetryFrames.clear();

        if (this.fetchTimer !== null) clearTimeout(this.fetchTimer);
        this.fetchTimer = null;
        this.fetchQueue = [];
        this.fetchRequests.clear();
        this.fetchedKeys.clear();
        this.fetchBusy = false;
        this.fetchPausedUntil = 0;
        this.fetchDisabled = false;
        this._unsubscribeConnectionOpen();

        for (const entry of this.domRoots.values()) this._teardownDomEntry(entry);
        this.domRoots.clear();

        if (this.persistTimer !== null) this._persistSettings();
        this._removeStyles();
        this.reactionUsersCache.clear();
        this.mods = {};
    }

    getSettingsPanel() {
        if (!this.settings) this._loadSettings();
        const current = this.settings;
        const t = key => this._t(key);
        const off = { label: t("off"), value: 0 };
        const slider = (id, min, max, step, markers, units, note) => ({
            type: "slider", id, name: t(id), value: current[id], min, max, step, markers,
            ...(units ? { units } : {}),
            ...(note ? { note } : {})
        });
        const toggle = (id, note) => ({ type: "switch", id, name: t(id), value: current[id], ...(note ? { note } : {}) });
        const category = (id, settings, collapsed) => ({
            type: "category", id, name: t(id), collapsible: !!collapsed, shown: !collapsed, settings
        });

        return BdApi.UI.buildSettingsPanel({
            settings: [
                { type: "custom", id: "preview", name: t("preview"), inline: false, children: this._h(this.PreviewC) },
                category("avatars", [
                    slider("max", 1, 20, 1, [1, 5, 10, 15, 20]),
                    slider("avatarSize", 8, 48, 1, [8, 16, 24, 32, 40, 48], "px"),
                    slider("avatarOverlap", 0, 100, 1, [0, 25, 50, 75, 100], "%"),
                    slider("avatarSpacing", 0, 50, 1, [0, 10, 20, 30, 40, 50], "%")
                ]),
                category("people", [toggle("hideSelf"), toggle("hideBots"), toggle("hideBlocked")]),
                category("loading", [toggle("autoFetch", t("autoFetchNote"))]),
                category("thresholds", [
                    slider("emojiThreshold", 0, 20, 1, [off, 5, 10, 15, 20], "", t("emojiThresholdNote")),
                    slider("reactionsTotalThreshold", 0, 10000, 10, [off, 2500, 5000, 7500, 10000], "", t("reactionsTotalThresholdNote")),
                    slider("reactionsPerEmojiThreshold", 0, 500, 5, [off, 100, 200, 300, 400, 500], "", t("reactionsPerEmojiThresholdNote"))
                ], true)
            ],
            onChange: (categoryId, id, value) => this.updateSetting(id, value)
        });
    }

    _t(key, vars) {
        const locale = (document.documentElement && document.documentElement.lang) || navigator.language || "en";
        const table = String(locale).toLowerCase().startsWith("ja") ? STRINGS.ja : STRINGS.en;
        const text = table[key] || STRINGS.en[key] || key;
        return vars ? text.replace(/\{(\w+)\}/g, (match, name) => String(vars[name] ?? "")) : text;
    }

    _SettingsPreview() {
        const h = this._h.bind(this);
        const settings = this._useSettings();
        const currentUser = this.mods.UserStore ? this.mods.UserStore.getCurrentUser() : null;
        const samples = Array.from({ length: 20 }, (_, index) => ({
            id: `preview-${index}`,
            discriminator: String((index % 5) + 1),
            username: `${index + 1}`
        }));
        const users = currentUser ? [currentUser, ...samples.slice(1)] : samples;
        const count = settings.max + 3;

        return h("div", { className: "bd-who-reacted__preview" },
            h("div", { className: "bd-who-reacted__preview-pill" },
                h("span", { "aria-hidden": true }, "👍"),
                h("span", null, String(count)),
                h(this.ReactorsC, {
                    count,
                    users,
                    max: settings.max,
                    size: settings.avatarSize,
                    overlap: settings.avatarOverlap / 100,
                    spacing: settings.avatarSpacing / 100,
                    guildId: null
                })
            )
        );
    }

    updateSetting(id, value) {
        if (!Object.prototype.hasOwnProperty.call(this.defaults, id)) return;
        const current = this.settings || this.defaults;
        const next = this._normalizeSettings({ ...current, [id]: value });
        if (next[id] === current[id]) return;

        this.settings = next;
        this._schedulePersist();
        if (!next.autoFetch) this._clearFetchQueue();
        for (const listener of Array.from(this.listeners)) {
            try {
                listener();
            } catch (err) {
                this._logError("Settings listener threw:", err);
            }
        }
    }

    _normalizeSettings(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const defaults = this.defaults;
        const number = (key, min, max) => {
            const value = Number(source[key]);
            return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : defaults[key];
        };
        const boolean = key => {
            const value = source[key];
            if (value === true || value === 1 || value === "1" || value === "true") return true;
            if (value === false || value === 0 || value === "0" || value === "false") return false;
            return defaults[key];
        };

        return {
            max: number("max", 1, 20),
            avatarSize: number("avatarSize", 8, 48),
            avatarOverlap: number("avatarOverlap", 0, 100),
            avatarSpacing: number("avatarSpacing", 0, 50),
            emojiThreshold: number("emojiThreshold", 0, 20),
            reactionsTotalThreshold: number("reactionsTotalThreshold", 0, 10000),
            reactionsPerEmojiThreshold: number("reactionsPerEmojiThreshold", 0, 500),
            hideSelf: boolean("hideSelf"),
            hideBots: boolean("hideBots"),
            hideBlocked: boolean("hideBlocked"),
            autoFetch: boolean("autoFetch")
        };
    }

    _loadSettings() {
        let saved = null;
        try {
            saved = BdApi.Data.load(this.name, "settings");
        } catch (err) {
            this._logError("Failed to load settings:", err);
        }
        this.settings = this._normalizeSettings(saved);
    }

    _schedulePersist() {
        if (this.persistTimer !== null) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => this._persistSettings(), 300);
    }

    _persistSettings() {
        if (this.persistTimer !== null) clearTimeout(this.persistTimer);
        this.persistTimer = null;
        try {
            BdApi.Data.save(this.name, "settings", this.settings);
        } catch (err) {
            this._logError("Failed to save settings:", err);
        }
    }

    _clearLegacyDiagnostics() {
        try {
            if (BdApi.Data.load(this.name, "diagnostics") !== undefined) {
                BdApi.Data.delete(this.name, "diagnostics");
            }
        } catch (err) {
            this._logError("Failed to remove legacy diagnostics:", err);
        }
    }

    _logError(...parts) {
        try {
            BdApi.Logger.error(this.name, ...parts);
        } catch {}
    }

    _showError(message) {
        try {
            BdApi.UI.showToast(message, { type: "error" });
        } catch (err) {
            this._logError("Failed to show an error toast:", err);
        }
    }

    _resolveModules() {
        const store = (name, methods) => {
            let mod = null;
            try {
                mod = BdApi.Webpack.getStore(name);
            } catch (err) {
                this._logError(`getStore("${name}") threw:`, err);
            }
            return mod && methods.every(method => typeof mod[method] === "function") ? mod : null;
        };

        this.mods.ReactionStore = store("MessageReactionsStore", ["getReactions"]);
        this.mods.UserStore = store("UserStore", ["getUser", "getCurrentUser"]);
        this.mods.ChannelStore = store("ChannelStore", ["getChannel"]);
        this.mods.MessageStore = store("MessageStore", ["getMessage"]);
        this.mods.RelationshipStore = store("RelationshipStore", ["isBlocked"]);
        this.mods.RestAPI = this._findModule(["get", "post", "put", "patch", "del"]);
        this.mods.Dispatcher = this._findModule(["dispatch", "subscribe", "unsubscribe", "register"]);

        const missing = ["ReactionStore", "UserStore", "ChannelStore"].filter(key => !this.mods[key]);
        if (missing.length > 0) {
            this._logError(`Failed to resolve ${missing.join(", ")}.`);
            return false;
        }
        return true;
    }

    _findModule(methods) {
        try {
            return BdApi.Webpack.getModule(
                mod => mod && typeof mod === "object" && methods.every(method => typeof mod[method] === "function"),
                { searchExports: true }
            ) || null;
        } catch (err) {
            this._logError(`Lookup for a module with ${methods.join("/")} threw:`, err);
            return null;
        }
    }

    _subscribeConnectionOpen() {
        const Dispatcher = this.mods.Dispatcher;
        if (!Dispatcher) return;
        try {
            Dispatcher.subscribe("CONNECTION_OPEN", this._onConnectionOpen);
        } catch (err) {
            this._logError("Failed to subscribe to CONNECTION_OPEN:", err);
        }
    }

    _unsubscribeConnectionOpen() {
        const Dispatcher = this.mods.Dispatcher;
        if (!Dispatcher) return;
        try {
            Dispatcher.unsubscribe("CONNECTION_OPEN", this._onConnectionOpen);
        } catch (err) {
            this._logError("Failed to unsubscribe from CONNECTION_OPEN:", err);
        }
    }

    _onConnectionOpen() {
        this.fetchedKeys.clear();
        this.fetchDisabled = false;
    }

    _injectStyles() {
        BdApi.DOM.addStyle(this.name, `
.${CONTAINER_CLASS} {
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
    flex-shrink: 0;
    margin-left: 4px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    max-height: 100%;
    pointer-events: auto;
    cursor: default;
}

.${CONTAINER_CLASS}:empty {
    display: none;
}

.bd-who-reacted__reactors {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
    line-height: 1;
}

.bd-who-reacted__reactors:not(:empty) {
    margin-left: 4px;
}

.bd-who-reacted__reactor-avatar {
    display: block;
    flex-shrink: 0;
    box-sizing: border-box;
    border-radius: 50%;
    border: 1.5px solid var(--background-secondary);
    background-color: #2b2d31;
    object-fit: cover;
    opacity: 1 !important;
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

.${PILL_CLASS} {
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center !important;
    width: auto !important;
    max-width: none !important;
    overflow: visible !important;
}

.bd-who-reacted__preview {
    display: flex;
    align-items: center;
    min-height: 56px;
    padding: 4px 0 8px;
}

.bd-who-reacted__preview-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 8px;
    border: 1px solid var(--border-faint, rgba(255, 255, 255, 0.08));
    background: var(--background-secondary, #2b2d31);
    color: var(--text-normal, #dbdee1);
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
}
`);
    }

    _removeStyles() {
        try {
            BdApi.DOM.removeStyle(this.name);
        } catch (err) {
            this._logError("Failed to remove styles:", err);
        }
    }

    _h(...args) {
        return BdApi.React.createElement(...args);
    }

    _useSettings() {
        const React = BdApi.React;
        const [, setRevision] = React.useState(0);
        React.useEffect(() => {
            const listener = () => setRevision(revision => revision + 1);
            this.listeners.add(listener);
            return () => {
                this.listeners.delete(listener);
            };
        }, []);
        return this.settings || this.defaults;
    }

    _useStoreState(stores, getState, deps, isEqual = Object.is) {
        const React = BdApi.React;
        const read = () => {
            try {
                return getState();
            } catch (err) {
                this._logError("Store selector threw:", err);
                return undefined;
            }
        };
        const [state, setState] = React.useState(read);
        const current = React.useRef(state);

        React.useEffect(() => {
            let active = true;
            const onChange = () => {
                if (!active) return;
                const next = read();
                if (isEqual(current.current, next)) return;
                current.current = next;
                setState(next);
            };

            const cleanups = [];
            for (const store of stores) {
                if (!store) continue;
                const [add, remove] = typeof store.addChangeListener === "function"
                    ? ["addChangeListener", "removeChangeListener"]
                    : ["addReactChangeListener", "removeReactChangeListener"];
                if (typeof store[add] !== "function" || typeof store[remove] !== "function") continue;
                store[add](onChange);
                cleanups.push(() => store[remove](onChange));
            }

            onChange();
            return () => {
                active = false;
                for (const cleanup of cleanups) cleanup();
            };
        }, deps);

        return state;
    }

    _avatarSize(size) {
        const requested = Math.max(16, Number(size) || 20);
        const powers = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
        return powers.find(value => value >= requested) || 4096;
    }

    _defaultAvatarUrl(user) {
        let index = 0;
        try {
            if (user && user.discriminator && user.discriminator !== "0") {
                index = Number(user.discriminator) % 5;
            } else if (user && user.id) {
                index = Number((BigInt(user.id) >> 22n) % 6n);
            }
        } catch {}
        return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    }

    _avatarUrl(user, guildId, size) {
        const cdnSize = this._avatarSize(size);
        let url = null;

        try {
            if (typeof user.getAvatarURL === "function") url = user.getAvatarURL(guildId, cdnSize, false);
        } catch {}

        if (!url && user.id && typeof user.avatar === "string" && user.avatar) {
            url = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=${cdnSize}`;
        }
        if (!url) return this._defaultAvatarUrl(user);

        url = String(url);
        if (url.startsWith("//")) return `https:${url}`;
        if (url.startsWith("/")) return `https://cdn.discordapp.com${url}`;
        return url;
    }

    _userLabel(user) {
        return String(user.globalName || user.global_name || user.displayName || user.username || user.tag || user.id || "Unknown user");
    }

    _avatarMask(size, overlap, spacing) {
        const round = value => Math.round(value * 100) / 100;
        const radius = round((0.5 + spacing) * size);
        const centerX = round((1.5 + spacing - overlap) * size);
        const image = `radial-gradient(circle ${radius}px at ${centerX}px 50%, transparent ${round(Math.max(0, radius - 0.5))}px, #000 ${radius}px)`;
        return { offset: round((overlap - spacing) * size), image };
    }

    _Reactor(props) {
        const { user, size, guildId, mask } = props;
        const fallback = this._defaultAvatarUrl(user);
        const label = this._userLabel(user);

        return this._h("img", {
            className: "bd-who-reacted__reactor-avatar",
            width: size,
            height: size,
            src: this._avatarUrl(user, guildId, size),
            title: label,
            "aria-label": label,
            alt: "",
            loading: "lazy",
            decoding: "async",
            draggable: false,
            style: mask
                ? { marginRight: `${-mask.offset}px`, WebkitMaskImage: mask.image, maskImage: mask.image }
                : undefined,
            onError: event => {
                const image = event.currentTarget;
                if (image && image.src !== fallback) image.src = fallback;
            }
        });
    }

    _Reactors(props) {
        const h = this._h.bind(this);
        const { containerRef, users, size, guildId } = props;
        const total = Math.max(0, Number(props.count) || 0);
        const shown = users.slice(0, Math.min(props.max, total));
        const remaining = total - shown.length;
        const mask = shown.length > 1 ? this._avatarMask(size, props.overlap, props.spacing) : null;

        const children = shown.map((user, index) => h(this.ReactorC, {
            key: user.id,
            user,
            size,
            guildId,
            mask: index < shown.length - 1 ? mask : null
        }));

        if (remaining > 0) {
            const label = this._t("more", { n: remaining });
            children.push(h("div", {
                key: "more",
                className: "bd-who-reacted__more-reactors",
                title: label,
                "aria-label": label,
                style: {
                    height: `${size}px`,
                    minWidth: `${size}px`,
                    padding: `0 ${Math.max(3, size * 0.22)}px`,
                    borderRadius: `${size / 2}px`,
                    fontSize: `${Math.max(9, size * 0.44)}px`
                }
            }, `+${remaining}`));
        }

        if (children.length === 0) return null;
        return h("div", { className: "bd-who-reacted__reactors", ref: containerRef }, children);
    }

    _reactionKey(channelId, messageId, emoji, type) {
        return `${channelId || ""}:${messageId || ""}:${emoji && (emoji.id || emoji.name) || ""}:${type || 0}`;
    }

    _reactionsArray(message) {
        if (!message || !message.reactions) return [];
        if (Array.isArray(message.reactions)) return message.reactions;
        if (typeof message.reactions.toArray !== "function") return [];
        try {
            const reactions = message.reactions.toArray();
            return Array.isArray(reactions) ? reactions : [];
        } catch {
            return [];
        }
    }

    _exceedsReactionThresholds(message, settings) {
        const reactions = this._reactionsArray(message);
        if (settings.emojiThreshold && reactions.length > settings.emojiThreshold) return true;

        if (settings.reactionsTotalThreshold) {
            const total = reactions.reduce((sum, reaction) => sum + (reaction && reaction.count ? reaction.count : 0), 0);
            if (total > settings.reactionsTotalThreshold) return true;
        }

        if (settings.reactionsPerEmojiThreshold) {
            return reactions.some(reaction => reaction && reaction.count > settings.reactionsPerEmojiThreshold);
        }
        return false;
    }

    _reactionCount(message, emoji, type) {
        const match = this._reactionsArray(message).find(reaction => {
            const other = reaction && reaction.emoji;
            if (!other) return false;
            if (emoji.id || other.id) return String(emoji.id || "") === String(other.id || "");
            return String(emoji.name || "") === String(other.name || "");
        });
        if (!match) return null;

        const details = match.count_details || match.countDetails;
        const typed = Number(type) === 1
            ? Number(details && (details.burst ?? details.super))
            : Number(details && details.normal);
        if (Number.isFinite(typed) && typed > 0) return typed;

        const total = Number(match.count);
        return Number.isFinite(total) ? Math.max(0, total) : null;
    }

    _readReactionUsers(channelId, messageId, emoji, type, limit) {
        const { ReactionStore, UserStore } = this.mods;
        let reactions = null;
        try {
            reactions = ReactionStore.getReactions(channelId, messageId, emoji, 100, type);
        } catch (err) {
            this._logError("ReactionStore.getReactions threw:", err);
            return EMPTY_USERS;
        }
        if (!reactions) return EMPTY_USERS;

        const users = [];
        const seen = new Set();
        const add = (id, value) => {
            if (users.length >= limit) return;
            let user = value && typeof value === "object" && value.id ? value : null;
            if (!user) {
                try {
                    user = UserStore.getUser(id);
                } catch {
                    user = null;
                }
            }
            if (!user || !user.id || seen.has(user.id)) return;
            seen.add(user.id);
            users.push(user);
        };

        if (reactions instanceof Map) {
            for (const [id, value] of reactions) add(id, value);
        } else if (Array.isArray(reactions)) {
            for (const value of reactions) add(typeof value === "string" ? value : value && value.id, value);
        } else if (typeof reactions === "object") {
            for (const [id, value] of Object.entries(reactions)) add(id, value);
        }

        return users.length > 0 ? users : EMPTY_USERS;
    }

    _cacheReactionUsers(key, users) {
        this.reactionUsersCache.delete(key);
        this.reactionUsersCache.set(key, users.slice(0, this.reactionUsersCacheUserMax));
        if (this.reactionUsersCache.size > this.reactionUsersCacheMax) {
            this.reactionUsersCache.delete(this.reactionUsersCache.keys().next().value);
        }
    }

    _getCachedReactionUsers(key) {
        return this.reactionUsersCache.get(key) || EMPTY_USERS;
    }

    _filterUsers(users, settings) {
        const { UserStore, RelationshipStore } = this.mods;
        try {
            let result = users;
            if (settings.hideSelf) {
                const currentUser = UserStore.getCurrentUser();
                if (currentUser) result = result.filter(user => user.id !== currentUser.id);
            }
            if (settings.hideBots) result = result.filter(user => !user.bot);
            if (settings.hideBlocked && RelationshipStore) result = result.filter(user => !RelationshipStore.isBlocked(user.id));
            return result;
        } catch (err) {
            this._logError("Failed to filter reactors:", err);
            return users;
        }
    }

    _WhoReactedReactors(props) {
        const React = BdApi.React;
        const { channelId, messageId, emoji, type, fallbackMessage, fallbackCount } = props;
        const { ChannelStore, MessageStore, ReactionStore } = this.mods;
        const settings = this._useSettings();
        const containerRef = React.useRef(null);

        const message = this._useStoreState(
            MessageStore ? [MessageStore] : [],
            () => (MessageStore && MessageStore.getMessage(channelId, messageId)) || fallbackMessage,
            [channelId, messageId, fallbackMessage]
        );
        const channel = this._useStoreState([ChannelStore], () => ChannelStore.getChannel(channelId), [channelId]);

        const hidden = this._exceedsReactionThresholds(message, settings);
        const readLimit = Math.min(100, settings.max * 2);
        const storeUsers = this._useStoreState(
            [ReactionStore],
            () => (hidden ? EMPTY_USERS : this._readReactionUsers(channelId, messageId, emoji, type, readLimit)),
            [hidden, channelId, messageId, emoji.id, emoji.name, type, readLimit],
            sameUsers
        ) || EMPTY_USERS;

        const reactionKey = this._reactionKey(channelId, messageId, emoji, type);
        const matchedCount = this._reactionCount(message, emoji, type);
        const count = matchedCount === null ? Math.max(0, Number(fallbackCount) || 0) : matchedCount;
        const needsFetch = settings.autoFetch && !hidden && count > 0 && storeUsers.length < Math.min(count, settings.max);

        React.useEffect(() => {
            if (storeUsers.length > 0) this._cacheReactionUsers(reactionKey, storeUsers);
        }, [reactionKey, storeUsers]);

        React.useEffect(() => {
            const element = containerRef.current;
            if (!needsFetch || !element) return undefined;
            return this._requestReactors(element, { key: reactionKey, channelId, messageId, emoji, type });
        }, [needsFetch, reactionKey]);

        if (hidden || count <= 0) return null;

        const users = storeUsers.length > 0 ? storeUsers : this._getCachedReactionUsers(reactionKey);
        return this._h(this.ReactorsC, {
            containerRef,
            count,
            users: this._filterUsers(users, settings),
            max: settings.max,
            size: settings.avatarSize,
            overlap: settings.avatarOverlap / 100,
            spacing: settings.avatarSpacing / 100,
            guildId: channel && channel.guild_id
        });
    }

    _autoFetchAvailable() {
        const { RestAPI, Dispatcher, UserStore } = this.mods;
        return !this.fetchDisabled && !!(RestAPI && Dispatcher && UserStore);
    }

    _requestReactors(element, request) {
        if (!this._autoFetchAvailable() || this.fetchedKeys.has(request.key)) return () => {};

        const entry = { ...request, element, visible: false, queued: false };
        this.fetchRequests.set(element, entry);
        this._getVisibilityObserver().observe(element);

        return () => {
            if (this.fetchRequests.get(element) === entry) this.fetchRequests.delete(element);
            if (this.visibilityObserver) this.visibilityObserver.unobserve(element);
            this._dequeue(entry);
        };
    }

    _getVisibilityObserver() {
        if (!this.visibilityObserver) {
            this.visibilityObserver = new IntersectionObserver(
                entries => this._onVisibilityChange(entries),
                { rootMargin: "200px 0px" }
            );
        }
        return this.visibilityObserver;
    }

    _onVisibilityChange(entries) {
        for (const item of entries) {
            const entry = this.fetchRequests.get(item.target);
            if (!entry) continue;
            entry.visible = item.isIntersecting;
            if (entry.visible) this._enqueue(entry);
            else this._dequeue(entry);
        }
        this._pumpQueue();
    }

    _enqueue(entry) {
        if (entry.queued || this.fetchedKeys.has(entry.key)) return;
        entry.queued = true;
        this.fetchQueue.push(entry);
    }

    _dequeue(entry) {
        if (!entry.queued) return;
        entry.queued = false;
        const index = this.fetchQueue.indexOf(entry);
        if (index !== -1) this.fetchQueue.splice(index, 1);
    }

    _clearFetchQueue() {
        for (const entry of this.fetchQueue) entry.queued = false;
        this.fetchQueue = [];
    }

    _markFetched(key) {
        this.fetchedKeys.delete(key);
        this.fetchedKeys.add(key);
        if (this.fetchedKeys.size > this.fetchedKeysMax) {
            this.fetchedKeys.delete(this.fetchedKeys.values().next().value);
        }
    }

    _pumpQueue() {
        if (!this.started || this.fetchBusy || this.fetchTimer !== null || this.fetchQueue.length === 0) return;

        const wait = this.fetchPausedUntil - Date.now();
        if (wait > 0) {
            this.fetchTimer = setTimeout(() => {
                this.fetchTimer = null;
                this._pumpQueue();
            }, wait);
            return;
        }

        let entry = null;
        while (this.fetchQueue.length > 0) {
            const candidate = this.fetchQueue.pop();
            candidate.queued = false;
            if (!this.fetchedKeys.has(candidate.key)) {
                entry = candidate;
                break;
            }
        }
        if (!entry || !this._autoFetchAvailable() || !this.settings.autoFetch) return;
        this._fetchReactors(entry);
    }

    _fetchReactors(entry) {
        const generation = this.fetchGeneration;
        const emojiKey = entry.emoji.id ? `${entry.emoji.name}:${entry.emoji.id}` : entry.emoji.name;
        this.fetchBusy = true;
        this._markFetched(entry.key);

        let request;
        try {
            request = this.mods.RestAPI.get({
                url: `/channels/${entry.channelId}/messages/${entry.messageId}/reactions/${encodeURIComponent(emojiKey)}`,
                query: { limit: 100, type: entry.type },
                oldFormErrors: true
            });
        } catch (err) {
            request = Promise.reject(err);
        }

        Promise.resolve(request).then(response => {
            if (generation !== this.fetchGeneration) return;
            try {
                this._storeFetchedReactors(entry, response);
            } catch (err) {
                this._logError("Failed to store fetched reactors:", err);
            }
        }, error => {
            if (generation !== this.fetchGeneration) return;
            this._handleFetchError(entry, error);
        }).finally(() => {
            if (generation !== this.fetchGeneration) return;
            this.fetchBusy = false;
            this.fetchTimer = setTimeout(() => {
                this.fetchTimer = null;
                this._pumpQueue();
            }, this.fetchInterval);
        });
    }

    _storeFetchedReactors(entry, response) {
        const { Dispatcher, UserStore } = this.mods;
        const users = Array.isArray(response && response.body) ? response.body.filter(user => user && user.id) : [];
        for (const user of users) {
            if (!UserStore.getUser(user.id)) Dispatcher.dispatch({ type: "USER_UPDATE", user });
        }
        Dispatcher.dispatch({
            type: "MESSAGE_REACTION_ADD_USERS",
            channelId: entry.channelId,
            messageId: entry.messageId,
            users,
            emoji: entry.emoji,
            reactionType: entry.type
        });
    }

    _handleFetchError(entry, error) {
        const status = Number(error && error.status);

        if (status === 429) {
            const retryAfter = Number(error.body && error.body.retry_after);
            const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 5000;
            this.fetchPausedUntil = Date.now() + Math.min(60000, Math.max(1000, delay));
            this.fetchedKeys.delete(entry.key);
            if (this.fetchRequests.get(entry.element) === entry && entry.visible) this._enqueue(entry);
            return;
        }

        if (!Number.isFinite(status) || status <= 0) {
            this.fetchDisabled = true;
            this._clearFetchQueue();
            this._logError("Automatic reactor loading stopped after an unexpected error:", error);
            return;
        }

        this._logError(`Failed to load reactors (HTTP ${status}).`);
    }

    _startObserver() {
        const root = document.querySelector("#app-mount") || document.body;
        if (!root) {
            this._logError("Could not find the app root to observe.");
            return false;
        }

        this.observer = new MutationObserver(this._onMutations);
        this.observer.observe(root, { childList: true, subtree: true });
        this.pendingScanRoots.add(root);
        this._scheduleScan();
        return true;
    }

    _onMutations(mutations) {
        if (!this.started) return;

        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1 && !node.closest(`.${CONTAINER_CLASS}`)) this.pendingScanRoots.add(node);
            }
            if (mutation.removedNodes.length > 0) this.pruneRequested = true;
        }

        if (this.pendingScanRoots.size > 0 || this.pruneRequested) this._scheduleScan();
    }

    _scheduleScan() {
        if (this.scanFrameId !== null) return;

        this.scanFrameId = requestAnimationFrame(() => {
            this.scanFrameId = null;
            if (!this.started) return;

            if (this.pruneRequested) {
                this.pruneRequested = false;
                this._pruneDomRoots();
            }

            const pills = new Set();
            for (const root of this.pendingScanRoots) {
                if (!root.isConnected) continue;
                if (root.matches(PILL_SELECTOR)) pills.add(root);
                for (const element of root.querySelectorAll(PILL_SELECTOR)) pills.add(element);
            }
            this.pendingScanRoots.clear();

            for (const pill of pills) this._injectIntoPill(pill, 0);
        });
    }

    _pruneDomRoots() {
        for (const [pill, entry] of this.domRoots) {
            if (pill.isConnected && entry.container.isConnected) continue;
            this._teardownDomEntry(entry);
            this.domRoots.delete(pill);
        }
        for (const [pill, frameId] of this.pillRetryFrames) {
            if (pill.isConnected) continue;
            cancelAnimationFrame(frameId);
            this.pillRetryFrames.delete(pill);
        }
    }

    _schedulePillRetry(pill, attempt) {
        if (this.pillRetryFrames.has(pill)) return;
        const frameId = requestAnimationFrame(() => {
            this.pillRetryFrames.delete(pill);
            if (this.started) this._injectIntoPill(pill, attempt);
        });
        this.pillRetryFrames.set(pill, frameId);
    }

    _teardownDomEntry(entry) {
        try {
            entry.root.unmount();
        } catch (err) {
            this._logError("Failed to unmount reactors:", err);
        }
        entry.container.remove();
        entry.pill.classList.remove(PILL_CLASS);
    }

    _injectIntoPill(pill, attempt) {
        if (!pill.isConnected || this.ignoredPills.has(pill)) return;
        if (attempt === 0 && this.pillRetryFrames.has(pill)) return;

        const existing = this.domRoots.get(pill);
        if (existing) {
            if (existing.container.isConnected && existing.container.parentNode === pill) return;
            this._teardownDomEntry(existing);
            this.domRoots.delete(pill);
        }

        const props = this._readPillProps(pill);
        if (!props) {
            if (attempt >= this.maxPillRetries) this.ignoredPills.add(pill);
            else this._schedulePillRetry(pill, attempt + 1);
            return;
        }

        const message = props.message;
        let channelId = null;
        try {
            channelId = typeof message.getChannelId === "function" ? message.getChannelId() : message.channel_id;
        } catch {}
        if (!channelId || !message.id) {
            this.ignoredPills.add(pill);
            return;
        }

        for (const stale of pill.querySelectorAll(`:scope > .${CONTAINER_CLASS}`)) stale.remove();

        const container = document.createElement("span");
        container.className = CONTAINER_CLASS;
        pill.classList.add(PILL_CLASS);
        pill.appendChild(container);

        try {
            const root = BdApi.ReactDOM.createRoot(container);
            root.render(this._h(this.RootC, {
                channelId,
                messageId: message.id,
                emoji: props.emoji,
                type: props.type,
                fallbackMessage: message,
                fallbackCount: props.count
            }));
            this.domRoots.set(pill, { root, container, pill });
        } catch (err) {
            this._logError("Failed to render reactors into a reaction:", err);
            container.remove();
            pill.classList.remove(PILL_CLASS);
        }
    }

    _readPillProps(pill) {
        try {
            return this._findReactionPropsInFiber(BdApi.ReactUtils.getInternalInstance(pill), 25);
        } catch (err) {
            this._logError("Failed to read reaction props:", err);
            return null;
        }
    }

    _findReactionPropsInFiber(fiber, maxDepth) {
        const visited = new Set();
        let node = fiber;
        let depth = 0;

        while (node && depth < maxDepth && !visited.has(node)) {
            visited.add(node);
            const props = [node.memoizedProps, node.pendingProps].find(candidate =>
                candidate &&
                typeof candidate === "object" &&
                candidate.message &&
                (candidate.emoji || (candidate.reaction && candidate.reaction.emoji))
            );

            if (props && props.emoji) {
                return { message: props.message, emoji: props.emoji, count: props.count ?? 0, type: props.type ?? 0 };
            }
            if (props) {
                return {
                    message: props.message,
                    emoji: props.reaction.emoji,
                    count: props.reaction.count ?? 0,
                    type: props.type ?? props.reaction.type ?? 0
                };
            }

            node = node.return;
            depth++;
        }

        return null;
    }
};
