/**
 * @name WhoReacted
 * @author jaimeadf (original), Fokiiiiiii
 * @authorId 0
 * @description Shows the avatars of users who reacted to a message.
 * @version 1.0.4
 * @source https://github.com/Fokiiiiiii/WhoReacted
 * @website https://github.com/Fokiiiiiii/WhoReacted
 * @updateUrl https://raw.githubusercontent.com/Fokiiiiiii/WhoReacted/main/WhoReacted.plugin.js
 */

module.exports = class WhoReacted {
    constructor(meta) {
        this.meta = meta || {};
        this.name = "WhoReacted";

        this.defaults = {
            max: 6,
            avatarSize: 24,
            avatarOverlap: 100 / 3,
            avatarSpacing: 100 / 12,
            emojiThreshold: 10,
            reactionsTotalThreshold: 500,
            reactionsPerEmojiThreshold: 100,
            hideSelf: false,
            hideBots: false,
            hideBlocked: false
        };
        this.settings = Object.assign({}, this.defaults);
        this.settingsListeners = new Set();
        this.modules = {};
        this.unpatches = [];
        this.started = false;
        this.moduleRetryTimer = null;
        this.moduleRetryAttempts = 0;
        this.moduleRetryLimit = 10;

        this.reactionRevision = 0;
        this.reactionCache = new Map();
        this.reactionCacheTtl = 60 * 1000;
        this.reactionStoreUnsubscribe = null;
        this.maskIdCounter = 0;

        this.ReactorC = props => this._Reactor(props);
        this.MaskedReactorC = props => this._MaskedReactor(props);
        this.ReactorsC = props => this._Reactors(props);
        this.SmartReactorsC = props => this._SmartReactors(props);
    }

    start() {
        this.moduleRetryAttempts = 0;
        this._loadSettings();
        this._injectStyles();
        this.started = true;
        this._startWhenModulesReady();
    }

    _startWhenModulesReady() {
        if (!this.started) return;

        if (!this._resolveModules()) {
            this._scheduleModuleRetry();
            return;
        }

        this.moduleRetryAttempts = 0;
        this._subscribeReactionStore();

        if (!this._patchReaction()) {
            this._scheduleModuleRetry();
        }
    }

    _scheduleModuleRetry() {
        if (!this.started || this.moduleRetryTimer) return;

        if (this.moduleRetryAttempts >= this.moduleRetryLimit) {
            this._failStart("WhoReacted: Discordのリアクションモジュールを取得できませんでした。");
            return;
        }

        this.moduleRetryAttempts++;
        this.moduleRetryTimer = setTimeout(() => {
            this.moduleRetryTimer = null;
            this._startWhenModulesReady();
        }, 500);
    }

    _failStart(message) {
        this.started = false;
        this._unsubscribeReactionStore();
        this._removeStyles();
        this._showToast(message, "error");
    }

    stop() {
        if (this.moduleRetryTimer) {
            clearTimeout(this.moduleRetryTimer);
            this.moduleRetryTimer = null;
        }
        this.moduleRetryAttempts = 0;

        try {
            if (typeof BdApi !== "undefined" && BdApi.Patcher) {
                BdApi.Patcher.unpatchAll(this.name);
            }
        } catch (err) {
            this._log("Failed to unpatch WhoReacted:", err);
        }

        for (const unpatch of this.unpatches.splice(0)) {
            try {
                if (typeof unpatch === "function") unpatch();
            } catch (err) {
                this._log("Failed to remove a WhoReacted patch:", err);
            }
        }

        this._unsubscribeReactionStore();
        this.reactionCache.clear();
        this.started = false;
        this._removeStyles();
    }

    getSettingsPanel() {
        if (!this.settings) this._loadSettings();
        if (typeof BdApi !== "undefined" && BdApi.UI && typeof BdApi.UI.buildSettingsPanel === "function") {
            return this._buildSettingsPanel();
        }
        return this._buildFallbackSettingsPanel();
    }

    _resolveModules() {
        const Webpack = typeof BdApi !== "undefined" && BdApi.Webpack;
        const Filters = Webpack && Webpack.Filters;
        if (!Webpack || !Filters) return false;

        const byKeys = (...keys) => {
            try {
                if (typeof Filters.byKeys === "function") return Filters.byKeys(...keys);
                if (typeof Filters.byProps === "function") return Filters.byProps(...keys);
            } catch (err) {
                this._log("Module filter failed:", err);
            }
            return null;
        };

        const getStore = (name, keys) => {
            let module = null;
            try {
                if (typeof Webpack.getStore === "function") {
                    module = Webpack.getStore(name);
                }
            } catch (err) {
                this._log("Store lookup failed:", name, err);
            }

            if (!module) {
                try {
                    const filter = byKeys(...keys);
                    if (filter) module = Webpack.getModule(filter);
                } catch (err) {
                    this._log("Module lookup failed:", name, err);
                }
            }
            return module;
        };

        this.modules.ReactionStore = getStore("MessageReactionsStore", ["getReactions"]);
        this.modules.ChannelStore = getStore("ChannelStore", ["getChannel", "hasChannel"]);
        this.modules.UserStore = getStore("UserStore", ["getUser", "getCurrentUser"]);
        this.modules.RelationshipStore = getStore("RelationshipStore", ["isBlocked"]);

        try {
            const useStateFilter = typeof Filters.byStrings === "function"
                ? Filters.byStrings("useStateFromStores")
                : null;
            this.modules.useStateFromStores = useStateFilter
                ? Webpack.getModule(useStateFilter, { searchExports: true })
                : null;
        } catch (err) {
            this.modules.useStateFromStores = null;
        }

        this.modules.ConnectedReaction = this._findConnectedReaction(Webpack, Filters);
        this.moduleResolution = {
            reactionStore: Boolean(this.modules.ReactionStore),
            channelStore: Boolean(this.modules.ChannelStore),
            userStore: Boolean(this.modules.UserStore),
            connectedReaction: Boolean(this.modules.ConnectedReaction)
        };

        return Boolean(
            this.modules.ReactionStore &&
            this.modules.ChannelStore &&
            this.modules.UserStore &&
            this.modules.ConnectedReaction &&
            typeof this.modules.ConnectedReaction.type === "function"
        );
    }

    _findConnectedReaction(Webpack, Filters) {
        const normalize = candidate => {
            if (!candidate) return null;
            if (candidate.default) {
                const defaultCandidate = normalize(candidate.default);
                if (defaultCandidate) return defaultCandidate;
            }
            if (candidate.type && typeof candidate.type === "function") {
                return candidate;
            }
            if (typeof candidate === "function" && candidate.prototype?.render) {
                return { type: candidate, direct: true };
            }
            return null;
        };

        const source = candidate => {
            const normalized = normalize(candidate);
            if (!normalized) return "";
            try {
                return String(normalized.type);
            } catch (err) {
                return "";
            }
        };

        const isCandidate = candidate => {
            const normalized = normalize(candidate);
            if (!normalized) return false;
            const text = source(normalized);
            if (!text) return false;
            return text.includes("burstReactionsEnabled") ||
                (/reaction/i.test(text) && /(emoji|tooltip|popout|count)/i.test(text));
        };

        const queries = [
            () => Webpack.getModule(candidate => isCandidate(candidate), { searchExports: true }),
            () => typeof Filters.byStrings === "function"
                ? Webpack.getModule(Filters.byStrings("burstReactionsEnabled"), { searchExports: true })
                : null,
            () => typeof Filters.byStrings === "function"
                ? Webpack.getModule(Filters.byStrings("burstReactions"), { searchExports: true })
                : null,
            () => typeof Filters.byStrings === "function"
                ? Webpack.getModule(Filters.byStrings("reaction", "emoji"), { searchExports: true })
                : null
        ];

        for (const query of queries) {
            try {
                const candidate = normalize(query());
                if (isCandidate(candidate)) return candidate;
            } catch (err) {
                // Discord's module shape changes between builds; try the next resolver.
            }
        }

        return null;
    }

    _patchReaction() {
        const connectedReaction = this.modules.ConnectedReaction;
        const patcher = BdApi.Patcher;
        if (!connectedReaction || !patcher || typeof patcher.after !== "function") return false;

        const patchRenderTarget = target => {
            if (!target || typeof target.render !== "function") return false;
            try {
                const unpatchRender = patcher.after(
                    this.name,
                    target,
                    "render",
                    (thisObject, __, result) => this._appendReactors(thisObject, result)
                );
                if (typeof unpatchRender === "function") this.unpatches.push(unpatchRender);
                return true;
            } catch (err) {
                this._log("Failed to patch reaction render:", err);
                return false;
            }
        };

        const directTarget = connectedReaction.type?.prototype?.render
            ? connectedReaction.type.prototype
            : null;
        if (connectedReaction.direct || directTarget) {
            return Boolean(patchRenderTarget(directTarget || connectedReaction.type.prototype));
        }

        let reactionRenderPatched = false;
        let unpatchConnectedReaction;
        try {
            unpatchConnectedReaction = patcher.after(
                this.name,
                connectedReaction,
                "type",
                (_, __, reaction) => {
                    const target = reaction?.type?.prototype?.render
                        ? reaction.type.prototype
                        : reaction?.prototype?.render
                            ? reaction.prototype
                            : null;
                    if (!target || reactionRenderPatched) return reaction;

                    if (!patchRenderTarget(target)) return reaction;
                    reactionRenderPatched = true;

                    try {
                        unpatchConnectedReaction();
                    } catch (err) {
                        this._log("Failed to remove bootstrap patch:", err);
                    }
                    return reaction;
                }
            );
        } catch (err) {
            this._log("Failed to patch connected reaction:", err);
            return false;
        }

        if (typeof unpatchConnectedReaction === "function") {
            this.unpatches.push(unpatchConnectedReaction);
        }
        return true;
    }

    _appendReactors(instance, result) {
        const props = instance?.props;
        const children = result?.props?.children;
        const tooltipSlot = Array.isArray(children) ? children[0] : null;
        const renderTooltip = tooltipSlot?.props?.children;

        if (!props?.message || !props?.emoji || typeof renderTooltip !== "function") {
            return result;
        }

        tooltipSlot.props.children = tooltipProps => {
            const tooltipChildren = renderTooltip(tooltipProps);
            const tooltipLevel = tooltipChildren?.props?.children;
            const popoutSlot = tooltipLevel?.props?.children;
            const renderPopout = popoutSlot?.props?.children;

            if (!tooltipLevel || !popoutSlot || typeof renderPopout !== "function") {
                return tooltipChildren;
            }

            popoutSlot.props.children = popoutProps => {
                const popoutChildren = renderPopout(popoutProps);
                if (!popoutChildren?.props) return popoutChildren;

                const existingChildren = Array.isArray(popoutChildren.props.children)
                    ? popoutChildren.props.children.slice()
                    : [popoutChildren.props.children].filter(Boolean);
                const key = this._reactionKey(
                    props.message,
                    props.emoji,
                    props.type
                );

                if (!existingChildren.some(child => child?.key === key)) {
                    existingChildren.push(this._h(this.SmartReactorsC, {
                        key,
                        message: props.message,
                        emoji: props.emoji,
                        count: props.count,
                        type: props.type
                    }));
                }

                popoutChildren.props.children = existingChildren;
                return popoutChildren;
            };

            return tooltipChildren;
        };

        return result;
    }

    _subscribeReactionStore() {
        if (this.reactionStoreUnsubscribe) return;
        const store = this.modules.ReactionStore;
        const add = store && (store.addChangeListener || store.addReactChangeListener);
        const remove = store && (store.removeChangeListener || store.removeReactChangeListener);
        if (typeof add !== "function" || typeof remove !== "function") return;

        const listener = () => {
            this.reactionRevision++;
            this.reactionCache.clear();
        };

        try {
            add.call(store, listener);
            this.reactionStoreUnsubscribe = () => remove.call(store, listener);
        } catch (err) {
            this._log("Failed to subscribe to reactions:", err);
        }
    }

    _unsubscribeReactionStore() {
        if (this.reactionStoreUnsubscribe) {
            try {
                this.reactionStoreUnsubscribe();
            } catch (err) {
                this._log("Failed to unsubscribe from reactions:", err);
            }
        }
        this.reactionStoreUnsubscribe = null;
    }

    _useSettings() {
        const React = BdApi.React;
        const [settings, setSettings] = React.useState(() => Object.assign({}, this.settings));

        React.useEffect(() => {
            const listener = () => setSettings(Object.assign({}, this.settings));
            this.settingsListeners.add(listener);
            listener();
            return () => this.settingsListeners.delete(listener);
        }, []);

        return [
            settings,
            this.defaults,
            (name, value) => this.updateSetting(name, value)
        ];
    }

    _useStateFromStores(stores, getState) {
        const hook = this.modules.useStateFromStores;
        if (typeof hook === "function") {
            return hook(stores, getState);
        }
        return this._manualUseStateFromStores(stores, getState);
    }

    _manualUseStateFromStores(stores, getState) {
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
            onChange();

            return () => {
                disposed = true;
                for (const store of stores) {
                    if (store && typeof store.removeChangeListener === "function") {
                        store.removeChangeListener(onChange);
                    }
                }
            };
        }, []);

        return state;
    }

    _SmartReactors({ message, emoji, count, type }) {
        const React = BdApi.React;
        const [settings] = this._useSettings();

        const ReactorsComponent = React.useMemo(() => {
            let component = this.ReactorsC;
            if (settings.hideSelf) component = this._withSelfHidden(component);
            if (settings.hideBots) component = this._withBotsHidden(component);
            if (settings.hideBlocked) component = this._withBlockedHidden(component);
            return this._withStoresConnected(component);
        }, [settings.hideSelf, settings.hideBots, settings.hideBlocked]);

        if (this._shouldHide(message, settings)) return null;

        return this._h(ReactorsComponent, {
            message,
            emoji,
            count,
            type,
            max: settings.max,
            size: settings.avatarSize,
            overlap: settings.avatarOverlap / 100,
            spacing: settings.avatarSpacing / 100
        });
    }

    _withStoresConnected(ReactorsComponent) {
        return props => {
            const message = props.message;
            const channelId = this._getChannelId(message);
            const ChannelStore = this.modules.ChannelStore;
            const channel = this._useStateFromStores(
                [ChannelStore],
                () => {
                    try {
                        return ChannelStore.getChannel(channelId);
                    } catch (err) {
                        return null;
                    }
                }
            );
            const users = this._useStateFromStores(
                [this.modules.ReactionStore],
                () => this._getReactionUsers(message, props.emoji, props.type, props.count)
            );

            return this._h(ReactorsComponent, Object.assign({}, props, {
                channel,
                users
            }));
        };
    }

    _withSelfHidden(ReactorsComponent) {
        return props => {
            const currentUser = this._useStateFromStores(
                [this.modules.UserStore],
                () => this.modules.UserStore.getCurrentUser()
            );
            const currentId = currentUser && currentUser.id;
            return this._h(ReactorsComponent, Object.assign({}, props, {
                users: props.users.filter(user => user && user.id !== currentId)
            }));
        };
    }

    _withBotsHidden(ReactorsComponent) {
        return props => this._h(ReactorsComponent, Object.assign({}, props, {
            users: props.users.filter(user => user && !user.bot)
        }));
    }

    _withBlockedHidden(ReactorsComponent) {
        return props => {
            const relationshipRevision = this._useStateFromStores(
                [this.modules.RelationshipStore],
                () => Date.now()
            );
            const users = BdApi.React.useMemo(() => props.users.filter(user => {
                try {
                    return user && !this.modules.RelationshipStore.isBlocked(user.id);
                } catch (err) {
                    return true;
                }
            }), [props.users, relationshipRevision]);

            return this._h(ReactorsComponent, Object.assign({}, props, { users }));
        };
    }

    _Reactors({ count, channel, users, max, size, overlap, spacing }) {
        const safeUsers = Array.isArray(users) ? users.filter(Boolean) : [];
        const numericCount = Number(count);
        const totalCount = Number.isFinite(numericCount) ? Math.max(0, numericCount) : safeUsers.length;
        const usersShown = Math.min(Math.max(0, Number(max) || 0), safeUsers.length);
        const userSummary = safeUsers.slice(0, usersShown);
        const children = [];

        userSummary.forEach((user, index) => {
            const isLast = index === userSummary.length - 1;
            const props = {
                key: user.id || index,
                size,
                user,
                guildId: channel?.guild_id
            };
            children.push(isLast
                ? this._h(this.ReactorC, props)
                : this._h(this.MaskedReactorC, Object.assign({}, props, { overlap, spacing }))
            );
        });

        const remaining = Math.max(0, totalCount - usersShown);
        if (remaining > 0) {
            children.push(this._h(
                "div",
                {
                    key: "more",
                    className: "bd-who-reacted__more-reactors",
                    style: {
                        height: `${size}px`,
                        minWidth: `${size}px`,
                        padding: `0 ${size / 3}px`,
                        borderRadius: `${size / 2}px`,
                        fontSize: `${size / 2}px`
                    }
                },
                `+${remaining}`
            ));
        }

        if (children.length === 0) return null;
        return this._h("div", { className: "bd-who-reacted__reactors" }, children);
    }

    _Reactor({ user, guildId, size }) {
        let avatarUrl = "";
        try {
            if (user && typeof user.getAvatarURL === "function") {
                avatarUrl = user.getAvatarURL(guildId, size);
            } else if (user && user.avatar && user.id) {
                avatarUrl = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=${size}`;
            } else if (user && user.id) {
                const discriminator = Number(user.discriminator);
                const index = Number.isFinite(discriminator) ? Math.abs(discriminator) % 5 : 0;
                avatarUrl = `https://cdn.discordapp.com/embed/avatars/${index}.png`;
            }
        } catch (err) {
            avatarUrl = "";
        }

        if (!avatarUrl) return null;
        return this._h("img", {
            className: "bd-who-reacted__reactor-avatar",
            width: size,
            height: size,
            src: avatarUrl,
            alt: ""
        });
    }

    _MaskedReactor({ user, guildId, size, overlap, spacing }) {
        const innerRadius = 0.5;
        const outerRadius = innerRadius + spacing;
        const offset = (overlap - spacing) * size;
        const maskId = `bd-who-reacted-mask-${this.maskIdCounter++}`;

        return this._h(
            "svg",
            { style: { marginRight: `${-offset}px` }, width: size, height: size },
            this._h(
                "defs",
                null,
                this._h(
                    "mask",
                    { id: maskId, maskContentUnits: "objectBoundingBox", viewBox: "0 0 1 1" },
                    this._h("rect", { fill: "white", width: "1", height: "1" }),
                    this._h("circle", {
                        fill: "black",
                        cx: 2 * innerRadius + outerRadius - overlap,
                        cy: "0.5",
                        r: outerRadius
                    })
                )
            ),
            this._h(
                "foreignObject",
                { width: "100%", height: "100%", mask: `url(#${maskId})` },
                this._h(this.ReactorC, { size, user, guildId })
            )
        );
    }

    _getReactionUsers(message, emoji, type, count) {
        const channelId = this._getChannelId(message);
        const messageId = message && message.id;
        if (!channelId || !messageId || !emoji) return [];

        const key = this._reactionKey(message, emoji, type);
        const expectedCount = Number(count);
        const normalizedCount = Number.isFinite(expectedCount) ? expectedCount : null;
        const cached = this.reactionCache.get(key);
        if (
            cached &&
            cached.revision === this.reactionRevision &&
            cached.count === normalizedCount &&
            Date.now() - cached.timestamp <= this.reactionCacheTtl
        ) {
            return cached.users;
        }

        let reactions = {};
        try {
            reactions = this.modules.ReactionStore.getReactions(
                channelId,
                messageId,
                emoji,
                100,
                type
            ) || {};
        } catch (err) {
            this._log("getReactions failed:", err);
        }

        let users = [];
        if (reactions instanceof Map) {
            users = Array.from(reactions.entries()).map(([id, user]) => {
                if (user && typeof user === "object" && user.id) return user;
                return this.modules.UserStore.getUser(id);
            });
        } else if (Array.isArray(reactions)) {
            users = reactions.map(user => typeof user === "string"
                ? this.modules.UserStore.getUser(user)
                : user
            );
        } else if (reactions && typeof reactions === "object") {
            users = Object.entries(reactions).map(([id, user]) => {
                if (user && typeof user === "object" && user.id) return user;
                return this.modules.UserStore.getUser(id);
            });
        }

        const filteredUsers = users.filter(user => user && user.id);
        this.reactionCache.set(key, {
            revision: this.reactionRevision,
            count: normalizedCount,
            users: filteredUsers,
            timestamp: Date.now()
        });
        return filteredUsers;
    }

    _shouldHide(message, settings) {
        const reactions = Array.isArray(message?.reactions) ? message.reactions : [];
        const emojiThreshold = Number(settings.emojiThreshold);
        if (emojiThreshold > 0 && reactions.length > emojiThreshold) return true;

        const totalThreshold = Number(settings.reactionsTotalThreshold);
        if (totalThreshold > 0) {
            const total = reactions.reduce((sum, reaction) => {
                const count = Number(reaction?.count);
                return sum + (Number.isFinite(count) && count > 0 ? count : 0);
            }, 0);
            if (total > totalThreshold) return true;
        }

        const perEmojiThreshold = Number(settings.reactionsPerEmojiThreshold);
        if (perEmojiThreshold > 0) {
            return reactions.some(reaction => {
                const count = Number(reaction?.count);
                return Number.isFinite(count) && count > perEmojiThreshold;
            });
        }

        return false;
    }

    _getChannelId(message) {
        try {
            return typeof message?.getChannelId === "function"
                ? message.getChannelId()
                : message?.channel_id;
        } catch (err) {
            return null;
        }
    }

    _reactionKey(message, emoji, type) {
        return `${this._getChannelId(message) || ""}:${message?.id || ""}:${emoji?.id || emoji?.name || ""}:${type || 0}`;
    }

    _normalizeSettings(raw) {
        const settings = Object.assign({}, this.defaults, raw && typeof raw === "object" ? raw : {});
        const number = (value, min, max, fallback) => {
            const parsed = Number(value);
            return Number.isFinite(parsed)
                ? Math.min(max, Math.max(min, parsed))
                : fallback;
        };
        const boolean = value => value === true || value === 1 || value === "true";

        settings.max = number(settings.max, 1, 100, this.defaults.max);
        settings.avatarSize = number(settings.avatarSize, 8, 48, this.defaults.avatarSize);
        settings.avatarOverlap = number(settings.avatarOverlap, 0, 100, this.defaults.avatarOverlap);
        settings.avatarSpacing = number(settings.avatarSpacing, 0, 50, this.defaults.avatarSpacing);
        settings.emojiThreshold = number(settings.emojiThreshold, 0, 20, this.defaults.emojiThreshold);
        settings.reactionsTotalThreshold = number(settings.reactionsTotalThreshold, 0, 10000, this.defaults.reactionsTotalThreshold);
        settings.reactionsPerEmojiThreshold = number(settings.reactionsPerEmojiThreshold, 0, 500, this.defaults.reactionsPerEmojiThreshold);
        settings.hideSelf = boolean(settings.hideSelf);
        settings.hideBots = boolean(settings.hideBots);
        settings.hideBlocked = boolean(settings.hideBlocked);
        return settings;
    }

    _loadSettings() {
        let saved = null;
        try {
            saved = BdApi.Data.load(this.name, "settings");
        } catch (err) {
            this._log("Failed to load settings:", err);
        }
        this.settings = this._normalizeSettings(saved);
    }

    updateSetting(name, value) {
        if (!Object.prototype.hasOwnProperty.call(this.defaults, name)) return;
        this.settings = this._normalizeSettings(Object.assign({}, this.settings, { [name]: value }));
        try {
            BdApi.Data.save(this.name, "settings", this.settings);
        } catch (err) {
            this._log("Failed to save settings:", err);
        }
        for (const listener of this.settingsListeners) {
            try {
                listener();
            } catch (err) {
                this._log("Settings listener failed:", err);
            }
        }
    }

    _buildSettingsPanel() {
        const settings = this.settings;
        const thresholdMarker = value => {
            if (Number(value) === 0) return "Off";
            if (Number(value) >= 1000) return `${Number(value) / 1000}k`;
            return `${value}`;
        };
        const pxMarker = value => `${value}px`;
        const percentMarker = value => `${Number(value).toFixed(2)}%`;

        const schema = [
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
                        value: settings.max,
                        min: 1,
                        max: 100,
                        step: 1,
                        onChange: value => this.updateSetting("max", value)
                    },
                    {
                        type: "slider",
                        id: "avatarSize",
                        name: "Avatar Size",
                        note: "Sets the size of the avatars.",
                        value: settings.avatarSize,
                        min: 8,
                        max: 48,
                        step: 1,
                        markers: [8, 12, 16, 20, 24, 32, 40, 48],
                        onMarkerRender: pxMarker,
                        onChange: value => this.updateSetting("avatarSize", value)
                    },
                    {
                        type: "slider",
                        id: "avatarOverlap",
                        name: "Avatar Overlap",
                        note: "Sets how much an avatar covers the previous one.",
                        value: settings.avatarOverlap,
                        min: 0,
                        max: 100,
                        step: 1,
                        onMarkerRender: percentMarker,
                        onChange: value => this.updateSetting("avatarOverlap", value)
                    },
                    {
                        type: "slider",
                        id: "avatarSpacing",
                        name: "Avatar Spacing",
                        note: "Sets the gap between two avatars.",
                        value: settings.avatarSpacing,
                        min: 0,
                        max: 50,
                        step: 1,
                        onMarkerRender: percentMarker,
                        onChange: value => this.updateSetting("avatarSpacing", value)
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
                        note: "Hides reactors when distinct emoji reactions exceed this value. 0 disables it.",
                        value: settings.emojiThreshold,
                        min: 0,
                        max: 20,
                        step: 1,
                        onMarkerRender: thresholdMarker,
                        onChange: value => this.updateSetting("emojiThreshold", value)
                    },
                    {
                        type: "slider",
                        id: "reactionsTotalThreshold",
                        name: "Reactions Total Threshold",
                        note: "Hides reactors when the sum of reaction counts exceeds this value. 0 disables it.",
                        value: settings.reactionsTotalThreshold,
                        min: 0,
                        max: 10000,
                        step: 10,
                        onMarkerRender: thresholdMarker,
                        onChange: value => this.updateSetting("reactionsTotalThreshold", value)
                    },
                    {
                        type: "slider",
                        id: "reactionsPerEmojiThreshold",
                        name: "Reactions per Emoji Threshold",
                        note: "Hides reactors when one emoji exceeds this value. 0 disables it.",
                        value: settings.reactionsPerEmojiThreshold,
                        min: 0,
                        max: 500,
                        step: 5,
                        onMarkerRender: thresholdMarker,
                        onChange: value => this.updateSetting("reactionsPerEmojiThreshold", value)
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
                        value: settings.hideSelf,
                        onChange: value => this.updateSetting("hideSelf", value)
                    },
                    {
                        type: "switch",
                        id: "hideBots",
                        name: "Hide Bots",
                        value: settings.hideBots,
                        onChange: value => this.updateSetting("hideBots", value)
                    },
                    {
                        type: "switch",
                        id: "hideBlocked",
                        name: "Hide Blocked Users",
                        value: settings.hideBlocked,
                        onChange: value => this.updateSetting("hideBlocked", value)
                    }
                ]
            }
        ];

        return BdApi.UI.buildSettingsPanel({
            settings: schema,
            onChange: (categoryOrId, idOrValue, maybeValue) => {
                const id = maybeValue === undefined ? categoryOrId : idOrValue;
                const value = maybeValue === undefined ? idOrValue : maybeValue;
                this.updateSetting(id, value);
            }
        });
    }

    _buildFallbackSettingsPanel() {
        if (typeof document === "undefined") return null;
        const panel = document.createElement("div");
        panel.className = "bd-who-reacted-settings";
        panel.style.padding = "16px";

        const addSwitch = (label, id) => {
            const row = document.createElement("label");
            row.style.display = "flex";
            row.style.gap = "8px";
            row.style.marginBottom = "12px";
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = this.settings[id];
            input.addEventListener("change", () => this.updateSetting(id, input.checked));
            row.append(input, document.createTextNode(label));
            panel.appendChild(row);
        };

        const addNumber = (label, id, min, max, step) => {
            const row = document.createElement("label");
            row.style.display = "flex";
            row.style.flexDirection = "column";
            row.style.gap = "4px";
            row.style.marginBottom = "12px";
            const text = document.createElement("span");
            text.textContent = label;
            const input = document.createElement("input");
            input.type = "number";
            input.min = min;
            input.max = max;
            input.step = step;
            input.value = this.settings[id];
            input.addEventListener("change", () => this.updateSetting(id, input.value));
            row.append(text, input);
            panel.appendChild(row);
        };

        addNumber("Maximum Avatars", "max", 1, 100, 1);
        addNumber("Avatar Size", "avatarSize", 8, 48, 1);
        addNumber("Avatar Overlap (%)", "avatarOverlap", 0, 100, 1);
        addNumber("Avatar Spacing (%)", "avatarSpacing", 0, 50, 1);
        addNumber("Emoji Threshold (0 = off)", "emojiThreshold", 0, 20, 1);
        addNumber("Reactions Total Threshold (0 = off)", "reactionsTotalThreshold", 0, 10000, 10);
        addNumber("Reactions per Emoji Threshold (0 = off)", "reactionsPerEmojiThreshold", 0, 500, 5);
        addSwitch("Hide Self", "hideSelf");
        addSwitch("Hide Bots", "hideBots");
        addSwitch("Hide Blocked Users", "hideBlocked");
        return panel;
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
    margin-left: 8px;
}

.bd-who-reacted__reactor-avatar {
    display: block;
    border-radius: 50%;
    border: 1px solid var(--background-secondary);
    object-fit: cover;
}

.bd-who-reacted__more-reactors {
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    align-items: center;
    color: var(--text-normal);
    font-weight: 500;
    background-color: var(--background-tertiary);
}
`;
        BdApi.DOM.addStyle(this.name, css);
    }

    _removeStyles() {
        try {
            BdApi.DOM.removeStyle(this.name);
        } catch (err) {
            this._log("Failed to remove styles:", err);
        }
    }

    _h() {
        return BdApi.React.createElement.apply(BdApi.React, arguments);
    }

    _showToast(message, type) {
        try {
            if (BdApi.UI && typeof BdApi.UI.showToast === "function") {
                BdApi.UI.showToast(message, { type });
            }
        } catch (err) {
            this._log(message, err);
        }
    }

    _log(...parts) {
        try {
            if (BdApi.Logger && typeof BdApi.Logger.error === "function") {
                BdApi.Logger.error(this.name, ...parts);
            }
        } catch (err) {
            // Logging must never interrupt plugin lifecycle.
        }
    }
};
