# Screenshots

The README now shows the real interface. `rostrum-window.png` and
`rostrum-panel.png` were captured from the demo window below; the concept
illustration they replaced has been deleted. Only `rostrum-acp-workflow.png`
remains a drawing, and it is an architecture diagram rather than a picture of
the product pretending to be one.

Retake them whenever the panel changes shape. Two bugs were found purely by
looking at the first capture — a duplicated Queue button and a control row that
ran off the edge of the sidebar — so it is worth doing after any UI work.

Capturing a real screenshot needs a real agent, which normally means
credentials, a network, and whatever the model happens to say that day. The
demo agent removes all three.

## Taking the shot

```sh
npm run demo
```

This builds the extension, downloads the pinned VS Code baseline on first run,
and opens a clean window — a throwaway profile, no other extensions, the
default dark theme — with a scripted agent already configured.

Then:

1. Open the **Rostrum** view in the Activity Bar, then **Rostrum Chat**.
2. Run **Rostrum: New Session** and choose **Demo Agent**.
3. Send any prompt.
4. Capture the window once the approval card appears.
   On macOS: `Cmd+Shift+4`, then `Space`, then click the window.

The agent replies the same way every time, so the shot is reproducible. One
turn exercises reasoning, a plan, a tool call with input and output, a file
diff, a rendered diagram, inline maths, and an approval request that is left
outstanding — so the permission card is on screen rather than having to be
caught mid-flight.

`test/demo-agent.mjs` performs no work and touches nothing on disk. It exists
to be photographed and is excluded from the packaged extension.

## What to capture

Worth having, roughly in order of how much a listing needs them:

| Shot | Shows |
| --- | --- |
| Chat panel mid-turn, approval card visible | The core loop: an agent working, and you deciding |
| Changes and Timeline views | That edits are tracked across files, not just shown once |
| A historical diff | That an agent's edit can be reviewed after the fact |
| Session switcher with several live conversations | Concurrency, which most rivals do not have |
| Agent diagnostics output | Declared-versus-observed capabilities |

## Annotating

Number the callouts and explain them in the surrounding Markdown rather than
burning text into the image. Text in a PNG cannot be read by a screen reader,
does not survive dark mode, and cannot be corrected without re-exporting.

Keep the alt text describing what the reader would *see*, not what the feature
is called.

## Before committing an image

- Crop to the panel and the editor beside it. A full 6K desktop is mostly
  wallpaper once the Marketplace scales it down.
- Check for anything from your own machine: paths, branch names, other files.
- Compress. The two illustrations currently in `docs/images/` are over 1 MB
  each, which is why `docs/**` is excluded from the VSIX and the README
  references them by absolute URL instead.
