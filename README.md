# Heroes of Twilight

Expanded Twilight Princess multiplayer for [Dusklight](https://github.com/TwilitRealm/dusklight), based on **Crests of Courage by remiafterdark**.

I started Heroes of Twilight mostly for one reason: I wanted to play Twilight Princess with my kids.

The goal is to keep the multiplayer foundation that already works while making it easier to use, adding more ways to play together, and expanding the online side without turning it into something completely different.

Everyone playing together should use the same version of the mod.

## Multiplayer

Heroes of Twilight has two different multiplayer modes.

### Twilight Connected

Twilight Connected is the private co-op mode.

One player hosts a room and the other players join them. This is the mode for actually playing through Twilight Princess together and using the shared synchronization features.

Depending on the host settings, things like items, world progress, dungeons, time, PvP and other multiplayer features can be synchronized between players.

Some synchronization features are experimental and can still break things. If an option is marked unfinished or experimental, use it knowing that.

### Hyrule Online

Hyrule Online is the global side of Heroes of Twilight.

This is not supposed to turn everyone's game into one shared save.

You keep playing your own adventure while other players can appear in Hyrule with you. Their character, name, movement and other player information can be shown without giving them control over your story progress.

The idea is simple: make Hyrule feel populated by other real heroes while everybody can still play their own game.

Hyrule Online is also being expanded with things like player presence, heroes in your current area, chat, blocking and other community features.

## Install

Put the Heroes of Twilight `.dusk` file in Dusklight's `mods` folder.

Launch Twilight Princess through Dusklight and the Heroes of Twilight multiplayer menus will appear in the Dusklight menu bar.

Custom mod data is stored under:

`mod_data/dev.remiafterdark.coop_mod`

The original mod-data location is intentionally kept for compatibility with the multiplayer foundation.

## Models

Players can use different character models and other supported customization options.

Compatible models are stored under:

`mod_data/dev.remiafterdark.coop_mod/models`

Heroes of Twilight also works on making model and skin management easier so players do not have to manually dig through folders for everything.

Models and other custom assets belong to their respective creators. Check the included credits and permissions before redistributing somebody else's work.

## Bugs

Use **Report Bug** from inside Heroes of Twilight when something goes wrong.

When possible, explain what you were doing, which multiplayer mode you were using, what you expected to happen, and what actually happened.

Screenshots, videos and logs are extremely helpful.

If you can reproduce the same bug more than once, mention that too.

## Building

Heroes of Twilight uses the same general CMake/Ninja build setup as the project it was built from.

For a local build you will need CMake, Ninja and a supported compiler.

```sh
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCOOP_PUBLIC_BUILD=ON
cmake --build build
