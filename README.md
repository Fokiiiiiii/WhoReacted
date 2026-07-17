# WhoReacted

BetterDiscord plugin that shows the avatars of people who reacted next to each reaction pill.

## Features

- Inline, compact avatars beside each reaction pill
- `+N` overflow count without hiding the native reaction count
- Configurable avatar size, overlap, spacing, and maximum visible avatars
- Optional filters for yourself, bots, and blocked users
- Resilient runtime discovery for current Discord builds
- Plain, single-file JavaScript: no bundler and no ZeresPluginLibrary dependency
- Caches the last known reactor list per reaction so avatars don't flash away during Discord's virtualized re-renders

## Installation

1. Install [BetterDiscord](https://betterdiscord.app/).
2. Download [`WhoReacted.plugin.js`](https://raw.githubusercontent.com/Fokiiiiiii/WhoReacted/main/WhoReacted.plugin.js) from the repository's `main` branch.
3. Open **User Settings → Plugins → Open Plugins Folder**.
4. Copy the file into that folder and enable **WhoReacted**.

The file must retain the `.plugin.js` extension. Do not install the repository's README or configuration files as plugins.

## Updates

The canonical update source is the fixed `main`-branch plugin URL in the metadata (`@source` and `@updateUrl`). To publish an update, keep `WhoReacted.plugin.js` at the repository root, bump the `@version`, push the file to `main`, then create a matching Git tag and GitHub release. BetterDiscord's official update tracking uses the fixed source URL plus the version bump; `@updateUrl` is included as a compatibility hint for clients that recognize it and is not a separate download location.

Raw plugin download: <https://raw.githubusercontent.com/Fokiiiiiii/WhoReacted/main/WhoReacted.plugin.js>

## Settings

Open the plugin's settings from BetterDiscord. You can adjust:

- Maximum visible avatars
- Avatar size, overlap, and spacing
- Hide thresholds for large reaction sets (skip rendering avatars above a configurable emoji/reaction count)
- Whether to hide your own avatar, bot accounts, or blocked users

## Known limitations

Discord's internal React components and stores are private implementation details and can change without notice. A Discord update may temporarily require a compatibility update. The plugin injects avatars by observing rendered reaction pills directly (DOM/Fiber inspection) rather than patching Discord's internal components, which stays valid even when pills first appear long after the plugin starts.

The plugin does not bypass Discord permissions or expose users who cannot be returned by Discord's own reaction data. It does not proactively fetch reactor lists from Discord's API — it only displays what Discord's client has already loaded (typically after the native reaction tooltip has been hovered once). Until that happens, a message shows a `+N` count badge instead of avatars.

## BetterDiscord notes

This is an unofficial BetterDiscord plugin. BetterDiscord and Discord are separate projects. Use plugins at your own risk and keep a backup of your BetterDiscord plugin folder before upgrading Discord or BetterDiscord.

## Attribution

The original WhoReacted plugin was created by **jaimeadf** in the [BetterDiscordPlugins repository](https://github.com/jaimeadf/BetterDiscordPlugins). This repository contains a community-maintained modernization for current Discord builds.

## License

Released under the MIT License. See [LICENSE](LICENSE).
