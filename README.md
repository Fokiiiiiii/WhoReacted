# WhoReacted

BetterDiscord plugin that shows the avatars of people who reacted in the native reaction popout.

## Features

- Compact avatars in the native reaction popout
- `+N` overflow count without hiding the native reaction count
- Configurable avatar size, overlap, spacing, and maximum visible avatars
- Optional filters for yourself, bots, and blocked users
- Original-style reaction component patching with defensive module discovery
- Plain, single-file JavaScript: no bundler and no ZeresPluginLibrary dependency
- Caches reactor lists per reaction while Discord's native popout is open

## Installation

1. Install [BetterDiscord](https://betterdiscord.app/).
2. Download [`WhoReacted.plugin.js`](https://raw.githubusercontent.com/Fokiiiiiii/WhoReacted/main/WhoReacted.plugin.js) from the repository's `main` branch.
3. Open **User Settings → Plugins → Open Plugins Folder**.
4. Copy the file into that folder and enable **WhoReacted**.

The file must retain the `.plugin.js` extension. Do not install the repository's README or configuration files as plugins.

## Settings

Open the plugin's settings from BetterDiscord. You can adjust:

- Maximum visible avatars
- Avatar size, overlap, and spacing
- Hide thresholds for large reaction sets (skip rendering avatars above a configurable emoji/reaction count)
- Whether to hide your own avatar, bot accounts, or blocked users

## Known limitations

Discord's internal React components and stores are private implementation details and can change without notice. A Discord update may temporarily require a compatibility update. The plugin follows the original WhoReacted architecture and patches Discord's reaction component to add its Reactors component to the native popout.

The plugin does not bypass Discord permissions or expose users who cannot be returned by Discord's own reaction data. It does not proactively fetch reactor lists from Discord's API — it only displays what Discord's client has already loaded (typically after the native reaction tooltip has been hovered once). Until that happens, a message shows a `+N` count badge instead of avatars.

## BetterDiscord notes

This is an unofficial BetterDiscord plugin. BetterDiscord and Discord are separate projects. Use plugins at your own risk and keep a backup of your BetterDiscord plugin folder before upgrading Discord or BetterDiscord.

## Attribution

The original WhoReacted plugin was created by **jaimeadf** in the [BetterDiscordPlugins repository](https://github.com/jaimeadf/BetterDiscordPlugins). This repository keeps that architecture and adds compatibility, caching, filtering, and settings safeguards for current Discord builds.

## License

Released under the MIT License. See [LICENSE](LICENSE).
