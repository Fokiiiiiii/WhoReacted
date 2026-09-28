# WhoReacted

BetterDiscord plugin that shows the avatars of the people who reacted next to each reaction on a message.

## Features

- Small overlapping avatars inside each reaction, with a `+N` badge for the rest
- Loads who reacted for the reactions on screen, so avatars appear without hovering
- Adjustable count, size, overlap, and gap, with a live preview in the settings
- Optional filters for yourself, bots, and blocked users
- Hides avatars on messages with many reactions, with adjustable limits
- Settings in English or Japanese, following Discord's language
- Plain, single-file JavaScript: no bundler and no ZeresPluginLibrary dependency

## Installation

1. Install [BetterDiscord](https://betterdiscord.app/).
2. Download [`WhoReacted.plugin.js`](https://raw.githubusercontent.com/Fokiiiiiii/WhoReacted/main/WhoReacted.plugin.js) from the repository's `main` branch.
3. Open **User Settings → Plugins → Open Plugins Folder**.
4. Copy the file into that folder and enable **WhoReacted**.

The file must keep the `.plugin.js` extension. Do not install the repository's README or configuration files as plugins.

## Settings

- **Preview** shows how the avatars look while you change the settings.
- **Avatars**: how many to show per reaction, size, overlap, and gap
- **Hide**: yourself, bots, and blocked users
- **Loading**: load reactors automatically (on by default)
- **Messages with many reactions** (collapsed): hide avatars when a message has more kinds of emoji, more reactions in total, or more reactions on one emoji than the limit. Set a limit to Off to disable it.

## Automatic loading

Discord only knows who reacted after it has requested the reaction list, which normally happens when you hover a reaction. With **Load reactors automatically** on, WhoReacted makes that request itself, in the same form Discord uses, but only for reactions that are on screen and still missing avatars.

- Requests go out one at a time with a pause between them, and each reaction is requested once.
- When Discord answers with a rate limit, the plugin waits for the time Discord asks for.
- If a request fails in an unexpected way, automatic loading turns itself off until Discord reconnects.

This sends extra requests from your account. If you prefer not to, turn the setting off; reactions then show a `+N` count until you hover them once.

## How it works

WhoReacted watches Discord's message list for reaction buttons, reads each reaction from Discord's own components, and renders the avatars into it. It reads Discord's reaction, message, user, and channel stores and re-renders only when the data it shows changes. It does not patch Discord's components.

## Known limitations

Discord's internal components and stores are private implementation details and can change without notice. A Discord update may temporarily require a compatibility update.

## BetterDiscord notes

This is an unofficial BetterDiscord plugin. BetterDiscord and Discord are separate projects. Use plugins at your own risk and keep a backup of your BetterDiscord plugin folder before upgrading Discord or BetterDiscord.

## Attribution

The original WhoReacted plugin was created by **jaimeadf** in the [BetterDiscordPlugins repository](https://github.com/jaimeadf/BetterDiscordPlugins). This rewrite keeps its idea and look and targets current Discord builds.

## License

Released under the MIT License. See [LICENSE](LICENSE).
