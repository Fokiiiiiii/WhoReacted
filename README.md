# WhoReacted

BetterDiscord plugin that shows the avatars of people who reacted next to each reaction pill.

## Features

- Inline, compact avatars beside each reaction pill
- `+N` overflow count without hiding the native reaction count
- Configurable avatar size, overlap, spacing, and maximum visible avatars
- Optional filters for yourself, bots, and blocked users
- Resilient runtime discovery for current Discord builds
- Plain, single-file JavaScript: no bundler and no ZeresPluginLibrary dependency
- Uses a cache and DOM fallback to reduce repeated requests and survive UI updates

## Installation

1. Install [BetterDiscord](https://betterdiscord.app/).
2. Download [`WhoReacted.plugin.js`](https://raw.githubusercontent.com/Fokiiiiiii/WhoReacted/main/WhoReacted.plugin.js) from the repository's `main` branch.
3. Open **User Settings → Plugins → Open Plugins Folder**.
4. Copy the file into that folder and enable **WhoReacted**.

The file must retain the `.plugin.js` extension. Do not install the repository's README or configuration files as plugins.

## Updates

The canonical update source is the fixed `main`-branch plugin URL in the metadata (`@source` and `@updateUrl`). To publish an update, keep `WhoReacted.plugin.js` at the repository root, bump the `@version` and matching diagnostic version, push the file to `main`, then create a matching Git tag and GitHub release. BetterDiscord's official update tracking uses the fixed source URL plus the version bump; `@updateUrl` is included as a compatibility hint for clients that recognize it and is not a separate download location.

Raw plugin download: <https://raw.githubusercontent.com/Fokiiiiiii/WhoReacted/main/WhoReacted.plugin.js>

## Settings

Open the plugin's settings from BetterDiscord. You can adjust:

- Maximum visible avatars
- Avatar size, overlap, and spacing
- Fetch thresholds for large reaction sets
- Whether to hide your own avatar, bot accounts, or blocked users

## Known limitations

Discord's internal React components and stores are private implementation details and can change without notice. A Discord update may temporarily require a compatibility update. The plugin intentionally falls back to DOM/Fiber inspection when the preferred component hook is unavailable.

The plugin does not bypass Discord permissions or expose users who cannot be returned by Discord's own reaction data. Avatar fetching is subject to Discord's rate limits and the permissions available to the current client.

## BetterDiscord notes

This is an unofficial BetterDiscord plugin. BetterDiscord and Discord are separate projects. Use plugins at your own risk and keep a backup of your BetterDiscord plugin folder before upgrading Discord or BetterDiscord.

## Attribution

The original WhoReacted plugin was created by **jaimeadf** in the [BetterDiscordPlugins repository](https://github.com/jaimeadf/BetterDiscordPlugins). This repository contains a community-maintained modernization for current Discord builds.

## License

Released under the MIT License. See [LICENSE](LICENSE).
