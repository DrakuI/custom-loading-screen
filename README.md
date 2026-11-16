[![Downloads](https://img.shields.io/github/downloads/DrakuI/custom-loading-screen/total?label=downloads&style=for-the-badge)](https://github.com/DrakuI/custom-loading-screen/releases)
[![Foundry Version](https://img.shields.io/badge/dynamic/json?label=Foundry&query=%24.compatibility.verified&url=https%3A%2F%2Fgithub.com%2FDrakuI%2Fcustom-loading-screen%2Freleases%2Flatest%2Fdownload%2Fmodule.json&color=orange&style=for-the-badge)](https://foundryvtt.com/packages/custom-loading-screen)
[![Patreon](https://img.shields.io/badge/Patreon-F96854?logo=patreon&logoColor=white&style=for-the-badge)](https://patreon.com/noiterpg?utm_medium=unknown&utm_source=join_link&utm_campaign=creatorshare_creator&utm_content=copyLink)

# Custom Loading Screen

Fork of [Loading Screen System](https://github.com/NoWitchCraft/loading-screen) 2.3.2 by NoWitchCraft
(Apache-2.0) for Foundry VTT v14 (verified on 14.369). It shows a themed loading screen while a scene loads.

## Features

- Four designs: Standard, Minimalist, Cinematic, Fantasy/RPG.
- Tips in a bar anchored to the bottom of the screen, rotating at a set interval. Custom tips: one per line.
- Images from a folder, a file or a wildcard pattern; one is chosen at random and, optionally, they rotate with a
  crossfade. Videos (webm, mp4) work too. Without images the scene's own background is used.
- Loading music from a file, folder or wildcard pattern, with volume, fade-out or play to the end, a per-browser
  switch and a per-scene choice.
- Minimum display time; a click closes the screen once the scene is ready.
- Progress bar fed by the real texture loading.
- Preview from the module settings.
- Custom screens: a full-screen cinematic transition between maps, with music, camera movement, and macro support.

## Wildcard Sources

| Entry | Meaning |
| --- | --- |
| `worlds/my-world/loading` | every image (or track) in the folder |
| `worlds/my-world/loading/tavern.webp` | only that file |
| `worlds/my-world/loading/tavern-*.webp` | all tavern- webp files |
| `worlds/my-world/loading/*.{webp,jpg}` | alternatives |
| `worlds/my-world/loading/*/*.webp` | wildcards in folder names |
| `worlds/my-world/loading/**` | the folder and all its sub-folders |

## Custom screens

https://github.com/user-attachments/assets/3816eb39-278a-4c94-a034-609805da8b4c

Can control media and macro for video, image or something to fill the screen, sounds and where this sound plays or ends, camera controls for cinematic views and a forward to a scene, which loads before the custom screen.

**Stop**: The GM has a purple button in the top right corner, interrupts everything.

Macros run at "When it starts", "Scene appears" or "Camera stops", after their delay, once, on the active GM's client;

Players see what their tokens can see, but walls are not visible during custom loading screens.

## API

```js
const api = game.modules.get("custom-loading-screen").api;
api.preview({scene: "SceneId", duration: 8}); // show the screen on this client only
api.hide();                                    // close the current screen
await api.resolveMedia("worlds/my-world/loading/*.webp", "image");
await api.refreshCache();                      // GM: resolve all sources again

api.custom.list();                             // saved custom screens
api.custom.play("Intro");                      // GM: play for everyone (id or name)
api.custom.changeScene("Intro", "Greenest");   // GM: play it on the way to another scene than its Forward to
api.custom.stop();                             // GM: interrupt it everywhere; player: here
api.custom.preview("Intro");                   // this client only
api.custom.skip();                             // next phase of the custom screen playing here
api.custom.open();                             // the Custom Screens window
```

## License

Apache License 2.0, see [LICENSE](LICENSE). Original work by NoWitchCraft; modified files carry a notice at the top.
Includes the libWrapper shim by Rui Pinheiro (LGPL-3.0-or-later), in scripts/lib/lib-wrapper-shim.js.
